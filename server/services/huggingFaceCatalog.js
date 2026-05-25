import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { LOCAL_LLM_CATEGORIES, isBackend } from '../lib/localLlmCatalog.js'

const HF_API_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 12_000

const CATEGORY_IDS = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id))
const CATEGORY_SEARCH = {
  chat: 'instruct chat gguf',
  reasoning: 'reasoning thinking gguf',
  coding: 'coding coder agentic code gguf',
  vision: 'vision image text gguf',
  embedding: 'embedding sentence-transformers gguf',
  lightweight: 'small 4b 3b 2b gguf',
  multilingual: 'multilingual qwen llama gguf'
}

const TRUSTED_PUBLISHERS = new Set([
  'unsloth',
  'bartowski',
  'ggml-org',
  'lmstudio-community',
  'mradermacher',
  'qwen',
  'meta-llama',
  'mistralai',
  'google',
  'microsoft',
  'nomic-ai',
  'ibm-granite'
])

const QUANT_PRIORITY = [
  'UD-Q4_K_XL',
  'UD-Q4_K_M',
  'Q4_K_M',
  'Q4_K_S',
  'IQ4_XS',
  'UD-IQ4_XS',
  'Q5_K_M',
  'Q6_K',
  'Q8_0',
  'BF16',
  'F16'
]

const normalizeText = (value) => String(value || '').trim()

function normalizeInstalledForBackend(backend, id) {
  const raw = normalizeText(id).toLowerCase().replace(/:latest$/, '')
  if (backend === 'ollama') return raw
  return raw.split('/').pop().replace(/[-.]gguf$/i, '')
}

function repoIdOf(model) {
  return normalizeText(model?.modelId || model?.id || model?.name)
}

function publisherOf(repoId) {
  return repoId.split('/')[0]?.toLowerCase() || ''
}

function tagsOf(model) {
  return Array.isArray(model?.tags) ? model.tags.map((tag) => String(tag).toLowerCase()) : []
}

function siblingsOf(model) {
  return Array.isArray(model?.siblings) ? model.siblings : []
}

function ggufFilesOf(model) {
  return siblingsOf(model)
    .map((s) => ({ name: normalizeText(s.rfilename || s.name), size: Number.isFinite(s.size) ? s.size : null }))
    .filter((file) => /\.gguf$/i.test(file.name))
}

function hasGgufSignal(model) {
  const repoId = repoIdOf(model).toLowerCase()
  const tags = tagsOf(model)
  return repoId.includes('gguf') || tags.includes('gguf') || ggufFilesOf(model).length > 0
}

function quantFromFilename(filename) {
  const stem = normalizeText(filename).split('/').pop().replace(/\.gguf$/i, '')
  const match = stem.match(/(?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16)$/i)
  return match?.[0] || null
}

function pickGgufFile(model) {
  const files = ggufFilesOf(model)
  if (files.length === 0) return null
  return files
    .map((file) => {
      const quant = quantFromFilename(file.name)
      const priority = quant ? QUANT_PRIORITY.findIndex((q) => q.toLowerCase() === quant.toLowerCase()) : -1
      return { ...file, quant, priority: priority === -1 ? 999 : priority }
    })
    .sort((a, b) => a.priority - b.priority || (a.size || Number.MAX_SAFE_INTEGER) - (b.size || Number.MAX_SAFE_INTEGER))[0]
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let idx = 0
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024
    idx++
  }
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`
}

function extractParams(repoId) {
  const match = repoId.match(/(\d+(?:\.\d+)?)\s*b(?:[-_ ]?a(\d+)b)?/i)
  if (!match) return null
  return match[2] ? `${match[1]}B / ${match[2]}B active` : `${match[1]}B`
}

function classifyModel(model, requestedCategory) {
  if (CATEGORY_IDS.has(requestedCategory) && requestedCategory !== 'all') return requestedCategory
  const haystack = `${repoIdOf(model)} ${(tagsOf(model) || []).join(' ')} ${model?.pipeline_tag || ''}`.toLowerCase()
  if (/(embed|sentence-transformers|feature-extraction)/.test(haystack)) return 'embedding'
  if (/(vision|vl|llava|image-text|multimodal|mmproj)/.test(haystack)) return 'vision'
  if (/(code|coder|coding|devstral|starcoder|deepseek-coder|repo)/.test(haystack)) return 'coding'
  if (/(reason|thinking|r1|qwq)/.test(haystack)) return 'reasoning'
  if (/(1b|2b|3b|4b|small|mini|tiny|smol)/.test(haystack)) return 'lightweight'
  if (/(multilingual|qwen|aya|bloom|command-r)/.test(haystack)) return 'multilingual'
  return 'chat'
}

function capabilitiesFor(model, category) {
  const tags = tagsOf(model)
  const caps = new Set()
  if (category !== 'embedding') caps.add('chat')
  if (category === 'coding') caps.add('code')
  if (category === 'reasoning') caps.add('reasoning')
  if (category === 'vision') caps.add('vision')
  if (category === 'embedding') caps.add('embeddings')
  if (tags.includes('tools') || tags.includes('tool-calling') || /tool/i.test(repoIdOf(model))) caps.add('tools')
  return [...caps]
}

function licenseOf(model) {
  const cardLicense = normalizeText(model?.cardData?.license || model?.license)
  if (cardLicense) return cardLicense
  const tag = tagsOf(model).find((t) => t.startsWith('license:'))
  return tag ? tag.replace(/^license:/, '') : null
}

function scoreModel(model, category, file) {
  const repoId = repoIdOf(model)
  const publisher = publisherOf(repoId)
  const tags = tagsOf(model)
  const downloads = Number(model?.downloads || 0)
  const likes = Number(model?.likes || 0)
  const updatedAt = Date.parse(model?.lastModified || model?.last_modified || model?.updatedAt || '')
  const daysOld = Number.isFinite(updatedAt) ? (Date.now() - updatedAt) / 86_400_000 : null
  const categoryText = `${repoId} ${tags.join(' ')} ${model?.pipeline_tag || ''}`.toLowerCase()

  let score = 0
  score += Math.log10(downloads + 1) * 12
  score += Math.log10(likes + 1) * 8
  if (TRUSTED_PUBLISHERS.has(publisher)) score += 22
  if (file) score += 18
  if (/gguf/i.test(repoId) || tags.includes('gguf')) score += 10
  if (category !== 'chat' && CATEGORY_SEARCH[category]?.split(/\s+/).some((term) => categoryText.includes(term))) score += 12
  if (daysOld != null && daysOld <= 180) score += 8
  if (licenseOf(model)) score += 4
  if (/(uncensored|abliterated|nsfw)/i.test(repoId)) score -= 12
  return Math.round(score)
}

function displayName(repoId) {
  return repoId.split('/').pop().replace(/[-_]?gguf$/i, '').replace(/[-_]+/g, ' ').trim() || repoId
}

function installIdForBackend(backend, repoId, file) {
  if (backend === 'lmstudio') return repoId
  const quant = file?.quant
  return `hf.co/${repoId}${quant ? `:${quant}` : ''}`
}

function isInstalled(backend, result, installedIds) {
  const installed = new Set(installedIds.map((id) => normalizeInstalledForBackend(backend, id)))
  if (installed.has(normalizeInstalledForBackend(backend, result.id))) return true
  if (backend === 'lmstudio') {
    return installed.has(normalizeInstalledForBackend(backend, result.repository))
  }
  return false
}

function toResult(model, backend, requestedCategory, installedIds) {
  const repoId = repoIdOf(model)
  if (!repoId || !repoId.includes('/')) return null
  const file = pickGgufFile(model)
  const category = classifyModel(model, requestedCategory)
  const id = installIdForBackend(backend, repoId, file)
  const score = scoreModel(model, category, file)
  const result = {
    id,
    key: repoId,
    name: displayName(repoId),
    category,
    params: extractParams(repoId) || 'HF',
    size: formatBytes(file?.size) || (file?.quant || 'GGUF'),
    family: repoId.split('/').pop().split(/[-_]/)[0]?.toLowerCase() || 'huggingface',
    description: model?.cardData?.summary || model?.cardData?.description || 'Community Hugging Face GGUF model.',
    capabilities: capabilitiesFor(model, category),
    installed: false,
    source: 'huggingface',
    repository: repoId,
    publisher: publisherOf(repoId),
    downloads: Number(model?.downloads || 0),
    likes: Number(model?.likes || 0),
    sizeBytes: Number.isFinite(file?.size) ? file.size : null,
    createdAt: model?.createdAt || model?.created_at || null,
    updatedAt: model?.lastModified || model?.last_modified || model?.updatedAt || null,
    license: licenseOf(model),
    quant: file?.quant || null,
    score
  }
  result.installed = isInstalled(backend, result, installedIds)
  return result
}

function hfHeaders() {
  const headers = { Accept: 'application/json' }
  const token = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fetchModels(search, limit, useGgufFilter) {
  const params = new URLSearchParams({
    search,
    sort: 'downloads',
    direction: '-1',
    limit: String(limit),
    full: 'true'
  })
  if (useGgufFilter) params.set('filter', 'gguf')

  const response = await fetchWithTimeout(`${HF_API_BASE}?${params.toString()}`, { headers: hfHeaders() }, HF_TIMEOUT_MS)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Hugging Face search failed: ${response.status}${text ? ` — ${text.slice(0, 160)}` : ''}`)
  }
  const data = await response.json()
  return Array.isArray(data) ? data : []
}

// The search endpoint returns siblings WITHOUT per-file sizes; only the
// per-model endpoint (?blobs=true) carries them. Cache by repo so repeated
// searches (the box is debounced per keystroke) don't re-fetch. `undefined` =
// not fetched, `null` = fetched-but-no-size (sentinel, per the absent-vs-empty
// rule) so a sizeless repo isn't probed on every search.
const repoSizeCache = new Map()

async function fetchRepoSizeBytes(repoId) {
  if (repoSizeCache.has(repoId)) return repoSizeCache.get(repoId)
  // repoId comes from the HF search response (untrusted upstream) — encode each
  // path segment so a `?`/`#`/`..` in the id can't reshape the request path/query.
  const safeRepoPath = String(repoId).split('/').map(encodeURIComponent).join('/')
  const model = await fetchWithTimeout(`${HF_API_BASE}/${safeRepoPath}?blobs=true`, { headers: hfHeaders() }, HF_TIMEOUT_MS)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
  // Re-run the same quant picker against the now-sized siblings.
  const picked = pickGgufFile(model)
  const bytes = Number.isFinite(picked?.size) ? picked.size : null
  repoSizeCache.set(repoId, bytes)
  return bytes
}

// Backfill real file sizes for results the search endpoint left sizeless.
async function enrichWithSizes(results) {
  await Promise.allSettled(results.map(async (result) => {
    if (Number.isFinite(result.sizeBytes)) return
    const bytes = await fetchRepoSizeBytes(result.repository)
    if (Number.isFinite(bytes)) {
      result.sizeBytes = bytes
      result.size = formatBytes(bytes) || result.size
    }
  }))
  return results
}

export async function searchHuggingFaceModels({ backend, query = '', category = 'all', limit = 12, installedIds = [] }) {
  if (!isBackend(backend)) return []
  const requestedCategory = CATEGORY_IDS.has(category) ? category : 'all'
  const search = normalizeText(query) || CATEGORY_SEARCH[requestedCategory] || 'gguf'
  const fetchLimit = Math.max(limit * 3, 30)
  let models = await fetchModels(search, fetchLimit, true)
  if (models.length === 0) models = await fetchModels(search, fetchLimit, false)

  const seen = new Set()
  const results = models
    .filter(hasGgufSignal)
    .map((model) => toResult(model, backend, requestedCategory, installedIds))
    .filter(Boolean)
    .filter((model) => {
      if (seen.has(model.repository)) return false
      seen.add(model.repository)
      return true
    })
    .sort((a, b) => b.score - a.score || b.downloads - a.downloads)
    .slice(0, limit)

  return enrichWithSizes(results)
}
