// Ollama-registry quant discovery for bare curated catalog names.
//
// The curated catalog (server/lib/localLlmCatalog.js) ships two kinds of Ollama
// install ids:
//   - `hf.co/<repo>[:quant]` — Hugging Face-backed; enriched by the HF path in
//     huggingFaceCatalog.js (it reads the repo's GGUF siblings).
//   - bare registry names (`llama3.2`, `qwen2.5`, `gpt-oss:20b`, `llama3.3:70b`)
//     — these pull from Ollama's OWN registry, not Hugging Face, so the HF path
//     has nothing to enumerate.
//
// This module gives the bare-name cards the same per-quant variant data by
// discovering each model's tags from the Ollama registry and reading per-quant
// weight sizes from the registry manifests. It returns raw variant candidates
// (`{ tag, installId, quant, sizeBytes }`); the fit/recommended/installed
// assembly stays in huggingFaceCatalog.js so the GGUF and Ollama-registry cards
// behave identically.
//
// Network is bounded by the same discipline as fetchRepoModel: per-process
// caches with a `null` sentinel (fetched-but-unavailable, cached) distinct from
// a transient failure (returns null, NOT cached, so a recovered registry
// re-enriches on the next request).

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'

const REGISTRY_BASE = 'https://registry.ollama.ai/v2'
const REGISTRY_TIMEOUT_MS = 12_000
// Ollama publishes OCI image manifests; the model weights live in a layer with
// this media type (template/params/license layers carry the other media types).
const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json'
const MODEL_LAYER_MEDIA_TYPE = 'application/vnd.ollama.image.model'
// Upper bound on distinct quant variants probed per card. After dedup-by-quant
// at the target size this is rarely hit (a model ships ~4–8 quants), but it caps
// the manifest fan-out for a pathologically tag-heavy model.
const MAX_VARIANTS = 12

const tagsCache = new Map()
const manifestCache = new Map()
const CACHE_MAX = 500
// A transient fetch failure (network down / timeout / malformed body / 5xx / 429)
// — distinct from a genuine permanent non-OK (404 / 410 / 403). The former must
// NOT be cached (it would permanently disable enrichment until the registry
// recovers); the latter is a real "no such model" answer worth caching.
const TRANSIENT_FETCH = Symbol('ollama-registry-transient')

function cacheSet(cache, key, value) {
  // Evict oldest entry when the cap is reached (insertion-order iteration).
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
  cache.set(key, value)
}

// Resolve a fetch Response into either the parsed JSON body, `null` (a permanent
// "no data" answer worth caching — model genuinely absent), or TRANSIENT_FETCH (a
// retry-worthy failure that must NOT be cached). Permanent = 404 Not Found / 410
// Gone / 403 Forbidden; everything else non-OK (500/502/503/408/429/…) is transient,
// as is an OK response whose body won't parse (a proxy/captive-portal error page
// served as HTTP 200 — `readResponseJson` returns its fallback rather than throwing).
const PERMANENT_NOT_FOUND = new Set([403, 404, 410])
function resolveRegistryBody(res) {
  if (res.ok) return readResponseJson(res, { fallback: TRANSIENT_FETCH, emptyValue: TRANSIENT_FETCH })
  return PERMANENT_NOT_FOUND.has(res.status) ? null : TRANSIENT_FETCH
}

// Split a curated Ollama install id into its registry path + optional tag.
//   `gpt-oss:20b`          → { name: 'gpt-oss', repoPath: 'library/gpt-oss', tag: '20b' }
//   `llama3.2`             → { name: 'llama3.2', repoPath: 'library/llama3.2', tag: null }
//   `namespace/model:tag`  → { name: 'namespace/model', repoPath: 'namespace/model', tag: 'tag' }
// Bare names live in the registry's implicit `library` namespace. hf.co-prefixed
// ids are NOT registry names (the HF path owns them) — returns null.
export function parseOllamaRegistryId(id) {
  const raw = String(id || '').trim()
  if (!raw || /^hf\.co\//i.test(raw)) return null
  const slash = raw.indexOf('/')
  const colon = raw.lastIndexOf(':')
  // A colon only marks a tag when it follows the namespace slash (or there's no
  // slash); a `:` inside a namespace segment would never occur for these ids.
  const hasTag = colon > slash
  const name = hasTag ? raw.slice(0, colon) : raw
  const tag = hasTag ? raw.slice(colon + 1) : null
  if (!name) return null
  const repoPath = name.includes('/') ? name : `library/${name}`
  return { name, repoPath, tag }
}

// Ollama quant suffix from a tag. Tags mix size + quant
// (`3b`, `q4_K_M`, `3b-instruct-q4_K_M`, `q8_0`, `fp16`); the quant is the
// trailing component. Returns a canonical UPPERCASE quant (`Q4_K_M`, `Q8_0`,
// `FP16`, `BF16`) so it ranks against the shared QUANT_PRIORITY (matched
// case-insensitively), or null when the tag carries no quant.
const OLLAMA_QUANT_RE = /(?:^|-)(iq\d(?:_[a-z0-9]+)*|q\d(?:_[a-z0-9]+)*|bf16|fp16|f16|fp32|f32)$/i
export function quantFromOllamaTag(tag) {
  const m = String(tag || '').match(OLLAMA_QUANT_RE)
  return m ? m[1].toUpperCase() : null
}

// Leading parameter-size token of a tag or params hint: `3b`, `70b`, `1.5b`,
// `35b` (from `35b-a3b` or `35B / 3B active`). Lowercased; null when absent
// (`q4_K_M`, `latest`, an embedding model's `137m`).
export function sizeTokenOf(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*b\b/i)
  return m ? `${m[1]}b`.toLowerCase() : null
}

// Sum the model-weight layer(s) of an Ollama OCI manifest. Returns null when the
// manifest has no model layer (or no positive total) so the caller keeps the
// curated size estimate rather than showing 0.
export function sumModelLayerBytes(manifest) {
  const layers = Array.isArray(manifest?.layers) ? manifest.layers : []
  const total = layers
    .filter((l) => l?.mediaType === MODEL_LAYER_MEDIA_TYPE)
    .reduce((sum, l) => sum + (Number.isFinite(l?.size) ? l.size : 0), 0)
  return total > 0 ? total : null
}

// Prefer an instruct/chat build over a base/text build when two tags map to the
// same quant at the same size, then the shorter (plainer) tag.
function tagRank(tag) {
  if (/(instruct|chat|(?:^|-)it(?:$|-))/i.test(tag)) return 0
  if (/(?:^|-)(text|base)(?:$|-)/i.test(tag)) return 2
  return 1
}
function preferTag(candidate, current) {
  const cr = tagRank(candidate)
  const curr = tagRank(current)
  if (cr !== curr) return cr < curr
  return candidate.length < current.length
}

async function fetchTags(repoPath, timeoutMs) {
  if (tagsCache.has(repoPath)) return tagsCache.get(repoPath)
  // repoPath is derived from a curated id, but encode each segment defensively so
  // a stray character can't reshape the request path.
  const safePath = repoPath.split('/').map(encodeURIComponent).join('/')
  const result = await fetchWithTimeout(`${REGISTRY_BASE}/${safePath}/tags/list`, { headers: { Accept: 'application/json' } }, timeoutMs)
    .then(resolveRegistryBody)
    .catch(() => TRANSIENT_FETCH)
  if (result === TRANSIENT_FETCH) return null // transient (throw / 5xx / 429 / unparseable 200) — don't cache
  const tags = Array.isArray(result?.tags) ? result.tags : null
  cacheSet(tagsCache, repoPath, tags)
  return tags
}

async function fetchManifestModelBytes(repoPath, tag, timeoutMs) {
  const key = `${repoPath}:${tag}`
  if (manifestCache.has(key)) return manifestCache.get(key)
  const safePath = repoPath.split('/').map(encodeURIComponent).join('/')
  const safeTag = encodeURIComponent(tag)
  // Same transient-vs-cacheable distinction as fetchTags (see resolveRegistryBody).
  const result = await fetchWithTimeout(`${REGISTRY_BASE}/${safePath}/manifests/${safeTag}`, { headers: { Accept: MANIFEST_ACCEPT } }, timeoutMs)
    .then(resolveRegistryBody)
    .catch(() => TRANSIENT_FETCH)
  if (result === TRANSIENT_FETCH) return null // transient (throw / 5xx / 429 / unparseable 200) — don't cache
  const bytes = sumModelLayerBytes(result) // result is null (permanent non-OK) or the manifest object
  cacheSet(manifestCache, key, bytes)
  return bytes
}

// Resolve the per-quant install variants for a bare Ollama registry model.
// Returns `[{ tag, installId, quant, sizeBytes }]` (sizeBytes null when the
// manifest is unavailable), or `[]` when the model isn't on the registry or has
// no quant-tagged builds at the target size. `paramsHint` (the curated card's
// params, e.g. '3B') supplies the target size when the id carries no size tag.
export async function fetchOllamaRegistryVariants(id, { paramsHint = null, timeoutMs = REGISTRY_TIMEOUT_MS } = {}) {
  const parsed = parseOllamaRegistryId(id)
  if (!parsed) return []
  const tags = await fetchTags(parsed.repoPath, timeoutMs)
  if (!Array.isArray(tags) || tags.length === 0) return []

  // Constrain variants to the card's parameter size so one card never mixes a
  // 1B and a 70B build in its picker.
  const targetSize = sizeTokenOf(parsed.tag) || sizeTokenOf(paramsHint)

  // Classify tags → quant-bearing ones at the target size, deduped by quant.
  const byQuant = new Map()
  for (const tag of tags) {
    const quant = quantFromOllamaTag(tag)
    if (!quant) continue
    const size = sizeTokenOf(tag)
    if (targetSize) {
      // With a known target size, require an explicit size match — a size-less
      // bare-quant tag (`q4_K_M`) belongs to the model's default size, which may
      // not be this card's build, so skip it.
      if (size !== targetSize) continue
    }
    const existing = byQuant.get(quant)
    if (!existing || preferTag(tag, existing)) byQuant.set(quant, tag)
  }
  const chosen = [...byQuant.entries()].slice(0, MAX_VARIANTS)
  if (chosen.length === 0) return []

  // Manifest size fan-out is bounded by the dedup + cap above; fetch concurrently.
  return Promise.all(chosen.map(async ([quant, tag]) => {
    const sizeBytes = await fetchManifestModelBytes(parsed.repoPath, tag, timeoutMs)
    return { tag, installId: `${parsed.name}:${tag}`, quant, sizeBytes }
  }))
}

// Test hook — clear the per-process caches so a suite's mocked fetch isn't
// shadowed by a prior test's cached result.
export function __resetOllamaRegistryCache() {
  tagsCache.clear()
  manifestCache.clear()
}
