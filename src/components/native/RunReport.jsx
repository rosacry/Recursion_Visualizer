import React from 'react'
import { shortValue } from '@/lib/native/format'

function Out({ title, text, trunc }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</div>
      <pre className="mt-0.5 max-h-40 overflow-auto rounded-md border border-border/60 bg-background/70 p-2 font-mono text-xs">{text === '' ? '(empty)' : text}{trunc ? '\n…(truncated)' : ''}</pre>
    </div>
  )
}

function exitText(r) {
  if (!r) return '—'
  if (r.timedOut) return `timed out after ${r.seconds}s`
  if (r.signal) return `killed by ${r.signal}`
  return `exit ${r.exitCode}`
}

export function compareRuns(result, model) {
  const direct = result?.direct
  const traced = result?.traced
  if (!direct || !traced) return null
  const same = direct.stdout === traced.stdout && (direct.exitCode ?? null) === (model?.end?.exitCode ?? direct.exitCode)
  return { same, direct: direct.stdout, traced: traced.stdout }
}

export default function RunReport({ result, model }) {
  if (!result) return null
  const tc = result.toolchain || {}
  const comp = result.compile || {}
  const end = model?.end || result.trace?.end || {}
  const cmp = compareRuns(result, model)
  const rootRet = model ? [...model.invs.values()].filter((i) => i.parent == null) : []
  return (
    <div className="app-panel space-y-3 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Run report</span>
        {cmp && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${cmp.same ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-rose-500/15 text-rose-700'}`}>
            {cmp.same ? '✓ traced run printed the same output as the direct native run' : '✗ traced output differs from the direct run'}
          </span>
        )}
        <span className="ml-auto text-xs text-muted-foreground">total {result.seconds}s</span>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1 text-xs">
          <div><span className="text-muted-foreground">compiler:</span> <span className="font-mono">{tc.compilerVersion}</span></div>
          <div><span className="text-muted-foreground">debugger:</span> <span className="font-mono">{tc.gdbVersion}</span> <span className="text-muted-foreground">(GDB Python API: line breakpoints + FinishBreakpoint)</span></div>
          <div><span className="text-muted-foreground">platform:</span> <span className="font-mono">{tc.platform}</span></div>
          <div className="break-all"><span className="text-muted-foreground">compile ({comp.seconds}s):</span> <span className="font-mono">{comp.command}</span></div>
        </div>
        <div className="space-y-1 text-xs">
          <div>
            <span className="text-muted-foreground">trace:</span>{' '}
            {model ? <>{model.N} steps · {model.invs.size} invocations · max depth {model.maxDepth} · {model.stats.seconds}s under GDB</> : 'not available'}
          </div>
          <div>
            <span className="text-muted-foreground">ended because:</span>{' '}
            <b>{end.reason === 'exited' ? 'the program exited' : end.reason || '—'}</b>
            {end.reason && end.reason !== 'exited' && (
              <> at step {end.truncatedAtStep} (limit {model?.limits?.maxSteps} steps) — program afterwards:{' '}
                <b>{end.programFinished === true ? `finished, exit ${end.exitCode}` : end.programFinished === false ? 'did not finish in time' : 'unknown'}</b></>
            )}
            {end.signal && <> · signal <b>{end.signal}</b> at {end.signalWhere}</>}
          </div>
          {rootRet.map((inv) => (
            <div key={inv.id}>
              <span className="text-muted-foreground">#{inv.id} {model.fns[inv.fn]?.short} (called from {inv.caller || 'main'}):</span>{' '}
              {inv.v ? <b className="font-mono">returned {shortValue(inv.v)}</b> : <i>{inv.status}</i>}
              {inv.ret == null && inv.v ? <span className="text-muted-foreground"> (captured after the trace stopped)</span> : null}
            </div>
          ))}
          {end.internalErrors && <div className="text-rose-600">tracer notes: {end.internalErrors.join('; ')}</div>}
        </div>
      </div>
      {comp.stderr && (
        <Out title="compiler messages" text={comp.stderr} />
      )}
      <div className="grid gap-3 md:grid-cols-2">
        <Out title={`direct native run (no debugger) · ${exitText(result.direct)} · ${result.direct?.seconds}s`} text={result.direct?.stdout ?? ''} trunc={result.direct?.stdoutTruncated} />
        <Out title={`traced run under GDB · exit ${end.exitCode ?? '—'}`} text={result.traced?.stdout ?? ''} trunc={result.traced?.stdoutTruncated} />
      </div>
      {(result.direct?.stderr || result.traced?.stderr) && (
        <div className="grid gap-3 md:grid-cols-2">
          <Out title="direct run stderr" text={result.direct?.stderr || ''} />
          <Out title="traced run stderr" text={result.traced?.stderr || ''} />
        </div>
      )}
    </div>
  )
}
