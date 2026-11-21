/**
 * traceModel.js — replays a native trace recorded by native/runner/rv_tracer.py.
 *
 * Nothing here executes or interprets the user's C++.  Every value comes from
 * the recorded deltas; this module only answers "what did memory hold at step s".
 *
 * Step kinds:  call | line | ret | unwind | sig | exit
 *   - call/line: the program is ABOUT TO EXECUTE `ln` in invocation `i`;
 *                values are the state before that line runs.
 *   - ret:       invocation `from` returned value `v`; invocation `i` (the
 *                caller) is stopped in the middle of line `ln`.
 */

function lastLE(arr, s) {
  // index of the last element <= s in a sorted array, or -1
  let lo = 0
  let hi = arr.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] <= s) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

export function expandElems(v) {
  if (!v) return []
  if (Array.isArray(v.e)) return v.e
  if (Array.isArray(v.r)) {
    const out = []
    for (const [val, cnt] of v.r) for (let k = 0; k < cnt; k++) out.push(val)
    return out
  }
  return []
}

export class TraceModel {
  constructor(result, sources) {
    const t = result.trace
    this.result = result
    this.sources = sources || {}
    this.steps = t.steps || []
    this.N = this.steps.length
    this.fns = t.functions || []
    this.globalsMeta = t.globals || []
    this.end = t.end || {}
    this.lateReturns = t.lateReturns || []
    this.limits = t.limits || {}
    this.stats = t.stats || {}
    this.cells = t.cells || []
    this.scopes = (t.scopes || []).map((arr) => new Map(arr))

    this.invs = new Map()
    for (const inv of t.invocations || []) this.invs.set(inv.id, { ...inv, children: [] })
    for (const inv of this.invs.values()) {
      if (inv.parent != null && this.invs.has(inv.parent)) this.invs.get(inv.parent).children.push(inv.id)
    }
    for (const inv of this.invs.values()) inv.children.sort((a, b) => a - b)
    this.roots = [...this.invs.values()].filter((i) => i.parent == null).map((i) => i.id)

    this.bindings = t.bindings || []
    this.bindingsByInv = new Map()
    this.globalBindings = []
    for (const b of this.bindings) {
      if (b.inv == null) this.globalBindings.push(b)
      else {
        if (!this.bindingsByInv.has(b.inv)) this.bindingsByInv.set(b.inv, new Map())
        this.bindingsByInv.get(b.inv).set(b.v, b)
      }
    }

    // per-cell delta timelines, per-binding rebinding timelines, per-invocation steps
    this.cellSteps = new Map()
    this.cellVals = new Map()
    this.rbSteps = new Map()
    this.rbCells = new Map()
    this.invStepIdx = new Map()
    this.invScopeIdx = new Map()
    this.callSteps = []
    this.retSteps = []
    let maxDepth = 0
    for (let s = 0; s < this.N; s++) {
      const st = this.steps[s]
      if (st.ch) {
        for (const [cid, v] of st.ch) {
          if (!this.cellSteps.has(cid)) {
            this.cellSteps.set(cid, [])
            this.cellVals.set(cid, [])
          }
          this.cellSteps.get(cid).push(s)
          this.cellVals.get(cid).push(v)
        }
      }
      if (st.rb) {
        for (const [bid, cid] of st.rb) {
          if (!this.rbSteps.has(bid)) {
            this.rbSteps.set(bid, [])
            this.rbCells.set(bid, [])
          }
          this.rbSteps.get(bid).push(s)
          this.rbCells.get(bid).push(cid)
        }
      }
      if (st.i != null) {
        if (!this.invStepIdx.has(st.i)) this.invStepIdx.set(st.i, [])
        this.invStepIdx.get(st.i).push(s)
        if (st.sc != null) {
          if (!this.invScopeIdx.has(st.i)) this.invScopeIdx.set(st.i, [])
          this.invScopeIdx.get(st.i).push(s)
        }
      }
      if (st.k === 'call') this.callSteps.push(s)
      if (st.k === 'ret') this.retSteps.push(s)
      if (st.d > maxDepth) maxDepth = st.d
    }
    this.maxDepth = maxDepth
    this._valCache = new Map()
    this._shareCache = new Map()
    this.maskWidth = this.computeMaskWidth()
  }

  // ------------------------------------------------------------------ basics

  fnOf(invId) {
    const inv = this.invs.get(invId)
    return inv ? this.fns[inv.fn] : null
  }

  invLabel(invId) {
    const fn = this.fnOf(invId)
    return fn ? `#${invId} ${fn.short}` : `#${invId}`
  }

  /** live invocations at step s, newest first */
  stackAt(s) {
    const st = this.steps[s]
    const out = []
    let cur = st ? st.i : null
    let guard = 0
    while (cur != null && guard++ < 100000) {
      out.push(cur)
      cur = this.invs.get(cur)?.parent ?? null
    }
    return out
  }

  isLive(invId, s) {
    const inv = this.invs.get(invId)
    if (!inv || inv.call == null || inv.call > s) return false
    if (inv.ret != null && inv.ret <= s) return false
    return this.stackAt(s).includes(invId)
  }

  /** index into the invocation's own steps of its latest step <= s */
  _ownStep(invId, s) {
    const arr = this.invStepIdx.get(invId)
    if (!arr) return -1
    const k = lastLE(arr, s)
    return k < 0 ? -1 : arr[k]
  }

  lineOf(invId, s) {
    const k = this._ownStep(invId, s)
    return k < 0 ? null : this.steps[k].ln
  }

  lastOwnStep(invId, s) {
    return this._ownStep(invId, s)
  }

  scopeOf(invId, s) {
    const arr = this.invScopeIdx.get(invId)
    if (!arr) return null
    const k = lastLE(arr, s)
    return k < 0 ? null : this.scopes[this.steps[arr[k]].sc]
  }

  bindingCell(b, s) {
    if (b.inv == null) return b.c
    const steps = this.rbSteps.get(b.id)
    if (!steps) return b.c
    const k = lastLE(steps, s)
    return k < 0 ? null : this.rbCells.get(b.id)[k]
  }

  /** value of a cell at step s (reconstructed from deltas) */
  cellValue(cid, s) {
    if (cid == null) return undefined
    const steps = this.cellSteps.get(cid)
    if (!steps) return undefined
    const k = lastLE(steps, s)
    if (k < 0) return undefined
    return this._materialize(cid, k)
  }

  /** step index at which the cell last changed, at or before s */
  cellChangedAt(cid, s) {
    const steps = this.cellSteps.get(cid)
    if (!steps) return -1
    const k = lastLE(steps, s)
    return k < 0 ? -1 : steps[k]
  }

  _materialize(cid, k) {
    const vals = this.cellVals.get(cid)
    const v = vals[k]
    if (!v || v.t !== 'patch') return v
    const key = `${cid}:${k}`
    if (this._valCache.has(key)) return this._valCache.get(key)
    // nearest earlier full value or cached materialization, then apply the patches once
    let j = k - 1
    let base = null
    while (j >= 0) {
      const ck = `${cid}:${j}`
      if (this._valCache.has(ck)) { base = this._valCache.get(ck); break }
      if (vals[j] && vals[j].t !== 'patch') { base = vals[j]; break }
      j--
    }
    if (!base) return undefined
    const elems = expandElems(base).slice()
    let n = base.n
    let cap = base.cap
    for (let m = j + 1; m <= k; m++) {
      const p = vals[m]
      for (const [i, val] of p.set || []) elems[i] = val
      if (p.n != null) n = p.n
      if (p.cap != null) cap = p.cap
    }
    if (elems.length > n) elems.length = n
    const out = { ...base, n, e: elems }
    if (cap != null) out.cap = cap
    delete out.r
    if (this._valCache.size > 48) this._valCache.delete(this._valCache.keys().next().value)
    this._valCache.set(key, out)
    return out
  }

  // --------------------------------------------------------------- frames

  /**
   * Variables of an invocation at step s.
   * status: 'ok' | 'uninit' | 'oos' (out of scope) | 'notyet' (block never entered yet)
   */
  frameVars(invId, s) {
    const fn = this.fnOf(invId)
    if (!fn) return []
    const scope = this.scopeOf(invId, s)
    const binds = this.bindingsByInv.get(invId) || new Map()
    const out = []
    fn.vars.forEach((meta, vi) => {
      if (meta.n === 'this' || meta.n.startsWith('__')) return // compiler-internal (this, __closure, __in_chrg)
      const b = binds.get(vi)
      const bound = b && b.since <= s ? b : null
      let status
      if (scope && scope.has(vi)) status = scope.get(vi) === 0 ? 'ok' : 'uninit'
      else status = bound ? 'oos' : 'notyet'
      const cellId = bound ? this.bindingCell(bound, s) : null
      out.push({
        vi, meta, status, binding: bound, cellId,
        na: bound ? bound.na : null,
        value: cellId != null ? this.cellValue(cellId, s) : undefined,
        changedHere: cellId != null && this.cellChangedAt(cellId, s) === s && s > 0,
      })
    })
    return out
  }

  globalVars(s) {
    return this.globalBindings.map((b) => ({
      vi: b.v, meta: this.globalsMeta[b.v] || { n: '?', ty: '?' }, status: 'ok', binding: b, cellId: b.c,
      value: this.cellValue(b.c, s), changedHere: this.cellChangedAt(b.c, s) === s && s > 0,
    }))
  }

  /** cell -> [{inv, name, ref}] for all variables in scope in live frames at step s */
  sharingAt(s) {
    if (this._shareCache.has(s)) return this._shareCache.get(s)
    const map = new Map()
    for (const invId of this.stackAt(s)) {
      for (const v of this.frameVars(invId, s)) {
        if (v.cellId == null || v.status === 'oos' || v.status === 'notyet') continue
        if (!map.has(v.cellId)) map.set(v.cellId, [])
        map.get(v.cellId).push({ inv: invId, name: v.meta.n, ref: v.meta.ref, kind: v.meta.k })
      }
    }
    if (this._shareCache.size > 32) this._shareCache.delete(this._shareCache.keys().next().value)
    this._shareCache.set(s, map)
    return map
  }

  /** where a cell lives: the binding that stores it by value (not a reference) */
  cellOwner(cid) {
    for (const b of this.bindings) {
      if (b.c !== cid) continue
      if (b.inv == null) return { global: true, name: this.globalsMeta[b.v]?.n }
      const fn = this.fnOf(b.inv)
      const meta = fn?.vars[b.v]
      if (meta && !meta.ref) return { inv: b.inv, name: meta.n }
    }
    // a reference to something outside the traced code (e.g. a local of main)
    const c = this.cells[cid]
    return { external: true, addr: c?.addr }
  }

  /** cells changed between steps a (exclusive) and b (inclusive) */
  changedBetween(a, b) {
    const set = new Set()
    for (let s = Math.max(0, a + 1); s <= b && s < this.N; s++) {
      for (const [cid] of this.steps[s].ch || []) set.add(cid)
    }
    return set
  }

  /** by-value scalar parameters at the invocation's call step (for tree labels) */
  argsAtCall(invId) {
    const inv = this.invs.get(invId)
    const fn = this.fnOf(invId)
    if (!inv || !fn || inv.call == null) return []
    const binds = this.bindingsByInv.get(invId) || new Map()
    const out = []
    fn.vars.forEach((meta, vi) => {
      if (meta.k !== 'arg' || meta.ref || meta.n === 'this') return
      const b = binds.get(vi)
      if (!b) return
      const cid = this.bindingCell(b, inv.call)
      const steps = cid != null ? this.cellSteps.get(cid) : null
      if (!steps) return
      const k = lastLE(steps, inv.call)
      const value = k < 0 ? undefined : this.cellVals.get(cid)[k]
      if (value && value.t !== 'patch' && value.t !== 'a') out.push({ vi, meta, value })
    })
    return out
  }

  // ------------------------------------------------------------ navigation

  clamp(s) {
    return Math.max(0, Math.min(this.N - 1, s))
  }

  stepInto(s) {
    return this.clamp(s + 1)
  }

  stepBack(s) {
    return this.clamp(s - 1)
  }

  depth(s) {
    return this.steps[s]?.d ?? 0
  }

  /** next step in this frame or an older one (skips the inside of calls) */
  stepOver(s) {
    const d = this.depth(s)
    for (let t = s + 1; t < this.N; t++) if (this.depth(t) <= d) return t
    return this.N - 1
  }

  stepBackOver(s) {
    const d = this.depth(s)
    for (let t = s - 1; t >= 0; t--) if (this.depth(t) <= d) return t
    return 0
  }

  /** the step at which the current frame returns to its caller */
  stepOut(s) {
    const d = this.depth(s)
    for (let t = s + 1; t < this.N; t++) if (this.depth(t) < d) return t
    return this.N - 1
  }

  /** the caller's step just before the current frame was called */
  stepBackOut(s) {
    const d = this.depth(s)
    for (let t = s - 1; t >= 0; t--) if (this.depth(t) < d) return t
    return 0
  }

  nextOfKind(s, kind, dir = 1) {
    for (let t = s + dir; t >= 0 && t < this.N; t += dir) if (this.steps[t].k === kind) return t
    return s
  }

  // ------------------------------------------------------------- display

  /** bit width for binary display: widest unsigned value seen in scope */
  computeMaskWidth() {
    let maxBits = 0
    const bindCells = new Map()
    for (const b of this.bindings) {
      const add = (cid) => {
        if (cid == null) return
        if (!bindCells.has(cid)) bindCells.set(cid, [])
        bindCells.get(cid).push(b)
      }
      add(b.c)
      for (const c of this.rbCells.get(b.id) || []) add(c)
    }
    const curScope = new Map()
    for (let s = 0; s < this.N; s++) {
      const st = this.steps[s]
      if (st.i != null && st.sc != null) curScope.set(st.i, this.scopes[st.sc])
      for (const [cid, v] of st.ch || []) {
        if (!v || v.t !== 'i' || v.s || v.c) continue
        const n = Number(v.v)
        if (!(n >= 0) || n > 2 ** 40) continue
        const ok = (bindCells.get(cid) || []).some((b) => {
          if (b.inv == null) return true
          const inv = this.invs.get(b.inv)
          // only frames alive at this step: sibling calls reuse the same stack slots
          if (!inv || inv.call == null || inv.call > s || (inv.ret != null && inv.ret <= s)) return false
          const sc = curScope.get(b.inv)
          return sc && sc.get(b.v) === 0 && this.bindingCell(b, s) === cid
        })
        if (!ok) continue
        const bits = n === 0 ? 1 : Math.floor(Math.log2(n)) + 1
        if (bits > maxBits) maxBits = bits
      }
    }
    return Math.max(1, Math.min(64, maxBits || 8))
  }

  /** source text of a line in a traced file */
  sourceLine(file, ln) {
    const text = this.sources[file]
    if (!text || !ln) return ''
    return text.split('\n')[ln - 1] ?? ''
  }

  fileOfInv(invId) {
    return this.fnOf(invId)?.file || 'solution.cpp'
  }
}
