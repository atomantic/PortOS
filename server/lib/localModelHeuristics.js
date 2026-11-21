/**
 * Local-model capability heuristics: Ollama / LM Studio don't tag models with a capability type, so PortOS infers
 * one from the model id / family. Pure and dependency-free (the browser re-exports these).
 *
 * `TOOL_USE_RE` is also inlined in server/lib/aiToolkit/internal/providerCatalogService.js because the vendored toolkit may not import
 * out of its directory; `localModelHeuristics.mirror.test.js` fails when the copies drift.
 */

// Embedding-only models, never valid for chat/generation. Markers are anchored so they don't match mid-word. `embeddinggemma`, `minilm` and
// `paraphrase-multilingual` carry no separable `embed` marker, so they are matched by name or they read as chat models (the daemon answers 400 "does not support chat").
const EMBEDDING_RE =
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5|snowflake-arctic-embed)(?:[-_/:]|$)|text-embedding|embeddinggemma|minilm|paraphrase-multilingual/i;

// `embedding` is Ollama's raw capability; `embeddings` is the badge label on a normalized PortOS model card (and LM Studio's `type`).
const isEmbeddingCapability = (value) => {
  const normalized = value ? String(value).toLowerCase() : '';
  return normalized === 'embedding' || normalized === 'embeddings';
};

/**
 * Explicit metadata is authoritative in BOTH directions (Ollama `capabilities` array, LM Studio `type`); the id regex is only the fallback for bare id strings.
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
 * @returns {boolean} true when the model is embedding-only
 */
export function isEmbeddingModel(model) {
  if (!model) return false;
  if (typeof model === 'string') return EMBEDDING_RE.test(model);
  if (typeof model !== 'object') return false;
  // Both vocabularies reach here (raw `embedding`, badge `embeddings`); matching one would make a non-empty badge array an authoritative false.
  // A chat model whose name merely matches (a fine-tune with `e5`) is thus not hidden from generation pickers.
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
 * A model usable for chat/generation: anything that isn't an embedding model.
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
 */
export function isGenerationModel(model) {
  if (typeof model === 'string') return model.length > 0 && !isEmbeddingModel(model);
  return Boolean(model && typeof model === 'object' && (model.id || model.name)) && !isEmbeddingModel(model);
}

// Vision/multimodal id markers (models accepting image blocks on /chat/completions). Short tokens (`vision`, `vl`) are token-bounded so they
// don't match mid-word; distinctive family names match as substrings so an interior version digit (`internvl2`, `glm-4v`) doesn't defeat them.
const VISION_RE = new RegExp([
  '(?:^|[-_/:])vision(?:[-_/:.]|$)',
  '(?:^|[-_/:])vl(?:\\d|[-_/:.]|$)',
  // Ollama tags Qwen-VL `qwen2.5vl` with no separator, which the bounded `vl` rule misses.
  'qwen[\\d.]*-?vl',
  // Anchored so `embeddinggemma-300m` (contains `gemma-3`) isn't read as vision.
  '(?:^|[-_/:])gemma-?[34]',
  'llava', 'bakllava', 'moondream', 'minicpm-?v', 'pixtral',
  'smolvlm', 'internvl', 'cogvlm', 'glm-?4v', 'phi-?3\\.5?-vision',
  'phi-?4-multimodal', 'got-ocr', 'idefics', 'fuyu', 'paligemma',
  'kosmos', 'nanollava',
  'nemotron-?3\\.5?-bolt', 'nemotron-?3\\.5-?super',
  'ornith-?1\\.5', 'lfm3-?omni',
].join('|'), 'i');

// CLI providers whose CLI accepts an image file (codex `-i`, claude via a file in the working dir). CLI providers expose no capability-tagged model list,
// so this allow-list keyed on `command` (robust to renamed providers) is how the captioner knows. grok opens a staged image via read_file (#15576); agy inspects staged images in its workspace.
const VISION_CLI_COMMANDS = new Set(['codex', 'claude', 'grok', 'agy', 'antigravity']);

/**
 * Whether a CLI-type provider can caption images; false for non-CLI providers.
 * @param {{type?:string, command?:string}} provider
 */
export function isVisionCapableCliProvider(provider) {
  if (!provider || provider.type !== 'cli' || typeof provider.command !== 'string') return false;
  // Basename, as the client does, so a path-configured `/usr/local/bin/codex` qualifies.
  return VISION_CLI_COMMANDS.has(provider.command.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, ''));
}

/**
 * Explicit metadata (LM Studio `type: 'vlm'`, Ollama `vision` capability) is preferred; the id regex is the fallback for untagged backends and string lists.
 * @param {string|{id?:string,name?:string,type?:string,capabilities?:string[]}} model
 */
export function isVisionModel(model) {
  if (!model) return false;
  if (typeof model === 'string') return VISION_RE.test(model);
  if (typeof model !== 'object') return false;
  // Authoritative in BOTH directions: any explicit type other than `vlm` means text-only even when the id matches (`gemma3:1b` is a text-only `llm`). Regex only when no metadata exists (Ollama /api/tags).
  const type = model.type ? String(model.type).toLowerCase() : null;
  if (type === 'vlm') return true;
  if (Array.isArray(model.capabilities) && model.capabilities.length > 0) {
    return model.capabilities.some((c) => String(c).toLowerCase() === 'vision');
  }
  if (type) return false; // explicit non-vision type — don't regex-guess past it
  const id = model.id || model.name || '';
  return typeof id === 'string' && VISION_RE.test(id);
}

// Tool-use (function-calling) families. The CoS agent harness depends on reliable tool calls, so Claude-on-Ollama providers surface only models that can drive tools.
// Ollama's `tools` capability is authoritative when present; this regex is the fallback for bare ids. Llama 3.0 and Gemma 3 are deliberately NOT matched
// (tools landed in 3.1 / Gemma 4), so the gemma rule anchors family and version. Keep in lockstep with the copy in aiToolkit/internal/providerCatalogService.js.
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
  'lfm[23]', 'ornith', 'flint', 'muse-glimmer', 'nex-n2', 'inkling',
  'smollm2',
  'dflash',
  'deepseek-v3', 'deepseek-r1', 'deepseek-v4',
].join('|'), 'i');

/**
 * Ollama's `tools` capability is authoritative in BOTH directions: a non-empty array without it is an explicit negative. Id regex only when no metadata exists.
 * @param {string|{id?:string,name?:string,capabilities?:string[]}} model
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

// Families ranked for EDITORIAL FIX GENERATION, best-first: tight instruction-following and clean constrained output matter more than long-form chattiness,
// so Cohere Command (RAG-tuned, leaks preamble) is demoted. `command-r-plus` must precede `command-r`/`command` so the longest substring wins.
// Retired-but-installable families stay listed: this ranks what is on disk, not what the install catalog ships.
const EDITORIAL_FAMILY_RANK = [
  'qwen',                                    // Qwen — top-tier instruction-following + clean structured output
  'muse-glimmer',                            // Meta's current open model — Llama's successor lineage
  'llama',                                   // Llama 3.x instruct
  'gemma',                                   // Gemma 2/3/4 instruct
  'glm',                                     // GLM-4.x — strong prose, tight instruction-following
  'mixtral', 'ministral', 'magistral', 'mistral', // Mistral family
  'granite',                                 // IBM Granite — constrained, clean structured output
  'olmo',                                    // AI2 Olmo — fully-open instruct
  'command-r-plus', 'command-r', 'command',  // Cohere Command — capable but chatty/RAG-tuned
  'nemotron',                                // NVIDIA — agentic/reasoning-tuned, chattier for prose
  'deepseek',                                // capable, leans code/math
  'phi',                                     // smaller but capable
  'gpt-oss',                                 // open-weights GPT
];

// Never recommended for editorial prose: embeddings, code-specialized, vision-ONLY, and media-generation weights. Only vision-specialist markers belong here
// (general image-reading models like Gemma 4 are fine editors).
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

// Bonus for a fresh `fits` measurement: enough that a proven model beats an equally plausible guess, too small to lift a poor family past a strong one.
const MEASURED_FITS_BONUS = 0.12;

/**
 * Recommend the best installed model for editorial feedback / line editing. A MEASUREMENT (`localModelAssessmentStore.getMeasuredFits`) overrules the
 * name-based guess: `does-not-fit`/`incompatible` models are dropped, `fits` gets a bonus. A STALE measurement and an UNMEASURED model change nothing.
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
