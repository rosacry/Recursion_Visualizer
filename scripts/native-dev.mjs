#!/usr/bin/env node
/**
 * npm run native  →  starts the native C++20 trace service (127.0.0.1:5180)
 *                    and the Vite UI (http://localhost:5173) together.
 * Ctrl+C stops both.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const procs = []

function start(name, args, color) {
  const p = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const tag = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (d) => {
      buf += d.toString()
      let k
      while ((k = buf.indexOf('\n')) >= 0) {
        out.write(tag + buf.slice(0, k) + '\n')
        buf = buf.slice(k + 1)
      }
    })
  }
  pipe(p.stdout, process.stdout)
  pipe(p.stderr, process.stderr)
  p.on('exit', (code) => {
    process.stdout.write(`${tag}exited with code ${code}\n`)
    shutdown(code ?? 0)
  })
  procs.push(p)
  return p
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) {
    try { p.kill() } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 300)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

start('native', [path.join('native', 'server.mjs')], '36')
start('ui', [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--port', '5173', '--strictPort'], '35')
console.log('\n  Recursion Visualizer (Native C++20):  http://localhost:5173/\n')
