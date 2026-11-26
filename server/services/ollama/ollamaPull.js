/** Streams Ollama pulls, retries transient interruptions and clears owned partial blobs after cancellation. */

import { join } from 'path'
import { readdir, unlink } from 'fs/promises'
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js'
import { describeFetchError } from '../../lib/fetchErrorChain.js'
import { safeJSONParse, sleep } from '../../lib/fileUtils.js'
import { huggingFaceRegistryBase, parseOllamaModelRef } from '../../lib/localLlmDisk.js'
import { checkOllamaAvailable, getBaseUrl } from './ollamaDaemon.js'
import { finalizeHuggingFacePull, getModelsDir } from './ollamaHuggingFaceImport.js'
import { bustInstalledModelsCache } from './ollamaModelCache.js'

// A pull streams progress as NDJSON; a transient network failure between Ollama
// and the registry/CDN surfaces mid-stream as an `{"error":"EOF"}` frame (or the
// response read rejecting outright). The `ollama` CLI silently retries these and
// the pull is resumable — partial blobs are kept — so a retry continues rather
// than restarts. Total attempts (1 initial + retries) and a linear backoff base.
const PULL_MAX_ATTEMPTS = 3
const PULL_RETRY_BASE_DELAY_MS = 1_000

/**
 * Pull a model, streaming progress. Resolves once the pull finishes.
 * Non-percent frames carry a reason flag so the UI can show why the banner is
 * paused instead of stalling: `retrying: true` during a transient-error backoff,
 * `finalizing: true` while PortOS completes an install Ollama abandoned (see
 * finalizeHuggingFacePull). A success that went through that recovery is flagged
 * `recovered: true`.
 * @param {string} modelId
 * @param {(p: { status: string, percent: number|null, completed?: number, total?: number, retrying?: boolean, finalizing?: boolean }) => void} [onProgress]
 * @returns {Promise<{ success: boolean, modelId: string, error?: string, recovered?: boolean }>}
 */
async function pullModel(modelId, onProgress, { signal } = {}) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available', modelId }
  }
  console.log(`📥 Ollama pull: ${modelId}`)

  // Layer digests this pull touched, so a cancel can remove exactly their
  // `-partial` scratch files and nothing another model owns.
  const digests = new Set()
  let lastError = null
  for (let attempt = 1; attempt <= PULL_MAX_ATTEMPTS; attempt++) {
    const result = await attemptOllamaPull(modelId, onProgress, { signal, digests })
    if (signal?.aborted) {
      const removed = await removePartialBlobs(digests)
      console.log(`🛑 Ollama pull canceled: ${modelId} (removed ${removed} partial file${removed === 1 ? '' : 's'})`)
      return { success: false, canceled: true, code: 'INSTALL_CANCELED', error: 'Download canceled', modelId }
    }
    if (result.success) {
      bustInstalledModelsCache()
      console.log(`✅ Ollama pull complete: ${modelId}${attempt > 1 ? ` (after ${attempt} attempts)` : ''}`)
      return { success: true, modelId }
    }
    lastError = result.error
    // Bad model name / missing manifest etc. won't fix themselves — only retry
    // the transient network class, and only while attempts remain.
    if (attempt >= PULL_MAX_ATTEMPTS || !isTransientPullError(lastError)) break
    const delayMs = PULL_RETRY_BASE_DELAY_MS * attempt
    console.log(`🔁 Ollama pull ${modelId} hit transient error "${lastError}" (attempt ${attempt}/${PULL_MAX_ATTEMPTS}); retrying in ${delayMs}ms`)
    if (typeof onProgress === 'function') onProgress({ status: 'retrying after network error', percent: null, retrying: true })
    await sleep(delayMs)
  }

  // The weights may all be on disk and only Ollama's manifest write missing —
  // retrying just re-races the same deadline, so finish the pull ourselves.
  // Gated on the ref being one we can actually finish, so a deadline against a
  // non-HF registry doesn't flash a "finishing install…" banner for a recovery
  // that has nowhere to fetch from.
  if (isPullDeadlineError(lastError) && huggingFaceRegistryBase(parseOllamaModelRef(modelId))) {
    if (typeof onProgress === 'function') {
      onProgress({ status: 'finishing install from downloaded files…', percent: null, finalizing: true })
    }
    const recovered = await finalizeHuggingFacePull(modelId).catch((err) => ({ success: false, error: err.message }))
    if (recovered.success) {
      bustInstalledModelsCache()
      return { success: true, modelId, recovered: true }
    }
    console.warn(`⚠️ Ollama pull recovery declined for ${modelId}: ${recovered.error}`)
  }

  console.error(`⚠️ Ollama pull failed for ${modelId}: ${lastError}`)
  const code = isShardedGgufError(lastError) ? 'SHARDED_GGUF'
    : isOllamaOutdatedError(lastError) ? 'OLLAMA_OUTDATED'
      : undefined
  return { success: false, error: lastError, modelId, ...(code ? { code } : {}) }
}

/**
 * Detect the Go-runtime deadline Ollama reports when a registry request outlives
 * its internal per-request budget: `context deadline exceeded`. Distinctive
 * because it lands AFTER the weight layers hit 100% — the blobs are downloaded
 * and verified, only the manifest write is missing — which is what makes the
 * local-completion recovery in finalizeHuggingFacePull() safe to attempt.
 *
 * Deliberately NOT part of isTransientPullError: retrying re-races the same slow
 * endpoint against the same deadline and fails identically every time.
 * @param {string|null|undefined} error
 */
function isPullDeadlineError(error) {
  return /context deadline exceeded/i.test(String(error ?? ''))
}

/**
 * Detect Ollama's refusal to pull a multi-part (sharded) GGUF. The HF passthrough
 * registry returns a 400 whose message names "sharded GGUF" and links the tracking
 * issue (ollama/ollama#5245). The catalog already flags sharded quants so the UI
 * disables Install — this classifier is defense-in-depth for the pull-by-name path
 * (a raw `hf.co/<repo>:<quant>` typed into the search box) so the caller can show
 * an actionable message instead of the raw 400. Match the phrase plus the 400 so
 * an unrelated 400 can't slip through.
 * @param {string|null|undefined} error
 */
function isShardedGgufError(error) {
  if (!error) return false
  const str = String(error)
  return /\b400\b/.test(str) && /sharded gguf/i.test(str)
}

/**
 * Detect Ollama's "model requires a newer version" 412 response surfaced in the
 * NDJSON stream. The registry returns it when a new model format (e.g. a fresh
 * GGUF feature) lands before the local Ollama binary supports it; the fix is to
 * upgrade the Ollama install. The error string we see looks like:
 *   "pull model manifest: 412: The model you are attempting to pull requires
 *    a newer version of Ollama. Please download the latest version at: …"
 * Match on the "newer version of Ollama" phrase plus the 412 status code so a
 * benign 412 from an unrelated path can't slip through.
 * @param {string|null|undefined} error
 */
function isOllamaOutdatedError(error) {
  if (!error) return false
  const str = String(error)
  return /\b412\b/.test(str) && /newer version of ollama/i.test(str)
}

/**
 * A single pull attempt. Returns `{ success }` or `{ success: false, error }`.
 * A read that rejects mid-stream (dropped connection) is caught and returned as
 * an error string so the caller's retry loop can classify it like an `{error}`
 * frame rather than letting it throw out of the request lifecycle.
 * @param {string} modelId
 * @param {(p: object) => void} [onProgress]
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function attemptOllamaPull(modelId, onProgress, { signal, digests } = {}) {
  // No timeout — multi-GB pulls take minutes; the stream is the lifecycle.
  // Aborting the request is what cancels: Ollama stops a blob download once no
  // request is waiting on it.
  const response = await fetchWithTimeout(`${getBaseUrl()}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: modelId, stream: true }),
    ...(signal ? { signal } : {}),
  }, 0).catch((err) => ({ _err: describeFetchError(err) }))

  if (response._err || !response.ok || !response.body) {
    return { success: false, error: response._err || `pull failed: ${response.status} ${response.statusText}` }
  }

  const lastError = await streamNdjson(response, (frame) => {
    if (digests && typeof frame.digest === 'string') digests.add(frame.digest)
    if (typeof onProgress === 'function') {
      const percent = frame.total > 0 && frame.completed >= 0
        ? Math.round((frame.completed / frame.total) * 100)
        : null
      onProgress({ status: frame.status || '', percent, completed: frame.completed, total: frame.total })
    }
  }).catch((err) => err?.message || String(err))

  return lastError ? { success: false, error: lastError } : { success: true }
}

/**
 * Delete the `<blob>-partial*` scratch files Ollama keeps for the given layer
 * digests (`sha256:<hex>`). Completed blobs are never touched: a layer another
 * model already shares has no partial file. Returns how many files went.
 * @param {Iterable<string>} digests
 * @returns {Promise<number>}
 */
async function removePartialBlobs(digests) {
  const prefixes = [...digests]
    .map((digest) => /^sha256:([a-f0-9]{64})$/.exec(digest)?.[1])
    .filter(Boolean)
    .map((hex) => `sha256-${hex}-partial`)
  if (!prefixes.length) return 0
  const blobsDir = join(getModelsDir(), 'blobs')
  const names = await readdir(blobsDir).catch(() => [])
  const doomed = names.filter((name) => prefixes.some((prefix) => name.startsWith(prefix)))
  const results = await Promise.all(doomed.map((name) => unlink(join(blobsDir, name)).then(() => true, () => false)))
  return results.filter(Boolean).length
}

/**
 * Classify a pull/stream error string as a transient network failure worth
 * retrying (Ollama↔registry EOF, connection reset, undici "terminated", etc.).
 * Non-transient errors — invalid model name, "file does not exist" — return
 * false so the retry loop gives up immediately.
 * @param {string|null|undefined} error
 * @returns {boolean}
 */
function isTransientPullError(error) {
  if (!error) return false
  return /\beof\b|connection reset|reset by peer|broken pipe|socket hang up|other side closed|terminated|i\/o timeout|\btimeout\b|tls handshake|temporary failure|network is unreachable|connection refused|econnreset|etimedout|epipe/i.test(String(error))
}

/**
 * Consume an Ollama NDJSON progress stream (used by /api/pull and /api/create).
 * Returns the last `{ error }` seen, or null on a clean stream. Reads via
 * getReader() to match the codebase's streaming convention; try/finally releases
 * the reader even if a read rejects mid-stream (avoids leaking the connection).
 * Flushes the decoder + trailing buffer so a final frame that wasn't newline-
 * terminated (notably a terminal `{"error":...}`) isn't silently dropped.
 * @param {Response} response - a fetch Response with a readable body
 * @param {(frame: object) => void} [onFrame]
 * @returns {Promise<string|null>} last error message, or null
 */
async function streamNdjson(response, onFrame) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastError = null

  const handleFrame = (line) => {
    const trimmed = line.trim()
    if (!trimmed) return
    const frame = safeParse(trimmed)
    if (!frame) return
    if (frame.error) lastError = frame.error
    if (typeof onFrame === 'function') onFrame(frame)
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        handleFrame(buffer.slice(0, nl))
        buffer = buffer.slice(nl + 1)
      }
    }
    buffer += decoder.decode()
    handleFrame(buffer)
  } finally {
    reader.releaseLock()
  }
  return lastError
}

// safeJSONParse imported from fileUtils provides identical null-on-failure semantics.
const safeParse = (line) => safeJSONParse(line, null);

export {
  pullModel,
  streamNdjson
}
