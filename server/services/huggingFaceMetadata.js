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
// Budget for the publish-date lookup behind a checkpoint search; longer than
// CATALOG_ENRICH_TIMEOUT_MS because here ages ARE the enrichment, but still bounded.
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

// 4 at a time, shared by BOTH entry points: a cold catalog load fires ~36 `?blobs=true`
// probes plus up to 18 per keystroke, a burst the Hub answers with an HTTP/2 GOAWAY.
const hfGate = createConcurrencyGate(4)
// The interactive search's own LIST query gets a small separate budget so it is never stuck
// behind the catalog's fan-out (abandoned probes keep draining through hfGate); 1–2
// requests, so 2 keeps the total offered to the Hub bounded (4 + 2).
const hfSearchGate = createConcurrencyGate(2)
// Coalesce concurrent probes of the SAME repo — a repo can appear in both the
// curated catalog and the live search, and neither caches until it resolves.
const repoModelFlight = createSingleFlight()

// Statuses that are a durable "no data" answer and safe to cache; everything else non-OK
// may change and is retried later (mirrors `resolveRegistryBody` in ollamaRegistryCatalog.js).
// Auth denials are excluded: a user can add a token or gain access at any time.
const HF_PERMANENT_NOT_FOUND = new Set([404, 410])

// Single door to the Hub: bounded concurrency + the shared one-shot retry. Returns a
// discriminated outcome, not a Response, because the body must be consumed INSIDE the gate
// slot (releasing at headers would let bodies stream concurrently and earn the GOAWAY):
//   { outcome: 'ok', data }                    — 2xx with a parseable body
//   { outcome: 'permanent', status, errorText } — a durable no-data answer; cacheable
//   { outcome: 'transient', status, errorText } — a bad moment; MUST NOT be cached
// Throws only when both attempts failed at the connection level.
function hfFetch(url) {
  return hfGate.run(async () => {
    const res = await fetchWithTimeout(
      url,
      { headers: await hfHeaders() },
      HF_TIMEOUT_MS,
      { retries: 1, retryDelayMs: HF_RETRY_DELAY_MS, shouldRetry: isReplayableConnectionError }
    // undici's bare `fetch failed` reads like a PortOS bug in the search box; name the
    // actual condition.
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
// `filter` is one Hub filter or a list of them; repeated `filter` params AND
// together (`['gguf', 'base_model:quantized:<repo>']` = that repo's GGUF quants).
export async function fetchModels(search, limit, filter) {
  const params = new URLSearchParams({
    sort: 'downloads',
    direction: '-1',
    limit: String(limit),
    full: 'true'
  })
  if (search) params.set('search', search)
  for (const value of [filter].flat().filter(Boolean)) params.append('filter', value)

  const result = await hfSearchGate.run(() => hfFetch(`${HF_API_BASE}?${params.toString()}`))
  if (result.outcome !== 'ok') {
    const detail = result.errorText ? ` — ${result.errorText.slice(0, 160)}` : ''
    throw new Error(`Hugging Face search failed: ${result.status}${detail}`)
  }
  return Array.isArray(result.data) ? result.data : []
}

const repoModelCache = new Map()
const REPO_MODEL_CACHE_MAX = 500
// A connection-level failure (network down / both attempts dropped), distinct from a durable
// no-data answer (401/403/404/410) and a transient HTTP status (429/5xx). Neither transient
// form may be cached or enrichment stays disabled for the repo until the TTL expires.
const TRANSIENT_FETCH = Symbol('transient-fetch')

// Fetch (and cache) the per-model record WITH per-file sizes (only `?blobs=true` carries
// them). Tiers, cheapest first: in-process Map, disk cache (huggingFaceRepoCache.js), Hub;
// the disk tier keeps the ~36-repo curated catalog at zero network after a restart.
//
// `null` = fetched-but-unavailable, cached at both tiers ONLY for a durable answer (404/410).
// Auth denial, rate limit, 5xx or a dropped connection also return null and are NOT cached,
// so a recovered or newly authorized Hub re-enriches instead of staying blank for the TTL.
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
    // Transient: return null but do NOT cache; persisting it as "no data" would hold a bad
    // moment in the disk tier for the full TTL.
    if (result === TRANSIENT_FETCH || result.outcome === 'transient') return null
    // 'permanent' IS a real answer, so cache the null. Auth denials are transient because
    // credentials or repo access can change.
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

// Publish dates for a set of repos, as `{ repoId: createdAt|null }`, for lists sourced from
// outside the Hub search (the MTPLX listing has no dates). Reuses fetchRepoModel's tiers and
// gate. Never throws: a repo the Hub has no answer for resolves to `null`.
export async function fetchRepoPublishedDates(repoIds = [], { timeoutMs = PUBLISH_DATE_BUDGET_MS } = {}) {
  // Cap fan-out independently of page size (MTPLX allows limit=100): unresolved probes keep
  // draining through hfGate and would starve catalog and search enrichment on a degraded Hub.
  const unique = [...new Set(repoIds.filter((id) => typeof id === 'string' && id.includes('/')))]
    .slice(0, MAX_PUBLISH_DATE_PROBES)
  // Seeded with nulls and filled in place, so the budget below can return early
  // with a partial answer instead of an empty one.
  const dates = Object.fromEntries(unique.map((repo) => [repo, null]))
  const work = Promise.allSettled(unique.map(async (repo) => {
    const model = await fetchRepoModel(repo)
    dates[repo] = model?.createdAt || model?.created_at || null
  }))
  // Bound the wait so an unreachable Hub can't hang a search; resolved repos are already in
  // `dates`, the rest stay null. Transient failures cache nothing, so they re-probe later.
  if (timeoutMs > 0) {
    let timer
    const budget = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.() })
    await Promise.race([work.finally(() => clearTimeout(timer)), budget])
  } else {
    await work
  }
  return dates
}
