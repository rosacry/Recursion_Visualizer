import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { compactValue } from '@/lib/native/format'

const NODE_W = 188
const NODE_H = 44
const GAP_X = 14
const LEVEL_H = 78

/** stable tidy layout of the whole recorded tree (positions never move while stepping) */
function layout(model) {
  const pos = new Map()
  let nextX = 0
  let maxDepth = 0
  for (const root of model.roots) {
    const stack = [[root, 0, false]]
    while (stack.length) {
      const [id, depth, done] = stack.pop()
      const inv = model.invs.get(id)
      if (!inv) continue
      if (depth > maxDepth) maxDepth = depth
      if (!inv.children.length) {
        pos.set(id, { x: nextX++, y: depth })
        continue
      }
      if (!done) {
        stack.push([id, depth, true])
        for (let k = inv.children.length - 1; k >= 0; k--) stack.push([inv.children[k], depth + 1, false])
      } else {
        const xs = inv.children.map((c) => pos.get(c)?.x ?? 0)
        pos.set(id, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: depth })
      }
    }
    nextX += 0.5
  }
  return { pos, width: Math.max(1, nextX), depth: maxDepth }
}

/** per function: argument names whose values differ between calls (shown on nodes) */
function varyingArgs(model) {
  const byFn = new Map()
  for (const inv of model.invs.values()) {
    const args = model.argsAtCall(inv.id).filter((v) => !v.meta.ref && v.value && ['i', 'b', 'e', 'f', 'str'].includes(v.value.t))
    if (!byFn.has(inv.fn)) byFn.set(inv.fn, new Map())
    const m = byFn.get(inv.fn)
    for (const a of args) {
      if (!m.has(a.meta.n)) m.set(a.meta.n, new Set())
      m.get(a.meta.n).add(JSON.stringify(a.value.v))
    }
  }
  const out = new Map()
  for (const [fn, m] of byFn) out.set(fn, [...m.entries()].filter(([, set]) => set.size > 1).map(([n]) => n))
  return out
}

const Node = memo(function Node({ x, y, id, title, sub, status, retText, retKind, selected, onClick, onDouble }) {
  const styles = {
    current: { fill: '#fde68a', stroke: '#d97706', sw: 2.5 },
    resumes: { fill: '#fde68a', stroke: '#b45309', sw: 3 },
    waiting: { fill: '#e0e7ff', stroke: '#6366f1', sw: 2 },
    returned: { fill: '#f1f5f9', stroke: '#94a3b8', sw: 1 },
    justReturned: { fill: '#ffe4e6', stroke: '#e11d48', sw: 2.5 },
    unwound: { fill: '#fee2e2', stroke: '#ef4444', sw: 1.5, dash: '4 3' },
    incomplete: { fill: '#fff7ed', stroke: '#f59e0b', sw: 1.5, dash: '4 3' },
  }[status] || { fill: '#fff', stroke: '#94a3b8', sw: 1 }
  return (
    <g transform={`translate(${x},${y})`} onClick={onClick} onDoubleClick={onDouble} style={{ cursor: 'pointer' }}>
      {selected && <rect x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8} rx={11} fill="none" stroke="#4f46e5" strokeWidth={2} strokeDasharray="5 3" />}
      <rect width={NODE_W} height={NODE_H} rx={8} fill={styles.fill} stroke={styles.stroke} strokeWidth={styles.sw} strokeDasharray={styles.dash} />
      <text x={8} y={17} fontSize={12} fontFamily="JetBrains Mono, monospace" fontWeight={700} fill="#0f172a">{title}</text>
      <text x={8} y={34} fontSize={10} fontFamily="JetBrains Mono, monospace" fill="#475569">{sub}</text>
      {retText != null && (
        <g transform={`translate(${NODE_W - 4},${-8})`}>
          <rect x={-Math.max(30, retText.length * 6.6 + 12)} width={Math.max(30, retText.length * 6.6 + 12)} height={17} rx={8}
            fill={retKind === 'true' ? '#059669' : retKind === 'false' ? '#e11d48' : '#334155'} />
          <text x={-6} y={12.5} fontSize={10.5} textAnchor="end" fontFamily="JetBrains Mono, monospace" fill="#fff" fontWeight={700}>{retText}</text>
        </g>
      )}
    </g>
  )
})

export default function CallTreePanel({ model, step, selectedInv, onSelectInv, onJump, maskWidth }) {
  const { pos, width, depth } = useMemo(() => layout(model), [model])
  const vary = useMemo(() => varyingArgs(model), [model])
  const argCache = useMemo(() => new Map(), [model])
  const [zoom, setZoom] = useState(1)
  const [follow, setFollow] = useState(true)
  const boxRef = useRef(null)
  const st = model.steps[step]
  const stack = model.stackAt(step)
  const onStack = new Set(stack)
  const cur = st?.i ?? null
  const justReturned = st?.k === 'ret' || st?.k === 'unwind' ? st.from : null
  const W = width * (NODE_W + GAP_X) + 40
  const H = (depth + 1) * LEVEL_H + 40
  const px = (id) => 20 + pos.get(id).x * (NODE_W + GAP_X)
  const py = (id) => 24 + pos.get(id).y * LEVEL_H

  const visible = []
  for (const inv of model.invs.values()) if (inv.call != null && inv.call <= step && pos.has(inv.id)) visible.push(inv)
  const count = visible.length

  useEffect(() => {
    if (!follow || cur == null || !boxRef.current || !pos.has(cur)) return
    const box = boxRef.current
    const cx = (px(cur) + NODE_W / 2) * zoom
    const cy = (py(cur) + NODE_H / 2) * zoom
    const left = cx - box.clientWidth / 2
    const top = cy - box.clientHeight / 2
    if (Math.abs(box.scrollLeft - left) > box.clientWidth * 0.3 || Math.abs(box.scrollTop - top) > box.clientHeight * 0.3) {
      box.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: 'smooth' })
    }
  }, [cur, step, follow, zoom]) // eslint-disable-line react-hooks/exhaustive-deps

  const subOf = (inv) => {
    if (argCache.has(inv.id)) return argCache.get(inv.id)
    const names = vary.get(inv.fn) || []
    const args = model.argsAtCall(inv.id)
    const parts = names.map((n) => {
      const a = args.find((v) => v.meta.n === n)
      return a ? `${n}=${compactValue(a.value, { maskWidth })}` : null
    }).filter(Boolean)
    let s = parts.join(' ')
    if (s.length > 30) s = s.slice(0, 29) + '…'
    argCache.set(inv.id, s)
    return s
  }

  return (
    <div className="app-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-1.5">
        <span className="text-sm font-semibold">Call tree</span>
        <span className="text-[11px] text-muted-foreground">{count} of {model.invs.size} invocations started · every node is one invocation (#id)</span>
        <div className="ml-auto flex items-center gap-2 text-[11px]">
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-amber-600 bg-amber-200" />active</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-indigo-500 bg-indigo-100" />waiting</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm border-2 border-rose-600 bg-rose-100" />just returned</span>
          <label className="flex items-center gap-1"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />follow</label>
          <button type="button" className="rounded border border-border px-1.5" onClick={() => setZoom((z) => Math.max(0.3, z - 0.15))}>−</button>
          <span className="w-9 text-center">{Math.round(zoom * 100)}%</span>
          <button type="button" className="rounded border border-border px-1.5" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}>+</button>
        </div>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1 overflow-auto bg-[radial-gradient(circle,_rgba(148,163,184,0.25)_1px,_transparent_1px)] [background-size:18px_18px]">
        <svg width={W * zoom} height={H * zoom} viewBox={`0 0 ${W} ${H}`}>
          {visible.map((inv) => {
            if (inv.parent == null || !pos.has(inv.parent)) return null
            const active = onStack.has(inv.id) && onStack.has(inv.parent)
            const ret = inv.id === justReturned
            const x1 = px(inv.parent) + NODE_W / 2
            const y1 = py(inv.parent) + NODE_H
            const x2 = px(inv.id) + NODE_W / 2
            const y2 = py(inv.id)
            const my = (y1 + y2) / 2
            return (
              <g key={`e${inv.id}`}>
                <path d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} fill="none"
                  stroke={ret ? '#e11d48' : active ? '#6366f1' : '#cbd5e1'} strokeWidth={ret || active ? 2.5 : 1.2}
                  markerEnd={ret ? undefined : undefined} />
                {ret && st.k === 'ret' && (
                  <g transform={`translate(${(x1 + x2) / 2},${my})`}>
                    <rect x={-44} y={-10} width={88} height={20} rx={10} fill="#fff" stroke="#e11d48" />
                    <text y={4} textAnchor="middle" fontSize={11} fontFamily="JetBrains Mono, monospace" fill="#be123c" fontWeight={700}>↑ {compactValue(st.v, { maskWidth })}</text>
                  </g>
                )}
              </g>
            )
          })}
          {visible.map((inv) => {
            let status = 'returned'
            if (inv.id === justReturned) status = st.k === 'unwind' ? 'unwound' : 'justReturned'
            else if (inv.id === cur) status = st.k === 'ret' ? 'resumes' : 'current'
            else if (onStack.has(inv.id)) status = 'waiting'
            else if (inv.ret == null || inv.ret > step) status = inv.status === 'unwound' ? 'unwound' : 'incomplete'
            else if (inv.status === 'unwound') status = 'unwound'
            const returned = inv.ret != null && inv.ret <= step && inv.status !== 'unwound'
            const rv = returned ? compactValue(inv.v, { maskWidth }) : null
            const kind = returned && inv.v?.t === 'b' ? String(inv.v.v) : 'other'
            return (
              <Node key={inv.id} id={inv.id} x={px(inv.id)} y={py(inv.id)}
                title={`#${inv.id} ${model.fns[inv.fn]?.short}`} sub={subOf(inv)} status={status}
                retText={rv} retKind={kind} selected={inv.id === selectedInv}
                onClick={() => onSelectInv(inv.id)} onDouble={() => onJump(inv.call)} />
            )
          })}
        </svg>
      </div>
      <div className="border-t border-border/50 px-3 py-1 text-[11px] text-muted-foreground">
        click a node to inspect that invocation · double-click to jump to its call · badge = value it returned
      </div>
    </div>
  )
}
