import React, { useRef } from 'react'

/** Plain textarea editor with line numbers (keeps the text byte-for-byte). */
export function CodeArea({ value, onChange, errorLines, placeholder, minRows = 18 }) {
  const taRef = useRef(null)
  const gutterRef = useRef(null)
  const lines = value.split('\n').length
  const onKeyDown = (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const ta = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = ta
      const next = value.slice(0, a) + '    ' + value.slice(b)
      onChange(next)
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = a + 4 })
    }
  }
  return (
    <div className="flex max-h-[520px] min-h-[200px] overflow-hidden rounded-lg border border-border/70 bg-background/80 font-mono text-[13px] leading-6">
      <div ref={gutterRef} className="select-none overflow-hidden border-r border-border/60 bg-muted/30 py-2 pl-2 pr-2 text-right text-xs leading-6 text-muted-foreground/70">
        {Array.from({ length: Math.max(lines, minRows) }, (_, i) => (
          <div key={i} className={errorLines?.has(i + 1) ? 'font-bold text-rose-600' : ''}>{i + 1}</div>
        ))}
      </div>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(e) => { if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop }}
        spellCheck={false}
        placeholder={placeholder}
        wrap="off"
        rows={Math.max(lines, minRows)}
        className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-3 py-2 outline-none"
      />
    </div>
  )
}

export function looksLikeNotCpp(text) {
  if (/^\s*def\s+\w+\s*\(.*\)\s*:/m.test(text) && !/[{};]/.test(text)) return 'This looks like Python. Native mode compiles C++20.'
  if (/\bpublic\s+static\s+void\s+main\s*\(\s*String/.test(text) || /\bSystem\.out\.println\b/.test(text)) return 'This looks like Java. Native mode compiles C++20.'
  return null
}
