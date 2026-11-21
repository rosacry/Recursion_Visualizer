import React from 'react'
import { shortValue } from '@/lib/native/format'
import { shareColor } from './ValueView'

function VarChip({ v, model, step, modeOf, maskWidth, sharing }) {
  const share = v.cellId != null ? sharing.get(v.cellId) : null
  const shared = share && share.length > 1
  let text
  if (v.status === 'uninit') text = 'not initialized yet'
  else if (v.na) text = `‹${v.na}›`
  else if (v.value && v.value.t === 'a') text = v.value.n <= 8 && !v.value.trunc ? shortValue(v.value, { maskWidth }) : `size ${v.value.n}`
  else text = shortValue(v.value, { maskWidth, mode: modeOf(v.meta, v.value) })
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 ${v.changedHere ? 'border-amber-500 bg-amber-300/25' : 'border-border/60 bg-background/60'}`}
      title={`${v.meta.ty} ${v.meta.n}${v.meta.ref ? ' (reference)' : ''}${shared ? ' — shared object' : ''}`}>
      {shared && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: shareColor(v.cellId) }} />}
      <span className="font-mono text-muted-foreground">{v.meta.n}{v.meta.ref ? '&' : ''}</span>
      <span className={`truncate font-mono ${v.status === 'uninit' ? 'italic text-muted-foreground' : ''}`}>{text}</span>
    </span>
  )
}

export default function StackPanel({ model, step, selectedInv, onSelectInv, modeOf, maskWidth }) {
  const [showAll, setShowAll] = React.useState(false)
  if (!model) return null
  const st = model.steps[step]
  const fullStack = model.stackAt(step)
  const LIMIT = 40
  const hidden = !showAll && fullStack.length > LIMIT + 3 ? fullStack.length - LIMIT - 3 : 0
  const stack = hidden ? [...fullStack.slice(0, LIMIT), ...fullStack.slice(-3)] : fullStack
  const cur = st?.i ?? null
  const sharing = model.sharingAt(step)
  const ghost = st?.k === 'ret' || st?.k === 'unwind' ? st.from : null
  return (
    <div className="app-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-sm font-semibold">Active call stack</span>
        <span className="text-[11px] text-muted-foreground">newest first · click a frame to inspect it</span>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2">
        {ghost != null && (
          <div className="rounded-lg border border-dashed border-rose-400/70 bg-rose-500/5 px-2.5 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-rose-700 dark:text-rose-300">#{ghost} {model.fnOf(ghost)?.short}</span>
              <span className="text-muted-foreground">{st.k === 'ret' ? 'just returned' : 'was unwound'}</span>
              {st.k === 'ret' && (
                <span className="rounded bg-card px-1.5 py-0.5 font-mono font-semibold ring-1 ring-border">→ {shortValue(st.v, { maskWidth })}</span>
              )}
            </div>
            {st.k === 'ret' && cur != null && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                its frame is gone · control goes back to <b>#{cur}</b> (below), which resumes mid-line {st.ln}
                {st.via ? ` (via ${st.via})` : ''}
              </div>
            )}
            {st.k === 'ret' && cur == null && (
              <div className="mt-0.5 text-[11px] text-muted-foreground">returned to untraced code ({model.invs.get(ghost)?.caller || 'main'})</div>
            )}
          </div>
        )}
        {stack.length === 0 && ghost == null && (
          <div className="p-3 text-sm text-muted-foreground">No traced frame is active at this step{st?.k === 'exit' ? ' — the program has exited.' : '.'}</div>
        )}
        {stack.map((invId, idx) => {
          const fn = model.fnOf(invId)
          const isCur = invId === cur
          const isSel = invId === selectedInv
          const resumes = isCur && st?.k === 'ret'
          const fullIdx = fullStack.indexOf(invId)
          const child = fullIdx > 0 ? fullStack[fullIdx - 1] : null
          if (hidden && idx === LIMIT) {
            return (
              <React.Fragment key={`gap-${invId}`}>
                <button type="button" onClick={() => setShowAll(true)} className="w-full rounded-md border border-dashed border-border py-1 text-xs text-muted-foreground hover:bg-muted">
                  … {hidden} more waiting frames (click to show all)
                </button>
                {renderFrame(invId, fn, isCur, isSel, resumes, child)}
              </React.Fragment>
            )
          }
          return renderFrame(invId, fn, isCur, isSel, resumes, child)
        })}
        {stack.length > 0 && (
          <div className="px-1 text-[11px] text-muted-foreground">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-500 align-middle" /> coloured dot = the same object in memory, reachable from several frames (C++ reference)
          </div>
        )}
      </div>
    </div>
  )

  function renderFrame(invId, fn, isCur, isSel, resumes, child) {
          const ln = model.lineOf(invId, step)
          const vars = model.frameVars(invId, step).filter((v) => v.status === 'ok' || v.status === 'uninit')
          const expanded = isCur || isSel || fullStack.length <= 4
          const inv = model.invs.get(invId)
          return (
            <button type="button" key={invId} onClick={() => onSelectInv(invId)}
              className={`block w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
                isCur ? 'border-amber-500 bg-amber-300/15 shadow-sm' : isSel ? 'border-indigo-500 bg-indigo-400/10' : 'border-border/60 bg-card/60 hover:border-primary/50'
              } ${isSel ? 'ring-2 ring-indigo-500/60' : ''}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-sm font-semibold">#{invId} {fn?.short}</span>
                {resumes && <span className="rounded bg-amber-500 px-1.5 text-[10px] font-bold uppercase tracking-wide text-white">resumes</span>}
                {isCur && !resumes && <span className="rounded bg-amber-500/90 px-1.5 text-[10px] font-bold uppercase tracking-wide text-white">active</span>}
                {!isCur && <span className="rounded bg-muted px-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">waiting</span>}
                {isSel && <span className="rounded bg-indigo-500 px-1.5 text-[10px] font-bold uppercase tracking-wide text-white">inspecting</span>}
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">line {ln ?? '?'}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {isCur
                  ? (resumes ? `#${st.from} just returned into this frame; the rest of line ${ln} has not run` : `about to execute line ${ln}`)
                  : `paused mid-line ${ln}, waiting for #${child} to return`}
                {inv?.parent == null && inv?.caller ? ` · called from ${inv.caller}` : ''}
              </div>
              {expanded ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {vars.map((v) => (
                    <VarChip key={v.vi} v={v} model={model} step={step} modeOf={modeOf} maskWidth={maskWidth} sharing={sharing} />
                  ))}
                </div>
              ) : (
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {vars.filter((v) => v.meta.k === 'arg' && !v.meta.ref).map((v) => `${v.meta.n}=${shortValue(v.value, { maskWidth, mode: modeOf(v.meta, v.value) })}`).join('  ')}
                </div>
              )}
            </button>
          )
  }
}
