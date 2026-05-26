import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// pullModel talks to Ollama over its native HTTP API via the global `fetch`
// (through fetchWithTimeout). We stub `fetch` so each test scripts the
// `/api/version` probe and a sequence of per-attempt `/api/pull` streams.

const encoder = new TextEncoder()

// Build a fake streaming Response from a list of NDJSON frame objects. If
// `rejectAt` is set, the reader throws on that read index (simulating a dropped
// connection mid-stream — undici surfaces this as `TypeError: terminated`).
function makeStreamResponse(frames, { rejectAt } = {}) {
  const lines = frames.map((f) => encoder.encode(`${JSON.stringify(f)}\n`))
  let i = 0
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          read: async () => {
            if (rejectAt != null && i === rejectAt) { i++; throw new Error('terminated') }
            if (i >= lines.length) return { value: undefined, done: true }
            return { value: lines[i++], done: false }
          },
          releaseLock() {}
        }
      }
    }
  }
}

const versionResponse = () => ({ ok: true, status: 200, json: async () => ({ version: '0.24.0' }) })

// Install a fetch stub that answers /api/version and dispenses one scripted
// /api/pull response per call from the given queue.
function stubFetch(pullResponses) {
  const queue = [...pullResponses]
  const pullUrls = []
  const fn = vi.fn(async (url) => {
    if (String(url).endsWith('/api/version')) return versionResponse()
    if (String(url).endsWith('/api/pull')) {
      pullUrls.push(url)
      const next = queue.shift()
      if (!next) throw new Error('pull called more times than scripted')
      // A queued Error simulates fetch itself rejecting (request-level failure,
      // e.g. undici `TypeError: fetch failed` with the real reason in .cause).
      if (next instanceof Error) throw next
      return next
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fn)
  return { fn, pullUrls }
}

// Fresh module per test → fresh availability cache so the version probe runs.
async function loadPullModel() {
  vi.resetModules()
  const mod = await import('./ollamaManager.js')
  return mod.pullModel
}

describe('ollamaManager.pullModel transient-error retry', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  // Drive a pull to completion while advancing the backoff timers.
  async function runPull(pullModel, id) {
    const onProgress = vi.fn()
    const promise = pullModel(id, onProgress)
    await vi.runAllTimersAsync()
    return { result: await promise, onProgress }
  }

  it('retries a mid-stream {"error":"EOF"} frame and succeeds on a later attempt', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ status: 'pulling manifest' }, { status: 'downloading', total: 100, completed: 40 }, { error: 'EOF' }]),
      makeStreamResponse([{ status: 'downloading', total: 100, completed: 100 }, { status: 'success' }])
    ])

    const { result } = await runPull(pullModel, 'smollm:135m')

    expect(result).toEqual({ success: true, modelId: 'smollm:135m' })
    expect(pullUrls).toHaveLength(2) // one retry
  })

  it('retries a dropped-connection read rejection (undici "terminated")', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ status: 'downloading', total: 100, completed: 10 }], { rejectAt: 1 }),
      makeStreamResponse([{ status: 'success' }])
    ])

    const { result } = await runPull(pullModel, 'qwen2.5:0.5b')

    expect(result.success).toBe(true)
    expect(pullUrls).toHaveLength(2)
  })

  it('retries a request-level "fetch failed" whose real reason lives in err.cause (ECONNRESET)', async () => {
    const pullModel = await loadPullModel()
    // undici surfaces a dropped connection as `TypeError: fetch failed` with the
    // actual ECONNRESET buried in `.cause` — the classifier must see the cause.
    const fetchFailed = new TypeError('fetch failed')
    fetchFailed.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    const { pullUrls } = stubFetch([
      fetchFailed,
      makeStreamResponse([{ status: 'success' }])
    ])

    const { result } = await runPull(pullModel, 'smollm:135m')

    expect(result.success).toBe(true)
    expect(pullUrls).toHaveLength(2) // classified transient via cause, retried
  })

  it('does NOT retry a non-transient error (bad model / missing manifest)', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }])
    ])

    const { result } = await runPull(pullModel, 'does-not-exist')

    expect(result.success).toBe(false)
    expect(result.error).toContain('file does not exist')
    expect(pullUrls).toHaveLength(1) // gave up immediately, no retry
  })

  it('gives up after the attempt ceiling and returns the last transient error', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ error: 'EOF' }]),
      makeStreamResponse([{ error: 'EOF' }]),
      makeStreamResponse([{ error: 'EOF' }])
    ])

    const { result } = await runPull(pullModel, 'smollm:135m')

    expect(result).toEqual({ success: false, error: 'EOF', modelId: 'smollm:135m' })
    expect(pullUrls).toHaveLength(3) // PULL_MAX_ATTEMPTS
  })

  it('signals a retry to onProgress so the UI banner does not stall during backoff', async () => {
    const pullModel = await loadPullModel()
    stubFetch([
      makeStreamResponse([{ error: 'EOF' }]),
      makeStreamResponse([{ status: 'success' }])
    ])

    const { onProgress } = await runPull(pullModel, 'smollm:135m')

    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ retrying: true }))
  })
})
