/**
 * Migrates installed models between Ollama and LM Studio using local GGUF weights or catalog downloads.
 */

import { isBackend, mapModelToBackend } from '../lib/localLlmCatalog.js'
import { sanitizeOllamaName } from '../lib/localLlmDisk.js'
import { localModelInventoryRow } from '../lib/modelInventory.js'
import * as lmStudioManager from './lmStudioManager.js'
import { recordModelInstall } from './modelManifest.js'

/**
 * Try to provision a single source model on the target WITHOUT downloading, by
 * copying its GGUF weights across the two on-disk layouts (the underlying GGUF
 * is the same; only Ollama's content-addressed blob store vs LM Studio's plain
 * file tree differ). Returns a per-model result on success, or `null` to tell
 * the caller to fall back to a re-pull (no local file, MLX-only, multi-file
 * sharded, a multimodal projector we can't carry into Ollama, or a copy error).
 */
async function tryLocalImport(to, model, targetId, resolved, mode, onProgress) {
  // Fast path requires a single-file GGUF on disk. MLX (no GGUF) and sharded
  // models fall through; a separate projector can be copied to LM Studio but
  // not cleanly imported into Ollama, so that case re-pulls too.
  if (!resolved?.ggufPath || resolved.isSharded) return null
  if (to === 'ollama' && resolved.projectorPath) return null

  const name = to === 'ollama'
    ? sanitizeOllamaName(targetId || model.id)
    : (targetId || `imported/${model.id.split('/').pop()}`)
  const verb = mode === 'link' ? 'Linking' : 'Copying'
  onProgress({ event: 'start', message: `${verb} ${name} onto ${to} (no download)…` })
  const r = to === 'ollama'
    ? await (await import('./ollamaDiskImport.js')).importModelFromGguf({ name, ggufPath: resolved.ggufPath, mode })
    : await lmStudioManager.importModelFromGguf({ lmstudioId: name, ggufPath: resolved.ggufPath, projectorPath: resolved.projectorPath, mode })
  if (!r.success) {
    onProgress({ event: 'start', message: `Local import of ${model.id} failed (${r.error}); re-pulling…` })
    return null
  }
  // `linked` reflects what actually happened on disk — link mode falls back to a
  // copy across filesystems, so report the real outcome, not the requested mode.
  onProgress({ event: 'start', message: `${r.linked ? 'Linked' : 'Copied'} ${r.modelId} onto ${to} (no download)` })
  // A migration's fast path never goes through `installModel` — it moves the GGUF
  // itself — so it records its own arrival, or the target backend's newest models
  // would be the ones the manifest does not know about.
  await recordModelInstall({
    ...localModelInventoryRow({ backend: to, modelId: r.modelId }),
    source: 'import',
  })
  return { source: model.id, target: r.modelId, status: 'imported', linked: !!r.linked, reason: null }
}

/** The other of the two backends (migration source for a given target). */
const otherBackend = (backend) => (backend === 'ollama' ? 'lmstudio' : 'ollama')

/**
 * Provision the OTHER backend's installed models onto `to`. This is bidirectional
 * (source is simply the opposite backend, NOT the active one) and decoupled from
 * the default-backend marker — it never flips it. Use `switchBackend` ("Set as
 * Default") for routing. The underlying GGUF weights ARE portable across backends:
 *
 *   • `mode: 'link'` (default) — hardlink the GGUF so both backends share one file
 *     on disk (zero extra space), falling back to a copy where a hardlink isn't
 *     possible (different filesystem).
 *   • `mode: 'copy'` — make an independent duplicate.
 *
 * Either way there's no re-download for portable single-file GGUFs; models that
 * can't be shared/copied (LM Studio MLX-format, sharded, or with a separate
 * projector when targeting Ollama) fall back to re-pulling the catalog
 * equivalent. Per-model results are reported; an individual failure doesn't abort.
 *
 * @param {{ listManagedBackendModels: Function, installModel: Function, describeInstallProgress: Function }} models
 * @param {string} to - target backend
 * @param {{ mode?: 'link'|'copy', onProgress?: (p: { event: string, message: string }) => void }} [opts]
 */
export async function migrateLocalModels({ listManagedBackendModels, installModel, describeInstallProgress }, to, { mode = 'link', onProgress = () => {} } = {}) {
  if (!isBackend(to)) return { success: false, error: `Unknown backend: ${to}` }
  if (mode !== 'link' && mode !== 'copy') mode = 'link'
  const from = otherBackend(to)

  onProgress({ event: 'start', message: `Reading models installed on ${from}…` })
  const { models: sourceModels, error } = await listManagedBackendModels(from, true)
  if (error) {
    onProgress({ event: 'error', message: error })
    return { success: false, error }
  }
  if (!sourceModels || sourceModels.length === 0) {
    const message = `No models installed on ${from} to move.`
    onProgress({ event: 'complete', message })
    return { success: true, from, to, mode, results: [] }
  }

  const results = []
  for (const model of sourceModels) {
    const { targetId, exact } = mapModelToBackend(from, model.id, to)
    const resolveLocal = from === 'ollama' ? (await import('./ollamaDiskImport.js')).resolveLocalModel : lmStudioManager.resolveLocalModel
    const resolved = await resolveLocal(model.id).catch(() => null)

    // 1) Fast path — link/copy the GGUF locally (no download) when we can.
    const imported = await tryLocalImport(to, model, targetId, resolved, mode, onProgress)
    if (imported) { results.push(imported); continue }

    // 2) Fallback — re-pull the catalog equivalent.
    if (!targetId) {
      const reason = resolved?.isMlx ? 'MLX format — no GGUF equivalent to re-pull' : 'no known equivalent'
      results.push({ source: model.id, target: null, status: 'skipped', reason })
      onProgress({ event: 'start', message: `Skipped ${model.id} — ${reason}` })
      continue
    }
    onProgress({ event: 'start', message: `Downloading ${targetId} on ${to}${exact ? '' : ' (best-effort)'}…` })
    const r = await installModel(to, targetId, (p) => {
      const label = describeInstallProgress(p)
      if (label) onProgress({ event: 'start', message: `Pulling ${targetId}: ${label}` })
    })
    // `pending` (LM Studio REST fallback) means the download was queued, not
    // finished — don't report it as a completed install.
    const status = r.success ? (r.pending ? 'started' : 'installed') : 'failed'
    results.push({ source: model.id, target: targetId, status, reason: r.error })
  }

  const linked = results.filter((r) => r.status === 'imported' && r.linked).length
  const copied = results.filter((r) => r.status === 'imported' && !r.linked).length
  const installed = results.filter((r) => r.status === 'installed').length
  const started = results.filter((r) => r.status === 'started').length
  const failed = results.filter((r) => r.status === 'failed').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const succeeded = linked + copied + installed + started

  // Surface a hard failure when nothing could be provisioned (e.g. target not
  // installed/running). All-skipped is fine — the target works, we just had no
  // equivalent to move.
  if (failed > 0 && succeeded === 0) {
    const error = `Migration ${from} → ${to} failed — no models could be provisioned (is ${to} installed and running?).`
    onProgress({ event: 'error', message: error })
    console.error(`⚠️ Migration ${from} → ${to} aborted: ${failed} failed, 0 succeeded`)
    return { success: false, from, to, mode, error, results }
  }

  const parts = [
    linked ? `${linked} linked (shared on disk)` : null,
    copied ? `${copied} copied` : null,
    installed ? `${installed} downloaded` : null,
    started ? `${started} downloading` : null,
    failed ? `${failed} failed` : null,
    skipped ? `${skipped} skipped` : null
  ].filter(Boolean)
  onProgress({ event: 'complete', message: `Moved ${from} → ${to} — ${parts.join(', ') || 'no models to move'}` })
  console.log(`🔀 Moved models ${from} → ${to} (${linked} linked, ${copied} copied, ${installed} downloaded, ${failed} failed)`)
  return { success: true, from, to, mode, results }
}
