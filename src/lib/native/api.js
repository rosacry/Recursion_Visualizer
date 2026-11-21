/** Client for the local native C++ trace service (native/server.mjs, proxied at /api/native). */

const BASE = '/api/native'

async function json(res) {
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`native service returned ${res.status}: ${text.slice(0, 300)}`)
  }
  if (!res.ok) throw new Error(body.error || `native service returned ${res.status}`)
  return body
}

export async function fetchHealth(refresh = false) {
  const res = await fetch(`${BASE}/health${refresh ? '?refresh=1' : ''}`)
  return json(res)
}

export async function startRun(job) {
  const res = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(job),
  })
  return json(res)
}

export async function getJob(id) {
  return json(await fetch(`${BASE}/jobs/${id}`))
}

export async function cancelJob(id) {
  return json(await fetch(`${BASE}/jobs/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
}

/** start a run and poll until it finishes; onProgress gets the job record */
export async function runAndWait(job, { onProgress, signal } = {}) {
  const { jobId } = await startRun(job)
  let delay = 150
  for (;;) {
    if (signal?.aborted) {
      await cancelJob(jobId).catch(() => {})
      throw new DOMException('cancelled', 'AbortError')
    }
    const rec = await getJob(jobId)
    onProgress?.(rec)
    if (rec.status !== 'running') return rec
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(400, delay + 50)
  }
}
