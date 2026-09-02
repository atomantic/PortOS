/**
 * Local-model capability heuristics.
 *
 * Local backends (Ollama / LM Studio) don't tag their models with a capability
 * type, so PortOS infers one from the model id / family string. Kept pure and
 * dependency-free so every consumer shares one source of truth:
 *   - ollamaManager.getEmbeddings (auto-discover an embedding model)
 *   - promptRunner.resolveEffectiveModel (never pick an embedding model for a
 *     generation/fallback run — the cause of the nomic-embed-text fallback bug)
 *   - localLlm.getStatus (recommend a best-fit editorial model)
 *
 * The client mirrors `isEmbeddingModel` + `isVisionModel` + `isToolUseModel`
 * in client/src/utils/providers.js — keep the regexes in lockstep (the
 * aiToolkit/lib dirs can't be imported there). `localModelHeuristics.mirror.test.js`
 * enforces that, by what each pattern matches rather than by its text.
 */

// Embedding-only models — never valid for chat/generation. The bge/nomic/e5/gte
// markers are anchored so they don't match mid-word inside an unrelated id.
// `embeddinggemma` glues the marker to the family with no separator, so the
// anchored `embedding` alternative misses it — match that name explicitly or it
// reads as a chat-capable Gemma and gets picked for generation.
// `minilm` / `paraphrase-multilingual` carry no `embed` marker at all
// (`all-minilm`, `paraphrase-multilingual` are two of Ollama's own embedding
// models) — matched by family, or they read as chat models and get benchmarked
// or picked for generation, which the daemon answers with
// `400 "…" does not support chat`.
const EMBEDDING_RE =
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5|snowflake-arctic-embed)(?:[-_/:]|$)|text-embedding|embeddinggemma|minilm|paraphrase-multilingual/i;

// `embedding` is Ollama's raw capability name; `embeddings` is the badge label a
// normalized PortOS model card carries (and LM Studio's `type`).
const isEmbeddingCapability = (value) => {
  const normalized = value ? String(value).toLowerCase() : '';
  return normalized === 'embedding' || normalized === 'embeddings';
};

/**
 * Detect an embedding-only model from its id and/or backend capability
 * metadata. Prefers explicit metadata, exactly like `isVisionModel` /
 * `isToolUseModel`: Ollama's `/api/show` reports `capabilities: ['embedding']`
 * for an embedding model and e.g. `['completion','tools','thinking']` for a
 * chat model, so a non-empty array is authoritative in BOTH directions and the
 * id regex is only the fallback for bare id strings (LM Studio, a stored
 * provider `models` list, `/api/tags` with no enrichment).
 *
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
 *   model id (e.g. "nomic-embed-text:latest") or a model card
 * @returns {boolean} true when the model is embedding-only
 */
export function isEmbeddingModel(model) {
  if (!model) return false;
  if (typeof model === 'string') return EMBEDDING_RE.test(model);
  if (typeof model !== 'object') return false;
  // LM Studio's native model list types every model (`embeddings` / `llm` /
  // `vlm`); Ollama's /api/show reports a capabilities array. Either one is
  // authoritative in BOTH directions, so a chat model whose NAME happens to
  // match (a fine-tune with `e5` in it) is not hidden from a generation picker.
  //
  // BOTH spellings are accepted because two vocabularies reach here: Ollama's
  // raw capability is `embedding`, while a normalized PortOS model card carries
  // the BADGE label `embeddings` (`localLlm.js#OLLAMA_CAPABILITY_BADGES` /
  // `lmStudioBadgeCapabilities`). Matching only one would make a non-empty
  // badge array an authoritative FALSE for a model that is plainly an
  // embedding model.
  const type = model.type ? String(model.type).toLowerCase() : null;
  if (isEmbeddingCapability(type)) return true;
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    return model.capabilities.some((c) => isEmbeddingCapability(c));
  }
  if (type) return false; // explicit non-embedding type — don't regex-guess past it
  const id = model.id || model.name || '';
  return typeof id === 'string' && id.length > 0 && EMBEDDING_RE.test(id);
}

/**
 * A model usable for chat/generation — anything that isn't an embedding model.
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
 * @returns {boolean}
 */
export function isGenerationModel(model) {
  if (typeof model === 'string') return model.length > 0 && !isEmbeddingModel(model);
  return Boolean(model && typeof model === 'object' && (model.id || model.name)) && !isEmbeddingModel(model);
}

// Vision / multimodal (VLM) model id markers. These are the families that
// accept image content blocks on an OpenAI-compatible /chat/completions call.
// Two groups:
//   - Short/ambiguous tokens (`vision`, `vl`) must be token-bounded so they
//     don't match mid-word (`vl` is the Qwen-VL/InternVL suffix). `vl` requires
//     a leading boundary and a trailing boundary-or-digit (`internvl2`).
//   - Distinctive family names are matched as plain substrings — they're
//     unique enough that an interior version digit (`internvl2`, `glm-4v`)
//     shouldn't defeat the match.
const VISION_RE = new RegExp([
  '(?:^|[-_/:])vision(?:[-_/:.]|$)',
  '(?:^|[-_/:])vl(?:\\d|[-_/:.]|$)',
  // Qwen-VL ids glue the family to `vl` with a version digit and no separator
  // (Ollama tags it `qwen2.5vl`, not `qwen2.5-vl`), so the bounded `vl` rule
  // above misses them — match the qwen…vl form explicitly.
  'qwen[\\d.]*-?vl',
  // Gemma 3 and 4 are multimodal. Anchor the family so `embeddinggemma-300m`
  // (which contains the literal `gemma-3`) isn't read as a vision model.
  '(?:^|[-_/:])gemma-?[34]',
  'llava', 'bakllava', 'moondream', 'minicpm-?v', 'pixtral',
  'smolvlm', 'internvl', 'cogvlm', 'glm-?4v', 'phi-?3\\.5?-vision',
  'phi-?4-multimodal', 'got-ocr', 'idefics', 'fuyu', 'paligemma',
  'kosmos', 'nanollava',
].join('|'), 'i');

// CLI providers whose underlying model is vision-capable and whose CLI accepts
// an image file (codex via `-i`, claude-code via a file in the working dir).
// CLI providers expose no enumerable model list with capability tags, so this
// command-based allow-list is how the captioner knows a CLI provider can read
// images. Keyed on `command` so a renamed/duplicated provider still qualifies.
const VISION_CLI_COMMANDS = new Set(['codex', 'claude']);

/**
 * Whether a CLI-type provider can caption images (its model reads vision and
 * its CLI accepts an image file). Returns false for non-CLI providers.
 *
 * @param {{type?:string, command?:string}} provider
 * @returns {boolean}
 */
export function isVisionCapableCliProvider(provider) {
  if (!provider || provider.type !== 'cli') return false;
  return VISION_CLI_COMMANDS.has(provider.command);
}

/**
 * Detect a vision-capable (multimodal) model from its id and/or backend
 * capability metadata. Prefers explicit metadata when present — LM Studio's
 * native `/api/v0/models` tags vision models with `type: 'vlm'`, and Ollama's
 * `/api/show` reports a `vision` capability — and falls back to the id regex
 * for backends that don't tag (or stored provider model lists that are just
 * strings).
 *
 * @param {string|{id?:string,name?:string,type?:string,capabilities?:string[]}} model
 * @returns {boolean}
 */
export function isVisionModel(model) {
  if (!model) return false;
  if (typeof model === 'string') return VISION_RE.test(model);
  if (typeof model !== 'object') return false;
  // Explicit metadata is authoritative — in BOTH directions. LM Studio tags
  // every model with a `type` (`vlm` / `llm` / `embeddings`), so a positive
  // `vlm` (or a `vision` capability) confirms vision, and any OTHER explicit
  // type means text-only even when the id happens to match the regex (e.g.
  // `gemma3:1b` is `type:'llm'` — a text-only Gemma 3). Only fall through to
  // the id heuristic when the backend gave us no capability metadata at all
  // (Ollama's /api/tags), so a name-only guess never overrides a known type.
  const type = model.type ? String(model.type).toLowerCase() : null;
  if (type === 'vlm') return true;
  if (Array.isArray(model.capabilities)
    && model.capabilities.some((c) => String(c).toLowerCase() === 'vision')) return true;
  if (type) return false; // explicit non-vision type — don't regex-guess past it
  const id = model.id || model.name || '';
  return typeof id === 'string' && VISION_RE.test(id);
}

// Tool-use (function-calling) capable model families. The CoS agent harness
// (Read/Write/Edit/Bash + the agent loop) depends entirely on reliable
// tool-calling, so a Claude-on-Ollama ("Claude Ollama") provider must only
// surface models that can actually drive tools. Ollama's /api/show reports a
// `tools` capability that is authoritative when present — this id regex is the
// fallback for bare model-id strings (e.g. LM Studio, or a stored provider
// `models` list). Matches the families with dependable function-calling support
// (Qwen 2.5/3+, Llama 3.1+, Mistral/Mixtral/Ministral, Cohere Command + North,
// Hermes, GLM-4, Granite 3/4, Gemma 4, gpt-oss, Nemotron, Olmo 3, LFM2, Ornith,
// Muse Glimmer, function-calling-specialized models). Llama 3.0 is deliberately
// NOT matched (tool use landed in 3.1); neither is Gemma 3 (tools landed in
// Gemma 4), so the gemma rule is anchored to the family AND the version.
//
// MIRRORED in client/src/utils/providers.js (isToolUseModel) and inlined in
// server/lib/aiToolkit/providers.js (TOOL_USE_RE) — keep all three in lockstep;
// `localModelHeuristics.mirror.test.js` fails when any of them drifts.
const TOOL_USE_RE = new RegExp([
  'qwen',
  'llama-?3\\.[1-9]', 'llama-?4',
  'mistral', 'mixtral', 'ministral', 'codestral', 'devstral', 'magistral',
  'command-?r', 'command-?a', 'north-mini-code',
  'firefunction', 'functionary', 'watt-tool', 'hermes', 'functiongemma',
  'glm-?4',
  'granite-?[34]',
  '(?:^|[-_/:])gemma-?4',
  'gpt-oss',
  'nemotron',
  'olmo-?3',
  'lfm2', 'ornith', 'muse-glimmer', 'nex-n2',
  'smollm2',
  'dflash',
  'deepseek-v3', 'deepseek-r1', 'deepseek-v4',
].join('|'), 'i');

/**
 * Detect a tool-use (function-calling) capable model from its id and/or backend
 * capability metadata. Prefers explicit metadata: Ollama's /api/show reports a
 * `tools` capability, which is authoritative in BOTH directions — a capabilities
 * array that lists `tools` confirms support, and a non-empty array WITHOUT it is
 * an explicit negative (don't regex-guess past it). Falls back to the id regex
 * only when no capability metadata is available (bare id strings, LM Studio).
 *
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
 * @returns {boolean}
 */
export function isToolUseModel(model) {
  if (!model) return false;
  if (typeof model === 'string') return TOOL_USE_RE.test(model);
  if (typeof model !== 'object') return false;
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    return model.capabilities.some((c) => String(c).toLowerCase() === 'tools');
  }
  const id = model.id || model.name || '';
  return typeof id === 'string' && TOOL_USE_RE.test(id);
}

// Families ranked for EDITORIAL FIX GENERATION, best-first. This task needs
// tight instruction-following and clean, constrained output (rewrite a passage,
// emit only the rewrite) — NOT chatty long-form generation. So instruction-tuned
// models lead; Cohere Command (R/R+) is demoted because it's RAG/long-form-tuned
// and tends to leak commentary/preamble into the output (observed: `# New page`
// notes and a `PANNEL` typo bleeding into a manuscript fix). Order is
// "most-preferred first"; `command-r-plus` must precede `command-r`/`command`
// so the longest substring match wins.
// Retired-but-installable families stay listed — this ranks whatever the user
// actually has on disk, not what the suggested-install catalog currently ships.
const EDITORIAL_FAMILY_RANK = [
  'qwen',                                    // Qwen — top-tier instruction-following + clean structured output
  'muse-glimmer',                            // Meta's current open model — Llama's successor lineage
  'llama',                                   // Llama 3.x instruct
  'gemma',                                   // Gemma 2/3/4 instruct
  'glm',                                     // GLM-4.x — strong prose, tight instruction-following
  'mixtral', 'ministral', 'mistral',         // Mistral family
  'granite',                                 // IBM Granite — constrained, clean structured output
  'olmo',                                    // AI2 Olmo — fully-open instruct
  'command-r-plus', 'command-r', 'command',  // Cohere Command — capable but chatty/RAG-tuned
  'nemotron',                                // NVIDIA — agentic/reasoning-tuned, chattier for prose
  'deepseek',                                // capable, leans code/math
  'phi',                                     // smaller but capable
  'gpt-oss',                                 // open-weights GPT
];

// Models we never recommend for editorial prose: embeddings, code-specialized,
// vision-ONLY/multimodal, and media-generation weights that may be installed.
// Only vision-*specialist* markers belong here — general models that happen to
// read images (Gemma 4, Qwen3.5, Ministral 3) are excellent editors, so the
// `-VL` / `…V` / OCR suffixes are matched rather than a whole family.
const NON_EDITORIAL_RE =
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5)(?:[-_/:]|$)|text-embedding|embeddinggemma|minilm|paraphrase-multilingual|coder|code-|starcoder|codellama|codegemma|(?:^|[-_/:])vision(?:[-_/:]|$)|(?:^|[-_/:])vl(?:\d|[-_/:.]|$)|qwen[\d.]*-?vl|glm-?[\d.]+v(?:[-_/:.]|$)|(?:^|[-_/:])ocr(?:[-_/:.]|$)|llava|moondream|minicpm-v|whisper|(?:^|[-_/:])tts(?:[-_/:]|$)|stable-?diffusion|sdxl|flux/i;

/** Parse a parameter count in billions from a model's `params`/id (e.g. "35B"). */
function parseParamsB(model) {
  const src = `${model?.params || ''} ${model?.id || model?.name || ''}`;
  const m = src.match(/(\d+(?:\.\d+)?)\s*[bB]\b/);
  return m ? parseFloat(m[1]) : null;
}

/** Score model size for editorial quality — bigger is better, peaking ~27–80B. */
function sizeScore(b) {
  if (b == null) return 0.4; // unknown — neutral
  if (b < 4) return 0.1;     // too small for nuanced editing
  if (b < 8) return 0.5;
  if (b < 14) return 0.7;
  if (b < 24) return 0.85;
  if (b <= 80) return 1.0;   // sweet spot for quality editing
  return 0.9;                // very large — great quality, slower
}

/** Score the model family against the editorial preference list. */
function familyScore(id) {
  const lower = String(id).toLowerCase();
  const idx = EDITORIAL_FAMILY_RANK.findIndex((fam) => lower.includes(fam));
  if (idx === -1) return 0.3; // unknown family — usable but unranked
  return 1.0 - (idx / EDITORIAL_FAMILY_RANK.length) * 0.5; // [1.0 .. 0.5], best-first
}

// How much a fresh, successful measurement is worth against the family/size
// guess. Big enough that a model PROVEN to run here beats an equally-plausible
// guess, small enough that it can't drag a poor editorial family (a coder model,
// a 1B toy) past a strong one just for having been benchmarked.
const MEASURED_FITS_BONUS = 0.12;

/**
 * Recommend the best installed model for editorial feedback / line editing.
 *
 * The family/size heuristic is a guess from a model's name. When a MEASUREMENT
 * exists for a model (`services/localModelAssessmentStore.js#getMeasuredFits`)
 * it overrules the guess in the two places evidence is decisive:
 *
 *   - a model measured `does-not-fit` / `incompatible` is dropped outright — the
 *     name says it would be a great editor, the machine says it cannot run it;
 *   - a model measured `fits` gets a bonus, so proven beats plausible.
 *
 * A STALE measurement (taken before a RAM upgrade or a backend update) does
 * neither: it describes a machine that no longer exists, so the guess stands.
 * An UNMEASURED model is untouched — unknown is not a mark against it.
 *
 * @param {Array<string|{id?:string,name?:string,params?:string,family?:string}>} models
 * @param {{ measured?: Record<string, {verdict?:string, stale?:boolean}> }} [options]
 *   `measured` is keyed by model id; a missing key means "never measured".
 * @returns {{ id: string, reason: string, evidence: 'measured'|'estimated',
 *   ruledOutByMeasurement: string[] }|null} null when nothing is suitable
 */
export function recommendEditorialModel(models, { measured = {} } = {}) {
  const editorial = (models || [])
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m?.id && !NON_EDITORIAL_RE.test(m.id));

  // Trusted only when fresh — a stale reading is not evidence about this machine.
  const trustedVerdict = (id) => {
    const record = measured?.[id];
    return record && !record.stale ? record.verdict : null;
  };
  const ruledOutByMeasurement = editorial
    .filter((m) => ['does-not-fit', 'incompatible'].includes(trustedVerdict(m.id)))
    .map((m) => m.id);
  const ruledOut = new Set(ruledOutByMeasurement);

  const candidates = editorial.filter((m) => !ruledOut.has(m.id));
  if (!candidates.length) return null;

  let best = null;
  for (const m of candidates) {
    const paramsB = parseParamsB(m);
    const fits = trustedVerdict(m.id) === 'fits';
    const score = familyScore(m.id) * 0.6 + sizeScore(paramsB) * 0.4 + (fits ? MEASURED_FITS_BONUS : 0);
    if (!best || score > best.score) best = { id: m.id, score, paramsB, fits };
  }
  if (!best) return null;

  const sizeLabel = best.paramsB ? `${best.paramsB}B params` : 'size unknown';
  const measuredNote = best.fits ? ' Measured on this machine: it runs here.' : '';
  const ruledOutNote = ruledOutByMeasurement.length
    ? ` ${ruledOutByMeasurement.length} otherwise-preferred model${ruledOutByMeasurement.length === 1 ? '' : 's'} ruled out by measurement (${ruledOutByMeasurement.join(', ')}).`
    : '';
  return {
    id: best.id,
    reason: `Best installed fit for editorial review/editing (${sizeLabel}) — tight instruction-following and clean, constrained output for generating fixes.${measuredNote}${ruledOutNote}`,
    // Says which kind of answer this is, so a caller never presents a guess with
    // the confidence of a measurement.
    evidence: best.fits ? 'measured' : 'estimated',
    ruledOutByMeasurement,
  };
}
