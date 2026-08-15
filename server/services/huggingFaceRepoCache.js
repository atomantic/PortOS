// Disk-backed cache of Hugging Face per-repo metadata (`/api/models/<repo>?blobs=true`).
//
// The curated local-LLM catalog is a KNOWN, fixed list of ~36 repos. Enriching it
// needs each repo's per-file sizes and native context length — data the search
// listing omits — so before this cache every cold page load re-asked the Hub for
// all 36, and a server restart made every load cold again. That is both the burst
// that provokes the Hub's HTTP/2 GOAWAY and a standing cost paid for metadata that
// barely changes: a published GGUF repo's file sizes are immutable, and new quants
// appear on the order of weeks, not minutes.
//
// So the cache is deliberately long-lived (CACHE_TTL_MS) and survives restarts. It
// is `ephemeral-file` under docs/STORAGE.md — pure regenerable cache, losing it
// costs one refetch — so it lives in `data/cache/` and is excluded from backup.
//
// Records are stored WHOLE rather than projected down to the fields enrichment
// currently reads. A projection would be ~10x smaller (≈440B vs ≈5KB per repo),
// but it silently breaks the day someone reads a field the projection dropped —
// they'd get `undefined` from a cache hit and a correct value from a miss, which
// is the worst kind of bug to chase. At the 500-entry cap the whole file is ≈2.5MB.

import { join } from 'node:path'
import { PATHS, readJSONFileStrict, atomicWrite, ensureDir } from '../lib/fileUtils.js'

const CACHE_FILE = join(PATHS.data, 'cache', 'huggingface-repos.json')
// Bump when the envelope shape changes — a mismatch drops the file and refetches
// rather than trying to read an older layout.
const CACHE_SCHEMA_VERSION = 1
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

// Load the cache file once per process. A missing file is an empty cache; an
// unreadable or wrong-version one is ALSO an empty cache — this is regenerable
// data, so refetching is always a safe recovery and never costs the user
// anything durable.
// Memoized on the PROMISE, not the result: enrichment fires ~36 probes at once
// and they all reach this before the first read resolves, so keying on the
// settled Map would let every one of them re-read the file.
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
  // Drop stale entries on the way out, so the file self-prunes instead of
  // growing forever with repos the user searched once a year ago.
  const fresh = [...entries.entries()].filter(([, entry]) => isFresh(entry, now))
  // Newest-first, then cap — an overflowing cache should evict the entries least
  // likely to be wanted again, not whichever the Map happened to hold first.
  fresh.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
  const capped = fresh.slice(0, CACHE_MAX_ENTRIES)
  await ensureDir(join(PATHS.data, 'cache'))
  await atomicWrite(CACHE_FILE, {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: Object.fromEntries(capped)
  })
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  // Outside the request lifecycle — a throw here would be unhandled, so the
  // failure is logged and swallowed (per the root CLAUDE.md timer-callback rule).
  // A cache that fails to persist still works in memory; the next load refetches.
  saveTimer = setTimeout(() => {
    flush().catch((err) => console.error(`❌ Failed to persist Hugging Face repo cache: ${err.message}`))
  }, SAVE_DEBOUNCE_MS)
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
