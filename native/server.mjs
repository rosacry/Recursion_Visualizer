#!/usr/bin/env node
/**
 * Native C++20 trace service for the Recursion Visualizer.
 *
 *   node native/server.mjs [--port 5180] [--static dist]
 *
 * Listens on 127.0.0.1 only.  Each run compiles the submitted C++ with
 * g++/clang++ (-std=c++20 -g -O0), runs it directly, then runs it under GDB
 * with native/runner/rv_tracer.py and returns the recorded trace.
 * On Windows the toolchain runs inside WSL (default: the Ubuntu distro).
 *
 * No dependencies beyond Node's standard library.
 */
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(HERE, 'runner', 'rv_job.py')

const args = process.argv.slice(2)
const argValue = (name, dflt) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const PORT = Number(process.env.RV_NATIVE_PORT || argValue('--port', 5180))
const HOST = '127.0.0.1'
const STATIC_DIR = argValue('--static', null) ? path.resolve(argValue('--static')) : null
const IS_WIN = process.platform === 'win32'
const MAX_BODY = 4 * 1024 * 1024
const MAX_JOBS = 12

// ---------------------------------------------------------------------------
// Where the Linux side runs
// ---------------------------------------------------------------------------

function detectWslDistro() {
  if (process.env.RV_WSL_DISTRO) return process.env.RV_WSL_DISTRO
  const r = spawnSync('wsl.exe', ['-l', '-q'], { encoding: 'buffer', windowsHide: true })
  if (r.status !== 0 || !r.stdout) return null
  const text = r.stdout.toString('utf16le').replace(/\0/g, '')
  const names = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  return names.find((n) => /^ubuntu/i.test(n)) || names.find((n) => !/docker/i.test(n)) || null
}

const WSL_DISTRO = IS_WIN ? detectWslDistro() : null

function toWslPath(p) {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p)
  if (!m) return p.replace(/\\/g, '/')
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

function linuxCommand(argv) {
  if (!IS_WIN) return { cmd: argv[0], args: argv.slice(1) }
  const base = WSL_DISTRO ? ['-d', WSL_DISTRO] : []
  return { cmd: 'wsl.exe', args: [...base, '--exec', ...argv] }
}

function runnerArgv() {
  return ['python3', IS_WIN ? toWslPath(RUNNER) : RUNNER]
}

// Keep the WSL VM warm while this service runs (exits when our stdin closes).
let keepAlive = null
function startKeepAlive() {
  if (!IS_WIN) return
  const { cmd, args: a } = linuxCommand(['sh', '-c', 'read _ignored'])
  keepAlive = spawn(cmd, a, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
  keepAlive.on('exit', () => { keepAlive = null })
}

// ---------------------------------------------------------------------------
// Toolchain report
// ---------------------------------------------------------------------------

let healthCache = null
function probeToolchain() {
  const script = [
    'echo "os=$(. /etc/os-release 2>/dev/null; echo $PRETTY_NAME)"',
    'for c in g++-12 g++ clang++-15 clang++-14 clang++ gdb python3; do',
    '  p=$(command -v $c 2>/dev/null) && echo "tool:$c=$p|$($c --version 2>&1 | head -n1)";',
    'done',
  ].join('\n')
  const { cmd, args: a } = linuxCommand(['bash', '-c', script])
  const r = spawnSync(cmd, a, { encoding: 'utf8', windowsHide: true, timeout: 60000 })
  const tools = {}
  let os = null
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('os=')) os = line.slice(3)
    const m = /^tool:([^=]+)=([^|]*)\|(.*)$/.exec(line)
    if (m) tools[m[1]] = { path: m[2], version: m[3] }
  }
  const compilers = []
  if (tools['g++-12'] || tools['g++']) compilers.push({ id: 'g++', label: (tools['g++-12'] || tools['g++']).version })
  const clang = tools['clang++-15'] || tools['clang++-14'] || tools['clang++']
  if (clang) compilers.push({ id: 'clang++', label: clang.version })
  return {
    ok: !!(compilers.length && tools.gdb && tools.python3),
    backend: IS_WIN ? `WSL (${WSL_DISTRO || 'default distro'})` : process.platform,
    linux: os,
    compilers,
    debugger: tools.gdb ? tools.gdb.version : null,
    python: tools.python3 ? tools.python3.version : null,
    error: r.error ? String(r.error) : (r.status !== 0 ? (r.stderr || '').slice(0, 2000) : null),
    checkedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const jobs = new Map()

function pruneJobs() {
  const list = [...jobs.values()].sort((a, b) => a.created - b.created)
  while (list.length > MAX_JOBS) {
    const j = list.shift()
    if (j.status !== 'running') jobs.delete(j.id)
    else break
  }
}

function validateJob(body) {
  const files = body && body.files
  if (!files || typeof files !== 'object') return 'missing files'
  const names = Object.keys(files)
  if (!names.length || names.length > 8) return 'expected 1-8 files'
  for (const n of names) {
    if (!/^[A-Za-z0-9_.-]+$/.test(n) || n.startsWith('.')) return `bad file name ${n}`
    if (typeof files[n] !== 'string') return `file ${n} must be text`
  }
  if (body.main && !names.includes(body.main)) return 'main file is not among the files'
  return null
}

function startJob(body) {
  const id = crypto.randomBytes(6).toString('hex')
  const limits = body.limits || {}
  const job = {
    files: body.files,
    main: body.main || 'driver.cpp',
    traceFiles: Array.isArray(body.traceFiles) && body.traceFiles.length ? body.traceFiles : ['solution.cpp'],
    stdin: typeof body.stdin === 'string' ? body.stdin : '',
    compiler: body.compiler === 'clang++' ? 'clang++' : 'g++',
    std: 'c++20',
    limits: {
      maxSteps: clamp(limits.maxSteps, 100, 500000, 25000),
      traceSeconds: clamp(limits.traceSeconds, 5, 600, 90),
      runSeconds: clamp(limits.runSeconds, 1, 120, 20),
      maxDepth: clamp(limits.maxDepth, 10, 100000, 5000),
    },
  }
  const rec = {
    id, created: Date.now(), status: 'running', progress: { phase: 'starting' },
    log: [], result: null, error: null, proc: null, finished: null,
  }
  jobs.set(id, rec)
  pruneJobs()

  const { cmd, args: a } = linuxCommand(runnerArgv())
  const proc = spawn(cmd, a, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  rec.proc = proc
  const out = []
  let errBuf = ''
  proc.stdout.on('data', (d) => out.push(d))
  proc.stderr.on('data', (d) => {
    errBuf += d.toString('utf8')
    let k
    while ((k = errBuf.indexOf('\n')) >= 0) {
      const line = errBuf.slice(0, k).replace(/\r$/, '')
      errBuf = errBuf.slice(k + 1)
      if (line.startsWith('@@progress ')) {
        try { rec.progress = { ...rec.progress, ...JSON.parse(line.slice(11)) } } catch { /* ignore */ }
      } else if (line.trim()) {
        rec.log.push(line)
        if (rec.log.length > 200) rec.log.shift()
      }
    }
  })
  proc.on('error', (e) => {
    rec.status = 'error'
    rec.error = `could not start the native runner: ${e.message}`
    rec.finished = Date.now()
  })
  proc.on('close', (code) => {
    rec.proc = null
    rec.finished = Date.now()
    if (rec.status === 'cancelled') return
    const text = Buffer.concat(out).toString('utf8')
    try {
      rec.result = JSON.parse(text)
      rec.status = 'done'
    } catch {
      rec.status = 'error'
      rec.error = `native runner exited with code ${code} without a result.\n${rec.log.slice(-20).join('\n')}`
    }
  })
  proc.stdin.end(JSON.stringify(job))
  return rec
}

function clamp(v, lo, hi, d) {
  const n = Number(v)
  if (!Number.isFinite(n)) return d
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

function killJob(rec) {
  if (!rec.proc) return
  rec.status = 'cancelled'
  try { rec.proc.kill() } catch { /* ignore */ }
  if (IS_WIN) {
    // the Linux-side process tree is torn down when wsl.exe exits; make sure it does
    spawnSync('taskkill', ['/pid', String(rec.proc.pid), '/T', '/F'], { windowsHide: true })
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])

function originAllowed(req) {
  const host = req.headers.host || ''
  const origin = req.headers.origin
  const viaProxy = !ALLOWED_HOSTS.has(host)
  if (viaProxy) {
    // Vite's dev proxy forwards with the original Host (localhost:5173) unless changeOrigin
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false
  }
  if (!origin) return true // same-origin GETs, curl
  try {
    const u = new URL(origin)
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
}

function serveStatic(req, res) {
  if (!STATIC_DIR) return false
  const url = new URL(req.url, 'http://x')
  let p = path.normalize(path.join(STATIC_DIR, decodeURIComponent(url.pathname)))
  if (!p.startsWith(STATIC_DIR)) return send(res, 403, 'forbidden'), true
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(STATIC_DIR, 'index.html')
  if (!fs.existsSync(p)) return false
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
  return true
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith('/api/native')) {
      if (req.method === 'GET' && serveStatic(req, res)) return
      return send(res, 404, { error: 'not found' })
    }
    if (!originAllowed(req)) return send(res, 403, { error: 'origin not allowed' })

    if (req.method === 'GET' && url.pathname === '/api/native/health') {
      if (!healthCache || url.searchParams.get('refresh')) healthCache = probeToolchain()
      return send(res, 200, healthCache)
    }
    if (req.method === 'POST' && url.pathname === '/api/native/run') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'expected application/json' })
      }
      let body
      try { body = JSON.parse(await readBody(req)) } catch (e) { return send(res, 400, { error: String(e.message || e) }) }
      const bad = validateJob(body)
      if (bad) return send(res, 400, { error: bad })
      const rec = startJob(body)
      return send(res, 202, { jobId: rec.id })
    }
    const m = /^\/api\/native\/jobs\/([0-9a-f]+)(\/cancel)?$/.exec(url.pathname)
    if (m) {
      const rec = jobs.get(m[1])
      if (!rec) return send(res, 404, { error: 'unknown job' })
      if (m[2] && req.method === 'POST') {
        killJob(rec)
        return send(res, 200, { status: rec.status })
      }
      if (req.method === 'GET') {
        const out = { id: rec.id, status: rec.status, progress: rec.progress, error: rec.error,
          log: rec.log.slice(-40), elapsed: ((rec.finished || Date.now()) - rec.created) / 1000 }
        if (rec.status === 'done') out.result = rec.result
        return send(res, 200, out)
      }
    }
    return send(res, 404, { error: 'not found' })
  } catch (e) {
    send(res, 500, { error: String(e && e.message || e) })
  }
})

server.listen(PORT, HOST, () => {
  startKeepAlive()
  const where = IS_WIN ? `WSL distro ${WSL_DISTRO || '(default)'}` : 'this machine'
  console.log(`[native] C++20 trace service on http://${HOST}:${PORT}  (toolchain: ${where})`)
  if (STATIC_DIR) console.log(`[native] serving ${STATIC_DIR} at http://${HOST}:${PORT}/`)
  setTimeout(() => { healthCache = probeToolchain(); console.log(`[native] toolchain: ${healthCache.ok ? 'ok' : 'NOT READY'} - ${healthCache.compilers.map((c) => c.label).join(' | ')} | ${healthCache.debugger || 'no gdb'}`) }, 10)
})

function shutdown() {
  for (const rec of jobs.values()) killJob(rec)
  if (keepAlive) try { keepAlive.stdin.end(); keepAlive.kill() } catch { /* ignore */ }
  server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
