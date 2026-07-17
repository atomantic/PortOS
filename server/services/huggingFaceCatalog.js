import { formatBytes as formatBytesRaw } from '../lib/fileUtils.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { LOCAL_LLM_CATEGORIES, isBackend } from '../lib/localLlmCatalog.js'
import { ENGINES } from './pipeline/musicGen.js'
import { fetchOllamaRegistryVariants } from './ollamaRegistryCatalog.js'

const HF_API_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 12_000
// Upper bound on how long the curated-catalog endpoint waits for HF variant
// enrichment. The curated catalog must stay usable offline (it was a pure local
// list before enrichment), so when HF is slow/down we return the catalog as-is
// after this budget; in-flight probes keep running and warm the repo cache, so
// the next load (or a recovered HF) enriches without delay.
const CATALOG_ENRICH_TIMEOUT_MS = 5_000

const CATEGORY_IDS = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id))
// Default browse phrases used when the search box is empty (and as the seed when
// a category tag is clicked with no query). The Hub `search` param is AND-across
// the space-separated tokens against the model id, so a multi-word phrase like
// 'coding coder agentic code gguf' matches ZERO repos (no id contains all five) —
// the category tab then renders blank. Keep each phrase to a single category
// keyword + 'gguf' so the default browse reliably returns the top-downloaded
// matches for that category. The user's typed query overrides these entirely.
const CATEGORY_SEARCH = {
  chat: 'instruct gguf',
  reasoning: 'reasoning gguf',
  coding: 'coder gguf',
  vision: 'vision gguf',
  // Audio is NOT a GGUF category — the search relaxes the GGUF filter for it
  // (see `searchHuggingFaceModels`) and these terms surface generation models.
  // Curated audio suggestions lead this list, so the live phrase can stay broad.
  audio: 'music audio text-to-music text-to-audio song generation',
  embedding: 'embedding gguf',
  // 'lightweight' means small param count. The Hub AND-matches the literal
  // substring '1b' against the model id, so this surfaces the genuinely tiny
  // '-1b-' models (gemma-3-1b, llama-3.2-1b); a name token like 'small' would
  // instead surface Mistral-Small-24B, which is the opposite of lightweight.
  lightweight: '1b gguf',
  multilingual: 'multilingual gguf'
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

// Delegates formatting to the shared fileUtils.formatBytes, but returns `null`
// (not the shared helper's "0 B") for unknown/zero sizes so callers can fall
// back to a quant/label string via `formatBytes(x) || fallback`.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null
  return formatBytesRaw(bytes)
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
  // Downloads and recency are the two factors the user cares about most, so they
  // dominate the blend. Downloads: a heavier log weight (a 1M-download model beats
  // a trusted-publisher 1K-download one). Recency: graduated, not a single 180-day
  // step — a model updated this week clearly outranks one from months/years ago,
  // and a stale model is actively demoted. (The Hub query already sorts by
  // downloads; this re-asserts both factors after the trust/format bonuses.)
  score += Math.log10(downloads + 1) * 18
  score += Math.log10(likes + 1) * 8
  if (daysOld != null) {
    if (daysOld <= 14) score += 26
    else if (daysOld <= 45) score += 20
    else if (daysOld <= 120) score += 12
    else if (daysOld <= 270) score += 5
    else if (daysOld <= 540) score -= 4
    else score -= 14
  }
  if (TRUSTED_PUBLISHERS.has(publisher)) score += 22
  if (file) score += 18
  if (/gguf/i.test(repoId) || tags.includes('gguf')) score += 10
  if (category !== 'chat' && CATEGORY_SEARCH[category]?.split(/\s+/).some((term) => categoryText.includes(term))) score += 12
  if (licenseOf(model)) score += 4
  if (/(uncensored|abliterated|nsfw)/i.test(repoId)) score -= 12
  return Math.round(score)
}

function displayName(repoId) {
  return repoId.split('/').pop().replace(/[-_]?gguf$/i, '').replace(/[-_]+/g, ' ').trim() || repoId
}

// Backend-specific pull/download id for a chosen quant.
//   ollama   → `hf.co/<repo>:<quant>` (Ollama resolves a single-file GGUF; it
//              CANNOT pull multi-part shards — see ollama/ollama#5245)
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

// A shard-set key (from a `…-NNNNN-of-MMMMM.gguf` file) ends in `-of-MMMMM` with
// no `.gguf` suffix; a standalone key is the full filename (`.gguf` and all). So
// the trailing `-of-#####` (anchored, no extension) is unambiguous.
function isShardedKey(key) {
  return /-of-\d{5}$/i.test(key)
}

// Why Ollama can't install a sharded quant — surfaced on the variant so the UI
// can disable Install with an actionable reason instead of letting the user hit
// Ollama's raw 400. LM Studio loads sharded GGUFs natively, so it's unaffected.
const OLLAMA_SHARDED_REASON =
  'Ollama cannot install multi-part (sharded) GGUFs (ollama/ollama#5245). ' +
  'Pick a smaller single-file quant, or install this build on LM Studio.'

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
      // The installable unit is the largest shard-set/standalone group; whether
      // THAT unit is sharded decides Ollama-compatibility (a quant may have both
      // a sharded build and a standalone one — the standalone wins on size ties
      // only if larger, but the unit we'd actually pull is the one we measure).
      let chosenKey = null
      let largestUnit = 0
      for (const [key, size] of units) {
        if (size >= largestUnit) { largestUnit = size; chosenKey = key }
      }
      const sizeBytes = largestUnit > 0 ? largestUnit : null
      const sharded = chosenKey ? isShardedKey(chosenKey) : false
      const variant = {
        quant,
        format: 'gguf',
        installId: variantInstallId(backend, repoId, quant),
        sizeBytes,
        size: formatBytes(sizeBytes) || quant,
        fit: classifyFit(sizeBytes, usableBytes),
        sharded
      }
      // Ollama can't pull shards; mark the variant so the picker disables Install
      // and the RAM-aware default skips it. LM Studio handles shards, so no flag.
      if (sharded && backend === 'ollama') {
        variant.unsupported = 'sharded'
        variant.unsupportedReason = OLLAMA_SHARDED_REASON
      }
      return variant
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

// The QUANT_PRIORITY-preferred variant — the sensible default when no RAM budget
// applies and no curator-chosen quant matches (e.g. a curated LM Studio entry
// whose blobs come back without sizes). Picks a balanced Q4-ish build rather than
// the size-desc `variants[0]`, which (sizeless ⇒ stable sort ⇒ HF file order)
// could wrongly default a small machine to a BF16/Q8 build.
function preferredQuantVariant(variants) {
  const rank = (q) => {
    const i = QUANT_PRIORITY.findIndex((p) => p.toLowerCase() === String(q).toLowerCase())
    return i === -1 ? QUANT_PRIORITY.length : i
  }
  return [...variants].sort((a, b) => rank(a.quant) - rank(b.quant))[0]
}

// Promote a chosen variant onto the result's primary fields so the default card
// reflects it (quant/size/installed). `rewriteInstallId` controls whether the
// result's `id` becomes the variant's install id: true for live HF results (their
// id IS the install id), false for curated entries — those keep their stable
// catalog id (other consumers, e.g. the playground, match installed models on it),
// and the UI selects the recommended variant via its `recommended` flag instead.
// Only overwrite the size when the variant actually has one — otherwise keep the
// result's existing size (a curated hard-coded estimate) rather than a bare label.
function applyVariant(result, variant, rewriteInstallId) {
  if (rewriteInstallId) result.id = variant.installId
  result.quant = variant.quant
  result.installed = variant.installed
  if (Number.isFinite(variant.sizeBytes)) {
    result.sizeBytes = variant.sizeBytes
    result.size = variant.size
  }
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
// LM Studio matches on the repo base plus a quant match — but repo-level fallback
// applies when EITHER side lacks a quant: an installed entry without one (LM Studio
// reported no `quantization`) OR a target without one. The target-side fallback is
// what an MLX repo needs — its install id is the bare repo (the quant is baked into
// the repo name, e.g. `mlx-community/Foo-4bit`), so it must still match an installed
// `mlx-community/Foo-4bit@4bit`. GGUF variants always carry a quant, so this never
// loosens per-quant GGUF matching; it only adds the missing repo-level case.
function installIdInstalled(backend, installId, repository, installedIds) {
  if (backend === 'ollama') {
    const target = normalizeOllamaInstalled(installId)
    return installedIds.some((id) => normalizeOllamaInstalled(id) === target)
  }
  const v = lmStudioParts(installId)
  return installedIds.some((id) => {
    const e = lmStudioParts(id)
    return e.base === v.base && (e.quant === '' || v.quant === '' || e.quant === v.quant)
  })
}

function isInstalled(backend, result, installedIds) {
  return installIdInstalled(backend, result.id, result.repository, installedIds)
}

// ---- MLX (Apple Silicon) ----------------------------------------------------
// MLX is Apple's native ML format. It ships sharded `.safetensors` + a config
// (no single GGUF), and is installable ONLY via LM Studio (`lms get <repo>`) on
// Apple Silicon — Ollama's MLX path accelerates GGUF from its own registry and
// can't pull arbitrary HF safetensors repos, so MLX is never surfaced for the
// Ollama backend (the search gates the whole MLX query on lmstudio+Apple Silicon).
const MLX_PUBLISHER = 'mlx-community'
const SAFETENSORS_RE = /\.safetensors$/i

function safetensorsFilesOf(model) {
  return siblingsOf(model)
    .map((s) => ({ name: normalizeText(s.rfilename || s.name), size: Number.isFinite(s.size) ? s.size : null }))
    .filter((file) => SAFETENSORS_RE.test(file.name))
}

// Sum the safetensors shards — an MLX repo's resident footprint ≈ the weight
// total (same overhead heuristic as GGUF; MEMORY_OVERHEAD covers the KV cache).
function sumSafetensorsBytes(model) {
  const total = safetensorsFilesOf(model).reduce((sum, f) => sum + (f.size || 0), 0)
  return total > 0 ? total : null
}

// MLX quant from the repo-name suffix. mlx-community encodes the quant in the
// REPO name (one quant per repo), not per-file: `Qwen2.5-7B-Instruct-4bit`,
// `-8bit`, `-6bit`, `-3bit`, `-bf16`, `-fp16`, sometimes a trailing method tag
// (`-4bit-DWQ`). Null when unparseable (the bare repo still installs — LM Studio
// resolves it — but no quant label is shown).
function mlxQuantFromRepo(repoId) {
  const name = String(repoId).split('/').pop() || ''
  const m = name.match(/(?:^|[-_])(\d{1,2}bit|bf16|fp16|fp32|f16|f32)(?:[-_](?:dwq|hi|lo|mixed[a-z0-9_]*))?$/i)
  return m ? m[1].toLowerCase() : null
}

function hasMlxSignal(model) {
  const repoId = repoIdOf(model)
  const hasSafetensors = siblingsOf(model).some((s) => SAFETENSORS_RE.test(normalizeText(s.rfilename || s.name)))
  return (tagsOf(model).includes('mlx') || repoId.toLowerCase().includes('mlx') || publisherOf(repoId) === MLX_PUBLISHER)
    && hasSafetensors
}

// Build an MLX search result. Same shape as a GGUF result with `format: 'mlx'`,
// a single variant (the repo's quant), and the LM Studio bare-repo install id.
// Sizes/variant fit are backfilled in enrichWithSizes from `?blobs=true`.
function toMlxResult(model, requestedCategory, installedIds) {
  const repoId = repoIdOf(model)
  if (!repoId || !repoId.includes('/')) return null
  const category = classifyModel(model, requestedCategory)
  const quant = mlxQuantFromRepo(repoId)
  const result = {
    id: repoId, // `lms get <repo>` — the repo IS the quant for mlx-community
    key: repoId,
    name: displayName(repoId),
    category,
    params: extractParams(repoId) || 'MLX',
    size: quant ? quant.toUpperCase() : 'MLX',
    family: repoId.split('/').pop().split(/[-_]/)[0]?.toLowerCase() || 'huggingface',
    description: model?.cardData?.summary || model?.cardData?.description
      || 'Apple MLX model — installs via LM Studio on Apple Silicon.',
    capabilities: capabilitiesFor(model, category),
    installed: false,
    source: 'huggingface',
    format: 'mlx',
    repository: repoId,
    publisher: publisherOf(repoId),
    downloads: Number(model?.downloads || 0),
    likes: Number(model?.likes || 0),
    sizeBytes: null,
    contextLength: null,
    createdAt: model?.createdAt || model?.created_at || null,
    updatedAt: model?.lastModified || model?.last_modified || model?.updatedAt || null,
    license: licenseOf(model),
    quant,
    score: scoreModel(model, category, null),
    installable: true
  }
  result.installed = installIdInstalled('lmstudio', repoId, repoId, installedIds)
  return result
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
    // Format discriminator for the UI badge: GGUF chat models vs. (separately
    // queried) MLX. Audio repos are neither, so they stay null.
    format: isAudio ? null : 'gguf',
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

// `filter` is a Hugging Face library tag — 'gguf' for the GGUF query, 'mlx' for
// the Apple-MLX query, or null/'' to relax the format filter (audio category and
// the GGUF-signal fallback). Only one filter at a time; MLX runs as a separate
// query so its results don't pollute the GGUF list.
async function fetchModels(search, limit, filter) {
  const params = new URLSearchParams({
    search,
    sort: 'downloads',
    direction: '-1',
    limit: String(limit),
    full: 'true'
  })
  if (filter) params.set('filter', filter)

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
// A transient fetch failure (network down / timeout / malformed body) — distinct
// from a genuine HTTP non-OK (404 / gated / private). The former must NOT be
// cached (it would permanently disable enrichment for the process until HF
// recovers); the latter is a real "no data" answer worth caching.
const TRANSIENT_FETCH = Symbol('transient-fetch')

// Fetch (and cache) the per-model record WITH per-file sizes. The search
// endpoint returns siblings without sizes; only `?blobs=true` carries them, and
// the box is debounced per keystroke, so cache by repo to avoid re-fetching.
// `null` = fetched-but-unavailable (gated / private / 404), cached (per the
// absent-vs-empty sentinel rule) so a sizeless repo isn't re-probed every search.
// A transient failure returns null too, but is NOT cached, so a recovered HF
// re-enriches on the next request instead of staying blank until restart.
async function fetchRepoModel(repoId) {
  if (repoModelCache.has(repoId)) return repoModelCache.get(repoId)
  // repoId comes from the HF search response (untrusted upstream) — encode each
  // path segment so a `?`/`#`/`..` in the id can't reshape the request path/query.
  const safeRepoPath = String(repoId).split('/').map(encodeURIComponent).join('/')
  const model = await fetchWithTimeout(`${HF_API_BASE}/${safeRepoPath}?blobs=true`, { headers: hfHeaders() }, HF_TIMEOUT_MS)
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => TRANSIENT_FETCH)
  if (model === TRANSIENT_FETCH) return null // transient — return null but don't cache
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

// Build the per-quant GGUF variant list onto `result` from a fetched repo record
// and mark the RAM-aware (or QUANT_PRIORITY) default. Shared by the live HF search
// and the curated-catalog enrichment so both cards behave the same. Returns true
// when variants were applied, false when the repo has no parseable GGUF quant
// (e.g. an MLX-only repo) so the caller can leave it as-is.
//
// `rewriteInstallId`: live HF results adopt the chosen variant's id as their own
// (their id IS the install id); curated entries keep their stable catalog id (so
// other consumers — the playground — still match installed models on it) and the
// UI picks the chosen variant via its `recommended` flag.
// Pick the default variant, flag it `recommended`, and promote it onto `result` —
// the shared tail of every variant path (GGUF files + Ollama registry tags), which
// differ only in how they build the size-desc `variants` list and set `installed`.
// Prefer the RAM-aware pick; otherwise the QUANT_PRIORITY default (matched by the
// result's existing quant); fall back to the QUANT_PRIORITY-preferred variant.
// `usableBytes != null` (not truthiness): 0 is a real budget on a tiny machine —
// pick the smallest (all flagged too-large) rather than falling through as if
// memory were unknown.
function applyChosenVariant(result, variants, { usableBytes, rewriteInstallId }) {
  // The default must be something the backend can actually install — never land
  // the RAM-aware/QUANT_PRIORITY pick on an Ollama-unsupported (sharded) variant.
  // Pick from the installable subset; only if EVERY variant is unsupported (a
  // repo that ships nothing but shards) fall back to the full list so the card
  // still has a coherent default (Install stays disabled per-variant downstream).
  const installable = variants.filter((v) => !v.unsupported)
  const pool = installable.length > 0 ? installable : variants
  const chosen = (usableBytes != null ? pickVariantForBudget(pool, usableBytes) : null)
    || pool.find((v) => v.quant && v.quant === result.quant)
    || preferredQuantVariant(pool)
  // Flag by identity (robust whether or not the id is rewritten) so the controlled
  // <select> and the recommended marker always agree on the chosen variant.
  for (const v of variants) v.recommended = v === chosen
  applyVariant(result, chosen, rewriteInstallId)
  result.variants = variants
}

function applyGgufVariants(result, model, { backend, usableBytes, installedIds, rewriteInstallId = true }) {
  const variants = buildVariants(model, backend, usableBytes)
  if (variants.length === 0) return false
  // Per-quant installed state — Ollama tracks each quant separately, so the card
  // must gate Install on the *selected* variant, not one repo-wide flag.
  for (const v of variants) v.installed = installIdInstalled(backend, v.installId, result.repository, installedIds)
  applyChosenVariant(result, variants, { usableBytes, rewriteInstallId })
  return true
}

// Backfill real file sizes AND native context windows from the per-model
// `?blobs=true` record (the search listing carries neither). Both are fetched
// from the same cached repo record, so a result missing either triggers one
// (deduped) per-repo fetch.
async function enrichWithSizes(results, { backend, usableBytes, installedIds = [] } = {}) {
  await Promise.allSettled(results.map(async (result) => {
    const isAudio = result.category === 'audio'
    const isMlx = result.format === 'mlx'
    const needsSize = !Number.isFinite(result.sizeBytes)
    // MLX repos carry no GGUF metadata block, so they have no native-context field.
    const needsContext = !isAudio && !isMlx && result.contextLength == null
    // Variants come only from the per-repo `?blobs=true` record (the listing
    // omits per-file sizes), so build them here for every non-audio result.
    const needsVariants = !isAudio && !result.variants
    if (!needsSize && !needsContext && !needsVariants) return
    const model = await fetchRepoModel(result.repository)
    if (!model) return
    if (isMlx) {
      // MLX size = summed safetensors shards. The picker shows a single variant
      // (the repo's quant) so the card UI matches the multi-quant GGUF cards.
      const bytes = sumSafetensorsBytes(model)
      if (Number.isFinite(bytes)) {
        result.sizeBytes = bytes
        result.size = formatBytes(bytes) || result.size
      }
      const variant = {
        quant: result.quant || 'mlx',
        format: 'mlx',
        installId: result.id, // bare repo — mlx-community encodes the quant in the name
        sizeBytes: Number.isFinite(result.sizeBytes) ? result.sizeBytes : null,
        size: formatBytes(result.sizeBytes) || (result.quant ? result.quant.toUpperCase() : 'MLX'),
        fit: classifyFit(result.sizeBytes, usableBytes),
        installed: installIdInstalled(backend, result.id, result.repository, installedIds),
        recommended: true
      }
      result.variants = [variant]
      result.installed = variant.installed
      return
    }
    if (!isAudio) {
      applyGgufVariants(result, model, { backend, usableBytes, installedIds })
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

export async function searchHuggingFaceModels({ backend, query = '', category = 'all', limit = 12, installedIds = [], installedAudioRepos = [], systemMemoryBytes = null, appleSilicon = false }) {
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
  // The default/category browse phrase contains "gguf" — sending that to the MLX
  // query (`filter=mlx&search=…gguf`) filters out MLX-only repos. Use a parallel
  // phrase with "gguf" swapped for "mlx" (or a bare "mlx") so the default browse
  // surfaces MLX repos, not just hand-typed queries that happen to match one.
  const mlxSearch = normalizeText(query) || CATEGORY_SEARCH[requestedCategory]?.replace(/\bgguf\b/gi, 'mlx') || 'mlx'
  const fetchLimit = Math.max(limit * 3, 30)
  // MLX is only installable via LM Studio on Apple Silicon (see toMlxResult), so
  // run the extra MLX query only there — never for Ollama, non-Apple hosts, or
  // the audio category. `appleSilicon` is injected by the route (default false),
  // keeping the service deterministic for tests regardless of the test host.
  const wantMlx = appleSilicon && backend === 'lmstudio' && requestedCategory !== 'audio'
  const [ggufModelsRaw, mlxModelsRaw] = await Promise.all([
    fetchModels(search, fetchLimit, ggufOnly ? 'gguf' : null),
    // MLX is optional enrichment — a transient/API-specific MLX-query failure must
    // not blank the primary GGUF results, so swallow it to an empty list. (The
    // GGUF query still throws on failure, preserving the original error behaviour.)
    wantMlx ? fetchModels(mlxSearch, fetchLimit, 'mlx').catch(() => []) : Promise.resolve([])
  ])
  let models = ggufModelsRaw
  if (models.length === 0 && ggufOnly) models = await fetchModels(search, fetchLimit, null)

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

  // MLX results (LM Studio + Apple Silicon only) merge into the same list — each
  // is its own card (`format: 'mlx'`), deduped against the GGUF repos already seen.
  const mlxLive = mlxModelsRaw
    .filter((model) => hasMlxSignal(model))
    .map((model) => toMlxResult(model, requestedCategory, installedIds))
    .filter(Boolean)
    .filter((model) => {
      if (seen.has(model.repository)) return false
      seen.add(model.repository)
      return true
    })

  const results = [...curated, ...live, ...mlxLive]
    .sort((a, b) => b.score - a.score || b.downloads - a.downloads)
    .slice(0, limit)

  return enrichWithSizes(results, { backend, usableBytes, installedIds })
}

// The Hugging Face repo backing a curated install id, or null for a bare Ollama
// registry name. LM Studio curated ids ARE HF repos (`publisher/Repo-GGUF`);
// Ollama ids are HF-backed only when prefixed `hf.co/`. Bare Ollama names
// (`llama3.2`, `qwen2.5`) pull from Ollama's own registry — those are enriched
// from the Ollama registry tags/manifests instead (see applyOllamaRegistryVariants).
function catalogRepoForBackend(backend, id) {
  const raw = String(id || '')
  if (backend === 'lmstudio') return raw.includes('/') ? raw.split('@')[0] : null
  const m = raw.match(/^hf\.co\/(.+)$/i)
  return m ? m[1].split(':')[0] : null
}

// Quant tag baked into a curated install id (`<repo>@Q4_K_M` / `hf.co/<repo>:Q4`),
// so the no-RAM-budget fallback can anchor on the curator's chosen quant. Null
// for ids with no quant tag (bare LM Studio repos / bare Ollama names).
function quantFromInstallId(backend, id) {
  const raw = String(id || '')
  if (backend === 'lmstudio') {
    const at = raw.indexOf('@')
    return at >= 0 ? raw.slice(at + 1) : null
  }
  const slash = raw.indexOf('/')
  const colon = raw.lastIndexOf(':')
  return colon > slash ? raw.slice(colon + 1) : null
}

// Enrich a bare Ollama registry entry (no HF repo) in place with a per-quant
// picker built from the Ollama registry's tags + manifests — the registry-backed
// analog of applyGgufVariants. The curated id stays stable (rewriteInstallId is
// implicitly false here); the RAM-aware default is conveyed via the recommended
// variant, whose installId is the precise `<name>:<tag>` pull. Returns true when
// variants were applied, false when the model isn't on the registry / has no
// quant-tagged builds (the curated entry then keeps its single hard-coded build).
async function applyOllamaRegistryVariants(entry, { usableBytes, installedIds }) {
  const candidates = await fetchOllamaRegistryVariants(entry.id, { paramsHint: entry.params })
  if (candidates.length === 0) return false
  // Whether the user already pulled the curator's default build (`entry.id`, e.g.
  // `llama3.2` stored as `:latest`). getCatalog set entry.installed latest-normalized.
  const installedAsDefault = entry.installed === true
  const variants = candidates
    .map((c) => {
      const sizeBytes = Number.isFinite(c.sizeBytes) ? c.sizeBytes : null
      return {
        quant: c.quant,
        format: 'gguf',
        installId: c.installId,
        sizeBytes,
        size: formatBytes(sizeBytes) || c.quant,
        fit: classifyFit(sizeBytes, usableBytes)
      }
    })
    .sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  // Per-quant installed state — Ollama tracks each `<name>:<tag>` build separately,
  // so the card gates Install on the selected variant (matches applyGgufVariants).
  for (const v of variants) v.installed = installIdInstalled('ollama', v.installId, entry.repository, installedIds)
  // The discovered quant variants use exact `<name>:<tag>` ids that never include the
  // default `:latest` alias, so an already-installed default build matches none of them.
  // The card gates Install on the SELECTED variant's `installed` (LocalLlmTab uses
  // `chosenVariant.installed`), so without representing the default build the card would
  // show Install for a model the user already has and pull a duplicate tag. Surface the
  // installed default as its own variant (install id = the curator's id, the real tag the
  // user pulled) when no discovered quant variant is itself installed.
  const hasInstalledVariant = variants.some((v) => v.installed)
  const defaultBuildPresent = variants.some((v) => v.installId === entry.id)
  if (installedAsDefault && !hasInstalledVariant && !defaultBuildPresent) {
    const sizeBytes = Number.isFinite(entry.sizeBytes) ? entry.sizeBytes : null
    variants.unshift({
      quant: entry.quant || quantFromInstallId('ollama', entry.id) || 'default',
      format: 'gguf',
      installId: entry.id,
      sizeBytes,
      size: formatBytes(sizeBytes) || entry.size || 'installed',
      fit: classifyFit(sizeBytes, usableBytes),
      installed: true
    })
  }
  // Seed the quant from the curator's id (`gpt-oss:20b` has no quant tag, so this
  // is usually null) so the no-RAM-budget fallback can anchor on it.
  if (entry.quant == null) entry.quant = quantFromInstallId('ollama', entry.id)
  // Initial selection: prefer the already-installed default build (so the card reads
  // Installed, its pre-enrichment behavior) over a RAM-aware re-pull; otherwise the
  // RAM-aware pick. The other quants stay listed with their true per-tag installed
  // state + fit hints for explicit selection. Keep the stable curated id either way.
  const installedDefault = variants.find((v) => v.installId === entry.id && v.installed)
  if (installedDefault) {
    for (const v of variants) v.recommended = v === installedDefault
    applyVariant(entry, installedDefault, false)
    entry.variants = variants
  } else {
    applyChosenVariant(entry, variants, { usableBytes, rewriteInstallId: false })
  }
  entry.format = 'gguf'
  return true
}

// Enrich curated-catalog entries (from localLlmCatalog.getCatalog) in place with
// the same per-quant variant picker + RAM-aware default the live HF search uses.
// HF-repo-backed entries (see catalogRepoForBackend) read their GGUF siblings;
// bare Ollama registry names are enriched from the Ollama registry instead. An
// MLX-only repo (no GGUF quants) or a model absent from the registry is left
// untouched — the card then shows the curator's single id with no picker.
// `usableBytes` makes the recommended quant fit this machine.
export async function enrichCatalogWithVariants(catalog, { backend, systemMemoryBytes = null, installedIds = [], timeoutMs = CATALOG_ENRICH_TIMEOUT_MS } = {}) {
  if (!isBackend(backend) || !Array.isArray(catalog)) return catalog
  const usableBytes = usableMemoryBytes(systemMemoryBytes)
  const work = Promise.allSettled(catalog.map(async (entry) => {
    const repo = catalogRepoForBackend(backend, entry.id)
    if (!repo) {
      // Bare Ollama registry name (no HF repo) — discover quants from the Ollama
      // registry. LM Studio bare ids never reach here (catalogRepoForBackend
      // returns the repo for any `publisher/Repo`); a null repo there means a
      // malformed id, which has nothing to enrich.
      if (backend === 'ollama') await applyOllamaRegistryVariants(entry, { usableBytes, installedIds })
      return
    }
    const model = await fetchRepoModel(repo)
    if (!model) return
    entry.repository = repo
    // Seed the quant from the curator's id so the no-budget fallback anchors on it.
    if (entry.quant == null) entry.quant = quantFromInstallId(backend, entry.id)
    // Keep the curated entry's stable id (rewriteInstallId: false) — the playground
    // matches installed models on it; the UI installs the recommended variant.
    const applied = applyGgufVariants(entry, model, { backend, usableBytes, installedIds, rewriteInstallId: false })
    if (!applied) return // MLX-only / no parseable GGUF quant — leave the curated entry as-is
    entry.format = 'gguf'
    // Backfill the real size + native context window the curated list hard-codes.
    if (!Number.isFinite(entry.sizeBytes)) {
      const picked = pickGgufFile(model)
      if (Number.isFinite(picked?.size)) {
        entry.sizeBytes = picked.size
        entry.size = formatBytes(picked.size) || entry.size
      }
    }
    if (entry.contextLength == null) {
      const ctx = contextLengthOf(model)
      if (ctx != null) entry.contextLength = ctx
    }
  }))
  // Bound the wait so a slow/unreachable HF never stalls the (offline-capable)
  // catalog endpoint. Entries enrich in place, so whatever resolved within the
  // budget is already applied; the rest keep their hard-coded fields and their
  // probes keep running in the background to warm the repo cache for next time.
  if (timeoutMs > 0) {
    let timer
    const budget = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.() })
    await Promise.race([work.finally(() => clearTimeout(timer)), budget])
  } else {
    await work
  }
  return catalog
}
