import React, { useEffect, useMemo, useRef } from 'react'

const KW = new Set(`alignas alignof auto bool break case catch char class const constexpr continue decltype default
delete do double else enum explicit extern false float for friend goto if inline int long mutable namespace new
noexcept nullptr operator private protected public return short signed sizeof static static_cast struct switch
template this throw true try typedef typename union unsigned using virtual void volatile while size_t`.split(/\s+/))

function highlight(line, inBlock) {
  const out = []
  let i = 0
  let block = inBlock
  const push = (text, cls) => out.push({ text, cls })
  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i)
      if (end < 0) { push(line.slice(i), 'c'); i = line.length; break }
      push(line.slice(i, end + 2), 'c'); i = end + 2; block = false; continue
    }
    const rest = line.slice(i)
    let m
    if (rest.startsWith('//')) { push(rest, 'c'); break }
    if (rest.startsWith('/*')) { block = true; continue }
    if ((m = /^#\s*\w+.*/.exec(rest)) && line.slice(0, i).trim() === '') { push(m[0], 'pp'); break }
    if ((m = /^"(?:\\.|[^"\\])*"?/.exec(rest)) || (m = /^'(?:\\.|[^'\\])*'?/.exec(rest))) { push(m[0], 's'); i += m[0].length; continue }
    if ((m = /^\b\d[\w.]*/.exec(rest))) { push(m[0], 'n'); i += m[0].length; continue }
    if ((m = /^[A-Za-z_]\w*/.exec(rest))) { push(m[0], KW.has(m[0]) ? 'k' : (/^std$/.test(m[0]) ? 'k' : '')); i += m[0].length; continue }
    push(line[i], ''); i++
  }
  return { tokens: out, block }
}

const CLS = {
  c: 'text-slate-400 italic', pp: 'text-fuchsia-600 dark:text-fuchsia-400', s: 'text-emerald-700 dark:text-emerald-400',
  n: 'text-orange-600 dark:text-orange-400', k: 'text-blue-700 dark:text-blue-400 font-medium', '': '',
}

export default function SourcePanel({ model, step, selectedInv, file, onFileChange, onSelectInv, errorLines }) {
  const text = model ? model.sources[file] || '' : ''
  const lines = useMemo(() => text.split('\n'), [text])
  const highlighted = useMemo(() => {
    let block = false
    return lines.map((l) => {
      const r = highlight(l, block)
      block = r.block
      return r.tokens
    })
  }, [lines])
  const scrollRef = useRef(null)

  const st = model?.steps[step]
  const curInv = st?.i ?? null
  const curFile = curInv != null ? model.fileOfInv(curInv) : null
  const curLine = st && curFile === file ? st.ln : null
  const stack = model ? model.stackAt(step) : []
  const markers = new Map() // line -> [{inv, role}]
  for (const invId of stack) {
    if (model.fileOfInv(invId) !== file) continue
    const ln = model.lineOf(invId, step)
    if (!ln) continue
    if (!markers.has(ln)) markers.set(ln, [])
    markers.get(ln).push(invId)
  }
  let retFromLine = null
  let retFrom = null
  if (st?.k === 'ret' && st.from != null && model.fileOfInv(st.from) === file) {
    retFrom = st.from
    retFromLine = model.lineOf(st.from, step - 1)
  }
  const selLine = selectedInv != null && selectedInv !== curInv && model?.fileOfInv(selectedInv) === file ? model.lineOf(selectedInv, step) : null

  useEffect(() => {
    const target = selLine || curLine
    if (!target || !scrollRef.current) return
    const el = scrollRef.current.querySelector(`[data-line="${target}"]`)
    if (el) {
      const box = scrollRef.current
      const top = el.offsetTop - box.clientHeight / 2 + 12
      box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
    }
  }, [curLine, selLine, step])

  const files = model ? Object.keys(model.sources) : []
  return (
    <div className="app-panel flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-border/60 bg-muted/30 px-2 py-1.5">
        {files.map((f) => (
          <button key={f} type="button" onClick={() => onFileChange(f)}
            className={`rounded-md px-2 py-0.5 font-mono text-xs ${f === file ? 'bg-card shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'}`}>
            {f}{model?.result?.trace?.files?.[f] ? '' : f === 'driver.cpp' ? ' (not traced)' : ''}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted-foreground">source exactly as compiled</span>
      </div>
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto py-2 font-mono text-[13px] leading-6">
        {highlighted.map((tokens, idx) => {
          const ln = idx + 1
          const isCur = ln === curLine
          const isSel = ln === selLine
          const isRet = ln === retFromLine
          const frameIds = markers.get(ln) || []
          const err = errorLines?.has(ln)
          return (
            <div key={ln} data-line={ln}
              className={`group flex min-w-max items-stretch ${isCur ? 'bg-amber-300/30 dark:bg-amber-400/20' : isSel ? 'bg-indigo-400/15' : err ? 'bg-rose-500/15' : ''}`}>
              <div className={`sticky left-0 z-[1] flex w-[5.5rem] shrink-0 items-center justify-end gap-1 border-r border-border/50 pr-2 text-right text-xs ${isCur ? 'bg-amber-200/80 dark:bg-amber-900/60' : 'bg-card/90'}`}>
                {frameIds.slice(0, 3).map((id) => (
                  <button key={id} type="button" onClick={() => onSelectInv(id)} title={`${model.invLabel(id)} is at line ${ln}`}
                    className={`rounded px-1 text-[10px] leading-4 ${id === curInv ? 'bg-amber-500 text-white' : id === selectedInv ? 'bg-indigo-500 text-white' : 'bg-muted text-muted-foreground'}`}>
                    #{id}
                  </button>
                ))}
                {frameIds.length > 3 && <span className="text-[10px] text-muted-foreground">+{frameIds.length - 3}</span>}
                <span className={isCur ? 'font-bold text-amber-700 dark:text-amber-300' : 'text-muted-foreground/70'}>{ln}</span>
              </div>
              <div className={`w-4 shrink-0 text-center ${isCur ? 'text-amber-600' : 'text-transparent'}`}>{isCur ? (st.k === 'ret' ? '↩' : '▶') : ''}</div>
              <code className="whitespace-pre pr-6">
                {tokens.length ? tokens.map((t, k) => <span key={k} className={CLS[t.cls]}>{t.text}</span>) : ' '}
              </code>
              {isRet && (
                <span className="ml-2 self-center rounded bg-rose-500/15 px-1.5 text-[11px] text-rose-700 dark:text-rose-300">↩ #{retFrom} returned from here</span>
              )}
              {isCur && st.k === 'ret' && (
                <span className="ml-2 self-center rounded bg-amber-500/20 px-1.5 text-[11px] text-amber-800 dark:text-amber-200">#{curInv} resumes mid-line</span>
              )}
              {isSel && !isCur && (
                <span className="ml-2 self-center rounded bg-indigo-500/15 px-1.5 text-[11px] text-indigo-700 dark:text-indigo-300">#{selectedInv} paused here</span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
