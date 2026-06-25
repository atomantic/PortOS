import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// startPersistentService / getServiceStatus shell out via promisify(execFile).
// Route every exec call through a per-test impl so the homebrew service flow can
// be scripted (brew --version, services start/stop/list). `spawn` is referenced
// at module import (startServer) but never invoked by these tests.
const execMock = { impl: () => {} }
vi.mock('child_process', () => ({
  execFile: (cmd, args, opts, cb) => execMock.impl(cmd, args, opts, cb),
  spawn: vi.fn()
}))

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

// A real fetch Response exposes both json() and text(); ollamaRequest now reads
// the body tolerantly via text() (readResponseJson), so the stub must provide it.
const versionResponse = () => {
  const body = { version: '0.24.0' }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

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

  it('tags a 412 "newer version of Ollama" error with code OLLAMA_OUTDATED', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ error: 'pull model manifest: 412: The model you are attempting to pull requires a newer version of Ollama. Please download the latest version at: https://ollama.com/download' }])
    ])

    const { result } = await runPull(pullModel, 'qwen3:8b')

    expect(result.success).toBe(false)
    expect(result.code).toBe('OLLAMA_OUTDATED')
    expect(pullUrls).toHaveLength(1) // not retried — outdated binary won't fix itself
  })

  it('tags a 400 "sharded GGUF" error with code SHARDED_GGUF', async () => {
    const pullModel = await loadPullModel()
    const { pullUrls } = stubFetch([
      makeStreamResponse([{ error: 'pull model manifest: 400: {"error":"The specified tag is a sharded GGUF. Ollama does not support this yet. Please use another tag or \\"latest\\". Follow this issue for more info: https://github.com/ollama/ollama/issues/5245"}' }])
    ])

    const { result } = await runPull(pullModel, 'hf.co/unsloth/Qwen3-Coder-Next-GGUF:UD-Q8_K_XL')

    expect(result.success).toBe(false)
    expect(result.code).toBe('SHARDED_GGUF')
    expect(pullUrls).toHaveLength(1) // not retried — sharding won't resolve on retry
  })
})

describe('ollamaManager.isBootstrapConflictError', () => {
  it('matches the launchctl bootstrap-5 / EIO failures brew surfaces', async () => {
    const { isBootstrapConflictError } = await import('./ollamaManager.js')
    expect(isBootstrapConflictError('Bootstrap failed: 5: Input/output error')).toBe(true)
    expect(isBootstrapConflictError('Error: Failure while executing; `/bin/launchctl bootstrap gui/501 …` exited with 5.')).toBe(true)
    expect(isBootstrapConflictError('service already loaded')).toBe(true)
  })

  it('does NOT match unrelated failures (no false bootout/retry)', async () => {
    const { isBootstrapConflictError } = await import('./ollamaManager.js')
    expect(isBootstrapConflictError('Permission denied')).toBe(false)
    expect(isBootstrapConflictError('ollama: command not found')).toBe(false)
    expect(isBootstrapConflictError('')).toBe(false)
    expect(isBootstrapConflictError(undefined)).toBe(false)
  })

  it('requires bootstrap context — a bare EIO / exit-5 unrelated to bootstrap is not a conflict', async () => {
    const { isBootstrapConflictError } = await import('./ollamaManager.js')
    // A generic disk EIO during an unrelated brew step must not trip the bootout.
    expect(isBootstrapConflictError('Error: write failed: Input/output error')).toBe(false)
    // Some other command exiting 5 with no bootstrap involved.
    expect(isBootstrapConflictError('Error: `brew cleanup` exited with 5.')).toBe(false)
  })
})

describe('ollamaManager.startPersistentService bootstrap recovery (homebrew)', () => {
  let originalPlatform
  beforeEach(() => {
    // Force the homebrew controller branch regardless of CI host OS.
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
    vi.unstubAllGlobals()
    execMock.impl = () => {}
  })

  // Reachable /api/version so waitForAvailability resolves true on first probe.
  function stubReachable() {
    const body = { version: '0.24.0' }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })))
  }

  async function loadManager() {
    vi.resetModules()
    return import('./ollamaManager.js')
  }

  it('boots out a stale launchd registration and retries when start fails with bootstrap-5', async () => {
    stubReachable()
    const calls = []
    let startAttempts = 0
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      calls.push(`${cmd} ${a}`)
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services start ollama') {
        startAttempts++
        if (startAttempts === 1) {
          const e = new Error('Bootstrap failed: 5: Input/output error')
          e.stderr = 'Bootstrap failed: 5: Input/output error'
          return cb(e)
        }
        return cb(null, { stdout: '', stderr: '' })
      }
      if (cmd === 'brew' && a === 'services stop ollama') return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started ilyaeivy ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist\n', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { startPersistentService } = await loadManager()
    const result = await startPersistentService()

    expect(result.success).toBe(true)
    expect(result.persistent).toBe(true)
    expect(startAttempts).toBe(2) // recovered: bootout then retried
    expect(calls).toContain('brew services stop ollama')
  })

  it('does NOT bootout/retry when start fails for an unrelated reason', async () => {
    stubReachable()
    let startAttempts = 0
    let stopCalled = false
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services start ollama') {
        startAttempts++
        const e = new Error('Permission denied')
        e.stderr = 'Permission denied'
        return cb(e)
      }
      if (cmd === 'brew' && a === 'services stop ollama') { stopCalled = true; return cb(null, { stdout: '', stderr: '' }) }
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started ilyaeivy ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist\n', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { startPersistentService } = await loadManager()
    // The API is still reachable here (stubReachable), but the failed start with a
    // non-bootstrap error must not trigger the bootout-and-retry recovery path.
    await startPersistentService()

    expect(startAttempts).toBe(1)
    expect(stopCalled).toBe(false)
  })

  it('surfaces the retry error (not the stale first error) when bootout+retry still fails', async () => {
    // A non-successful start falls to the failure branch and reports result.error
    // regardless of reachability; keep the API reachable so the probe returns fast.
    stubReachable()
    let startAttempts = 0
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services start ollama') {
        startAttempts++
        const e = new Error(startAttempts === 1 ? 'Bootstrap failed: 5: Input/output error' : 'launchctl bootstrap gui/501 still wedged')
        e.stderr = e.message
        return cb(e)
      }
      if (cmd === 'brew' && a === 'services stop ollama') return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama none\n', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { startPersistentService } = await loadManager()
    const result = await startPersistentService()

    expect(startAttempts).toBe(2) // recovery was attempted
    expect(result.success).toBe(false)
    expect(result.error).toContain('still wedged') // retry's error, not the first
  })
})
