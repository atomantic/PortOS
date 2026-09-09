/**
 * Shared Hugging Face metadata for local-model discovery.
 *
 * Owns authenticated list/repo reads, retry and concurrency budgets, and the
 * memory → disk → Hub cache. Use fetchModels for raw search rows,
 * fetchRepoModel for a size-bearing repo record, and fetchRepoPublishedDates
 * for bounded best-effort age enrichment (including non-Hub listings).
 *
 * Catalog ranking, GGUF/MLX variants, fit and installability stay in
 * huggingFaceCatalog.js; disk persistence stays in huggingFaceRepoCache.js.
 * Keep consumers on this service so they share one cache and request budget
 * without importing model selection or music rendering.
 */

import { getHfToken } from './hfToken.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { createConcurrencyGate } from '../lib/concurrencyGate.js'
import { createSingleFlight } from '../lib/singleFlight.js'
import { describeFetchError, isReplayableConnectionError } from '../lib/fetchErrorChain.js'
import { readCachedRepoModel, writeCachedRepoModel } from './huggingFaceRepoCache.js'

const HF_API_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 12_000
// Pause before the single connection-blip retry (see hfFetch).
const HF_RETRY_DELAY_MS = 250
// Budget for the publish-date lookup behind a checkpoint search. Deliberately
// longer than CATALOG_ENRICH_TIMEOUT_MS: that bound exists because the curated
// catalog must stay usable with zero enrichment offline, whereas a search's ages
// ARE the enrichment, and on a cold cache these probes can sit behind the
// catalog's own fan-out in the shared gate. Still bounded — a hung Hub must not
// hold the search open indefinitely.
const PUBLISH_DATE_BUDGET_MS = 15_000
// Hard cap on repos probed per publish-date lookup, independent of the caller's
// page size — abandoned probes keep draining through hfGate after the response.
const MAX_PUBLISH_DATE_PROBES = 24

async function hfHeaders() {
  const headers = { Accept: 'application/json' }
  const token = await getHfToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

// 4 at a time, shared by BOTH entry points: a cold catalog load fires ~36
// `?blobs=true` probes and a keystroke fires up to 18 more, concurrently — a
// burst the Hub answers with an HTTP/2 GOAWAY. See concurrencyGate for why a
// shared gate rather than a per-map cap.
const hfGate = createConcurrencyGate(4)
// The interactive search's own LIST query gets a separate, tiny budget so it is
// never stuck behind the catalog's fan-out. `enrichCatalogWithVariants` bounds
// how long the *response* waits, not the probes themselves — abandoned probes
// keep draining through hfGate — so a user who lands on the curated tab and then
// switches to Hugging Face would otherwise queue behind up to ~32 waiters. On a
// degraded Hub each of those costs two timeouts, which is minutes of a search box
// that has not even issued its request yet. This query is 1–2 requests, not a
// fan-out, so a budget of 2 keeps the total offered to the Hub bounded (4 + 2)
// while making the path the user is actually waiting on independent.
const hfSearchGate = createConcurrencyGate(2)
// Coalesce concurrent probes of the SAME repo — a repo can appear in both the
// curated catalog and the live search, and neither caches until it resolves.
const repoModelFlight = createSingleFlight()

// Statuses that are a real, durable "this repo has no data" answer and so are
// safe to cache. Everything else non-OK (including auth denials, rate limits,
// 5xx, and 408) may change and must be retried on a later lookup — mirrors
// `resolveRegistryBody` in ollamaRegistryCatalog.js, which has always drawn this
// line.
// Authentication denials are deliberately excluded: a user can add a token or
// gain access to a gated repo at any time, so caching a 401/403 would keep the
// catalog blank until the seven-day repo-cache TTL expires. A genuinely missing
// or gone repo remains a durable no-data answer.
const HF_PERMANENT_NOT_FOUND = new Set([404, 410])

// Single door to the Hub: bounded concurrency + the shared one-shot retry.
//
// Returns a discriminated outcome rather than a Response, because the body must
// be consumed INSIDE the gate slot. Releasing at response headers would bound
// only the header waits while every body streamed concurrently — i.e. exactly
// the many-simultaneous-streams-on-one-pooled-connection condition that earns
// the GOAWAY this gate exists to prevent.
//
//   { outcome: 'ok', data }                    — 2xx with a parseable body
//   { outcome: 'permanent', status, errorText } — a durable no-data answer; cacheable
//   { outcome: 'transient', status, errorText } — a bad moment; MUST NOT be cached
//
// Throws only when both attempts failed at the connection level.
function hfFetch(url) {
  return hfGate.run(async () => {
    const res = await fetchWithTimeout(
      url,
      { headers: await hfHeaders() },
      HF_TIMEOUT_MS,
      { retries: 1, retryDelayMs: HF_RETRY_DELAY_MS, shouldRetry: isReplayableConnectionError }
    // Both attempts lost the connection. undici's own message is a bare `fetch
    // failed`, which reaches the search box verbatim and reads like a bug in
    // PortOS — name the actual condition so the user knows to just try again.
    ).catch((err) => {
      if (!isReplayableConnectionError(err)) throw err
      throw new Error(`Hugging Face is not responding (connection dropped twice) — try again in a moment. [${describeFetchError(err)}]`)
    })
    if (!res.ok) {
      const errorText = await res.text().catch(() => '')
      const outcome = HF_PERMANENT_NOT_FOUND.has(res.status) ? 'permanent' : 'transient'
      return { outcome, status: res.status, errorText }
    }
    // A 200 whose body won't parse is a proxy/captive-portal error page, not an
    // answer about the repo — transient, so it is never cached as "no data".
    const data = await readResponseJson(res, { fallback: null })
    return data == null
      ? { outcome: 'transient', status: res.status, errorText: 'unparseable response body' }
      : { outcome: 'ok', data }
  })
}

// `filter` is a Hugging Face library tag — 'gguf' for the GGUF query, 'mlx' for
// the Apple-MLX query, or null/'' to relax the format filter (audio category and
// the GGUF-signal fallback). Only one filter at a time; MLX runs as a separate
// query so its results don't pollute the GGUF list.
export async function fetchModels(search, limit, filter) {
  const params = new URLSearchParams({
    search,
    sort: 'downloads',
    direction: '-1',
    limit: String(limit),
    full: 'true'
  })
  if (filter) params.set('filter', filter)

  const result = await hfSearchGate.run(() => hfFetch(`${HF_API_BASE}?${params.toString()}`))
  if (result.outcome !== 'ok') {
    const detail = result.errorText ? ` — ${result.errorText.slice(0, 160)}` : ''
    throw new Error(`Hugging Face search failed: ${result.status}${detail}`)
  }
  return Array.isArray(result.data) ? result.data : []
}

const repoModelCache = new Map()
const REPO_MODEL_CACHE_MAX = 500
// A connection-level failure (network down / both retry attempts dropped) —
// distinct both from a durable no-data answer (401/403/404/410, cacheable) and
// from a transient HTTP status (429/5xx), which `hfFetch` reports as
// `outcome: 'transient'`. Neither transient form may be cached: doing so would
// disable enrichment for the repo until the TTL expires, a week later.
const TRANSIENT_FETCH = Symbol('transient-fetch')

// Fetch (and cache) the per-model record WITH per-file sizes. The search
// endpoint returns siblings without sizes; only `?blobs=true` carries them.
//
// Three tiers, cheapest first: an in-process Map, then the disk cache
// (huggingFaceRepoCache.js), then the Hub. The disk tier is what stops the
// curated catalog — a KNOWN, fixed list of ~36 repos — from re-asking the Hub
// for all of them after every restart, self-update, or dev reload. Steady state
// on that path is zero network.
//
// `null` = fetched-but-unavailable, and it is cached at both tiers (per the
// absent-vs-empty sentinel rule) so a sizeless repo isn't re-probed every search
// — but ONLY when the Hub gave a durable answer (404/410). An auth denial, rate
// limit, 5xx, or dropped connection also returns null and is NOT cached, so a
// newly authorized or recovered Hub re-enriches on the next request instead of
// staying blank for the week the disk TTL would otherwise hold it.
export async function fetchRepoModel(repoId) {
  if (repoModelCache.has(repoId)) return repoModelCache.get(repoId)
  return repoModelFlight.run(repoId, async () => {
    const cached = await readCachedRepoModel(repoId)
    // `hit` is separate from the value because a cached `model` of null is a
    // real answer (gated/absent), not a miss.
    if (cached.hit) {
      rememberRepoModel(repoId, cached.model)
      return cached.model
    }
    // repoId comes from the HF search response (untrusted upstream) — encode each
    // path segment so a `?`/`#`/`..` in the id can't reshape the request path/query.
    const safeRepoPath = String(repoId).split('/').map(encodeURIComponent).join('/')
    const result = await hfFetch(`${HF_API_BASE}/${safeRepoPath}?blobs=true`)
      .catch(() => TRANSIENT_FETCH)
    // Transient — a rate limit, a 5xx, or a dropped connection. Return null so
    // this load degrades gracefully, but do NOT cache it: persisting a transient
    // as "no data" would bake a bad moment into the disk tier for the full TTL,
    // and a restart would no longer clear it the way the old memory-only cache did.
    if (result === TRANSIENT_FETCH || result.outcome === 'transient') return null
    // 'permanent' (gone) IS a real answer — cache the null. Auth denials are
    // transient because the user's credentials or repository access can change.
    const model = result.outcome === 'ok' ? result.data : null
    rememberRepoModel(repoId, model)
    await writeCachedRepoModel(repoId, model)
    return model
  })
}

function rememberRepoModel(repoId, model) {
  // Evict oldest entry when the cap is reached (insertion-order iteration).
  if (repoModelCache.size >= REPO_MODEL_CACHE_MAX) {
    repoModelCache.delete(repoModelCache.keys().next().value)
  }
  repoModelCache.set(repoId, model)
}

// Publish dates for a set of Hugging Face repos, as `{ repoId: createdAt|null }`.
//
// For lists whose rows come from somewhere OTHER than the Hub's own search — the
// MTPLX discover listing, which carries downloads and license but no dates — so
// the card can say how old a checkpoint is. Reuses fetchRepoModel's three tiers
// (memory → disk → Hub) and its gate, so a repeated search is free and a burst
// stays inside the same concurrency budget as everything else here.
//
// Never throws and never fails the caller's list: a repo the Hub has no answer
// for (gated, renamed, offline) resolves to `null`, which the UI renders as a
// missing age rather than an error.
export async function fetchRepoPublishedDates(repoIds = [], { timeoutMs = PUBLISH_DATE_BUDGET_MS } = {}) {
  // Cap the fan-out independently of the caller's page size. The MTPLX search
  // endpoint accepts limit=100, and every unresolved probe keeps draining through
  // the shared hfGate after the response returns — starving curated-catalog and
  // HF-search enrichment on a degraded Hub for as long as it takes. A page of
  // ages beyond the first two dozen rows is not worth that.
  const unique = [...new Set(repoIds.filter((id) => typeof id === 'string' && id.includes('/')))]
    .slice(0, MAX_PUBLISH_DATE_PROBES)
  // Seeded with nulls and filled in place, so the budget below can return early
  // with a partial answer instead of an empty one.
  const dates = Object.fromEntries(unique.map((repo) => [repo, null]))
  const work = Promise.allSettled(unique.map(async (repo) => {
    const model = await fetchRepoModel(repo)
    dates[repo] = model?.createdAt || model?.created_at || null
  }))
  // Bound the wait the way enrichCatalogWithVariants does, so an unreachable Hub
  // can never hang a search. Whatever resolved in time is already in `dates`; the
  // rest stay null and the card simply omits that row's age. Note a TRANSIENT
  // failure caches nothing (see fetchRepoModel), so those repos are re-probed on
  // the next search rather than being remembered as dateless.
  if (timeoutMs > 0) {
    let timer
    const budget = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.() })
    await Promise.race([work.finally(() => clearTimeout(timer)), budget])
  } else {
    await work
  }
  return dates
}
