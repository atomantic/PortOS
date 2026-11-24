/**
 * Offline disk access to Ollama's model store: manifest inventory, local GGUF
 * resolution and GGUF import for the backend-migration fast path. Split out of
 * ollamaManager.js so import/migration edits stay outside the daemon readiness
 * manager's wide import reach.
 */

import { dirname, join } from 'path'
import { readdir, stat, link } from 'fs/promises'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { describeFetchError } from '../lib/fetchErrorChain.js'
import { readJSONFile, sha256File, ensureDir } from '../lib/fileUtils.js'
import { parseOllamaManifest, parseOllamaModelRef, digestToBlobFilename, buildModelfile, manifestBlobRefs } from '../lib/localLlmDisk.js'
import {
  bustInstalledModelsCache, checkOllamaAvailable, getBaseUrl, getModelsDir, manifestPathFor, streamNdjson
} from './ollamaManager.js'

const fileExists = (p) => stat(p).then((s) => s.isFile()).catch(() => false)
const readManifest = (p) => readJSONFile(p, null, { logError: false })

/**
 * Enumerate Ollama manifests directly from disk so a stopped daemon does not
 * erase downloaded inventory. A corrupt or unreadable manifest rejects the
 * scan: counted UI must not turn unreadable state into a trustworthy empty.
 */
export async function listStoredModels() {
  const manifestsDir = join(getModelsDir(), 'manifests')
  const root = await stat(manifestsDir).then((entry) => entry.isDirectory(), (err) => {
    if (err?.code === 'ENOENT') return false
    throw err
  })
  if (!root) return []

  const registries = (await readdir(manifestsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
  const models = []
  for (const registry of registries) {
    const registryDir = join(manifestsDir, registry.name)
    const namespaces = (await readdir(registryDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
    for (const namespace of namespaces) {
      const namespaceDir = join(registryDir, namespace.name)
      const names = (await readdir(namespaceDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
      for (const name of names) {
        const nameDir = join(namespaceDir, name.name)
        const tags = (await readdir(nameDir, { withFileTypes: true }))
          .filter((entry) => entry.isFile())
        for (const tag of tags) {
          const manifest = await readJSONFile(join(nameDir, tag.name), null, { logError: false, strict: true })
          if (!manifest) throw new Error(`Ollama manifest disappeared during inventory: ${tag.name}`)
          const sizes = manifestBlobRefs(manifest).map((blob) => blob.size)
          const size = sizes.length > 0 && sizes.every(Number.isFinite)
            ? sizes.reduce((sum, value) => sum + value, 0)
            : null
          const localRegistry = registry.name === 'registry.ollama.ai'
          const localNamespace = namespace.name === 'library'
          const base = localRegistry && localNamespace
            ? name.name
            : localRegistry
              ? `${namespace.name}/${name.name}`
              : `${registry.name}/${namespace.name}/${name.name}`
          const id = `${base}:${tag.name}`
          models.push({ id, name: id, size })
        }
      }
    }
  }
  return models.sort((a, b) => (b.size || 0) - (a.size || 0))
}


// The canonical manifest path covers registry-pulled models; fall back to a
// shallow scan of manifests/<registry>/<namespace>/<name>/<tag> for custom
// registries/namespaces we didn't guess.
async function findManifest(modelsDir, ref) {
  const direct = await readManifest(manifestPathFor(modelsDir, ref))
  if (direct) return direct
  const manifestsDir = join(modelsDir, 'manifests')
  const registries = await readdir(manifestsDir).catch(() => [])
  for (const registry of registries) {
    const namespaces = await readdir(join(manifestsDir, registry)).catch(() => [])
    for (const ns of namespaces) {
      const candidate = join(manifestsDir, registry, ns, ref.name, ref.tag)
      const m = await readManifest(candidate)
      if (m) return m
    }
  }
  return null
}


/**
 * Locate an installed Ollama model's weight files on disk (no network).
 * @returns {Promise<{ ggufPath: string, projectorPath: string|null, isMlx: false, isSharded: false }|null>}
 */
export async function resolveLocalModel(modelId) {
  const modelsDir = getModelsDir()
  const manifest = await findManifest(modelsDir, parseOllamaModelRef(modelId))
  if (!manifest) return null
  const { modelDigest, projectorDigest } = parseOllamaManifest(manifest)
  if (!modelDigest) return null
  const ggufPath = join(modelsDir, 'blobs', digestToBlobFilename(modelDigest))
  if (!(await fileExists(ggufPath))) return null
  // Only report a projector the manifest references AND that's actually on disk
  // — a missing/corrupt projector blob shouldn't flag the model multimodal (and
  // block the fast path) or fail an LM Studio copy mid-way.
  let projectorPath = projectorDigest ? join(modelsDir, 'blobs', digestToBlobFilename(projectorDigest)) : null
  if (projectorPath && !(await fileExists(projectorPath))) projectorPath = null
  return { ggufPath, projectorPath, isMlx: false, isSharded: false }
}

/**
 * Pre-place the source GGUF as a hardlink at `blobs/sha256-<hash>` so the
 * subsequent `/api/create` reuses the existing (content-addressed) blob instead
 * of copying the multi-GB weights — zero extra disk, the file is shared with the
 * source backend's copy. Best-effort: a cross-filesystem hardlink (EXDEV) or any
 * error returns false and the caller's `/api/create` just copies as usual.
 * @returns {Promise<boolean>} whether the blob is now hardlinked
 */
async function prelinkBlob(ggufPath) {
  const hex = await sha256File(ggufPath)
  const blobPath = join(getModelsDir(), 'blobs', digestToBlobFilename(`sha256:${hex}`))
  if (await fileExists(blobPath)) return true // already present (content-addressed dedup)
  await ensureDir(dirname(blobPath))
  await link(ggufPath, blobPath)
  return true
}

/**
 * Register a local GGUF file as an Ollama model via `/api/create` (no download).
 * In `link` mode the blob is hardlinked into Ollama's store first so create
 * dedups against it (shared on disk); `copy` mode lets create copy the blob.
 * @param {{ name: string, ggufPath: string, mode?: 'link'|'copy' }} args
 * @returns {Promise<{ success: boolean, modelId?: string, linked?: boolean, error?: string }>}
 */
export async function importModelFromGguf({ name, ggufPath, mode = 'copy' }) {
  if (!(await checkOllamaAvailable())) {
    return { success: false, error: 'Ollama not available' }
  }
  const linked = mode === 'link' ? await prelinkBlob(ggufPath).catch(() => false) : false
  console.log(`📦 Ollama import (${linked ? 'hardlink' : 'copy'}): ${name} ← ${ggufPath}`)
  // No timeout — create may copy the (multi-GB) blob into the store (skipped
  // when we pre-hardlinked a matching blob above).
  const response = await fetchWithTimeout(`${getBaseUrl()}/api/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, modelfile: buildModelfile(ggufPath), stream: true })
  }, 0).catch((err) => ({ _err: describeFetchError(err) }))

  if (response._err || !response.ok || !response.body) {
    const error = response._err || `create failed: ${response.status} ${response.statusText}`
    return { success: false, error }
  }
  const lastError = await streamNdjson(response)
  if (lastError) return { success: false, error: lastError }
  bustInstalledModelsCache()
  console.log(`✅ Ollama import complete: ${name}${linked ? ' (hardlinked blob — no extra disk)' : ''}`)
  return { success: true, modelId: name, linked }
}
