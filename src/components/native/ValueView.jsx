import React, { useMemo, useState } from 'react'
import { binaryOf, charOf, defaultIntMode, elemText, formatInt, groupBits, setBits, shortValue } from '@/lib/native/format'
import { expandElems } from '@/lib/native/traceModel'

export const SHARE_COLORS = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#14b8a6', '#6366f1', '#84cc16']
export const shareColor = (cid) => SHARE_COLORS[cid % SHARE_COLORS.length]

export function resolveMode(val, override, globalMode) {
  if (!val || (val.t !== 'i' && val.t !== 'e')) return null
  if (override) return override
  if (globalMode && globalMode !== 'auto') {
    if (val.c && globalMode === 'dec') return 'char'
    return globalMode
  }
  return defaultIntMode(val)
}

const MODE_CYCLE = { bin: 'dec', dec: 'hex', hex: 'bin', char: 'dec' }
export const nextMode = (m) => MODE_CYCLE[m] || 'bin'

function IntValue({ val, mode, maskWidth, bitBase, onCycle, showBits }) {
  if (val.t === 'e') {
    return <span className="font-mono">{val.en?.[String(val.v)] ?? String(val.v)} <span className="text-muted-foreground">({val.v})</span></span>
  }
  const bin = mode === 'bin'
  const main = formatInt(val.v, val, mode, maskWidth)
  const bits = bin && showBits ? setBits(val.v, bitBase === 1) : null
  return (
    <button
      type="button"
      onClick={onCycle}
      title={`${val.ty || ''} — click to switch binary / decimal / hex`}
      className="group inline-flex items-baseline gap-1.5 rounded px-0.5 text-left font-mono hover:bg-primary/10"
    >
      <span className={bin ? 'tracking-wider text-sky-700 dark:text-sky-300' : ''}>{main}</span>
      {bin && <span className="text-[10px] text-muted-foreground">₂</span>}
      {bin && <span className="text-xs text-muted-foreground">= {String(val.v)}</span>}
      {mode === 'hex' && <span className="text-xs text-muted-foreground">= {String(val.v)}</span>}
      {mode === 'dec' && !val.s && Number(val.v) > 1 && (
        <span className="text-[11px] text-muted-foreground/70 opacity-0 group-hover:opacity-100">{binaryOf(val.v, val, maskWidth)}₂</span>
      )}
      {bits && bits.length > 0 && bits.length <= 12 && (
        <span className="rounded bg-sky-500/10 px-1 text-[10px] text-sky-700 dark:text-sky-300" title={bitBase === 1 ? 'set bits, counted from 1 at the right (bit i stands for number i)' : 'set bit indices (0 = least significant)'}>
          {bitBase === 1 ? 'bits' : 'idx'} {'{'}{bits.join(',')}{'}'}
        </span>
      )}
    </button>
  )
}

function ArrayValue({ val, focus, maskWidth, compact }) {
  const [open, setOpen] = useState(!compact && (val.n ?? 0) <= 64)
  const [binIndex, setBinIndex] = useState(true)
  const [center, setCenter] = useState(null)
  const elems = useMemo(() => expandElems(val), [val])
  const n = val.n ?? elems.length
  const scalar = !!val.et
  const width = Math.max(1, Math.ceil(Math.log2(Math.max(2, n))))
  const focusSet = new Set((focus || []).filter((x) => x != null))
  const c = center ?? (focus && focus.length ? focus[0] : 0)
  const WIN = 64
  const lo = n <= 256 ? 0 : Math.max(0, Math.min(n - WIN, c - WIN / 2))
  const hi = n <= 256 ? n : Math.min(n, lo + WIN)
  const fmtIdx = (i) => (binIndex ? i.toString(2).padStart(width, '0') : String(i))
  const inline = n <= 8 && !val.trunc
  return (
    <div className="min-w-0">
      {inline && (
        <div className="font-mono">
          [{elems.map((x, i) => (
            <span key={i}>
              {i > 0 && ', '}
              <span className={focusSet.has(i) ? 'rounded bg-amber-400/30 px-0.5 ring-1 ring-amber-500' : ''}>{scalar ? elemText(x, val.et) : shortValue(x, { maskWidth })}</span>
            </span>
          ))}]
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} className="font-mono text-left text-xs hover:underline">
        {val.ty || 'array'} <span className="text-muted-foreground">· size {n}{val.cap != null && val.cap !== n ? ` · capacity ${val.cap}` : ''}</span>
        {!inline && <span className="ml-1 text-xs text-primary">{open ? '▾ hide' : '▸ show elements'}</span>}
      </button>
      {val.trunc != null && <div className="text-[11px] text-amber-600">only the first {val.trunc} elements are recorded</div>}
      {open && !inline && (
        <div className="mt-1 rounded-md border border-border/60 bg-background/60 p-1.5">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            <span>index</span>
            <button type="button" className={`rounded px-1 ${binIndex ? 'bg-primary/15 text-primary' : ''}`} onClick={() => setBinIndex(true)}>binary</button>
            <button type="button" className={`rounded px-1 ${!binIndex ? 'bg-primary/15 text-primary' : ''}`} onClick={() => setBinIndex(false)}>decimal</button>
            {n > 256 && (
              <>
                <span>showing {lo}–{hi - 1}</span>
                <button type="button" className="rounded px-1 hover:bg-muted" onClick={() => setCenter(Math.max(0, lo - WIN / 2))}>◀</button>
                <button type="button" className="rounded px-1 hover:bg-muted" onClick={() => setCenter(Math.min(n - 1, hi + WIN / 2))}>▶</button>
                <input
                  className="w-20 rounded border border-border bg-background px-1"
                  placeholder="go to idx"
                  onKeyDown={(e) => { if (e.key === 'Enter') { const v = parseInt(e.currentTarget.value, binIndex ? 2 : 10); if (!Number.isNaN(v)) setCenter(v) } }}
                />
              </>
            )}
          </div>
          <div className="grid max-h-56 grid-cols-[repeat(auto-fill,minmax(4.6rem,1fr))] gap-1 overflow-auto">
            {elems.slice(lo, hi).map((x, k) => {
              const i = lo + k
              const hit = focusSet.has(i)
              return (
                <div key={i} className={`rounded border px-1 py-0.5 font-mono text-[11px] leading-tight ${hit ? 'border-amber-500 bg-amber-400/20 ring-1 ring-amber-500' : 'border-border/50'}`}>
                  <div className="text-[9px] text-muted-foreground">[{fmtIdx(i)}]</div>
                  <div>{scalar ? elemText(x, val.et) : shortValue(x, { maskWidth })}</div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ValueView({ val, mode, maskWidth, bitBase = 1, onCycle, focus, compact = false, showBits = true }) {
  if (val === undefined) return <span className="italic text-muted-foreground">not recorded</span>
  if (!val) return <span className="text-muted-foreground">?</span>
  switch (val.t) {
    case 'i':
    case 'e':
      return <IntValue val={val} mode={mode} maskWidth={maskWidth} bitBase={bitBase} onCycle={onCycle} showBits={showBits} />
    case 'b':
      return <span className={`font-mono font-semibold ${val.v === true ? 'text-emerald-600 dark:text-emerald-400' : val.v === false ? 'text-rose-600 dark:text-rose-400' : ''}`}>{String(val.v)}</span>
    case 'a':
      return <ArrayValue val={val} focus={focus} maskWidth={maskWidth} compact={compact} />
    case 'p':
      return <span className="font-mono">{shortValue(val, { maskWidth })}</span>
    case 's':
      return (
        <span className="font-mono">
          {'{ '}
          {(val.f || []).map(([k, v], i) => (
            <span key={k}>
              {i > 0 && ', '}
              <span className="text-muted-foreground">{k}:</span> {shortValue(v, { maskWidth })}
            </span>
          ))}
          {' }'}
        </span>
      )
    case 'str':
      return <span className="font-mono text-emerald-700 dark:text-emerald-300">{JSON.stringify(val.v)}{val.trunc ? '…' : ''}</span>
    case 'x':
      return <span className="whitespace-pre-wrap break-all font-mono text-xs">{val.v}</span>
    case 'f':
      return <span className="font-mono">{String(val.v)}</span>
    case 'void':
      return <span className="font-mono text-muted-foreground">void</span>
    case 'na':
      return <span className="italic text-muted-foreground">unavailable — {val.v}</span>
    default:
      return <span className="font-mono">{shortValue(val)}</span>
  }
}

export { binaryOf, charOf, groupBits }
