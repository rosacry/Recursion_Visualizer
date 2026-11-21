import React from 'react'
import { shortValue } from '@/lib/native/format'
import { expandElems } from '@/lib/native/traceModel'
import ValueView, { nextMode, shareColor } from './ValueView'

const KIND_LABEL = { arg: 'param', local: 'local', static: 'static', member: 'member', global: 'global' }

function StatusNote({ v }) {
  if (v.status === 'uninit') return <span className="italic text-muted-foreground">not initialized yet — declared on line {v.meta.l}</span>
  if (v.status === 'oos') return <span className="italic text-muted-foreground">out of scope here (its block is not active at this line)</span>
  if (v.status === 'notyet') return <span className="italic text-muted-foreground/70">not in scope yet</span>
  return null
}

function VarRow({ v, model, step, modeOf, setVarMode, maskWidth, bitBase, sharing, focusFor, invId }) {
  const share = v.cellId != null ? sharing.get(v.cellId) || [] : []
  const others = share.filter((o) => !(o.inv === invId && o.name === v.meta.n))
  const owner = v.meta.ref && v.cellId != null ? model.cellOwner(v.cellId) : null
  const prev = v.changedHere && v.cellId != null ? model.cellValue(v.cellId, step - 1) : undefined
  const mode = modeOf(v.meta, v.value)
  const showValue = v.status === 'ok' || v.status === 'uninit'
  return (
    <tr className={`border-t border-border/40 align-top ${v.changedHere ? 'bg-amber-300/20' : ''} ${v.status === 'oos' || v.status === 'notyet' ? 'opacity-60' : ''}`}>
      <td className="whitespace-nowrap py-1 pl-2 pr-2">
        <div className="flex items-center gap-1.5">
          {others.length > 0 && <span className="h-2.5 w-2.5 rounded-full" style={{ background: shareColor(v.cellId) }} title="shared object" />}
          <span className="font-mono text-[13px] font-semibold">{v.meta.n}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">{KIND_LABEL[v.meta.k] || v.meta.k}</span>
          <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{v.meta.ty}</span>
        </div>
      </td>
      <td className="py-1 pr-2 text-[13px]">
        {v.na ? <span className="italic text-muted-foreground">unavailable — {v.na}</span>
          : v.status === 'uninit' ? <StatusNote v={v} />
          : showValue ? (
            <ValueView val={v.value} mode={mode} maskWidth={maskWidth} bitBase={bitBase}
              onCycle={() => setVarMode(v.meta.n, nextMode(mode))} focus={focusFor(v)} compact />
          ) : <StatusNote v={v} />}
        {prev !== undefined && v.status === 'ok' && (
          <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">
            changed by the previous step · was {shortValue(prev, { maskWidth, mode })}
          </div>
        )}
      </td>
      <td className="py-1 pr-2 text-[11px] leading-snug text-muted-foreground">
        {v.meta.ref && owner && (
          <div>
            reference to {owner.inv != null ? <b>#{owner.inv} {model.fnOf(owner.inv)?.short}·{owner.name}</b> : owner.global ? <b>global {owner.name}</b> : <b>an object outside the traced code ({owner.addr})</b>}
          </div>
        )}
        {!v.meta.ref && v.meta.k !== 'member' && v.meta.k !== 'global' && (v.status === 'ok' || v.status === 'uninit') && (
          <div>own copy in this frame</div>
        )}
        {v.meta.k === 'member' && <div>member of *this (one object for all calls)</div>}
        {others.length > 0 && (
          <div>
            same object as {others.slice(0, 4).map((o) => `#${o.inv}·${o.name}`).join(', ')}{others.length > 4 ? ` +${others.length - 4}` : ''}
          </div>
        )}
      </td>
    </tr>
  )
}

function Section({ title, rows, ...rest }) {
  if (!rows.length) return null
  return (
    <>
      <tr><td colSpan={3} className="bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</td></tr>
      {rows.map((v) => <VarRow key={`${v.meta.k}:${v.vi}`} v={v} {...rest} />)}
    </>
  )
}

function AccessList({ model, viewStep, invId, maskWidth, isCurrent, step }) {
  const st = model.steps[viewStep]
  const acc = st?.acc
  if (!acc || !acc.length) return null
  const next = isCurrent ? model.lastOwnStep(invId, model.N - 1) : null
  const nextOwn = (() => {
    const arr = model.invStepIdx.get(invId) || []
    for (const s of arr) if (s > viewStep) return s
    return null
  })()
  return (
    <div className="border-b border-border/50 bg-sky-500/5 px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        element accesses on line {st.ln} (read from memory {isCurrent ? 'before the line runs' : 'when this frame reached the line'})
      </div>
      {acc.map((a, k) => {
        let after = null
        if (nextOwn != null && a.b != null && a.ix && a.ix.length === 1 && a.v && a.v.t !== 'a') {
          const b = model.bindings[a.b]
          const cid = b ? model.bindingCell(b, nextOwn) : null
          const arr = cid != null ? model.cellValue(cid, nextOwn) : null
          if (arr && arr.t === 'a' && arr.et) {
            const el = expandElems(arr)[a.ix[0]]
            if (el !== undefined && String(el) !== String(a.v.v)) after = el
          }
        }
        const w = Math.max(maskWidth || 1, 1)
        return (
          <div key={k} className="mt-0.5 flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
            <span className="font-semibold">{a.e}</span>
            {a.ix && (
              <span className="text-muted-foreground">
                → index {a.ix.map((i) => (i >= 0 ? `${i.toString(2).padStart(w, '0')}₂ = ${i}` : String(i))).join(', ')}
              </span>
            )}
            {a.oob != null && <span className="text-rose-600">out of range (size {a.oob})</span>}
            {a.v && <span>value <b>{shortValue(a.v, { maskWidth })}</b></span>}
            {after !== null && <span className="text-amber-700 dark:text-amber-300">→ {String(after)} after this line runs</span>}
            {a.na && <span className="italic text-muted-foreground">{a.na}</span>}
          </div>
        )
      })}
    </div>
  )
}

export default function FrameInspector({ model, step, invId, follow, onFollow, onJump, modeOf, setVarMode, maskWidth, bitBase }) {
  if (!model) return null
  const st = model.steps[step]
  const inv = invId != null ? model.invs.get(invId) : null
  if (!inv) {
    return (
      <div className="app-panel flex h-full flex-col items-center justify-center p-4 text-sm text-muted-foreground">
        No traced frame at this step.
        {model.globalBindings.length > 0 && <div className="mt-2">Globals are listed when a frame is active.</div>}
      </div>
    )
  }
  const fn = model.fnOf(invId)
  const live = model.isLive(invId, step)
  let viewStep = step
  let note = null
  if (!live) {
    if (inv.call != null && inv.call > step) {
      note = <>Not called yet at this step — it starts at step {inv.call}. <button className="text-primary underline" onClick={() => onJump(inv.call)}>Go there</button></>
      viewStep = null
    } else if (inv.ret != null && inv.ret <= step) {
      viewStep = model.lastOwnStep(invId, inv.ret - 1)
      note = <>Returned <b className="font-mono">{shortValue(inv.v, { maskWidth })}</b> at step {inv.ret}. Showing its frame at its last step ({viewStep}). <button className="text-primary underline" onClick={() => onJump(inv.ret)}>Go to its return</button></>
    } else {
      viewStep = model.lastOwnStep(invId, step)
      note = <>This frame is not on the stack at this step (status: {inv.status}).</>
    }
  }
  const isCurrent = live && st?.i === invId
  const vars = viewStep != null ? model.frameVars(invId, viewStep) : []
  const sharing = viewStep != null ? model.sharingAt(viewStep) : new Map()
  const ln = viewStep != null ? model.lineOf(invId, viewStep) : null
  const childOnStack = live && !isCurrent ? model.stackAt(step)[model.stackAt(step).indexOf(invId) - 1] : null

  // what changed in this frame's view while it was not running
  let changedWhile = null
  if (live) {
    let from = null
    let label = ''
    if (isCurrent && st.k === 'ret' && st.from != null) {
      const child = model.invs.get(st.from)
      from = (child?.call ?? step) - 1
      label = `while #${st.from} ran (steps ${from + 1}–${step})`
    } else if (!isCurrent) {
      from = model.lastOwnStep(invId, step)
      label = `since this frame paused at step ${from}`
    }
    if (from != null && from < step) {
      const cells = model.changedBetween(from, step)
      const rows = vars.filter((v) => v.cellId != null && cells.has(v.cellId) && (v.status === 'ok'))
      changedWhile = { label, from, rows }
    }
  }
  const focusFor = (v) => {
    const acc = (viewStep != null && model.steps[viewStep]?.i === invId ? model.steps[viewStep].acc : null) || []
    const out = []
    for (const a of acc) if (a.b != null && v.binding && a.b === v.binding.id && a.ix) out.push(a.ix[0])
    return out
  }
  const rowProps = { model, step: viewStep ?? step, modeOf, setVarMode, maskWidth, bitBase, sharing, focusFor, invId }
  const groups = {
    arg: vars.filter((v) => v.meta.k === 'arg'),
    local: vars.filter((v) => v.meta.k === 'local' || v.meta.k === 'static'),
    member: vars.filter((v) => v.meta.k === 'member'),
  }
  const globals = viewStep != null ? model.globalVars(viewStep) : []
  return (
    <div className="app-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">Frame</span>
          <span className="font-mono text-sm font-bold">#{invId} {fn?.short}</span>
          {isCurrent && <span className="rounded bg-amber-500 px-1.5 text-[10px] font-bold uppercase text-white">{st.k === 'ret' ? 'resumes' : 'active'}</span>}
          {live && !isCurrent && <span className="rounded bg-indigo-500 px-1.5 text-[10px] font-bold uppercase text-white">waiting on #{childOnStack}</span>}
          {!live && <span className="rounded bg-muted px-1.5 text-[10px] font-bold uppercase text-muted-foreground">{inv.status}</span>}
          <span className="ml-auto flex items-center gap-1 text-[11px]">
            <label className="flex cursor-pointer items-center gap-1 text-muted-foreground">
              <input type="checkbox" checked={follow} onChange={(e) => onFollow(e.target.checked)} /> follow active frame
            </label>
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground" title={fn?.name}>{fn?.name}</div>
        {ln != null && (
          <div className="truncate font-mono text-[11px]">
            <span className="text-muted-foreground">line {ln}:</span> {model.sourceLine(fn.file, ln).trim()}
          </div>
        )}
      </div>
      {note && <div className="border-b border-border/50 bg-muted/40 px-3 py-1.5 text-xs">{note}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {viewStep != null && <AccessList model={model} viewStep={model.lastOwnStep(invId, viewStep)} invId={invId} maskWidth={maskWidth} isCurrent={isCurrent && st.k !== 'ret'} step={step} />}
        {changedWhile && (
          <div className="border-b border-border/50 bg-violet-500/5 px-2 py-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">changed in this frame's view {changedWhile.label}</div>
            {changedWhile.rows.length === 0 && <div className="text-xs text-muted-foreground">nothing this frame can see changed</div>}
            {changedWhile.rows.map((v) => {
              const before = model.cellValue(v.cellId, changedWhile.from)
              const mode = modeOf(v.meta, v.value)
              const who = v.meta.ref || v.meta.k === 'member' ? <span className="text-[11px] text-muted-foreground">(shared — changed while this frame was not running)</span> : null
              const beforeText = shortValue(before, { maskWidth, mode })
              const afterText = shortValue(v.value, { maskWidth, mode })
              const big = v.value && v.value.t === 'a' && before && before.t === 'a' && v.value.et && Math.max(before.n ?? 0, v.value.n ?? 0) > 12
              if (big) {
                const a = expandElems(before)
                const b = expandElems(v.value)
                const diffs = []
                for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 12; i++) if (String(a[i]) !== String(b[i])) diffs.push(i)
                const pow2 = b.length >= 4 && (b.length & (b.length - 1)) === 0
                const w = Math.max(1, Math.round(Math.log2(Math.max(2, b.length))))
                return (
                  <div key={v.vi} className="flex flex-wrap items-baseline gap-x-2 font-mono text-[13px]">
                    <span className="h-2 w-2 rounded-full" style={{ background: shareColor(v.cellId) }} />
                    <b>{v.meta.n}</b>
                    {a.length !== b.length && <span>size {a.length} → {b.length}</span>}
                    {diffs.length === 0 && a.length === b.length && <span className="text-muted-foreground">changed during the call, then restored (same contents now)</span>}
                    {diffs.map((i) => (
                      <span key={i}>[{pow2 ? `${i.toString(2).padStart(w, '0')}₂=${i}` : i}] {a[i] === undefined ? '—' : String(a[i])}→<b className="text-violet-700 dark:text-violet-300">{b[i] === undefined ? '—' : String(b[i])}</b></span>
                    ))}
                    {who}
                  </div>
                )
              }
              return (
                <div key={v.vi} className="flex flex-wrap items-baseline gap-2 font-mono text-[13px]">
                  <span className="h-2 w-2 rounded-full" style={{ background: shareColor(v.cellId) }} />
                  <b>{v.meta.n}</b>
                  {beforeText === afterText ? (
                    <span className="text-muted-foreground">changed during the call, then restored to {afterText}</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground">{beforeText}</span>→
                      <span className="font-semibold text-violet-700 dark:text-violet-300">{afterText}</span>
                    </>
                  )}
                  {who}
                </div>
              )
            })}
          </div>
        )}
        <table className="w-full text-left">
          <tbody>
            <Section title="parameters" rows={groups.arg} {...rowProps} />
            <Section title="locals" rows={groups.local} {...rowProps} />
            <Section title="members of *this" rows={groups.member} {...rowProps} />
            <Section title="globals in the traced file" rows={globals} {...rowProps} />
          </tbody>
        </table>
      </div>
    </div>
  )
}
