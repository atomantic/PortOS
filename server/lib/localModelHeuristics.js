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
 * The client mirrors `isEmbeddingModel` + `isVisionModel` in
 * client/src/utils/providers.js — keep the regexes in lockstep (the
 * aiToolkit/lib dirs can't be imported there).
 */

// Embedding-only models — never valid for chat/generation. The bge/nomic/e5/gte
// markers are anchored so they don't match mid-word inside an unrelated id.
const EMBEDDING_RE =
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5|snowflake-arctic-embed)(?:[-_/:]|$)|text-embedding/i;

/**
 * @param {string} id model id (e.g. "nomic-embed-text:latest")
 * @returns {boolean} true when the id names an embedding-only model
 */
export function isEmbeddingModel(id) {
  return typeof id === 'string' && id.length > 0 && EMBEDDING_RE.test(id);
}

/**
 * A model usable for chat/generation — anything that isn't an embedding model.
 * @param {string} id
 * @returns {boolean}
 */
export function isGenerationModel(id) {
  return typeof id === 'string' && id.length > 0 && !isEmbeddingModel(id);
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
  'llava', 'bakllava', 'moondream', 'minicpm-?v', 'pixtral', 'gemma-?3',
  'smolvlm', 'internvl', 'cogvlm', 'glm-?4v', 'phi-?3\\.5?-vision',
  'phi-?4-multimodal', 'got-ocr', 'idefics', 'fuyu', 'paligemma',
  'kosmos', 'nanollava',
].join('|'), 'i');

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

// Families ranked for EDITORIAL FIX GENERATION, best-first. This task needs
// tight instruction-following and clean, constrained output (rewrite a passage,
// emit only the rewrite) — NOT chatty long-form generation. So instruction-tuned
// models lead; Cohere Command (R/R+) is demoted because it's RAG/long-form-tuned
// and tends to leak commentary/preamble into the output (observed: `# New page`
// notes and a `PANNEL` typo bleeding into a manuscript fix). Order is
// "most-preferred first"; `command-r-plus` must precede `command-r`/`command`
// so the longest substring match wins.
const EDITORIAL_FAMILY_RANK = [
  'qwen',                                    // Qwen — top-tier instruction-following + clean structured output
  'llama',                                   // Llama 3.x instruct
  'gemma',                                   // Gemma 2/3 instruct
  'mixtral', 'mistral',                      // Mistral family
  'command-r-plus', 'command-r', 'command',  // Cohere Command — capable but chatty/RAG-tuned
  'deepseek',                                // capable, leans code/math
  'phi',                                     // smaller but capable
  'gpt-oss',                                 // open-weights GPT
];

// Models we never recommend for editorial prose: embeddings, code-specialized,
// vision/multimodal, and media-generation weights that may be installed.
const NON_EDITORIAL_RE =
  /(?:^|[-_/:])(?:embed|embedding|bge|nomic|mxbai|gte|e5)(?:[-_/:]|$)|text-embedding|coder|code-|starcoder|codellama|codegemma|(?:^|[-_/:])vision(?:[-_/:]|$)|llava|moondream|minicpm-v|whisper|(?:^|[-_/:])tts(?:[-_/:]|$)|stable-?diffusion|sdxl|flux/i;

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

/**
 * Recommend the best installed model for editorial feedback / line editing.
 *
 * @param {Array<string|{id?:string,name?:string,params?:string,family?:string}>} models
 * @returns {{ id: string, reason: string }|null} null when nothing is suitable
 */
export function recommendEditorialModel(models) {
  const candidates = (models || [])
    .map((m) => (typeof m === 'string' ? { id: m } : m))
    .filter((m) => m?.id && !NON_EDITORIAL_RE.test(m.id));
  if (!candidates.length) return null;

  let best = null;
  for (const m of candidates) {
    const paramsB = parseParamsB(m);
    const score = familyScore(m.id) * 0.6 + sizeScore(paramsB) * 0.4;
    if (!best || score > best.score) best = { id: m.id, score, paramsB };
  }
  if (!best) return null;

  const sizeLabel = best.paramsB ? `${best.paramsB}B params` : 'size unknown';
  return {
    id: best.id,
    reason: `Best installed fit for editorial review/editing (${sizeLabel}) — tight instruction-following and clean, constrained output for generating fixes.`,
  };
}
