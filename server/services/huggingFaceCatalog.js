import { formatBytes as formatBytesRaw } from '../lib/fileUtils.js'
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js'
import { readResponseJson } from '../lib/readResponseJson.js'
import { createConcurrencyGate } from '../lib/concurrencyGate.js'
import { createSingleFlight } from '../lib/singleFlight.js'
import { describeFetchError, isReplayableConnectionError } from '../lib/fetchErrorChain.js'
import { readCachedRepoModel, writeCachedRepoModel } from './huggingFaceRepoCache.js'
import { LOCAL_LLM_CATEGORIES, isBackend } from '../lib/localLlmCatalog.js'
import { ENGINES } from './pipeline/musicGen.js'
import { fetchOllamaRegistryVariants } from './ollamaRegistryCatalog.js'
import { reconcileFit } from '../lib/localModelAssessment.js'

const HF_API_BASE = 'https://huggingface.co/api/models'
const HF_TIMEOUT_MS = 12_000
// Pause before the single connection-blip retry (see hfFetch).
const HF_RETRY_DELAY_MS = 250
// Upper bound on how long the curated-catalog endpoint waits for HF variant
// enrichment. The curated catalog must stay usable offline (it was a pure local
// list before enrichment), so when HF is slow/down we return the catalog as-is
// after this budget; in-flight probes keep running and warm the repo cache, so
// the next load (or a recovered HF) enriches without delay.
const CATALOG_ENRICH_TIMEOUT_MS = 5_000
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

const CATEGORY_IDS = new Set(LOCAL_LLM_CATEGORIES.map((c) => c.id))
// Default browse phrases used when the search box is empty (and as the seed when
// a category tag is clicked with no query). The Hub `search` param is AND-across
// the space-separated tokens against the model id, so a multi-word phrase like
// 'coding coder agentic code gguf' matches ZERO repos (no id contains all five) —
// the category tab then renders blank. Keep each phrase to a single category
// keyword + 'gguf' so the default browse reliably returns the top-downloaded
// matches for that category. The user's typed query overrides these entirely.
const CATEGORY_SEARCH = {
  // General purpose is the broad "start here" lane. Chat & voice remains a
  // narrower workflow filter in the curated catalog, but the Hub has no
  // reliable tag for that distinction, so it uses the same instruct search.
  general: 'instruct gguf',
  chat: 'instruct gguf',
  reasoning: 'reasoning gguf',
  coding: 'coder gguf',
  writing: 'fiction gguf',
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
  'UD-Q6_K',
  'Q6_K',
  'UD-Q8_K_XL',
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
  // The quant must be its own trailing token — start-of-name or after a `-`/`_`/`.`
  // separator. Without that boundary a repo's custom scheme suffix bleeds into a
  // bogus standard quant (`BTL-3-Compact-AVQ2` → `Q2`), and the resulting
  // `hf.co/<repo>:Q2` pull is rejected by Ollama with "not a valid quantization
  // scheme". An unparseable quant is better as null: the install id then falls
  // back to the bare repo, which Ollama resolves via its `latest` manifest.
  // `FP16` is deliberately NOT a token here (only `F16`/`BF16`): Ollama rejects
  // an `:FP16` tag as an invalid scheme, and an `:F16` tag on a repo whose file
  // is named `…-fp16.gguf` 404s ("tag is not available in the repository"), so a
  // `…-fp16.gguf` build has no pullable tag at all — dropping it from the variant
  // list and installing the repo's `latest` is the only form that works.
  const match = stem.match(/(?:^|[-_.])((?:UD-)?(?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16))$/i)
  return match?.[1] || null
}

function pickGgufFile(model) {
  const files = ggufFilesOf(model)
  if (files.length === 0) return null
  const ranked = files
    .map((file) => {
      const quant = quantFromFilename(file.name)
      const priority = quant ? QUANT_PRIORITY.findIndex((q) => q.toLowerCase() === quant.toLowerCase()) : -1
      return { ...file, quant, priority: priority === -1 ? 999 : priority }
    })
    .sort((a, b) => a.priority - b.priority || (a.size || Number.MAX_SAFE_INTEGER) - (b.size || Number.MAX_SAFE_INTEGER))
  const picked = ranked[0]
  // A repo whose builds all use a non-standard scheme (`…-AVQ2.gguf`) parses to no
  // quant, so the install id is the bare repo and the BACKEND decides which build
  // to pull. With several such files the pick above is arbitrary (all tie at 999,
  // so size-ascending wins) — advertising its size would promise "8.4 GB · fits
  // comfortably" for an install that may fetch a much larger build. Drop the size
  // so the card reports an unknown fit instead. A single-GGUF repo is unambiguous.
  return !picked.quant && ranked.length > 1 ? { ...picked, size: null } : picked
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
  return 'general'
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
  if (category !== 'general' && CATEGORY_SEARCH[category]?.split(/\s+/).some((term) => categoryText.includes(term))) score += 12
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
function installIdInstalled(backend, installId, installedIds) {
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
  return installIdInstalled(backend, result.id, installedIds)
}

// ---- MLX (Apple Silicon) ----------------------------------------------------
// MLX is Apple's native ML format. It ships sharded `.safetensors` + a config
// (no single GGUF). Live Hub discovery remains LM Studio-only: `lms get <repo>`
// understands an arbitrary result, whereas Ollama requires a supported local
// Safetensors import and a deliberate local model name. Curated Ollama imports
// are declared in localLlmCatalog.js instead of making every search result look
// one-click compatible.
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

// Speculative-decoding drafter checkpoints (MTP heads, DFlash/DFlash2 block
// drafters) are auxiliary weights, not standalone chat models: the drafter for
// a 27B target is ~2B of sidecar that only produces text once an engine pairs
// it with that target. PortOS orchestrates Ollama and LM Studio and does not
// own that pairing (docs/research/2026-08-19-dflash2-speculative-decoding.md,
// .../2026-08-16-qwen38-mlx-macos.md), so installing one hands the user a model
// that cannot chat.
//
// `draft-model` / `drafter` is the publisher's own declaration that a repo is
// non-standalone, and it is the only signal precise enough for the GGUF long
// tail. Looser ones do not survive contact with real repos: an `mtp` or
// `speculative-decoding` TAG also sits on complete models that merely preserve
// their built-in MTP head (`unsloth/Qwen3.6-27B-MTP-GGUF`), so matching those
// would hide mainstream one-click installs — a worse failure than this one.
const DRAFTER_TAGS = new Set(['draft-model', 'drafter'])

function hasDrafterTag(model) {
  return tagsOf(model).some((tag) => DRAFTER_TAGS.has(tag))
}

// The MLX branch additionally matches the repo NAME. That space is curated
// (mlx-community and Apple-Silicon republishers), where a `-MTP-`/`-DFlash-`
// suffix reliably marks a sidecar — unlike the GGUF long tail above. `dflash`
// joins the pre-existing `mtp`/`drafter` tokens because DFlash drafters ship as
// MLX safetensors too (`jfan/Qwen3.8-27B-heretic-dflash`), and `\d*` covers the
// DFlash2 generation. `dspark` is the same sidecar class from DeepSeek's
// drafter family — `mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-DSpark-bf16`
// declares `mlx` + `dspark` + `speculative-decoding` but no `draft-model` tag, so
// the tag predicate alone would offer a 30B target's drafter as a one-click
// install (docs/research/2026-08-19-dspark-vs-dflash2.md).
const MLX_DRAFTER_NAME_RE = /(?:^|[\/_-])(?:mtp|dflash\d*|dspark|drafter)(?:[\/_\-.]|$)/i

function isMlxDrafter(model) {
  return hasDrafterTag(model) || MLX_DRAFTER_NAME_RE.test(repoIdOf(model))
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
  result.installed = installIdInstalled('lmstudio', repoId, installedIds)
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
      { headers: hfHeaders() },
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
async function fetchModels(search, limit, filter) {
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
async function fetchRepoModel(repoId) {
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
  for (const v of variants) v.installed = installIdInstalled(backend, v.installId, installedIds)
  applyChosenVariant(result, variants, { usableBytes, rewriteInstallId })
  return true
}

// MLX repos encode one quantization in the repository name and ship sharded
// safetensors rather than a per-file GGUF picker. Keep the single-variant shape
// shared by live Hugging Face results and curated catalog entries so both paths
// use the same size, fit, and installed-state contract.
function applyMlxVariant(result, model, { backend, usableBytes, installedIds }) {
  const bytes = sumSafetensorsBytes(model)
  if (Number.isFinite(bytes)) {
    result.sizeBytes = bytes
    result.size = formatBytes(bytes) || result.size
  }
  const quant = result.quant || mlxQuantFromRepo(result.repository || result.id)
  if (result.quant == null && quant) result.quant = quant
  const variant = {
    quant: quant || 'mlx',
    format: 'mlx',
    installId: result.id, // bare repo — the repo name encodes the MLX quant
    sizeBytes: Number.isFinite(result.sizeBytes) ? result.sizeBytes : null,
    size: formatBytes(result.sizeBytes) || result.size || (quant ? quant.toUpperCase() : 'MLX'),
    fit: classifyFit(result.sizeBytes, usableBytes),
    installed: installIdInstalled(backend, result.id, installedIds),
    recommended: true
  }
  result.format = 'mlx'
  result.variants = [variant]
  result.installed = variant.installed
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
      applyMlxVariant(result, model, { backend, usableBytes, installedIds })
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
  // Arbitrary live MLX results are installable only through LM Studio (see
  // toMlxResult); trusted Ollama imports come from the curated catalog. Run this
  // discovery query only for LM Studio on Apple Silicon, never for Ollama,
  // non-Apple hosts, or audio. `appleSilicon` is route-injected (default false),
  // keeping tests deterministic regardless of their host.
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
    // Drafter sidecars ship in GGUF too (`incoai/Qwen3.8-27B-DFlash2-GGUF`), and
    // nothing about their listing says "not a chat model" except the tag.
    .filter((model) => !hasDrafterTag(model))
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
    .filter((model) => hasMlxSignal(model) && !isMlxDrafter(model))
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
  if (backend === 'lmstudio') {
    const hfUrl = raw.match(/^https?:\/\/(?:www\.)?huggingface\.co\/([^/?#]+\/[^/?#]+)/i)
    return hfUrl?.[1] || (raw.includes('/') ? raw.split('@')[0] : null)
  }
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
  for (const v of variants) v.installed = installIdInstalled('ollama', v.installId, installedIds)
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
// curated MLX entries get one native-format variant; bare Ollama registry names
// are enriched from the Ollama registry instead. A model absent from its source
// is left untouched so the offline catalog still renders.
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
    if (entry.format === 'mlx') {
      applyMlxVariant(entry, model, { backend, usableBytes, installedIds })
      return
    }
    // Seed the quant from the curator's id so the no-budget fallback anchors on it.
    if (entry.quant == null) entry.quant = quantFromInstallId(backend, entry.id)
    // Keep the curated entry's stable id (rewriteInstallId: false) — the playground
    // matches installed models on it; the UI installs the recommended variant.
    const applied = applyGgufVariants(entry, model, { backend, usableBytes, installedIds, rewriteInstallId: false })
    if (!applied) return // no parseable GGUF quant — leave the curated entry as-is
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

// Does a stored measurement describe THIS installable variant?
//
// Ollama: the install id carries the quant in its tag, so the same normalization
// `installed` uses is exactly right.
//
// LM Studio: the id is repo-level and the quant lives beside it on the record
// (`quantization`). Both must agree — including "both absent". A record written
// before `quantization` was captured therefore matches only a quant-less
// variant, which is the honest answer: it cannot say which build it measured.
function measurementMatches(backend, installId, measuredId, measurement) {
  if (backend === 'ollama') return installIdInstalled(backend, installId, [measuredId])
  const variant = lmStudioParts(installId)
  const stored = lmStudioParts(measuredId)
  if (variant.base !== stored.base) return false
  const storedQuant = stored.quant || normalizeText(measurement?.quantization).toLowerCase()
  return variant.quant === storedQuant
}

/**
 * Fold MEASURED evidence into the estimated fit badge.
 *
 * `classifyFit` above answers from file size alone: weight bytes × 1.2 against a
 * usable-memory budget. It never runs the model, so it cannot see a build that
 * loads and then thrashes, nor one the backend refuses outright. Once an
 * assessment exists for a model (`services/localModelAssessmentStore.js`) the
 * measurement is the better answer, and where the two DISAGREE is the most
 * useful thing this data can say — so both are kept on the variant.
 *
 * Matching shares `installIdInstalled`'s normalization for Ollama (casing and a
 * trailing `:latest`), but is STRICTER about quantization than the installed
 * flag is. `installIdInstalled` deliberately treats a quant-less id as matching
 * any quant — right for "is this repo installed", wrong here: an LM Studio
 * measurement is stored against a repo-level id, so a loose match would stamp
 * one quant's measured verdict onto every quant of the repo. A measurement
 * therefore only lands on a variant whose quant it actually names.
 *
 * Mutates in place (the catalog builders already do) and returns `models`.
 *
 * @param {Array<object>} models catalog/search results
 * @param {{ backend: string, measured?: Record<string, object> }} options
 *   `measured` comes from `getMeasuredFits(backend)`; `{}` means nothing has been
 *   measured, which leaves every estimate exactly as it was.
 */
export function applyMeasuredFit(models, { backend, measured } = {}) {
  const list = Array.isArray(models) ? models : []
  const measuredIds = measured ? Object.keys(measured) : []
  if (!measuredIds.length) return list
  const measurementFor = (installId) => {
    if (!installId) return null
    const hit = measuredIds.find((id) => measurementMatches(backend, installId, id, measured[id]))
    return hit ? measured[hit] : null
  }
  for (const model of list) {
    // Audio/music entries install into the shared audio registry, not a local
    // LLM backend, so a chat-model measurement can never describe them.
    if (model?.category === 'audio') continue
    const variants = Array.isArray(model?.variants) ? model.variants : []
    for (const variant of variants) {
      Object.assign(variant, reconcileFit(variant.fit, measurementFor(variant.installId)))
    }
    // Entries with no variant list (curated results without `?variants=1`) carry
    // no estimated fit at all — a measurement is then the ONLY thing that can
    // say anything, so surface it rather than leaving the card blank.
    if (!variants.length) Object.assign(model, reconcileFit(model?.fit ?? null, measurementFor(model?.id)))
  }
  return list
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
