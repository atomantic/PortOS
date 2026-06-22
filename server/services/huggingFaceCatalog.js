import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { LOCAL_LLM_CATEGORIES, isBackend } from '../lib/localLlmCatalog.js'
import { ENGINES } from './pipeline/musicGen.js'

const HF_API_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 12_000

const CATEGORY_IDS = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id))
const CATEGORY_SEARCH = {
  chat: 'instruct chat gguf',
  reasoning: 'reasoning thinking gguf',
  coding: 'coding coder agentic code gguf',
  vision: 'vision image text gguf',
  // Audio is NOT a GGUF category — the search relaxes the GGUF filter for it
  // (see `searchHuggingFaceModels`) and these terms surface generation models.
  audio: 'music audio text-to-music text-to-audio song generation',
  embedding: 'embedding sentence-transformers gguf',
  lightweight: 'small 4b 3b 2b gguf',
  multilingual: 'multilingual qwen llama gguf'
}

// Map a Hugging Face audio repo onto the PortOS music engine that can actually
// run it (server/services/pipeline/musicGen.js). Returns null when no shipped
// engine matches — the model is still DISCOVERABLE (search + "Visit") but not
// installable, because no sidecar can render it. Kept as a local heuristic
// rather than importing engine internals: the engine *runtime* knowledge lives
// in musicGen.js; this is just a repo-name → engine-id classifier.
function inferAudioEngine(haystack) {
  if (/ace-?step/.test(haystack)) return 'acestep'
  if (/musicgen/.test(haystack)) return 'musicgen'
  if (/audioldm/.test(haystack)) return 'audioldm2'
  return null
}

// An engine can host an arbitrary user-installed HF checkpoint only when its
// sidecar threads `--model <repo>` into from_pretrained (musicgen/audioldm2).
// ACE-Step resolves a fixed foundation checkpoint and ignores --model, so it is
// `customModels: false` and its repos are Visit-only here. The single source of
// truth for that flag is the ENGINES registry.
const engineHostsCustomRepo = (engineId) => ENGINES[engineId]?.customModels === true

// Curated audio/music suggestions surfaced at the top of the Audio & Music
// category so the headline generators are always one click from discovery even
// when the live Hub ranking buries them. `engine: null` means "no PortOS
// runtime yet" (Visit-only, experimental); `gated` flags repos that require
// accepting a license / data-sharing agreement on Hugging Face before download.
const CURATED_AUDIO_MODELS = [
  {
    repo: 'ACE-Step/acestep-v15-xl-base',
    name: 'ACE-Step v1.5 XL Base',
    description: 'Full-song generation with vocals — the ACE-Step v1.5 foundation checkpoint.',
    note: 'ACE-Step uses a fixed foundation checkpoint — install/select it from the Music studio.',
  },
  {
    repo: 'google/magenta-realtime-2',
    name: 'Magenta RealTime 2',
    description: "Google's real-time music generation model.",
    note: 'Experimental — no on-device PortOS runtime yet; open on Hugging Face to explore.',
  },
  {
    repo: 'stabilityai/stable-audio-3-medium',
    name: 'Stable Audio 3 Medium',
    description: "Stability AI's text-to-audio generation model.",
    note: 'Gated — requires accepting a data-sharing agreement on Hugging Face before download.',
    gated: true,
  },
]

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
  'ibm-granite',
  // audio/music generator publishers
  'facebook',
  'cvssp',
  'stabilityai',
  'ace-step'
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

// Weights → resident RAM multiplier (KV cache + runtime overhead). Mirrors the
// client's `recommendedRamGb` (~20% overhead) so the server's "does it fit"
// verdict and the UI's per-model RAM estimate agree.
const MEMORY_OVERHEAD = 1.2

// Usable RAM for a model after reserving headroom for the OS, the GGUF KV cache
// growth, and other resident apps. On unified-memory Macs this same pool also
// backs the GPU, so we reserve generously: max(8 GB, 20% of total). Returns null
// when the caller didn't supply a system-memory figure — that disables the
// RAM-aware default pick and leaves the QUANT_PRIORITY default untouched.
function usableMemoryBytes(systemMemoryBytes) {
  if (!Number.isFinite(systemMemoryBytes) || systemMemoryBytes <= 0) return null
  const reserve = Math.max(8 * 1024 ** 3, systemMemoryBytes * 0.2)
  return Math.max(0, systemMemoryBytes - reserve)
}

function estimatedResidentBytes(sizeBytes) {
  return Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes * MEMORY_OVERHEAD : null
}

// How comfortably a quant's estimated resident footprint fits the usable budget.
// 'unknown' when either the file size or the machine's memory is unavailable.
function classifyFit(sizeBytes, usableBytes) {
  const resident = estimatedResidentBytes(sizeBytes)
  // null usableBytes = no system-memory data → 'unknown'. A real but tiny budget
  // (0 on a machine at/below the reserved headroom) is NOT unknown — every model
  // is 'too-large' there, which is exactly what the user should see.
  if (resident == null || usableBytes == null || !Number.isFinite(usableBytes)) return 'unknown'
  if (resident > usableBytes) return 'too-large'
  if (resident > usableBytes * 0.6) return 'tight'
  return 'comfortable'
}

const normalizeText = (value) => String(value || '').trim()

// Ollama installed ids are full `hf.co/<repo>:<quant>` strings — lowercase and
// drop a `:latest` tag for comparison. (LM Studio matching goes through
// lmStudioParts instead, which is quant-aware.)
function normalizeOllamaInstalled(id) {
  return normalizeText(id).toLowerCase().replace(/:latest$/, '')
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

// Multimodal projector / auxiliary GGUFs (llama.cpp's `mmproj-*`) are not
// standalone model quants — they ship alongside a model and the runtime loads
// them automatically. They must never be offered as an installable variant or
// chosen as the RAM-aware default (a projector is small, so on a tight box the
// "largest that fits" picker would otherwise land on it). Excluded here so both
// the variant list and pickGgufFile's default skip them.
const AUX_GGUF_RE = /mmproj/i

function ggufFilesOf(model) {
  return siblingsOf(model)
    .map((s) => ({ name: normalizeText(s.rfilename || s.name), size: Number.isFinite(s.size) ? s.size : null }))
    .filter((file) => /\.gguf$/i.test(file.name) && !AUX_GGUF_RE.test(file.name))
}

function hasGgufSignal(model) {
  const repoId = repoIdOf(model).toLowerCase()
  const tags = tagsOf(model)
  return repoId.includes('gguf') || tags.includes('gguf') || ggufFilesOf(model).length > 0
}

function quantFromFilename(filename) {
  const stem = normalizeText(filename).split('/').pop()
    .replace(/\.gguf$/i, '')
    // Multi-part GGUF shards (`…-00001-of-00002`) carry the quant before the
    // shard suffix — strip it so BF16/F16 splits resolve to their real quant
    // instead of failing the match and being dropped from the variant list.
    .replace(/-\d{5}-of-\d{5}$/i, '')
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

// Detect an audio/music GENERATION model from its pipeline tag / tags / repo.
// Anchored on Hugging Face pipeline-tag tokens (hyphenated) and known generator
// families so a chat model that merely mentions "audio" isn't miscategorised in
// the auto-classify ('all') path.
const AUDIO_RE = /(text-to-audio|text-to-music|text-to-speech|audio-to-audio|automatic-speech-recognition|musicgen|audioldm|stable-audio|ace-?step|magenta|\bbark\b|\bxtts\b)/

// Does this model actually look like an audio/music model? The audio category
// relaxes the GGUF filter, so without this predicate a non-audio query (e.g.
// "llama") would return unrelated models that `toResult` then mislabels as audio
// (requestedCategory short-circuits classifyModel). This keeps the Audio & Music
// results constrained to genuine audio models while still not requiring GGUF.
function hasAudioSignal(model) {
  const haystack = `${repoIdOf(model)} ${tagsOf(model).join(' ')} ${model?.pipeline_tag || ''}`.toLowerCase()
  return AUDIO_RE.test(haystack)
}

function classifyModel(model, requestedCategory) {
  if (CATEGORY_IDS.has(requestedCategory) && requestedCategory !== 'all') return requestedCategory
  const haystack = `${repoIdOf(model)} ${(tagsOf(model) || []).join(' ')} ${model?.pipeline_tag || ''}`.toLowerCase()
  if (AUDIO_RE.test(haystack)) return 'audio'
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
  // Audio generators don't "chat" — they render audio, so they get only the
  // `audio` capability badge (no chat/tools).
  if (category === 'audio') return ['audio']
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

// Backend-specific pull/download id for a chosen quant.
//   ollama   → `hf.co/<repo>:<quant>` (Ollama resolves the GGUF, incl. shards)
//   lmstudio → `<repo>@<quant>` (the `lms get <repo>@<quant>` syntax)
// A null quant falls back to the bare repo so the backend picks its own default.
function variantInstallId(backend, repoId, quant) {
  if (backend === 'lmstudio') return quant ? `${repoId}@${quant}` : repoId
  return `hf.co/${repoId}${quant ? `:${quant}` : ''}`
}

function installIdForBackend(backend, repoId, file) {
  // The default result keeps LM Studio's bare-repo id (LM Studio resolves a
  // recommended quant itself); the quant only enters the id when a specific
  // variant is selected or the RAM-aware default re-pick applies one.
  if (backend === 'lmstudio') return repoId
  return variantInstallId('ollama', repoId, file?.quant)
}

// Every installable GGUF quant in a repo, deduped by quant (multi-part shards
// summed), sorted by size DESC (≈ fidelity DESC) so the picker lists the
// highest-quality build first. Files whose quant can't be parsed are skipped —
// they have no `:quant`/`@quant` tag a backend can pull. `usableBytes` annotates
// each variant with a fit verdict for the UI (null → 'unknown').
// Collapse a multi-part shard filename to a key shared by its set
// (`…-00001-of-00002.gguf` → `…-of-00002`); standalone files key to themselves.
// Only files with the same key are one installable unit whose sizes sum.
function shardSetKey(filename) {
  const m = normalizeText(filename).match(/^(.*)-\d{5}-of-(\d{5})\.gguf$/i)
  return m ? `${m[1]}-of-${m[2]}` : filename
}

function buildVariants(model, backend, usableBytes) {
  const repoId = repoIdOf(model)
  // quant → (shard-set/standalone key → summed size). Backends install by quant
  // tag (`:Q4_K_M` / `@Q4_K_M`), so one variant per quant — but the size is the
  // largest single installable unit, not the sum across unrelated same-quant
  // files (two standalone Q4_K_M builds must not read as one double-size variant).
  const groups = new Map()
  for (const file of ggufFilesOf(model)) {
    const quant = quantFromFilename(file.name)
    if (!quant) continue
    const units = groups.get(quant) || new Map()
    const key = shardSetKey(file.name)
    units.set(key, (units.get(key) || 0) + (Number.isFinite(file.size) ? file.size : 0))
    groups.set(quant, units)
  }
  return [...groups.entries()]
    .map(([quant, units]) => {
      const largestUnit = Math.max(0, ...units.values())
      const sizeBytes = largestUnit > 0 ? largestUnit : null
      return {
        quant,
        installId: variantInstallId(backend, repoId, quant),
        sizeBytes,
        size: formatBytes(sizeBytes) || quant,
        fit: classifyFit(sizeBytes, usableBytes)
      }
    })
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
}

// RAM-aware default: the highest-fidelity variant whose estimated resident
// footprint fits the usable budget (variants are size-desc, so the first that
// fits is the best). If none fit, fall back to the smallest. Returns null when
// no variant carries a known size (caller keeps the QUANT_PRIORITY default).
function pickVariantForBudget(variants, usableBytes) {
  const sized = variants.filter((v) => Number.isFinite(v.sizeBytes) && v.sizeBytes > 0)
  if (sized.length === 0) return null
  return sized.find((v) => estimatedResidentBytes(v.sizeBytes) <= usableBytes) || sized[sized.length - 1]
}

// Promote a chosen variant onto the result's primary install fields so the
// default card reflects it (id/quant/size) without the client having to re-pick.
function applyVariant(result, variant) {
  result.id = variant.installId
  result.quant = variant.quant
  result.sizeBytes = variant.sizeBytes
  result.size = variant.size
}

// Parse an LM Studio identifier into its repo base + quant for quant-aware
// install matching. Installed ids arrive as `<id>@<quant>` (the route appends
// LM Studio's reported quantization) and variant ids as `<repo>@<quant>`; both
// reduce to the last path segment minus the `-gguf` suffix.
function lmStudioParts(id) {
  const raw = normalizeText(id).toLowerCase().replace(/:latest$/, '')
  const seg = raw.split('/').pop()
  const at = seg.indexOf('@')
  const base = (at >= 0 ? seg.slice(0, at) : seg).replace(/[-.]gguf$/i, '')
  const quant = at >= 0 ? seg.slice(at + 1) : ''
  return { base, quant }
}

// Is a specific backend install id present among the installed ids? Ollama tracks
// each `hf.co/<repo>:<quant>` as its own model, so the match is quant-precise.
// LM Studio is matched per-quant too — but only when the installed entry carries
// a quant (it does when LM Studio reported a `quantization`); an entry without
// one falls back to repo-level, the best granularity that entry exposes. This is
// why selecting an un-downloaded quant correctly shows Install instead of hiding it.
function installIdInstalled(backend, installId, repository, installedIds) {
  if (backend === 'ollama') {
    const target = normalizeOllamaInstalled(installId)
    return installedIds.some((id) => normalizeOllamaInstalled(id) === target)
  }
  const v = lmStudioParts(installId)
  return installedIds.some((id) => {
    const e = lmStudioParts(id)
    return e.base === v.base && (e.quant === '' || e.quant === v.quant)
  })
}

function isInstalled(backend, result, installedIds) {
  return installIdInstalled(backend, result.id, result.repository, installedIds)
}

function toResult(model, backend, requestedCategory, installedIds, installedAudioRepos = new Set()) {
  const repoId = repoIdOf(model)
  if (!repoId || !repoId.includes('/')) return null
  const category = classifyModel(model, requestedCategory)
  const isAudio = category === 'audio'
  // Audio generators are not GGUF — skip the GGUF file picker entirely so a
  // non-GGUF repo doesn't surface a bogus "GGUF" size or an `hf.co/...:quant`
  // Ollama install id it can never honour.
  const file = isAudio ? null : pickGgufFile(model)
  const score = scoreModel(model, category, file)
  // For audio the `id` is just the repo id (the React key + the value the audio
  // installer routes to the music registry); for GGUF chat models it's the
  // backend-specific pull/download id.
  const id = isAudio ? repoId : installIdForBackend(backend, repoId, file)
  const audioEngine = isAudio
    ? inferAudioEngine(`${repoId} ${tagsOf(model).join(' ')} ${model?.pipeline_tag || ''}`.toLowerCase())
    : null
  const result = {
    id,
    key: repoId,
    name: displayName(repoId),
    category,
    params: extractParams(repoId) || (isAudio ? 'Audio' : 'HF'),
    size: formatBytes(file?.size) || (isAudio ? 'HF model' : (file?.quant || 'GGUF')),
    family: repoId.split('/').pop().split(/[-_]/)[0]?.toLowerCase() || 'huggingface',
    description: model?.cardData?.summary || model?.cardData?.description
      || (isAudio ? 'Community Hugging Face audio model.' : 'Community Hugging Face GGUF model.'),
    capabilities: capabilitiesFor(model, category),
    installed: false,
    source: 'huggingface',
    repository: repoId,
    publisher: publisherOf(repoId),
    downloads: Number(model?.downloads || 0),
    likes: Number(model?.likes || 0),
    sizeBytes: Number.isFinite(file?.size) ? file.size : null,
    // Native context window (tokens). The search endpoint omits the GGUF
    // metadata block, so this is backfilled from the per-repo `?blobs=true`
    // record in enrichWithSizes; stays null for audio repos (no `gguf` field).
    contextLength: null,
    createdAt: model?.createdAt || model?.created_at || null,
    updatedAt: model?.lastModified || model?.last_modified || model?.updatedAt || null,
    license: licenseOf(model),
    quant: file?.quant || null,
    score
  }
  if (isAudio) {
    // Engine the model maps to (or null) + whether the installer can host it.
    // A null engine or a fixed-checkpoint engine (ACE-Step) is Visit-only.
    result.engine = audioEngine
    result.installable = Boolean(audioEngine) && engineHostsCustomRepo(audioEngine)
    result.installed = installedAudioRepos.has(repoId.toLowerCase())
  } else {
    result.installable = true
    result.installed = isInstalled(backend, result, installedIds)
  }
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
  const data = await readResponseJson(response, { fallback: [] })
  return Array.isArray(data) ? data : []
}

const repoModelCache = new Map()
const REPO_MODEL_CACHE_MAX = 500

// Fetch (and cache) the per-model record WITH per-file sizes. The search
// endpoint returns siblings without sizes; only `?blobs=true` carries them, and
// the box is debounced per keystroke, so cache by repo to avoid re-fetching.
// `null` = fetched-but-unavailable (gated / private / 404), cached (per the
// absent-vs-empty sentinel rule) so a sizeless repo isn't re-probed every search.
async function fetchRepoModel(repoId) {
  if (repoModelCache.has(repoId)) return repoModelCache.get(repoId)
  // repoId comes from the HF search response (untrusted upstream) — encode each
  // path segment so a `?`/`#`/`..` in the id can't reshape the request path/query.
  const safeRepoPath = String(repoId).split('/').map(encodeURIComponent).join('/')
  const model = await fetchWithTimeout(`${HF_API_BASE}/${safeRepoPath}?blobs=true`, { headers: hfHeaders() }, HF_TIMEOUT_MS)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null)
  // Evict oldest entry when the cap is reached (insertion-order iteration).
  if (repoModelCache.size >= REPO_MODEL_CACHE_MAX) {
    repoModelCache.delete(repoModelCache.keys().next().value)
  }
  repoModelCache.set(repoId, model)
  return model
}

// Total resident size of an audio repo's weight files — audio generators ship
// `.safetensors`/`.ckpt`/`.bin` weights rather than a single GGUF, so the quant
// picker doesn't apply; sum the weight siblings instead.
const WEIGHT_FILE_RE = /\.(safetensors|ckpt|bin|pt|pth|onnx|gguf)$/i
function sumWeightBytes(model) {
  const total = siblingsOf(model)
    .filter((s) => WEIGHT_FILE_RE.test(normalizeText(s.rfilename || s.name)))
    .reduce((sum, s) => sum + (Number.isFinite(s.size) ? s.size : 0), 0)
  return total > 0 ? total : null
}

// Native context window (tokens) for a GGUF repo. HF surfaces it under
// `gguf.context_length` on the per-repo record (the search listing omits the
// whole `gguf` block). Returns null for non-GGUF/audio repos or when absent.
function contextLengthOf(model) {
  const n = Number(model?.gguf?.context_length)
  return Number.isFinite(n) && n > 0 ? n : null
}

// Backfill real file sizes AND native context windows from the per-model
// `?blobs=true` record (the search listing carries neither). Both are fetched
// from the same cached repo record, so a result missing either triggers one
// (deduped) per-repo fetch.
async function enrichWithSizes(results, { backend, usableBytes, installedIds = [] } = {}) {
  await Promise.allSettled(results.map(async (result) => {
    const isAudio = result.category === 'audio'
    const needsSize = !Number.isFinite(result.sizeBytes)
    const needsContext = !isAudio && result.contextLength == null
    // Variants come only from the per-repo `?blobs=true` record (the listing
    // omits per-file sizes), so build them here for every non-audio result.
    const needsVariants = !isAudio && !result.variants
    if (!needsSize && !needsContext && !needsVariants) return
    const model = await fetchRepoModel(result.repository)
    if (!model) return
    if (!isAudio) {
      const variants = buildVariants(model, backend, usableBytes)
      if (variants.length > 0) {
        // Per-quant installed state — Ollama tracks each quant separately, so the
        // card must gate Install on the *selected* variant, not one repo-wide flag.
        for (const v of variants) v.installed = installIdInstalled(backend, v.installId, result.repository, installedIds)
        // Always anchor the result on one of its own variants so the install id
        // and the client's controlled <select> agree. Prefer the RAM-aware pick;
        // otherwise the QUANT_PRIORITY default toResult chose (matched by quant);
        // fall back to the largest variant. Without this, LM Studio's bare-repo
        // default id — and any repo where the blobs endpoint omits sizes, so the
        // budget pick can't fire — would match no variant, flagging zero
        // recommended and making Install pull a different quant than the one shown.
        // `usableBytes != null` (not truthiness): 0 is a real budget on a tiny
        // machine — pick the smallest (all flagged too-large) rather than falling
        // through to QUANT_PRIORITY as if memory were unknown.
        const chosen = (usableBytes != null ? pickVariantForBudget(variants, usableBytes) : null)
          || variants.find((v) => v.quant && v.quant === result.quant)
          || variants[0]
        applyVariant(result, chosen)
        // Flag whichever variant the result now points at as recommended so the
        // UI can mark it (covers both the RAM-aware and QUANT_PRIORITY default).
        for (const v of variants) v.recommended = v.installId === result.id
        // Realign the result-level installed flag with the (possibly RAM-switched)
        // default variant — toResult computed it against the pre-switch id.
        result.installed = chosen.installed
        result.variants = variants
      }
    }
    if (needsSize && !Number.isFinite(result.sizeBytes)) {
      const bytes = isAudio
        ? sumWeightBytes(model)
        : (() => { const picked = pickGgufFile(model); return Number.isFinite(picked?.size) ? picked.size : null })()
      if (Number.isFinite(bytes)) {
        result.sizeBytes = bytes
        result.size = formatBytes(bytes) || result.size
      }
    }
    if (needsContext) {
      const ctx = contextLengthOf(model)
      if (ctx != null) result.contextLength = ctx
    }
  }))
  return results
}

// Build a result object for a curated audio suggestion. These don't come from
// the live Hub search, so synthesize a minimal model record and run it through
// the same `toResult` path (engine inference, install id, capabilities, etc.) so
// the result shape stays defined in exactly one place. `enrichWithSizes` fills
// the size from `?blobs=true`; the curated-only fields drive the UI badges and
// the score pins these above live results in the merge below.
function curatedAudioResult(entry, installedAudioRepos) {
  const synthetic = { modelId: entry.repo, downloads: 0, likes: 0, tags: [], cardData: { summary: entry.description } }
  return {
    ...toResult(synthetic, 'lmstudio', 'audio', [], installedAudioRepos),
    name: entry.name,
    suggested: true,
    note: entry.note || null,
    gated: entry.gated === true,
    score: Number.MAX_SAFE_INTEGER,
  }
}

export async function searchHuggingFaceModels({ backend, query = '', category = 'all', limit = 12, installedIds = [], installedAudioRepos = [], systemMemoryBytes = null }) {
  if (!isBackend(backend)) return []
  const requestedCategory = CATEGORY_IDS.has(category) ? category : 'all'
  // Usable RAM drives the per-quant fit verdicts and the RAM-aware default pick;
  // null (no system-memory figure) keeps the QUANT_PRIORITY default behaviour.
  const usableBytes = usableMemoryBytes(systemMemoryBytes)
  const installedAudio = new Set(installedAudioRepos.map((r) => String(r).toLowerCase()))
  // Audio models aren't GGUF — don't constrain the Hub query (or post-filter)
  // to GGUF repos for the audio category, or ACE-Step / Stable Audio / MusicGen
  // would all be filtered out.
  const ggufOnly = requestedCategory !== 'audio'
  const search = normalizeText(query) || CATEGORY_SEARCH[requestedCategory] || 'gguf'
  const fetchLimit = Math.max(limit * 3, 30)
  let models = await fetchModels(search, fetchLimit, ggufOnly)
  if (models.length === 0 && ggufOnly) models = await fetchModels(search, fetchLimit, false)

  const seen = new Set()
  // Curated audio suggestions lead the Audio & Music list (filtered by query
  // when the user is typing) so the headline generators are always visible.
  const curated = requestedCategory === 'audio'
    ? CURATED_AUDIO_MODELS
        .filter((entry) => {
          const q = normalizeText(query).toLowerCase()
          if (!q) return true
          return entry.repo.toLowerCase().includes(q) || entry.name.toLowerCase().includes(q)
        })
        .map((entry) => {
          seen.add(entry.repo)
          return curatedAudioResult(entry, installedAudio)
        })
    : []

  const live = models
    // GGUF categories keep the GGUF signal filter; the audio category swaps it
    // for an audio-signal filter (relaxed off GGUF, but still audio-only) so a
    // non-audio query can't surface unrelated models mislabeled as audio.
    .filter((model) => (ggufOnly ? hasGgufSignal(model) : hasAudioSignal(model)))
    .map((model) => toResult(model, backend, requestedCategory, installedIds, installedAudio))
    .filter(Boolean)
    .filter((model) => {
      if (seen.has(model.repository)) return false
      seen.add(model.repository)
      return true
    })

  const results = [...curated, ...live]
    .sort((a, b) => b.score - a.score || b.downloads - a.downloads)
    .slice(0, limit)

  return enrichWithSizes(results, { backend, usableBytes, installedIds })
}
