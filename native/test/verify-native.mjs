#!/usr/bin/env node
/**
 * npm run native:verify
 *
 * End-to-end check of the native C++20 path: compiles and traces the reference
 * programs through the local service (starting it if needed), then checks the
 * recorded trace with the same TraceModel the browser uses.
 *
 *   - Can I Win (4, 9): the five moments from the reference walkthrough
 *   - Can I Win (18, 79): trace limit handling, program still finishes, outputs match
 *   - Combination Sum: a second recursive C++20 program (vectors shared by reference)
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { TraceModel } from '../../src/lib/native/traceModel.js'
import { binaryOf, defaultIntMode } from '../../src/lib/native/format.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = Number(process.env.RV_NATIVE_PORT || 5180)
const BASE = `http://127.0.0.1:${PORT}/api/native`
const HEADERS = { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' }

let failures = 0
let checks = 0
function check(label, ok, detail = '') {
  checks++
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
}

async function serviceUp() {
  try {
    const r = await fetch(`${BASE}/health`)
    return r.ok
  } catch {
    return false
  }
}

async function ensureService() {
  if (await serviceUp()) return null
  console.log('starting native/server.mjs …')
  const p = spawn(process.execPath, [path.join(ROOT, 'native', 'server.mjs')], { stdio: 'ignore' })
  for (let k = 0; k < 120; k++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await serviceUp()) return p
  }
  throw new Error('native service did not start')
}

function example(name) {
  const dir = path.join(ROOT, 'native', 'examples', name)
  return {
    'solution.cpp': fs.readFileSync(path.join(dir, 'solution.cpp'), 'utf8'),
    'driver.cpp': fs.readFileSync(path.join(dir, 'driver.cpp'), 'utf8'),
  }
}

async function run(files, stdin, maxSteps = 25000, compiler = 'g++') {
  const r = await fetch(`${BASE}/run`, {
    method: 'POST', headers: HEADERS,
    body: JSON.stringify({ files, main: 'driver.cpp', traceFiles: ['solution.cpp'], stdin, compiler, limits: { maxSteps } }),
  })
  const { jobId, error } = await r.json()
  if (!jobId) throw new Error(error || 'no job id')
  for (;;) {
    const j = await (await fetch(`${BASE}/jobs/${jobId}`)).json()
    if (j.status !== 'running') {
      if (j.status !== 'done') throw new Error(j.error || j.status)
      return j.result
    }
    await new Promise((res) => setTimeout(res, 250))
  }
}

const num = (v) => (v && v.v !== undefined ? Number(v.v) : NaN)
function vars(model, inv, s) {
  const out = {}
  for (const v of model.frameVars(inv, s)) out[v.meta.n] = v
  return out
}
const val = (model, inv, s, name) => {
  const v = vars(model, inv, s)[name]
  return v && v.status === 'ok' ? num(v.value) : undefined
}
const ownSteps = (model, inv) => model.invStepIdx.get(inv) || []

async function canIWin49() {
  console.log('\nCan I Win — canIWin(4, 9)')
  const files = example('can-i-win')
  const res = await run(files, '4 9\n')
  check('compiled with -std=c++20 -g -O0', res.compile?.ok && /-std=c\+\+20/.test(res.compile.command) && / -O0 /.test(res.compile.command), res.compile?.command)
  check('direct native run prints false', res.direct?.stdout === 'false\n', JSON.stringify(res.direct?.stdout))
  check('traced run prints the same output', res.traced?.stdout === res.direct?.stdout, JSON.stringify(res.traced?.stdout))
  const m = new TraceModel(res, files)
  check('program exited normally inside the trace', m.end.reason === 'exited' && m.end.exitCode === 0, JSON.stringify(m.end))
  const canIWin = [...m.invs.values()].find((i) => m.fns[i.fn].short === 'canIWin')
  const root = [...m.invs.values()].find((i) => m.fns[i.fn].short === 'backtrack' && i.parent === canIWin.id)
  check('visualized result: canIWin returned false', canIWin.v?.t === 'b' && canIWin.v.v === false, JSON.stringify(canIWin.v))
  const child = m.invs.get(root.children[0])

  // 1. Player 1 tries 4: the root's last step before the recursive call
  const before = child.call - 1
  const st1 = m.steps[before]
  check('row 1: step before the call belongs to the root', st1.i === root.id && st1.k === 'line', `step ${before} k=${st1.k} inv=${st1.i} line ${st1.ln}`)
  const r1 = { remainder: val(m, root.id, before, 'remainder'), pick: val(m, root.id, before, 'pick'), p1: val(m, root.id, before, 'p1'), savedP1: val(m, root.id, before, 'savedP1'), candidates: val(m, root.id, before, 'candidates') }
  check('row 1: remainder=9 pick=4 p1=1000 savedP1=0000 candidates=0111',
    r1.remainder === 9 && r1.pick === 4 && r1.p1 === 8 && r1.savedP1 === 0 && r1.candidates === 7, JSON.stringify(r1))
  check('row 1: binary rendering at mask width 4', m.maskWidth === 4 && binaryOf(8, { b: 32 }, 4) === '1000' && binaryOf(7, { b: 32 }, 4) === '0111', `maskWidth=${m.maskWidth}`)

  // 2. Player 2's call begins; the waiting root keeps its own values
  const c = child.call
  check('row 2: call step starts a new invocation of backtrack', m.steps[c].k === 'call' && m.steps[c].i === child.id && child.id !== root.id, `#${child.id}`)
  check('row 2: child playerSwitch=1 remainder=5', val(m, child.id, c, 'playerSwitch') === 1 && val(m, child.id, c, 'remainder') === 5)
  check('row 2: waiting root shows playerSwitch=0 remainder=9', val(m, root.id, c, 'playerSwitch') === 0 && val(m, root.id, c, 'remainder') === 9)
  check('row 2: root is on the stack, waiting', m.stackAt(c)[1] === root.id)

  // 3. Player 2's call returns false; the same root resumes before restoration
  const r = child.ret
  const st3 = m.steps[r]
  check('row 3: return step resumes the same root', st3.k === 'ret' && st3.i === root.id && st3.from === child.id, `step ${r}`)
  check('row 3: returned value is false', st3.v?.t === 'b' && st3.v.v === false, JSON.stringify(st3.v))
  check('row 3: before restoration p1=1000 p2=0001', val(m, root.id, r, 'p1') === 8 && val(m, root.id, r, 'p2') === 1)
  check('row 3: step over from the call line lands on this return', m.stepOver(before) === r, `stepOver(${before}) = ${m.stepOver(before)}`)

  // 4. the root restores the masks
  const after = ownSteps(m, root.id).filter((s) => s > r)
  const s60 = after.find((s) => m.steps[s].ln === 60)
  const s61 = after.find((s) => m.steps[s].ln === 61)
  const s39 = after.find((s) => s > s61 && m.steps[s].ln === 39)
  check('row 4: at "p1 = savedP1;" (before it runs) p1=1000 p2=0001', val(m, root.id, s60, 'p1') === 8 && val(m, root.id, s60, 'p2') === 1, `step ${s60}`)
  check('row 4: after it, p1=0000 while p2 is still 0001', val(m, root.id, s61, 'p1') === 0 && val(m, root.id, s61, 'p2') === 1, `step ${s61}`)
  check('row 4: after "p2 = savedP2;", p2=0000 and candidates still 0111', val(m, root.id, s39, 'p2') === 0 && val(m, root.id, s39, 'candidates') === 7, `step ${s39}`)
  check('row 4: step over walks 60 → 61 → 39', m.stepOver(s60) === s61 && m.stepOver(s61) === s39)

  // 5. the same root tries its next choice
  const s41 = ownSteps(m, root.id).find((s) => s > s39 && m.steps[s].ln === 41)
  const s42 = ownSteps(m, root.id).find((s) => s > s39 && m.steps[s].ln === 42)
  check('row 5: same invocation selects position=0100', m.steps[s41].i === root.id && val(m, root.id, s41, 'position') === 4, `step ${s41}`)
  check('row 5: pick=3', val(m, root.id, s42, 'pick') === 3, `step ${s42}`)
  check('row 5: position shown in binary, pick in decimal', defaultIntMode(vars(m, root.id, s42).position.value) === 'bin' && defaultIntMode(vars(m, root.id, s42).pick.value) === 'dec')
  // backward replay through the restorations and the return
  let b = s42
  const back = []
  while (b > r) { b = m.stepBackOver(b); back.push(b) }
  check('row 5: back over replays …→ 61 → 60 → … → the return', back.includes(s61) && back.includes(s60) && back[back.length - 1] === r, back.join(' ← '))
  check('row 5: stepping back shows recorded shared values (p2=0001 at line 61)', val(m, root.id, s61, 'p2') === 1 && val(m, root.id, r, 'p1') === 8)

  // shared vs local
  const sh = m.sharingAt(c)
  const p1Child = vars(m, child.id, c).p1
  const p1Root = vars(m, root.id, c).p1
  const saved = vars(m, root.id, c).savedP1
  check('p1 is one shared object (reference) across frames', p1Child.cellId === p1Root.cellId && (sh.get(p1Child.cellId) || []).length >= 3)
  check('savedP1 is the root\'s own copy', saved.cellId !== p1Root.cellId && !saved.meta.ref)
  const acc = m.steps.find((s) => s.i === child.id && s.acc)?.acc?.[0]
  check('memo access recorded with index and value', acc && acc.e === 'memo[available]' && acc.ix?.[0] === 7 && Number(acc.v?.v) === -1, JSON.stringify(acc))
  check('source line numbers are the pasted file’s', m.sourceLine('solution.cpp', 48).includes('if (backtrack(maxChoosableInteger, p1, p2,'))
}

async function canIWin1879() {
  console.log('\nCan I Win — canIWin(18, 79)')
  const files = example('can-i-win')
  const res = await run(files, '18 79\n', 25000)
  const m = new TraceModel(res, files)
  check('direct native run prints true', res.direct?.stdout === 'true\n', JSON.stringify(res.direct?.stdout))
  check('traced run prints the same output', res.traced?.stdout === res.direct?.stdout)
  check('trace stopped at the step limit and says so', m.end.reason === 'step-limit' && m.end.truncatedAtStep === 25000, JSON.stringify({ reason: m.end.reason, at: m.end.truncatedAtStep }))
  check('program finished after the trace stopped', m.end.programFinished === true && m.end.exitCode === 0)
  const root = [...m.invs.values()].find((i) => i.parent == null)
  check('root canIWin return value captured after the stop: true', root.v?.v === true, JSON.stringify(root.v))
  console.log(`        ${m.N} steps, ${m.invs.size} invocations, ${m.stats.seconds}s under GDB, runner ${res.seconds}s`)
}

async function combinationSum() {
  console.log('\nCombination Sum — a second recursive C++20 program')
  const files = example('combination-sum')
  const res = await run(files, '[2,3,6,7]\n7\n')
  const m = new TraceModel(res, files)
  check('direct run prints [[2,2,3],[7]]', res.direct?.stdout === '[[2,2,3],[7]]\n', JSON.stringify(res.direct?.stdout))
  check('traced run prints the same output', res.traced?.stdout === res.direct?.stdout)
  const dfs = [...m.invs.values()].filter((i) => m.fns[i.fn].short === 'dfs')
  check('recursion recorded (several dfs invocations)', dfs.length >= 5, `${dfs.length} dfs calls`)
  const deep = dfs.find((i) => i.depth >= 3)
  const s = deep.call
  const pDeep = vars(m, deep.id, s).path
  const pParent = vars(m, deep.parent, s).path
  check('path is shared by reference between frames', pDeep.cellId === pParent.cellId)
  const sizes = new Set(m.cellSteps.get(pDeep.cellId).map((_, k) => m._materialize(pDeep.cellId, k)?.n))
  check('path grows and shrinks (push_back / pop_back recorded)', sizes.size >= 3, [...sizes].join(','))
}

const child = await ensureService()
try {
  await canIWin49()
  await canIWin1879()
  await combinationSum()
} catch (e) {
  failures++
  console.error('\nERROR', e)
} finally {
  if (child) child.kill()
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ''}`)
process.exit(failures ? 1 : 0)
