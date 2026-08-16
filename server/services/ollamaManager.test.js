import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'fs/promises'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { pinPlatform } from '../lib/testHelper.js'

// startPersistentService / getServiceStatus shell out via promisify(execFile).
// Route every exec call through a per-test impl so the homebrew service flow can
// be scripted (brew --version, services start/stop/list). `spawn` is referenced
// at module import (startServer) but never invoked by these tests.
const execMock = { impl: () => {} }
vi.mock('../lib/childProcess.js', () => ({
  execFile: (cmd, args, opts, cb) => execMock.impl(cmd, args, opts, cb),
  spawn: vi.fn()
}))

// The HF pull recovery attaches the user's HF token (so a gated repo Ollama could
// pull is recoverable too). Stub the resolver rather than reading real settings.
const hfTokenMock = { token: null }
vi.mock('../lib/hfToken.js', () => ({ getHfToken: async () => hfTokenMock.token }))

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
async function loadManager() {
  vi.resetModules()
  return import('./ollamaManager.js')
}

const loadPullModel = () => loadManager().then((mod) => mod.pullModel)

describe('ollamaManager residency status', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a failed /api/ps probe distinct from a trustworthy empty list', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      if (String(url).endsWith('/api/version')) return versionResponse()
      if (String(url).endsWith('/api/ps')) throw new Error('ps offline')
      throw new Error(`unexpected fetch: ${url}`)
    }))
    const { getLoadedModels, getLastLoadedModelsError } = await loadManager()

    await expect(getLoadedModels()).resolves.toEqual([])
    expect(getLastLoadedModelsError()).toMatch(/ps offline/i)
  })
})

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

// ---- HF pull recovery ("context deadline exceeded" after 100%) --------------
//
// finalizeHuggingFacePull touches the real filesystem, so these tests point
// OLLAMA_MODELS at a temp dir and pre-place the layer blobs Ollama had already
// finished downloading — the exact on-disk state the bug leaves behind.

// Serve a Buffer the way fetch does, for the HF registry stub.
const bufferResponse = (buf) => ({ ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })

describe('ollamaManager HF pull recovery', () => {
  const HF_ID = 'hf.co/example-org/Example-Model-GGUF:Q8_0'
  const HF_BASE = 'https://huggingface.co/v2/example-org/Example-Model-GGUF'
  let modelsDir
  let originalModelsEnv

  // Real content so digests are genuine — the recovery verifies every blob it
  // writes, and a fake digest must be able to fail that check.
  const configBody = Buffer.from(JSON.stringify({ model_format: 'gguf', model_family: 'qwen35' }))
  const configDigest = `sha256:${createHash('sha256').update(configBody).digest('hex')}`
  const weightsBody = Buffer.from('pretend 30GB of GGUF weights')
  const weightsDigest = `sha256:${createHash('sha256').update(weightsBody).digest('hex')}`

  const manifest = () => ({
    schemaVersion: 2,
    config: { digest: configDigest, mediaType: 'application/vnd.docker.container.image.v1+json', size: configBody.length },
    layers: [{ digest: weightsDigest, mediaType: 'application/vnd.ollama.image.model', size: weightsBody.length }]
  })

  beforeEach(async () => {
    originalModelsEnv = process.env.OLLAMA_MODELS
    modelsDir = await mkdtemp(join(tmpdir(), 'portos-ollama-models-'))
    process.env.OLLAMA_MODELS = modelsDir
    await mkdir(join(modelsDir, 'blobs'), { recursive: true })
  })

  afterEach(async () => {
    if (originalModelsEnv === undefined) delete process.env.OLLAMA_MODELS
    else process.env.OLLAMA_MODELS = originalModelsEnv
    await rm(modelsDir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  const blobPath = (digest) => join(modelsDir, 'blobs', digest.replace(':', '-'))
  const manifestPath = () => join(modelsDir, 'manifests', 'hf.co', 'example-org', 'Example-Model-GGUF', 'Q8_0')

  // Pre-place the weight layer Ollama finished before it died.
  const placeWeights = () => writeFile(blobPath(weightsDigest), weightsBody)

  // Stub the HF OCI registry. `blobBody` overrides what the config blob serves
  // (to simulate corruption); `failBlob` makes the blob request fail outright.
  // The returned array of requested URLs also carries the per-request `init`
  // objects on `.inits`, so header propagation is assertable.
  function stubRegistry({ blobBody = configBody, failBlob = false, manifestDoc = manifest() } = {}) {
    const urls = []
    urls.inits = []
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      const u = String(url)
      urls.push(u)
      urls.inits.push(init)
      if (u.endsWith('/api/version')) return versionResponse()
      if (u === `${HF_BASE}/manifests/Q8_0`) return bufferResponse(Buffer.from(JSON.stringify(manifestDoc)))
      if (u === `${HF_BASE}/blobs/${configDigest}`) {
        if (failBlob) return { ok: false, status: 504, statusText: 'Gateway Timeout' }
        return bufferResponse(blobBody)
      }
      throw new Error(`unexpected fetch: ${u}`)
    }))
    return urls
  }

  const exists = (p) => stat(p).then(() => true, () => false)

  describe('isPullDeadlineError', () => {
    it('matches Ollama’s Go deadline error', async () => {
      const { isPullDeadlineError } = await loadManager()
      expect(isPullDeadlineError('context deadline exceeded')).toBe(true)
      expect(isPullDeadlineError('Post "https://…": context deadline exceeded')).toBe(true)
    })
    it('does NOT match the transient class or unrelated errors', async () => {
      const { isPullDeadlineError } = await loadManager()
      // Must stay disjoint from isTransientPullError — a plain retry can't fix a
      // deadline, and the recovery path must not swallow real network blips.
      expect(isPullDeadlineError('EOF')).toBe(false)
      expect(isPullDeadlineError('read ECONNRESET')).toBe(false)
      expect(isPullDeadlineError('pull model manifest: file does not exist')).toBe(false)
      expect(isPullDeadlineError(null)).toBe(false)
    })
  })

  describe('listStoredModels', () => {
    it('enumerates manifests from disk while the daemon is stopped', async () => {
      await mkdir(join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'example'), { recursive: true })
      await writeFile(
        join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', 'example', 'latest'),
        JSON.stringify(manifest()),
      )
      const { listStoredModels } = await loadManager()

      const rows = await listStoredModels()

      expect(rows).toEqual([expect.objectContaining({
        id: 'example:latest',
        name: 'example:latest',
        size: configBody.length + weightsBody.length,
      })])
    })
  })

  describe('finalizeHuggingFacePull', () => {
    it('fetches the missing config blob and writes the manifest Ollama never wrote', async () => {
      await placeWeights()
      stubRegistry()
      const { finalizeHuggingFacePull } = await loadManager()

      expect(await finalizeHuggingFacePull(HF_ID)).toEqual({ success: true })
      expect(await readFile(blobPath(configDigest))).toEqual(configBody)
      // Byte-identical to what the registry served, so Ollama derives the same digest.
      expect(await readFile(manifestPath(), 'utf8')).toBe(JSON.stringify(manifest()))
    })

    it('carries the user’s HF token so a gated repo is recoverable too', async () => {
      hfTokenMock.token = 'hf_example_token'
      await placeWeights()
      const urls = stubRegistry()
      const { finalizeHuggingFacePull } = await loadManager()

      await finalizeHuggingFacePull(HF_ID)

      // Both the manifest and the blob request need the bearer — a 401 on either
      // would make the recovery decline every time for a gated model.
      expect(urls.inits.every((init) => init?.headers?.Authorization === 'Bearer hf_example_token')).toBe(true)
      hfTokenMock.token = null
    })

    it('keeps the already-downloaded weight layer instead of re-fetching 30GB', async () => {
      await placeWeights()
      const urls = stubRegistry()
      const { finalizeHuggingFacePull } = await loadManager()

      await finalizeHuggingFacePull(HF_ID)

      expect(urls).not.toContain(`${HF_BASE}/blobs/${weightsDigest}`)
      expect(await readFile(blobPath(weightsDigest))).toEqual(weightsBody) // untouched
    })

    it('clears the `-partial` scratch files Ollama abandoned for the recovered blob', async () => {
      await placeWeights()
      const partial = `${blobPath(configDigest)}-partial`
      const partialPart = `${blobPath(configDigest)}-partial-0`
      await writeFile(partial, Buffer.alloc(481))
      await writeFile(partialPart, '{"N":0,"Offset":0,"Size":481,"Completed":0}\n')
      stubRegistry()
      const { finalizeHuggingFacePull } = await loadManager()

      await finalizeHuggingFacePull(HF_ID)

      // Left in place they'd shadow the completed blob on a later resume attempt.
      expect(await exists(partial)).toBe(false)
      expect(await exists(partialPart)).toBe(false)
    })

    it('refuses to write the manifest when a downloaded blob fails digest verification', async () => {
      await placeWeights()
      stubRegistry({ blobBody: Buffer.from('corrupted bytes from a bad CDN edge') })
      const { finalizeHuggingFacePull } = await loadManager()

      const result = await finalizeHuggingFacePull(HF_ID)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/digest verification/)
      // No manifest AND no bogus blob — a corrupt model that reports installed is
      // worse than a failed install.
      expect(await exists(manifestPath())).toBe(false)
      expect(await exists(blobPath(configDigest))).toBe(false)
    })

    it('refuses when a multi-GB weight layer is the missing blob (that is a real download)', async () => {
      // No placeWeights(), and the layer declares its true multi-GB size — so
      // this was never a "finished downloading, only the manifest is missing"
      // failure and must not turn into a silent 30GB re-download here.
      const big = manifest()
      big.layers[0].size = 29_787_701_792
      stubRegistry({ manifestDoc: big })
      const { finalizeHuggingFacePull } = await loadManager()

      const result = await finalizeHuggingFacePull(HF_ID)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/too large to recover/)
      expect(await exists(manifestPath())).toBe(false)
    })

    it('refuses a blob whose manifest size is missing rather than guessing', async () => {
      // Unknown size must not read as "0 bytes, nothing to fetch" — absent and
      // legitimately-empty are different, and only one is safe to accept.
      const noSize = manifest()
      delete noSize.layers[0].size
      stubRegistry({ manifestDoc: noSize })
      const { finalizeHuggingFacePull } = await loadManager()

      const result = await finalizeHuggingFacePull(HF_ID)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/unknown bytes/)
      expect(await exists(manifestPath())).toBe(false)
    })

    it('treats a size-mismatched on-disk blob as missing and re-fetches it', async () => {
      await placeWeights()
      await writeFile(blobPath(configDigest), Buffer.from('truncated')) // wrong size
      const urls = stubRegistry()
      const { finalizeHuggingFacePull } = await loadManager()

      expect(await finalizeHuggingFacePull(HF_ID)).toEqual({ success: true })
      expect(urls).toContain(`${HF_BASE}/blobs/${configDigest}`)
      expect(await readFile(blobPath(configDigest))).toEqual(configBody)
    })

    it('surfaces a failed blob fetch without writing a partial manifest', async () => {
      await placeWeights()
      stubRegistry({ failBlob: true })
      const { finalizeHuggingFacePull } = await loadManager()

      const result = await finalizeHuggingFacePull(HF_ID)

      expect(result.success).toBe(false)
      expect(result.error).toMatch(/504/)
      expect(await exists(manifestPath())).toBe(false)
    })

    it('declines a non-Hugging-Face ref (no OCI registry to fetch from)', async () => {
      const { finalizeHuggingFacePull } = await loadManager()
      const result = await finalizeHuggingFacePull('gpt-oss:20b')
      expect(result).toEqual({ success: false, error: 'not a Hugging Face model ref' })
    })

    it('declines a manifest that lists no blobs', async () => {
      stubRegistry({ manifestDoc: { schemaVersion: 2 } })
      const { finalizeHuggingFacePull } = await loadManager()
      const result = await finalizeHuggingFacePull(HF_ID)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/no blobs/)
    })
  })

  describe('pullModel deadline recovery', () => {
    // Script /api/pull to fail with the deadline error, then let the recovery run.
    function stubPullThenRegistry(registryOpts) {
      const inner = stubRegistry(registryOpts)
      const registryFetch = globalThis.fetch
      let pulls = 0
      vi.stubGlobal('fetch', vi.fn(async (url, ...rest) => {
        if (String(url).endsWith('/api/pull')) {
          pulls++
          return makeStreamResponse([
            { status: 'pulling manifest' },
            { status: 'pulling', total: 100, completed: 100 },
            { error: 'context deadline exceeded' }
          ])
        }
        return registryFetch(url, ...rest)
      }))
      return { urls: inner, pullCount: () => pulls }
    }

    it('completes the install locally instead of failing at 100%', async () => {
      await placeWeights()
      const { pullCount } = stubPullThenRegistry()
      const { pullModel } = await loadManager()
      const onProgress = vi.fn()

      const result = await pullModel(HF_ID, onProgress)

      expect(result).toEqual({ success: true, modelId: HF_ID, recovered: true })
      expect(pullCount()).toBe(1) // NOT retried — a retry re-races the same deadline
      // The banner must move off "100%" while the recovery runs.
      expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ finalizing: true }))
      expect(await exists(manifestPath())).toBe(true)
    })

    it('reports the original deadline error when recovery cannot finish the install', async () => {
      // Multi-GB weight layer absent → recovery declines → the user sees Ollama's
      // real error rather than a confusing recovery-internal message.
      const big = manifest()
      big.layers[0].size = 29_787_701_792
      const { pullModel } = await loadManager()
      stubPullThenRegistry({ manifestDoc: big })

      const result = await pullModel(HF_ID)

      expect(result.success).toBe(false)
      expect(result.error).toBe('context deadline exceeded')
    })

    it('does not announce a recovery for a non-HF ref it could never finish', async () => {
      // registry.ollama.ai has no OCI endpoint PortOS can complete a pull from,
      // so a deadline there must fail plainly — no "finishing install…" banner
      // for work that has nowhere to fetch from.
      stubPullThenRegistry()
      const { pullModel } = await loadManager()
      const onProgress = vi.fn()

      const result = await pullModel('gpt-oss:20b', onProgress)

      expect(result.success).toBe(false)
      expect(result.error).toBe('context deadline exceeded')
      expect(onProgress).not.toHaveBeenCalledWith(expect.objectContaining({ finalizing: true }))
    })
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
  let restorePlatform = () => {}
  beforeEach(() => {
    // Force the homebrew controller branch regardless of CI host OS.
    restorePlatform = pinPlatform('darwin')
  })
  afterEach(() => {
    restorePlatform()
    vi.unstubAllGlobals()
    execMock.impl = () => {}
  })

  // Reachable /api/version so waitForAvailability resolves true on first probe.
  function stubReachable() {
    const body = { version: '0.24.0' }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })))
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
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started testuser ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist\n', stderr: '' })
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
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started testuser ~/Library/LaunchAgents/homebrew.mxcl.ollama.plist\n', stderr: '' })
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

describe('ollamaManager context window', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  // Answers /api/version (reachable) and /api/ps with the given resident models.
  function stubPs(models) {
    const bodyFor = (url) => (String(url).endsWith('/api/ps') ? { models } : { version: '0.32.13' })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const body = bodyFor(url)
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }))
  }

  it('reports the largest window across resident models', async () => {
    stubPs([{ name: 'a', context_length: 32768 }, { name: 'b', context_length: 131072 }])
    const { getRuntimeContextLength } = await loadManager()
    expect(await getRuntimeContextLength()).toBe(131072)
  })

  it('reports null when nothing is resident — Ollama has not committed to a window yet', async () => {
    stubPs([])
    const { getRuntimeContextLength } = await loadManager()
    expect(await getRuntimeContextLength()).toBeNull()
  })

  it('ignores models whose window Ollama did not report', async () => {
    stubPs([{ name: 'a' }, { name: 'b', context_length: 0 }])
    const { getRuntimeContextLength } = await loadManager()
    expect(await getRuntimeContextLength()).toBeNull()
  })

  it('does nothing when no window is configured', async () => {
    stubPs([{ name: 'a', context_length: 4096 }])
    const { ensureContextWindow } = await loadManager()
    expect(await ensureContextWindow(null)).toEqual({ applied: false, reason: 'not-configured', contextLength: null })
  })

  it('leaves a daemon alone when it already loaded a large enough window', async () => {
    stubPs([{ name: 'a', context_length: 131072 }])
    const { ensureContextWindow } = await loadManager()
    expect(await ensureContextWindow(65536)).toMatchObject({ applied: false, reason: 'already-large-enough' })
  })

})

describe('ollamaManager context window — launch-at-login daemons', () => {
  let restorePlatform = null
  afterEach(() => { vi.unstubAllGlobals(); restorePlatform?.(); restorePlatform = null })

  function stubPs(models) {
    const bodyFor = (url) => (String(url).endsWith('/api/ps') ? { models } : { version: '0.32.13' })
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const body = bodyFor(url)
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
    }))
  }

  // Reloading a registered service must NEVER route through `brew services stop`
  // / `systemctl disable` — that silently drops the user's launch-at-login
  // registration as a side effect of raising a context window.
  it('restarts a homebrew service in place, carrying the window via launchctl setenv', async () => {
    restorePlatform = pinPlatform('darwin')
    stubPs([{ name: 'a', context_length: 32768 }])
    const calls = []
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      calls.push(`${cmd} ${a}`)
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started testuser plist\n', stderr: '' })
      if (cmd === 'launchctl' && a.startsWith('setenv OLLAMA_CONTEXT_LENGTH')) return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'brew' && a === 'services restart ollama') return cb(null, { stdout: '', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { ensureContextWindow } = await loadManager()
    const result = await ensureContextWindow(131072)

    expect(result).toMatchObject({ applied: true, reason: 'service-restarted', contextLength: 131072 })
    expect(calls).toContain('launchctl setenv OLLAMA_CONTEXT_LENGTH 131072')
    expect(calls).toContain('brew services restart ollama')
    expect(calls.some((c) => c.includes('services stop'))).toBe(false)
  })

  // An idle daemon (nothing resident) is the NORMAL state between runs. Skipping
  // it would make `numCtx` a no-op exactly when it matters: the window Ollama
  // picks when the harness loads its model is the VRAM-based default the setting
  // exists to override.
  it('applies the window to an idle daemon rather than waiting for a model to be resident', async () => {
    restorePlatform = pinPlatform('darwin')
    stubPs([])
    const calls = []
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      calls.push(`${cmd} ${a}`)
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started testuser plist\n', stderr: '' })
      if (cmd === 'launchctl') return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'brew' && a === 'services restart ollama') return cb(null, { stdout: '', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { ensureContextWindow } = await loadManager()
    const result = await ensureContextWindow(131072)

    expect(result).toMatchObject({ applied: true, reason: 'service-restarted' })
    expect(calls).toContain('launchctl setenv OLLAMA_CONTEXT_LENGTH 131072')
  })

  it('does not reload twice for the same window once it has been handed over', async () => {
    restorePlatform = pinPlatform('darwin')
    stubPs([{ name: 'a', context_length: 32768 }])
    let restarts = 0
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      if (cmd === 'brew' && a === '--version') return cb(null, { stdout: 'Homebrew 4.0.0', stderr: '' })
      if (cmd === 'brew' && a === 'services list') return cb(null, { stdout: 'ollama started testuser plist\n', stderr: '' })
      if (cmd === 'launchctl') return cb(null, { stdout: '', stderr: '' })
      if (cmd === 'brew' && a === 'services restart ollama') { restarts++; return cb(null, { stdout: '', stderr: '' }) }
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { ensureContextWindow } = await loadManager()
    await ensureContextWindow(131072)
    // Ollama may still load a model at less than the requested window (it fits
    // the KV cache to VRAM). That must not read as "not applied" and bounce the
    // daemon before every agent spawn.
    const second = await ensureContextWindow(131072)

    expect(restarts).toBe(1)
    expect(second).toMatchObject({ applied: false, reason: 'already-applied' })
  })

  it('reports the systemd drop-in instead of tearing the unit down', async () => {
    restorePlatform = pinPlatform('linux')
    stubPs([{ name: 'a', context_length: 32768 }])
    const calls = []
    execMock.impl = (cmd, args, opts, cb) => {
      const a = (args || []).join(' ')
      calls.push(`${cmd} ${a}`)
      if (cmd === 'systemctl' && a === '--version') return cb(null, { stdout: 'systemd 250', stderr: '' })
      if (cmd === 'systemctl' && a === 'is-active ollama') return cb(null, { stdout: 'active\n', stderr: '' })
      if (cmd === 'systemctl' && a === 'is-enabled ollama') return cb(null, { stdout: 'enabled\n', stderr: '' })
      return cb(new Error(`unexpected exec: ${cmd} ${a}`))
    }

    const { ensureContextWindow } = await loadManager()
    const result = await ensureContextWindow(131072)

    expect(result).toMatchObject({ applied: false, reason: 'service-managed' })
    expect(result.error).toContain('systemctl edit ollama')
    expect(calls.some((c) => c.includes('disable'))).toBe(false)
  })
})
