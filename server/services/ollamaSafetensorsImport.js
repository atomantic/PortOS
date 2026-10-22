/**
 * Lifecycle pieces for the curated Safetensors import in ollamaManager.js:
 * the supervised `ollama create` child and the staged-checkpoint directory it
 * reads from.
 *
 * Neither the Ollama CLI nor its HTTP client puts a deadline on `create`, so a
 * wedged CLI/daemon pair would hold the install request forever. The supervisor
 * bounds SILENCE, not wall time: a conversion that keeps printing new progress,
 * or keeps growing the daemon's blob store, may run as long as it needs.
 *
 * Killing the CLI does not prove the daemon stopped reading the staged files,
 * so the staging directory is deleted only after an open-file probe shows no
 * other process holds any of it. When that cannot be shown the directory is
 * kept, its marker file (the durable recovery record — it lives and dies with
 * the staging it describes) is stamped `retained`, and the next install of the
 * same model reuses it instead of downloading again.
 */

import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, readdir, readFile, rm, stat } from 'fs/promises'
import { spawn } from '../lib/childProcess.js'
import { atomicWrite, safeJSONParse, sleep } from '../lib/fileUtils.js'
import { killWithEscalation } from '../lib/killWithEscalation.js'
import { findOpenFileHolders } from '../lib/openFileHolders.js'

export const STAGING_PREFIX = 'portos-ollama-hf-import-'
const MARKER_NAME = 'portos-import.json'
export const CREATE_IDLE_LIMIT_MS = 10 * 60_000
const CREATE_CHECK_INTERVAL_MS = 15_000
const CREATE_KILL_GRACE_MS = 10_000
// After SIGKILL a live child exits within milliseconds; still being there this
// long later means PortOS cannot claim the operation ended.
const CREATE_EXIT_BOUND_MS = 30_000
const RELEASE_PROBE_ATTEMPTS = 4
const RELEASE_PROBE_DELAY_MS = 15_000
const OUTPUT_TAIL_CHARS = 8_192
const SEEN_LINES_CAP = 5_000

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g
const SPINNER_RE = /[⠀-⣿]/g
// Ollama's progress bar redraws a transfer rate and ETA on every tick even when
// nothing moves; those must not count as progress.
const RATE_RE = /\b\d+(?:\.\d+)?\s?[KMGT]?i?B\/s\b/gi
const DURATION_RE = /\b(?:\d+h)?(?:\d+m)?\d+(?:\.\d+)?(?:ms|s)\b|\b\d+h\d+m\b|\b\d+m\b/g

/** Complete output segments, reduced to the text that changes only on real progress. */
export function normalizeCreateOutput(text) {
  return String(text).replace(ANSI_RE, '').split(/[\r\n]+/)
    .map((line) => line.replace(SPINNER_RE, '').replace(RATE_RE, '').replace(DURATION_RE, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function lastErrorLine(tail) {
  const lines = normalizeCreateOutput(tail)
  return lines.reverse().find((line) => /error/i.test(line)) || lines[0] || null
}

/** Size signature of the daemon's blob store — grows while the daemon writes a converted layer. */
export async function blobStoreSignature(modelsDir) {
  const dir = join(modelsDir, 'blobs')
  const names = await readdir(dir).catch(() => null)
  if (!names) return null
  let bytes = 0
  for (const name of names) bytes += await stat(join(dir, name)).then((s) => s.size, () => 0)
  return `${names.length}:${bytes}`
}

/**
 * Run `ollama create` until it exits, or until neither its output nor
 * `probeProgress()` has changed for `idleLimitMs`, in which case the child is
 * stopped (SIGTERM, then SIGKILL). Always resolves, exactly once:
 *   { status: 'completed' } | { status: 'failed', error } |
 *   { status: 'stalled', error, exited } — `exited: false` means the child
 *   outlived SIGKILL and PortOS cannot claim the operation ended.
 */
export function runSupervisedOllamaCreate({
  modelId, modelfile, onStatus, probeProgress,
  idleLimitMs = CREATE_IDLE_LIMIT_MS, checkIntervalMs = CREATE_CHECK_INTERVAL_MS
}) {
  return new Promise((resolve) => {
    const child = spawn('ollama', ['create', modelId, '-f', modelfile], { stdio: ['ignore', 'pipe', 'pipe'] })
    let settled = false
    let exited = false
    let stalled = false
    let probing = false
    let lastProgressAt = Date.now()
    let lastSignature
    let partial = ''
    let tail = ''
    let exitTimer = null
    let interval = null
    const seen = new Set()
    const idleMinutes = Math.round(idleLimitMs / 60_000)
    const stallError = `Ollama stopped reporting progress while importing ${modelId} (nothing for ${idleMinutes} min), so PortOS stopped the import.`

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(exitTimer)
      resolve(outcome)
    }
    const onOutput = (chunk) => {
      const text = partial + chunk.toString()
      tail = (tail + chunk.toString()).slice(-OUTPUT_TAIL_CHARS)
      // Only judge complete segments, so a redraw split across two chunks
      // cannot masquerade as a new line.
      const cut = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r'))
      partial = text.slice(cut + 1).slice(-OUTPUT_TAIL_CHARS)
      for (const line of normalizeCreateOutput(text.slice(0, cut + 1))) {
        if (seen.has(line)) continue
        if (seen.size >= SEEN_LINES_CAP) seen.clear()
        seen.add(line)
        lastProgressAt = Date.now()
        try { onStatus?.(line) } catch (err) { console.error(`❌ ollama create progress handler failed: ${err.message}`) }
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    child.on('error', (err) => {
      exited = true
      finish({ status: 'failed', error: `Could not run ollama create: ${err.message}` })
    })
    child.on('close', (code, signal) => {
      exited = true
      if (stalled) return finish({ status: 'stalled', error: stallError, exited: true })
      if (code === 0) return finish({ status: 'completed' })
      finish({ status: 'failed', error: lastErrorLine(tail + partial) || `ollama create exited with ${code ?? signal}` })
    })

    const tick = async () => {
      if (stalled || exited || probing) return
      probing = true
      const signature = await Promise.resolve(probeProgress?.()).catch(() => null).finally(() => { probing = false })
      if (signature != null && signature !== lastSignature) {
        if (lastSignature !== undefined) lastProgressAt = Date.now()
        lastSignature = signature
      }
      if (stalled || exited || Date.now() - lastProgressAt < idleLimitMs) return
      stalled = true
      console.warn(`⚠️ ollama create ${modelId} made no progress for ${idleMinutes} min — stopping it`)
      killWithEscalation(child, { label: `ollama create ${modelId}`, stillRunning: () => !exited, delayMs: CREATE_KILL_GRACE_MS })
      exitTimer = setTimeout(() => finish({ status: 'stalled', error: stallError, exited: false }), CREATE_KILL_GRACE_MS + CREATE_EXIT_BOUND_MS)
      exitTimer.unref?.()
    }
    interval = setInterval(() => {
      tick().catch((err) => console.error(`❌ ollama create watchdog failed: ${err.message}`))
    }, checkIntervalMs)
    interval.unref?.()
  })
}

const markerPath = (tempRoot) => join(tempRoot, MARKER_NAME)

/** Create a staging directory whose marker names the import it belongs to. */
export async function createImportStaging({ modelId, repo, subdir }) {
  const tempRoot = await mkdtemp(join(tmpdir(), STAGING_PREFIX))
  await atomicWrite(markerPath(tempRoot), JSON.stringify({ modelId, repo, subdir, phase: 'downloading', createdAt: new Date().toISOString() }))
  return tempRoot
}

async function readMarker(tempRoot) {
  const raw = await readFile(markerPath(tempRoot), 'utf8').catch(() => null)
  const marker = raw == null ? null : safeJSONParse(raw, null)
  return marker && typeof marker === 'object' ? marker : null
}

export async function updateImportStaging(tempRoot, fields) {
  const marker = await readMarker(tempRoot)
  await atomicWrite(markerPath(tempRoot), JSON.stringify({ ...marker, ...fields }))
}

/** Newest staging directory left behind for `modelId`, or null. */
export async function findImportStaging(modelId) {
  const names = await readdir(tmpdir()).catch(() => [])
  let found = null
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const tempRoot = join(tmpdir(), name)
    const marker = await readMarker(tempRoot)
    if (marker?.modelId !== modelId) continue
    if (!found || String(marker.createdAt) > String(found.marker.createdAt)) found = { tempRoot, marker }
  }
  return found
}

/** True when every expected file is staged at its published size. */
export async function stagedFilesComplete(modelDir, files) {
  for (const file of files) {
    if (!(file.size > 0)) return false
    const size = await stat(join(modelDir, ...file.relativePath.split('/'))).then((s) => s.size, () => -1)
    if (size !== file.size) return false
  }
  return true
}

async function listFilesRecursive(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? listFilesRecursive(path) : [path]
  }))
  return nested.flat()
}

/**
 * Wait (bounded) for every other process to let go of the staging directory.
 * @returns {Promise<{ free: true } | { free: false, reason: string, pids?: number[] }>}
 */
export async function awaitStagingRelease(tempRoot, { attempts = RELEASE_PROBE_ATTEMPTS, delayMs = RELEASE_PROBE_DELAY_MS, probe = findOpenFileHolders } = {}) {
  const canary = markerPath(tempRoot)
  const files = (await listFilesRecursive(tempRoot)).filter((path) => path !== canary)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await probe(files, { canary })
    if (!result.known) return { free: false, reason: result.reason }
    if (result.pids.length === 0) return { free: true }
    if (attempt === attempts) return { free: false, reason: `still open in process ${result.pids.join(', ')}`, pids: result.pids }
    await sleep(delayMs)
  }
  return { free: false, reason: 'not probed' }
}

export async function removeImportStaging(tempRoot) {
  await rm(tempRoot, { recursive: true, force: true }).catch((err) => {
    console.error(`❌ Ollama Safetensors import cleanup failed: ${err.message}`)
  })
}
