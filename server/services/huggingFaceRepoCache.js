// Disk-backed cache of Hugging Face per-repo metadata (`/api/models/<repo>?blobs=true`).
//
// The curated local-LLM catalog is a fixed list of ~36 repos whose enrichment needs per-file
// sizes and context length; re-asking the Hub on every cold load provokes its HTTP/2 GOAWAY,
// for data that barely changes. So the cache is long-lived (CACHE_TTL_MS) and survives restarts.
//
// Storage: `ephemeral-file` — machine-local, never federated, a regenerable projection in
// `data/cache/`. Non-overridable backup exclude; purgeable from Data Manager (`cache`).
//
// Records are stored WHOLE, not projected to the fields enrichment reads today: a projection
// would return `undefined` on a hit and a value on a miss the day someone reads a dropped field.

import { join } from 'node:path'
import { PATHS, readJSONFileStrict, atomicWrite, ensureDir } from '../lib/fileUtils.js'

const CACHE_FILE = join(PATHS.data, 'cache', 'huggingface-repos.json')
// Bump when the envelope shape changes — a mismatch drops the file and refetches
// rather than trying to read an older layout.
// v2 invalidates legacy `model: null` entries, which may represent a cached
// 401/403 from before auth denials became retryable (#4365). Their envelope did
// not retain the HTTP status, so selective migration is impossible.
const CACHE_SCHEMA_VERSION = 2
// 7 days. Long because the payload is near-immutable (published file sizes never
// change); bounded because a repo CAN gain a new quant, and a stale card would
// hide it indefinitely.
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
// Matches the in-memory cap so the two tiers can't disagree about what fits.
const CACHE_MAX_ENTRIES = 500
// Coalesce the write burst: enriching a catalog resolves ~36 probes within a
// second or two, and each one would otherwise rewrite the whole file.
const SAVE_DEBOUNCE_MS = 2_000

// repoId -> { fetchedAt, model }. `model: null` is a REAL cached answer (gated /
// private / 404), distinct from an absent key — same absent-vs-empty sentinel
// discipline the in-memory tier uses.
let entries = null // null = not loaded yet (distinct from loaded-and-empty)
let loading = null // in-flight load promise, so a burst of readers shares one file read
let saveTimer = null
let dirty = false

function isFresh(entry, now) {
  return Boolean(entry) && Number.isFinite(entry.fetchedAt) && (now - entry.fetchedAt) < CACHE_TTL_MS
}

// Load the cache file once per process. A missing, unreadable or wrong-version file is an
// empty cache (regenerable data; refetching is always safe). Memoized on the PROMISE, not
// the result: ~36 concurrent probes reach this before the first read resolves.
async function load() {
  if (!loading) loading = readEntries()
  return loading
}

async function readEntries() {
  const { ok, value } = await readJSONFileStrict(CACHE_FILE, null)
  entries = new Map()
  if (!ok || value?.schemaVersion !== CACHE_SCHEMA_VERSION || !value?.entries) return entries
  const now = Date.now()
  for (const [repoId, entry] of Object.entries(value.entries)) {
    if (isFresh(entry, now)) entries.set(repoId, entry)
  }
  return entries
}

async function flush() {
  saveTimer = null
  if (!dirty || !entries) return
  dirty = false
  const now = Date.now()
  // Drop stale entries so the file self-prunes; newest-first, then cap, so overflow evicts
  // the least likely to be wanted again.
  const fresh = [...entries.entries()].filter(([, entry]) => isFresh(entry, now))
  fresh.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
  const capped = fresh.slice(0, CACHE_MAX_ENTRIES)
  // Apply the prune+cap to the IN-MEMORY map too: nothing else evicts from it, and each
  // search enriches up to 18 repos at ~5 KB apiece.
  //
  // Prune IN PLACE, never `entries = new Map(capped)`: `load()` is memoized on its promise,
  // so every holder has the original Map; rebinding would leave writers on the old Map and
  // nothing written after the first flush would persist. Regression-tested.
  const keep = new Set(capped.map(([repoId]) => repoId))
  for (const repoId of [...entries.keys()]) {
    if (!keep.has(repoId)) entries.delete(repoId)
  }
  await ensureDir(join(PATHS.data, 'cache'))
  await atomicWrite(CACHE_FILE, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: Object.fromEntries(capped)
  })
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  // Timer callback: a throw would be unhandled, so log and swallow. A cache that fails to
  // persist still works in memory; the next load refetches.
  saveTimer = setTimeout(() => {
    flush().catch((err) => console.error(`❌ Failed to persist Hugging Face repo cache: ${err.message}`))
  }, SAVE_DEBOUNCE_MS)
  // unref'd so a pending write never holds the process open; a shutdown inside the debounce
  // window drops that batch and the next boot refetches. Deliberately NOT closed with a
  // SIGTERM/SIGINT handler: a leaf cache registering one overrides Node's default
  // terminate-on-signal and can make a script or test stop dying on Ctrl-C. Process
  // lifecycle belongs to server/index.js.
  saveTimer.unref?.()
}

/**
 * Read a cached repo record.
 * @returns {Promise<{ hit: boolean, model: object|null }>} `hit: false` on a miss
 *   or an expired entry. On a hit, `model` may legitimately be `null` (the repo is
 *   gated/private/absent) — which is why the hit flag is separate from the value.
 */
export async function readCachedRepoModel(repoId) {
  const store = await load()
  const entry = store.get(repoId)
  if (!isFresh(entry, Date.now())) return { hit: false, model: null }
  return { hit: true, model: entry.model }
}

/** Record a fetched repo record (`null` = fetched-but-unavailable). */
export async function writeCachedRepoModel(repoId, model) {
  const store = await load()
  store.set(repoId, { fetchedAt: Date.now(), model })
  scheduleSave()
}

/** Test hook — drop in-memory state so a suite starts from a known cache. */
export function __resetRepoCache() {
  entries = null
  loading = null
  dirty = false
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
}

/** Test hook — force the pending debounced write to complete now. */
export async function __flushRepoCache() {
  if (saveTimer) clearTimeout(saveTimer)
  await flush()
}
