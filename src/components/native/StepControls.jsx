import React, { useEffect, useMemo, useRef } from 'react'
import { shortValue } from '@/lib/native/format'

function Btn({ onClick, title, children, disabled, primary }) {
  return (
    <button type="button" onClick={onClick} title={title} disabled={disabled}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
        primary ? 'border-primary bg-primary text-primary-foreground hover:brightness-110' : 'border-border bg-card hover:bg-accent'}`}>
      {children}
    </button>
  )
}

function DepthStrip({ model, step, onSeek }) {
  const ref = useRef(null)
  const W = 1200
  const H = 34
  const bins = useMemo(() => {
    const n = model.N
    const out = new Array(W).fill(0)
    const kinds = new Array(W).fill(0)
    for (let s = 0; s < n; s++) {
      const x = Math.floor((s / Math.max(1, n)) * W)
      const d = model.steps[s].d || 0
      if (d > out[x]) out[x] = d
      if (model.steps[s].k === 'ret') kinds[x] |= 1
    }
    return { out, kinds }
  }, [model])
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const g = c.getContext('2d')
    g.clearRect(0, 0, W, H)
    const md = Math.max(1, model.maxDepth)
    for (let x = 0; x < W; x++) {
      const h = (bins.out[x] / md) * (H - 4)
      g.fillStyle = 'rgba(99,102,241,0.55)'
      g.fillRect(x, H - h, 1, h)
    }
    const cx = Math.floor((step / Math.max(1, model.N)) * W)
    g.fillStyle = '#f59e0b'
    g.fillRect(Math.max(0, cx - 1), 0, 3, H)
  }, [bins, step, model])
  const seek = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
    onSeek(Math.round(f * (model.N - 1)))
  }
  return (
    <canvas ref={ref} width={W} height={H} title="recursion depth over the recorded steps — click to jump"
      className="h-[34px] w-full cursor-pointer rounded-md border border-border/60 bg-background/60"
      onMouseDown={seek} onMouseMove={(e) => { if (e.buttons === 1) seek(e) }} />
  )
}

export function stepBanner(model, step, maskWidth) {
  const st = model.steps[step]
  if (!st) return { tone: 'muted', text: '' }
  const label = (id) => (id == null ? 'untraced code' : model.invLabel(id))
  const src = (inv, ln) => {
    const t = model.sourceLine(model.fileOfInv(inv), ln).trim()
    return t ? `“${t.length > 70 ? t.slice(0, 69) + '…' : t}”` : ''
  }
  switch (st.k) {
    case 'call': {
      const inv = model.invs.get(st.i)
      const by = inv?.parent != null ? `called by ${label(inv.parent)} at line ${model.lineOf(inv.parent, step)}` : `called from ${inv?.caller || 'main'}${inv?.callLine ? ` (driver line ${inv.callLine})` : ''}`
      return { tone: 'call', head: `Call · ${label(st.i)} begins`, text: `${by}. Parameters are bound; about to execute line ${st.ln} ${src(st.i, st.ln)}. Values shown are before that line runs.` }
    }
    case 'line': {
      const arr = model.invStepIdx.get(st.i) || []
      let visits = 0
      for (const s of arr) { if (s > step) break; if (model.steps[s].ln === st.ln && model.steps[s].k !== 'ret') visits++ }
      return { tone: 'line', head: `About to execute line ${st.ln} in ${label(st.i)}`, text: `${src(st.i, st.ln)} — values shown are BEFORE this line runs.${visits > 1 ? ` (visit ${visits} of this line in this call)` : ''}` }
    }
    case 'ret':
      if (st.i == null) {
        return { tone: 'ret', head: `${label(st.from)} returned ${shortValue(st.v, { maskWidth })}`, text: `control went back to untraced code (${model.invs.get(st.from)?.caller || 'main'}).` }
      }
      return { tone: 'ret', head: `↩ ${label(st.from)} returned ${shortValue(st.v, { maskWidth })} → ${label(st.i)} resumes`, text: `${label(st.i)} is stopped in the middle of line ${st.ln}; the rest of that line (which uses the returned value) has not run yet. Values are read right after the return.` }
    case 'unwind':
      return { tone: 'sig', head: `${label(st.from)} was unwound`, text: `its frame disappeared without a normal return (exception). ${label(st.i)} continues.` }
    case 'sig':
      return { tone: 'sig', head: `Program received ${st.sig}`, text: `at ${st.where}. The traced run stops here.` }
    case 'exit':
      return { tone: 'exit', head: `Program exited with code ${st.code}`, text: 'End of the recorded trace.' }
    default:
      return { tone: 'muted', head: st.k, text: '' }
  }
}

const TONE = {
  call: 'border-sky-400/60 bg-sky-400/10', line: 'border-amber-400/60 bg-amber-300/15', ret: 'border-rose-400/60 bg-rose-400/10',
  sig: 'border-red-500/60 bg-red-500/10', exit: 'border-emerald-500/60 bg-emerald-500/10', muted: 'border-border bg-muted/30',
}

export default function StepControls({ model, step, setStep, maskWidth }) {
  const N = model.N
  const b = stepBanner(model, step, maskWidth)
  const st = model.steps[step]
  const truncated = model.end.reason && model.end.reason !== 'exited'
  const atEnd = step >= N - 1
  return (
    <div className="app-panel space-y-2 p-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn onClick={() => setStep(0)} title="first step (Home)">⏮</Btn>
        <Btn onClick={() => setStep(model.stepBackOut(step))} title="back out: to the caller, just before this call (Shift+←)">⤒ back out</Btn>
        <Btn onClick={() => setStep(model.stepBackOver(step))} title="back over: previous step in this frame, skipping calls (↑)">↶ back over</Btn>
        <Btn onClick={() => setStep(model.stepBack(step))} title="back one step (←)">◀ back</Btn>
        <Btn primary onClick={() => setStep(model.stepInto(step))} title="step into: next recorded step (→)">step into ▶</Btn>
        <Btn primary onClick={() => setStep(model.stepOver(step))} title="step over: next step in this frame or its caller; a call's inside is skipped (↓)">step over ↷</Btn>
        <Btn primary onClick={() => setStep(model.stepOut(step))} title="step out: run until this frame returns (Shift+→)">step out ⤓</Btn>
        <Btn onClick={() => setStep(N - 1)} title="last recorded step (End)">⏭</Btn>
        <span className="mx-1 h-5 w-px bg-border" />
        <Btn onClick={() => setStep(model.nextOfKind(step, 'call', -1))} title="previous call">◀ call</Btn>
        <Btn onClick={() => setStep(model.nextOfKind(step, 'call', 1))} title="next call">call ▶</Btn>
        <Btn onClick={() => setStep(model.nextOfKind(step, 'ret', -1))} title="previous return">◀ return</Btn>
        <Btn onClick={() => setStep(model.nextOfKind(step, 'ret', 1))} title="next return">return ▶</Btn>
        <div className="ml-auto flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">step</span>
          <input type="number" min={0} max={N - 1} value={step}
            onChange={(e) => { const v = parseInt(e.target.value, 10); if (!Number.isNaN(v)) setStep(Math.max(0, Math.min(N - 1, v))) }}
            className="w-20 rounded-md border border-border bg-background px-1.5 py-0.5 font-mono" />
          <span className="font-mono text-muted-foreground">/ {N - 1}</span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono">depth {st?.d ?? 0}</span>
        </div>
      </div>
      <div className="relative">
        <DepthStrip model={model} step={step} onSeek={setStep} />
        <input type="range" min={0} max={Math.max(0, N - 1)} value={step} onChange={(e) => setStep(Number(e.target.value))}
          className="absolute inset-x-0 bottom-0 h-2 w-full cursor-pointer opacity-0" aria-label="step (drag to scrub)" />
      </div>
      <div className={`rounded-lg border px-3 py-2 ${TONE[b.tone] || TONE.muted}`}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-[11px] text-muted-foreground">step {step}</span>
          <span className="text-sm font-semibold">{b.head}</span>
        </div>
        <div className="text-[13px] text-foreground/80">{b.text}</div>
        {atEnd && truncated && (
          <div className="mt-1 rounded-md border border-amber-500/60 bg-amber-400/15 px-2 py-1 text-[13px]">
            <b>Trace stopped here ({model.end.reason}).</b> This is the last recorded step ({N - 1}); the program{' '}
            {model.end.programFinished === true ? <>kept running without tracing and <b>finished</b> (exit code {String(model.end.exitCode)})</>
              : model.end.programFinished === false ? <>did <b>not</b> finish within the time limit after the trace stopped</>
              : <>status after the stop is unknown</>}.
          </div>
        )}
      </div>
    </div>
  )
}
