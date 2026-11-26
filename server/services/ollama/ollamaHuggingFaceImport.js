/** Finalizes interrupted Hugging Face GGUF pulls in Ollama’s model store using digest-verified registry blobs. */

import { homedir } from 'os'
import { join } from 'path'
import { readdir, stat, unlink } from 'fs/promises'
import { createHash } from 'crypto'
import { fetchWithTimeout } from '../../lib/fetchWithTimeout.js'
import { describeFetchError } from '../../lib/fetchErrorChain.js'
import { safeJSONParse, atomicWrite } from '../../lib/fileUtils.js'
import {
  parseOllamaModelRef, ollamaManifestRelPath,
  manifestBlobRefs, huggingFaceRegistryBase,
} from '../../lib/localLlmDisk.js'
import { buildHfAuthHeaders } from '../../lib/huggingfaceLora.js'

// Hugging Face can be pathologically slow serving the tiny (≈500 byte) *config*
// blob of a large GGUF repo — a cold CDN miss regularly takes 50-60s, well past
// Ollama's internal per-request deadline. The weight layers all reach 100%, then
// the pull dies with "context deadline exceeded" and no manifest is written, so
// the model vanishes even though ~30GB of verified blobs are on disk. Ollama
// itself doesn't resume that step, and every retry re-races the same deadline.
// So when a pull fails that way we finish it ourselves: fetch the manifest +
// missing blobs with a generous timeout, verify each digest, and write the
// manifest Ollama would have written. See isPullDeadlineError().
const HF_FINALIZE_TIMEOUT_MS = 180_000
// Only complete blobs small enough to hold in memory and hash in one shot — the
// config/params/template layers this recovery exists for are bytes-to-kilobytes.
// A missing multi-GB weight layer is a real download, not a stalled hiccup, so
// we bail and let the error surface rather than silently re-downloading it here.
const HF_FINALIZE_MAX_BLOB_BYTES = 4 * 1024 * 1024

/** Ollama's models root: `$OLLAMA_MODELS` or `~/.ollama/models`. */
function getModelsDir() {
  return process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')
}

// One expression for the canonical manifest path, so the recovery writer and
// findManifest's reader can't drift apart.
export const manifestPathFor = (modelsDir, ref) => join(modelsDir, ...ollamaManifestRelPath(ref).split('/'))

/**
 * Fetch a Hugging Face registry document (manifest or blob) as a Buffer, with a
 * timeout generous enough for HF's slow cold-CDN small-blob path (the very thing
 * Ollama's own deadline gives up on). Carries the user's HF token when they have
 * one, so a gated repo Ollama could pull is recoverable too.
 * @returns {Promise<{ buffer: Buffer }|{ error: string }>}
 */
async function fetchHuggingFaceDocument(url, headers) {
  return fetchWithTimeout(url, { headers }, HF_FINALIZE_TIMEOUT_MS)
    .then(async (response) => (response.ok
      ? { buffer: Buffer.from(await response.arrayBuffer()) }
      : { error: `${response.status} ${response.statusText}` }))
    .catch((err) => ({ error: describeFetchError(err) }))
}

/**
 * Finish a Hugging Face pull that downloaded its weights but died before Ollama
 * wrote the manifest (see HF_FINALIZE_TIMEOUT_MS). Re-fetches the manifest, then
 * for each blob it references: keeps an on-disk blob whose size already matches,
 * and downloads + digest-verifies any small missing one. Only when EVERY blob is
 * present and correct does it write the manifest — a half-written manifest would
 * leave `ollama run` failing on a missing blob, which is worse than no model.
 *
 * Digest verification is the whole safety story here: we are hand-placing files
 * into Ollama's content-addressed store, so a byte we didn't verify is a corrupt
 * model that reports as installed.
 *
 * Pure disk + network: the caller invalidates the installed-model cache, so this
 * stays safe to call from a future "repair this install" action.
 *
 * @param {string} modelId e.g. `hf.co/<owner>/<repo>:Q8_0`
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function finalizeHuggingFacePull(modelId) {
  const ref = parseOllamaModelRef(modelId)
  const base = huggingFaceRegistryBase(ref)
  if (!base) return { success: false, error: 'not a Hugging Face model ref' }

  const modelsDir = getModelsDir()
  const blobsDir = join(modelsDir, 'blobs')
  // Imported lazily: hfToken.js reaches settings.js, which resolves its file
  // path from PATHS at module load — a static import would drag that (and
  // everything settings pulls in) into every consumer of this module.
  const { getHfToken } = await import('../hfToken.js')
  const headers = buildHfAuthHeaders(await getHfToken())
  const fetched = await fetchHuggingFaceDocument(`${base}/manifests/${ref.tag}`, headers)
  if (fetched.error) return { success: false, error: `manifest fetch failed: ${fetched.error}` }

  const manifestText = fetched.buffer.toString('utf8')
  const refs = manifestBlobRefs(safeJSONParse(manifestText, null))
  if (refs.length === 0) return { success: false, error: 'manifest listed no blobs' }

  for (const blob of refs) {
    const blobPath = join(blobsDir, blob.filename)
    const existing = await stat(blobPath).then((s) => s.size, () => null)
    // Ollama already verified anything it finished writing, so a size match is
    // enough to accept it — re-hashing a 30GB weight layer would take minutes.
    if (existing !== null && existing === blob.size) continue
    if (blob.size === null || blob.size > HF_FINALIZE_MAX_BLOB_BYTES) {
      return { success: false, error: `blob ${blob.filename} (${blob.size ?? 'unknown'} bytes) is missing and too large to recover` }
    }
    const got = await fetchHuggingFaceDocument(`${base}/blobs/${blob.digest}`, headers)
    if (got.error) return { success: false, error: `blob ${blob.filename} fetch failed: ${got.error}` }
    const hex = createHash('sha256').update(got.buffer).digest('hex')
    if (hex !== blob.hex) return { success: false, error: `blob ${blob.filename} failed digest verification` }
    await atomicWrite(blobPath, got.buffer)
    console.log(`🧩 Ollama pull recovery: restored blob ${blob.filename.slice(0, 19)} (${got.buffer.length}B) for ${modelId}`)
  }

  // Ollama leaves `<blob>-partial*` scratch files behind for the download it
  // abandoned; they'd shadow the completed blobs on a future resume attempt. One
  // pass over the (potentially large) blobs dir clears every blob's leftovers.
  const scratch = await readdir(blobsDir).catch(() => [])
  await Promise.all(scratch
    .filter((name) => refs.some((blob) => name.startsWith(`${blob.filename}-partial`)))
    .map((name) => unlink(join(blobsDir, name)).catch(() => {})))

  // Write the manifest byte-for-byte as the registry served it so the digest
  // Ollama derives from it matches the registry's.
  await atomicWrite(manifestPathFor(modelsDir, ref), manifestText)
  console.log(`✅ Ollama pull recovery: wrote manifest for ${modelId} (${refs.length} blobs verified)`)
  return { success: true }
}

export {
  finalizeHuggingFacePull,
  getModelsDir
}
