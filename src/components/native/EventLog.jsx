import React, { useEffect, useRef, useState } from 'react'
import { shortValue } from '@/lib/native/format'

const ROW = 22

export default function EventLog({ model, step, setStep, maskWidth }) {
  const ref = useRef(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(300)
  const N = model.N

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeight(el.clientHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const top = step * ROW
    if (top < el.scrollTop + ROW || top > el.scrollTop + el.clientHeight - 2 * ROW) {
      el.scrollTop = Math.max(0, top - el.clientHeight / 2)
    }
  }, [step])

  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10)
  const last = Math.min(N, Math.ceil((scrollTop + height) / ROW) + 10)
  const rows = []
  for (let s = first; s < last; s++) {
    const st = model.steps[s]
    let icon = '·'
    let text = ''
    let cls = ''
    if (st.k === 'call') { icon = '▶'; cls = 'text-sky-700 dark:text-sky-300'; text = `call ${model.invLabel(st.i)} · L${st.ln}` }
    else if (st.k === 'line') { text = `${model.invLabel(st.i)} L${st.ln}  ${model.sourceLine(model.fileOfInv(st.i), st.ln).trim()}` }
    else if (st.k === 'ret') { icon = '↩'; cls = 'text-rose-700 dark:text-rose-300'; text = `#${st.from} returned ${shortValue(st.v, { maskWidth })} → ${st.i != null ? `#${st.i} resumes L${st.ln}` : 'untraced caller'}` }
    else if (st.k === 'exit') { icon = '■'; cls = 'text-emerald-700'; text = `program exited (${st.code})` }
    else if (st.k === 'sig') { icon = '⚡'; cls = 'text-red-600'; text = `${st.sig} at ${st.where}` }
    else if (st.k === 'unwind') { icon = '⤓'; cls = 'text-red-600'; text = `#${st.from} unwound` }
    rows.push(
      <button type="button" key={s} onClick={() => setStep(s)}
        style={{ position: 'absolute', top: s * ROW, height: ROW, left: 0, right: 0, paddingLeft: 6 + Math.min(st.d || 0, 30) * 6 }}
        className={`flex items-center gap-1.5 truncate pr-2 text-left font-mono text-[11.5px] ${s === step ? 'bg-amber-300/40 font-semibold' : 'hover:bg-muted/60'} ${cls}`}>
        <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">{s}</span>
        <span className="w-3 shrink-0 text-center">{icon}</span>
        <span className="truncate">{text}</span>
      </button>,
    )
  }
  return (
    <div className="app-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-sm font-semibold">Recorded steps</span>
        <span className="text-[11px] text-muted-foreground">{N} steps · indented by stack depth</span>
      </div>
      <div ref={ref} className="relative min-h-0 flex-1 overflow-auto" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div style={{ height: N * ROW, position: 'relative' }}>{rows}</div>
      </div>
    </div>
  )
}
