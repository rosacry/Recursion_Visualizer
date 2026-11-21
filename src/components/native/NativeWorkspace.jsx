import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Loader2, RotateCcw, Square, ChevronDown, ChevronRight, Cpu, AlertTriangle, CheckCircle2, Info } from 'lucide-react'
import { TraceModel } from '@/lib/native/traceModel'
import { fetchHealth, runAndWait } from '@/lib/native/api'
import { DEFAULT_PRESET, PRESETS, presetById } from '@/lib/native/presets'
import { CodeArea, looksLikeNotCpp } from './NativeEditor'
import SourcePanel from './SourcePanel'
import StackPanel from './StackPanel'
import FrameInspector from './FrameInspector'
import CallTreePanel from './CallTreePanel'
import StepControls from './StepControls'
import EventLog from './EventLog'
import RunReport from './RunReport'
import { resolveMode } from './ValueView'

const LS_KEY = 'rv.native.workspace.v1'

function referenceWorkspace(preset = DEFAULT_PRESET) {
  return {
    presetId: preset.id,
    solution: preset.solution,
    driver: preset.driver,
    stdin: preset.inputs[0]?.stdin ?? '',
    compiler: 'g++',
    maxSteps: 25000,
  }
}

function loadWorkspace() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return null
    const ws = JSON.parse(raw)
    if (typeof ws.solution !== 'string' || typeof ws.driver !== 'string') return null
    return { ...referenceWorkspace(), ...ws }
  } catch {
    return null
  }
}

function saveWorkspace(ws) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(ws)) } catch { /* private mode */ }
}

function isUntouchedReference(ws) {
  const p = presetById(ws.presetId)
  return !!p && ws.solution === p.solution && ws.driver === p.driver
}

function errorLinesOf(stderr, file) {
  const set = new Set()
  if (!stderr) return set
  const re = new RegExp(`${file.replace('.', '\\.')}:(\\d+):\\d+: (?:fatal )?error`, 'g')
  let m
  while ((m = re.exec(stderr))) set.add(Number(m[1]))
  return set
}

const PHASE_TEXT = {
  starting: 'starting the native runner…', compile: 'compiling with optimizations off…', 'direct-run': 'running the executable directly…',
  trace: 'recording under GDB…', untraced: 'trace limit reached — letting the program finish untraced…', done: 'finishing…',
}

export default function NativeWorkspace() {
  const [ws, setWs] = useState(() => loadWorkspace() || referenceWorkspace())
  const [tab, setTab] = useState('solution')
  const [editorOpen, setEditorOpen] = useState(true)
  const [health, setHealth] = useState(null)
  const [healthErr, setHealthErr] = useState(null)
  const [run, setRun] = useState({ status: 'idle' })
  const [result, setResult] = useState(null)
  const [model, setModel] = useState(null)
  const [ranJob, setRanJob] = useState(null)
  const [step, setStep] = useState(0)
  const [follow, setFollow] = useState(true)
  const [pinned, setPinned] = useState(null)
  const [srcFile, setSrcFile] = useState('solution.cpp')
  const [intMode, setIntMode] = useState('auto')
  const [maskOverride, setMaskOverride] = useState(null)
  const [bitBase, setBitBase] = useState(1)
  const [varModes, setVarModes] = useState({})
  const [showHelp, setShowHelp] = useState(false)
  const abortRef = useRef(null)
  const autoRan = useRef(false)

  useEffect(() => { saveWorkspace(ws) }, [ws])

  useEffect(() => {
    let alive = true
    fetchHealth().then((h) => { if (alive) setHealth(h) }).catch((e) => { if (alive) setHealthErr(e.message) })
    return () => { alive = false }
  }, [])

  const update = (patch) => setWs((w) => ({ ...w, ...patch }))

  const doRun = useCallback(async (override) => {
    const w = override || ws
    if (abortRef.current) abortRef.current.abort()
    const ctl = new AbortController()
    abortRef.current = ctl
    const job = {
      files: { 'solution.cpp': w.solution, 'driver.cpp': w.driver },
      main: 'driver.cpp',
      traceFiles: ['solution.cpp'],
      stdin: w.stdin,
      compiler: w.compiler,
      limits: { maxSteps: w.maxSteps },
    }
    setRun({ status: 'running', progress: { phase: 'starting' }, started: Date.now() })
    try {
      const rec = await runAndWait(job, {
        signal: ctl.signal,
        onProgress: (r) => setRun((cur) => (cur.status === 'running' ? { ...cur, progress: r.progress, elapsed: r.elapsed } : cur)),
      })
      if (rec.status !== 'done') throw new Error(rec.error || `run ${rec.status}`)
      const res = rec.result
      setResult(res)
      setRanJob(job)
      if (!res.ok) {
        setModel(null)
        setRun({ status: 'failed', stage: res.stage, error: res.error })
        setEditorOpen(true)
        return
      }
      const t0 = performance.now()
      const m = new TraceModel(res, { 'solution.cpp': job.files['solution.cpp'], 'driver.cpp': job.files['driver.cpp'] })
      console.info(`[native] job ${rec.elapsed?.toFixed?.(2)}s (runner ${res.seconds}s), ${m.N} steps, model built in ${(performance.now() - t0).toFixed(0)} ms`)
      setModel(m)
      setStep(0)
      setPinned(null)
      setFollow(true)
      setSrcFile('solution.cpp')
      setRun({ status: 'done' })
      setEditorOpen(false)
    } catch (e) {
      if (e.name === 'AbortError') setRun({ status: 'idle', note: 'cancelled' })
      else setRun({ status: 'error', error: e.message })
    } finally {
      if (abortRef.current === ctl) abortRef.current = null
    }
  }, [ws])

  // Start with the reference already traced (only for the untouched reference workspace).
  useEffect(() => {
    if (autoRan.current || !health?.ok) return
    autoRan.current = true
    if (isUntouchedReference(ws)) doRun()
  }, [health]) // eslint-disable-line react-hooks/exhaustive-deps

  const stale = ranJob && (ranJob.files['solution.cpp'] !== ws.solution || ranJob.files['driver.cpp'] !== ws.driver || ranJob.stdin !== ws.stdin)
  const maskWidth = maskOverride ?? model?.maskWidth ?? 8
  const modeOf = useCallback((meta, val) => resolveMode(val, varModes[meta?.n], intMode), [varModes, intMode])
  const setVarMode = useCallback((name, mode) => setVarModes((m) => ({ ...m, [name]: mode })), [])
  const curInv = model?.steps[step]?.i ?? null
  const selectedInv = follow ? curInv : (pinned ?? curInv)
  const go = useCallback((s) => { if (model) setStep(model.clamp(s)) }, [model])
  const selectInv = useCallback((id) => { setPinned(id); setFollow(false) }, [])

  // keyboard stepping
  useEffect(() => {
    if (!model) return undefined
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase()
      if (tag === 'textarea' || tag === 'input' || tag === 'select' || e.target?.isContentEditable) return
      let next = null
      if (e.key === 'ArrowRight' && e.shiftKey) next = model.stepOut(step)
      else if (e.key === 'ArrowLeft' && e.shiftKey) next = model.stepBackOut(step)
      else if (e.key === 'ArrowRight' || e.key === 'F11') next = e.shiftKey ? model.stepOut(step) : model.stepInto(step)
      else if (e.key === 'ArrowLeft') next = model.stepBack(step)
      else if (e.key === 'ArrowDown' || e.key === 'F10') next = model.stepOver(step)
      else if (e.key === 'ArrowUp') next = model.stepBackOver(step)
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = model.N - 1
      if (next !== null) {
        e.preventDefault()
        setStep(model.clamp(next))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [model, step])

  const preset = presetById(ws.presetId)
  const compileErrLines = useMemo(() => errorLinesOf(result?.compile?.stderr, tab === 'driver' ? 'driver.cpp' : 'solution.cpp'), [result, tab])
  const notCpp = looksLikeNotCpp(ws.solution)
  const running = run.status === 'running'

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------ workspace / editor */}
      <div className="app-panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2">
          <button type="button" onClick={() => setEditorOpen((o) => !o)} className="flex items-center gap-1 text-sm font-semibold">
            {editorOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Native C++20
          </button>
          <span className="text-xs text-muted-foreground">compiled with {ws.compiler === 'clang++' ? 'clang++' : 'g++'} -std=c++20 -g -O0 · executed natively · traced with GDB</span>
          <HealthChip health={health} error={healthErr} />
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={ws.presetId || ''} onChange={(e) => { const p = presetById(e.target.value); if (p) setWs(referenceWorkspace(p)) }}
              className="rounded-md border border-border bg-background px-2 py-1 text-xs" title="load a built-in workspace (replaces the editors)">
              {!preset && <option value="">custom workspace</option>}
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
            <select value={ws.compiler} onChange={(e) => update({ compiler: e.target.value })} className="rounded-md border border-border bg-background px-2 py-1 text-xs">
              {(health?.compilers || [{ id: 'g++', label: 'g++' }, { id: 'clang++', label: 'clang++' }]).map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1 text-xs text-muted-foreground" title="maximum number of recorded steps; the program still runs to completion after the limit">
              step limit
              <input type="number" min={100} max={500000} step={1000} value={ws.maxSteps}
                onChange={(e) => update({ maxSteps: Math.max(100, Math.min(500000, Number(e.target.value) || 25000)) })}
                className="w-24 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono" />
            </label>
            {running ? (
              <button type="button" onClick={() => abortRef.current?.abort()} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-sm">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            ) : null}
            <button type="button" disabled={running} onClick={() => doRun()} data-testid="native-run"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 text-sm font-semibold text-primary-foreground shadow-sm hover:brightness-110 disabled:opacity-60">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Run
            </button>
          </div>
        </div>

        {/* status line */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
          {running && (
            <span className="flex items-center gap-1.5 text-primary">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> {PHASE_TEXT[run.progress?.phase] || run.progress?.phase}
              {run.progress?.steps ? ` ${run.progress.steps.toLocaleString()} steps` : ''}
              {run.elapsed ? ` · ${run.elapsed.toFixed(1)}s` : ''}
            </span>
          )}
          {run.status === 'done' && model && (
            <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> recorded {model.N.toLocaleString()} steps, {model.invs.size.toLocaleString()} invocations
              {model.end.reason && model.end.reason !== 'exited' && <b className="text-amber-700 dark:text-amber-300"> · trace stopped early ({model.end.reason}) — see the last step</b>}
            </span>
          )}
          {run.status === 'failed' && (
            <span className="flex items-center gap-1.5 text-rose-700 dark:text-rose-400"><AlertTriangle className="h-3.5 w-3.5" /> {run.stage === 'compile' ? 'compilation failed — the compiler output is below' : run.error}</span>
          )}
          {run.status === 'error' && <span className="flex items-center gap-1.5 text-rose-700"><AlertTriangle className="h-3.5 w-3.5" /> {run.error}</span>}
          {stale && !running && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-amber-800 dark:text-amber-200">edited since this trace was recorded — Run again to refresh</span>}
          <span className="ml-auto flex flex-wrap items-center gap-1.5 text-muted-foreground">
            input
            {preset?.inputs?.map((inp) => (
              <button key={inp.label} type="button" onClick={() => update({ stdin: inp.stdin })} data-testid="input-preset"
                className={`rounded-full border px-2.5 py-0.5 font-mono text-xs ${ws.stdin === inp.stdin ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border text-foreground hover:bg-muted'}`}>
                {inp.label}
              </button>
            ))}
            {!(preset?.inputs || []).some((inp) => inp.stdin === ws.stdin) && (
              <span className="rounded-full border border-primary bg-primary/10 px-2.5 py-0.5 font-mono text-xs text-primary">stdin: {ws.stdin.trim().replace(/\s+/g, ' ').slice(0, 32) || '(empty)'}</span>
            )}
            <button type="button" className="text-xs text-primary underline" onClick={() => { setEditorOpen(true); setTab('stdin') }}>edit</button>
          </span>
        </div>

        {editorOpen && (
          <div className="space-y-2 border-t border-border/50 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {[['solution', 'solution.cpp — your code, compiled unchanged'], ['driver', 'driver.cpp — main() / test driver'], ['stdin', 'stdin — input']].map(([k, label]) => (
                <button key={k} type="button" onClick={() => setTab(k)}
                  className={`rounded-md px-2.5 py-1 font-mono text-xs ${tab === k ? 'bg-card shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'}`}>
                  {label}
                </button>
              ))}
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                {preset && !isUntouchedReference(ws) && (
                  <button type="button" onClick={() => setWs({ ...referenceWorkspace(preset), stdin: ws.stdin })} className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" title="restore the reference solution and driver">
                    <RotateCcw className="h-3 w-3" /> reset to reference
                  </button>
                )}
              </div>
            </div>
            {tab === 'solution' && (
              <>
                <CodeArea value={ws.solution} onChange={(v) => update({ solution: v })} errorLines={compileErrLines} placeholder="Paste your LeetCode C++ solution here" />
                {notCpp && <div className="text-xs text-amber-700">{notCpp}</div>}
                <div className="text-[11px] text-muted-foreground">Your solution is written to solution.cpp byte-for-byte. The driver #includes it, so every highlighted line is a line of what you pasted. LeetCode supplies headers and <span className="font-mono">using</span> declarations implicitly; add them in the driver before the #include.</div>
              </>
            )}
            {tab === 'driver' && (
              <>
                <CodeArea value={ws.driver} onChange={(v) => update({ driver: v })} errorLines={compileErrLines} />
                {!/#include\s+"solution\.cpp"/.test(ws.driver) && <div className="text-xs text-rose-600">The driver must contain #include "solution.cpp".</div>}
              </>
            )}
            {tab === 'stdin' && (
              <CodeArea value={ws.stdin} onChange={(v) => update({ stdin: v })} minRows={6} placeholder="Input passed to the program on stdin" />
            )}
            {run.status === 'failed' && result?.compile && !result.compile.ok && (
              <div className="rounded-lg border border-rose-400/60 bg-rose-500/5 p-2">
                <div className="mb-1 font-mono text-[11px] text-muted-foreground">$ {result.compile.command}</div>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-rose-800 dark:text-rose-200">{result.compile.stderr || result.compile.stdout || `exit code ${result.compile.exitCode}`}</pre>
              </div>
            )}
            {run.status === 'failed' && result && result.stage !== 'compile' && (
              <pre className="max-h-72 overflow-auto rounded-lg border border-rose-400/60 bg-rose-500/5 p-2 font-mono text-xs">{result.error}{'\n'}{result.gdbStderr}</pre>
            )}
          </div>
        )}
      </div>

      {/* ------------------------------------------------ visualizer */}
      {model && (
        <>
          <div className="sticky top-0 z-20">
            <StepControls model={model} step={step} setStep={go} maskWidth={maskWidth} />
          </div>
          <div className="app-panel flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs">
            <span className="font-semibold">Display</span>
            <label className="flex items-center gap-1">integers
              <select value={intMode} onChange={(e) => { setIntMode(e.target.value); setVarModes({}) }} className="rounded border border-border bg-background px-1 py-0.5">
                <option value="auto">auto: unsigned → binary, signed → decimal</option>
                <option value="dec">all decimal</option>
                <option value="bin">all binary</option>
                <option value="hex">all hex</option>
              </select>
            </label>
            <label className="flex items-center gap-1">mask width
              <button type="button" className="rounded border border-border px-1" onClick={() => setMaskOverride(Math.max(1, maskWidth - 1))}>−</button>
              <span className="w-5 text-center font-mono">{maskWidth}</span>
              <button type="button" className="rounded border border-border px-1" onClick={() => setMaskOverride(Math.min(64, maskWidth + 1))}>+</button>
              {maskOverride != null && <button type="button" className="text-primary underline" onClick={() => setMaskOverride(null)}>auto ({model.maskWidth})</button>}
            </label>
            <label className="flex items-center gap-1" title="how set bits are labelled next to a binary value">set bits
              <select value={bitBase} onChange={(e) => setBitBase(Number(e.target.value))} className="rounded border border-border bg-background px-1 py-0.5">
                <option value={1}>counted from 1 (bit i ↔ number i)</option>
                <option value={0}>0-based bit indices</option>
              </select>
            </label>
            <span className="text-muted-foreground">click any integer to switch it between binary / decimal / hex</span>
            <button type="button" onClick={() => setShowHelp((s) => !s)} className="ml-auto inline-flex items-center gap-1 text-primary">
              <Info className="h-3.5 w-3.5" /> what is a step?
            </button>
          </div>
          {showHelp && <StepHelp />}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="h-[600px] xl:col-span-5">
              <SourcePanel model={model} step={step} selectedInv={selectedInv} file={srcFile} onFileChange={setSrcFile} onSelectInv={selectInv} />
            </div>
            <div className="h-[600px] xl:col-span-3">
              <StackPanel model={model} step={step} selectedInv={selectedInv} onSelectInv={selectInv} modeOf={modeOf} maskWidth={maskWidth} />
            </div>
            <div className="h-[600px] xl:col-span-4">
              <FrameInspector model={model} step={step} invId={selectedInv} follow={follow}
                onFollow={(f) => { setFollow(f); if (f) setPinned(null) }} onJump={go}
                modeOf={modeOf} setVarMode={setVarMode} maskWidth={maskWidth} bitBase={bitBase} />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <div className="h-[460px] xl:col-span-8">
              <CallTreePanel model={model} step={step} selectedInv={selectedInv} onSelectInv={selectInv} onJump={go} maskWidth={maskWidth} />
            </div>
            <div className="h-[460px] xl:col-span-4">
              <EventLog model={model} step={step} setStep={go} maskWidth={maskWidth} />
            </div>
          </div>
        </>
      )}
      {result && <RunReport result={result} model={model} />}
      {!model && !running && run.status !== 'failed' && (
        <div className="app-panel p-6 text-center text-sm text-muted-foreground">
          <Cpu className="mx-auto mb-2 h-6 w-6" />
          Paste a C++20 solution, adjust the driver and stdin, then click <b>Run</b>. The program is compiled and executed natively; the visualizer only replays what it recorded.
        </div>
      )}
    </div>
  )
}

function HealthChip({ health, error }) {
  if (error) return <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-700" title={error}>native service offline — start it with npm run native</span>
  if (!health) return <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">checking toolchain…</span>
  if (!health.ok) return <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] text-rose-700" title={health.error || ''}>toolchain not ready</span>
  return (
    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300" title={`${health.compilers.map((c) => c.label).join('\n')}\n${health.debugger}\n${health.backend} · ${health.linux}`}>
      {health.backend} · {health.debugger?.replace(/\s*\(.*\)/, '')}
    </span>
  )
}

function StepHelp() {
  return (
    <div className="app-panel space-y-1.5 p-3 text-[13px] leading-relaxed">
      <p><b>What one step is.</b> Every step is one stop of the compiled program under GDB (nothing is simulated):</p>
      <ul className="ml-5 list-disc space-y-0.5">
        <li><b>call</b> — a function from solution.cpp was entered. Its frame and parameters are set up; it is about to run its first line.</li>
        <li><b>line</b> — the program reached the start of a new source line in the same invocation. This is GDB’s own <span className="font-mono">step</span> rule, so a line holding several operations (for example <span className="font-mono">candidates &amp;= ~position;</span>, or a loop header’s increment and test) is <i>one</i> step, and a loop header shows up once per iteration. The debugger only sees line boundaries, not the individual operations inside a line.</li>
        <li><b>return</b> — the callee returned. The value is captured at the return address (GDB FinishBreakpoint), so the caller is stopped <i>in the middle of</i> the line that made the call; the rest of that line has not run yet.</li>
      </ul>
      <p><b>Before or after?</b> Values are read from the process memory at the stop, so they are the state <b>before the highlighted line executes</b>. “Changed by the previous step” marks what the previously executed line did. Stepping backward shows exactly what was recorded at that earlier step, including earlier contents of shared objects such as <span className="font-mono">memo</span>.</p>
      <p><b>Copies vs references.</b> Variables are bound to memory addresses. A C++ reference (<span className="font-mono">unsigned int&amp; p1</span>) points at another frame’s object, so every frame that shares it shows the same coloured dot and the same value; a by-value local (<span className="font-mono">savedP1</span>) is that frame’s own copy.</p>
      <p><b>Labels.</b> <i>not initialized yet</i> = declared on this line or later; <i>out of scope</i> = its block is not active at this line; <i>unavailable</i> = GDB could not read it. Calls into the standard library (<span className="font-mono">std::bit_floor</span>, <span className="font-mono">vector::operator[]</span>) run natively and are not stepped into. Only solution.cpp is traced; the driver runs untraced.</p>
    </div>
  )
}
