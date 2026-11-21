/** Value formatting for native traces (binary / decimal / hex, chars, arrays). */
import { expandElems } from './traceModel.js'

export function toBigInt(v) {
  try {
    return BigInt(v)
  } catch {
    return null
  }
}

/** two's-complement bit pattern of an integer in `bits` bits */
export function bitPattern(v, bits) {
  let n = toBigInt(v)
  if (n === null) return null
  const B = BigInt(bits)
  if (n < 0n) n = (1n << B) + n
  return n.toString(2).padStart(Number(B), '0').slice(-Number(B))
}

export function groupBits(str) {
  if (str.length <= 8) return str
  const out = []
  for (let i = str.length; i > 0; i -= 4) out.unshift(str.slice(Math.max(0, i - 4), i))
  return out.join(' ')
}

/**
 * Binary string at the display width: masks use the mask width unless the value
 * does not fit, negative numbers use their full two's-complement width.
 */
export function binaryOf(v, desc, maskWidth) {
  const n = toBigInt(v)
  if (n === null) return String(v)
  const bits = desc?.b || 32
  if (n < 0n) return bitPattern(n, bits)
  let w = maskWidth || bits
  const need = n === 0n ? 1 : n.toString(2).length
  if (need > w) w = need
  return n.toString(2).padStart(w, '0')
}

export function setBits(v, base1 = true) {
  const n = toBigInt(v)
  if (n === null || n < 0n) return []
  const out = []
  let i = 0
  let x = n
  while (x > 0n && i < 128) {
    if (x & 1n) out.push(base1 ? i + 1 : i)
    x >>= 1n
    i++
  }
  return out
}

export function defaultIntMode(desc) {
  if (!desc) return 'dec'
  if (desc.c) return 'char'
  if (desc.t === 'b') return 'bool'
  return desc.s ? 'dec' : 'bin'
}

export function charOf(v) {
  const n = Number(v)
  if (n >= 32 && n < 127) return `'${String.fromCharCode(n)}'`
  const esc = { 0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r' }
  return esc[n] ? `'${esc[n]}'` : `'\\x${(n & 0xff).toString(16)}'`
}

export function formatInt(v, desc, mode, maskWidth) {
  if (v === undefined || v === null) return '?'
  if (desc?.t === 'b') return String(v)
  if (desc?.t === 'e') return desc.en?.[String(v)] ?? String(v)
  switch (mode) {
    case 'bin':
      return groupBits(binaryOf(v, desc, maskWidth))
    case 'hex': {
      const n = toBigInt(v)
      if (n === null) return String(v)
      return '0x' + (n < 0n ? (n + (1n << BigInt(desc?.b || 32))) : n).toString(16)
    }
    case 'char':
      return `${v} ${charOf(v)}`
    default:
      return String(v)
  }
}

/** short one-line text for any recorded value */
export function shortValue(val, opts = {}) {
  if (val === undefined) return '—'
  if (!val) return '?'
  const { maskWidth, mode } = opts
  switch (val.t) {
    case 'i':
    case 'e': {
      const m = mode || defaultIntMode(val)
      const main = formatInt(val.v, val, m, maskWidth)
      if (m === 'bin') return `${main} (${val.v})`
      return main
    }
    case 'b':
      return String(val.v)
    case 'f':
      return String(val.v)
    case 'p':
      if (val.null) return 'nullptr'
      if (val.str !== undefined) return `${val.v} "${val.str}"`
      if (val.to) return `${val.v} → ${shortValue(val.to, opts)}`
      return val.v
    case 's':
      return `{${(val.f || []).map(([k, v]) => `${k}: ${shortValue(v, opts)}`).join(', ')}}`
    case 'a': {
      const n = val.n ?? 0
      const els = val.e ? val.e : (val.r && n <= 12 ? expandElems(val) : null)
      if (els && n <= 12 && !val.trunc) {
        return `[${els.map((x) => (val.et ? elemText(x, val.et, opts) : shortValue(x, opts))).join(', ')}]`
      }
      return `${val.ty || 'array'} · size ${n}`
    }
    case 'str':
      return JSON.stringify(val.v) + (val.trunc ? '…' : '')
    case 'x':
      return val.v
    case 'void':
      return 'void'
    case 'na':
      return `‹${val.v}›`
    default:
      return JSON.stringify(val)
  }
}

export function elemText(raw, et, opts = {}) {
  if (raw === null || raw === undefined) return '?'
  if (et.t === 'b') return String(raw)
  if (et.t === 'f') return String(raw)
  if (et.t === 'e') return et.en?.[String(raw)] ?? String(raw)
  if (et.c) return charOf(raw)
  return String(raw)
}

export function isScalarInt(val) {
  return val && (val.t === 'i' || val.t === 'e')
}

/** compact label for tree nodes: true/false/number */
export function compactValue(val, opts = {}) {
  if (!val) return ''
  if (val.t === 'b') return String(val.v)
  if (val.t === 'i') return shortValue(val, { ...opts, mode: val.s ? 'dec' : (opts.mode || 'bin') })
  return shortValue(val, opts)
}

export function prettyFnName(full) {
  return full
}
