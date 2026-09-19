/**
 * Static contract for PortOS's local entailment ("jev") scoring boundary.
 *
 * This is the closed-set counterpart to `modelAbuseGuard.js`. Where Prompt
 * Guard answers "is this content attacking a model?", jev answers "which of
 * these fixed options does this text entail?" — a natural-language-inference
 * cross-encoder, not a chat model. It is installed from one pinned Hugging Face
 * revision, executed by a separate offline Python sidecar, never handed a
 * PortOS tool definition, and never selectable as a chat provider.
 *
 * Pure: no I/O, no process state. Lifecycle lives in `services/jev.js`.
 */

import { z } from 'zod';

export const JEV_ID = 'openjev-qwen3.5-4b-nli';

/**
 * The model's own three-way label set, in the `id2label` order the pinned
 * `config.json` declares. Declared once here: the wire schema's per-hypothesis
 * shape is built from it, the descriptor carries it, and `run_jev.py` mirrors
 * it — so a re-labelled checkpoint cannot leave the two sides disagreeing about
 * which number is the entailment probability.
 */
export const JEV_LABELS = Object.freeze(['contradiction', 'entailment', 'neutral']);

// The repository is an aggregate: it also carries a 35B MoE variant and a
// directory of trained MLP heads. Only the 4B NLI subfolder is ever fetched,
// which is why `subfolder` is part of the identity rather than a runner flag.
export const JEV_SUBFOLDER = 'qwen3.5-4b-nli';

export const JEV_MODEL = Object.freeze({
  id: JEV_ID,
  name: 'OpenJEV Qwen3.5 4B NLI',
  repository: 'AlexWortega/openjev',
  revision: 'f8187e6e11d413d0771bcc7970b85f78e194264c',
  subfolder: JEV_SUBFOLDER,
  pipelineTag: 'text-classification',
  runtime: 'python-transformers',
  params: '4B',
  // The tokenizer and the text config both declare 262144 positions. The
  // service bounds requests far below that (see JEV_MAX_PREMISE_CHARS); this
  // is the model's ceiling, not the operator-facing budget.
  contextTokens: 262_144,
  gated: false,
  license: 'mit',
  capabilities: ['entailment', 'closed-set-decision'],
  labels: JEV_LABELS,
  sourceUrl: 'https://huggingface.co/AlexWortega/openjev',
  // Weights only, from the pinned subfolder. Surfaced so the install panel can
  // state the download size before an operator commits to it.
  weightsBytes: 9_078_635_984,
  featured: {
    label: 'Recommended for closed-set decisions',
    description: 'Local entailment scorer with no chat, agent, tool, or MCP loop.',
  },
});

// Only these files are downloaded, and only from the pinned subfolder. The
// repository's `code/` directory, its 35B weights, and `mlp_heads_35b/` are
// never fetched and never executed. `chat_template.jinja` and
// `train_result.json` exist in the subfolder but are not load-bearing for
// sequence classification, so they stay out of the allowlist.
export const JEV_REQUIRED_FILES = Object.freeze([
  `${JEV_SUBFOLDER}/config.json`,
  `${JEV_SUBFOLDER}/model.safetensors`,
  `${JEV_SUBFOLDER}/tokenizer.json`,
  `${JEV_SUBFOLDER}/tokenizer_config.json`,
]);

// Fixed import names, not user-controlled pip arguments.
export const JEV_PYTHON_IMPORTS = Object.freeze([
  'torch',
  'transformers',
  'safetensors',
  'huggingface_hub',
]);

// The same pins Prompt Guard runs, in a SEPARATE virtualenv (see
// `services/jev.js`). Sharing an environment would couple two independent
// security boundaries to one dependency resolution. Updating these pins
// requires the explicit install canary, and a bump here that is driven by a
// transformers requirement must bump `modelAbuseGuard.js` in the same change.
export const JEV_PYTHON_PACKAGES = Object.freeze([
  'torch==2.14.0',
  'transformers==5.16.1',
  'safetensors==0.8.0',
  'huggingface_hub==1.30.0',
]);

/**
 * Operator-facing install stages, in the order `installJev` runs them.
 *
 * FOUR stages, not five: openjev is ungated and MIT-licensed, so there is no
 * Hugging Face token or model-card approval step the way Prompt Guard has one.
 */
export const JEV_STAGES = Object.freeze([
  {
    id: 'python',
    label: 'Host Python',
    description: 'Python 3.10 or newer, with a supported PyTorch wheel for this machine.',
  },
  {
    id: 'venv',
    label: 'Dedicated jev runtime',
    description: 'A private virtualenv that never shares packages with Prompt Guard, image, or video generation.',
  },
  {
    id: 'packages',
    label: 'Scorer packages',
    description: 'Pinned torch, transformers, safetensors, and huggingface_hub imports.',
  },
  {
    id: 'model',
    label: 'Pinned model snapshot',
    description: 'The four required files from the pinned 4B NLI subfolder.',
  },
]);

/**
 * Map host facts onto the fixed install-stage list.
 *
 * `ready` is the scoring-time gate: importable runtime AND cached weights.
 * Python and the virtualenv are prerequisites the installer still has to
 * clear; neither by itself makes the scorer usable.
 */
export function jevStageReadiness({
  pythonAvailable = false,
  venvReady = false,
  runtimeReady = false,
  modelCached = false,
} = {}) {
  const readyById = {
    python: pythonAvailable === true,
    venv: venvReady === true,
    packages: runtimeReady === true,
    model: modelCached === true,
  };
  return {
    stages: JEV_STAGES.map((stage) => ({ ...stage, ready: readyById[stage.id] === true })),
    ready: runtimeReady === true && modelCached === true,
  };
}

// ── Bounds ────────────────────────────────────────────────────────────────
// One window of a PR diff or a PRD section. Well under the model's 262k-token
// ceiling: the premise is re-encoded once per hypothesis, so the cost of a
// request is (premise + hypothesis) x hypotheses.
export const JEV_MAX_PREMISE_CHARS = 32_000;
export const JEV_MAX_HYPOTHESES = 32;
export const JEV_MAX_HYPOTHESIS_CHARS = 512;
// top1 - top2 entailment probability. Below this, `decide` abstains.
export const JEV_DEFAULT_MIN_MARGIN = 0.15;
export const JEV_REQUEST_TIMEOUT_MS = 30_000;
export const JEV_IDLE_UNLOAD_MS = 10 * 60 * 1000;
// A 9 GB checkpoint is slow to page in from cold storage on first use. This
// bounds the wait for `/health` to report `ready`, not a scoring request.
export const JEV_START_TIMEOUT_MS = 5 * 60 * 1000;
// The sidecar reply is a small fixed-shape JSON document (32 hypotheses x 3
// floats, plus each hypothesis echoed back at most 512 chars).
export const JEV_MAX_RESPONSE_CHARS = 128_000;

/**
 * Every failure `scoreHypotheses` / `decide` can report.
 *
 * Codes, never text: a Python traceback can carry local paths or the premise
 * itself, and neither may reach an operator-facing payload or a log line.
 */
// The subset the SIDECAR itself puts in an error body. The service accepts
// only these from a reply — a body claiming `jev-not-installed` would send an
// operator to reinstall a working install, so an unrecognized one collapses to
// `jev-response-invalid` instead of being forwarded.
export const JEV_SIDECAR_FAILURE_CODES = Object.freeze([
  'jev-request-invalid',
  'jev-response-invalid',
  'jev-premise-too-large',
  // A trained project head the sidecar could not apply. Forwarded rather than
  // collapsed, and deliberately NOT answered by silently falling back to the
  // stock classifier: the operator adopted a head on the strength of three
  // measured numbers, and answering with a different classifier would make
  // that measurement describe something other than what ran.
  'jev-head-not-found',
  'jev-head-invalid',
  'jev-head-too-large',
  'jev-head-unreadable',
  'jev-head-revision-mismatch',
]);

export const JEV_FAILURE_CODES = Object.freeze([
  // Only the Node lifecycle can produce these three.
  'jev-not-installed',
  'jev-start-failed',
  'jev-timeout',
  ...JEV_SIDECAR_FAILURE_CODES,
]);

// ── Wire contract ─────────────────────────────────────────────────────────

/**
 * What a caller may ask the sidecar to score. Also the route-input schema:
 * `routes/localLlm.js` validates against it from HERE rather than through
 * `validation.js`. Re-exporting it there put this module into the static import
 * closure of all ~227 suites that reach `mediaValidation.js`, for one schema one
 * route uses — the "constant re-exported through a heavy barrel" shape the
 * import budget in `lib/importScoping.test.js` exists to catch.
 *
 * `.strict()`: the sidecar is a fixed-shape endpoint, so an unexpected key is
 * a caller bug (or an attempt to reach a parameter that does not exist), not
 * something to silently drop.
 */
export const jevScoreRequestSchema = z.object({
  premise: z.string().min(1).max(JEV_MAX_PREMISE_CHARS),
  hypotheses: z.array(z.string().min(1).max(JEV_MAX_HYPOTHESIS_CHARS))
    .min(1)
    .max(JEV_MAX_HYPOTHESES),
  minMargin: z.number().min(0).max(1).optional(),
}).strict();

const probability = z.number().min(0).max(1);

/** What `scripts/run_jev.py` returns from `POST /score`. */
export const jevScoreResponseSchema = z.object({
  schemaVersion: z.literal(1),
  complete: z.literal(true),
  scores: z.array(z.object({
    hypothesis: z.string(),
    ...Object.fromEntries(JEV_LABELS.map((label) => [label, probability])),
  }).strict()).min(1).max(JEV_MAX_HYPOTHESES),
}).strict();

/**
 * Validate a sidecar reply against the hypotheses that were actually asked
 * about, in order.
 *
 * Order and identity are both checked. A reply that is well-formed but
 * describes a DIFFERENT hypothesis list would otherwise silently re-label
 * every score — the decision would be confidently about the wrong options.
 */
export function normalizeJevScores(parsed, { hypotheses } = {}) {
  const result = jevScoreResponseSchema.safeParse(parsed);
  if (!result.success) return { ok: false, code: 'jev-response-invalid' };
  const asked = Array.isArray(hypotheses) ? hypotheses : null;
  const { scores } = result.data;
  if (!asked || scores.length !== asked.length) return { ok: false, code: 'jev-response-invalid' };
  if (scores.some((score, index) => score.hypothesis !== asked[index])) {
    return { ok: false, code: 'jev-response-invalid' };
  }
  return { ok: true, scores };
}

/**
 * Turn per-hypothesis entailment probabilities into a choice, or an
 * abstention.
 *
 * ABSTENTION IS THE CONTRACT. A caller that treats `abstained: true` as
 * permission to take the top option anyway has defeated the entire point of
 * this service: the margin is what separates "the model distinguished these
 * options" from "the model produced a number". The documented handling is to
 * fall back to a chat model, or to do nothing.
 *
 * `margin` is `top1.entailment - top2.entailment`, so it needs a runner-up:
 * a single hypothesis is a yes/no question, not a closed-set choice, and gets
 * `jev-request-invalid` rather than a margin on an invented scale. Express
 * yes/no as two hypotheses.
 *
 * `confidence` is the winner's raw entailment probability — reported, but NOT
 * part of the gate. A caller that wants a floor beneath a clear-but-weak
 * winner (0.20 vs 0.02 clears a 0.15 margin) applies it on top of this.
 */
export function decideFromScores(scores, minMargin = JEV_DEFAULT_MIN_MARGIN) {
  if (!Array.isArray(scores) || scores.length < 2) return { ok: false, code: 'jev-request-invalid' };
  const threshold = Number.isFinite(minMargin) ? minMargin : JEV_DEFAULT_MIN_MARGIN;
  // Copy before sorting: `scores` is the caller's request-ordered array and
  // several callers report it alongside the decision.
  const ranked = [...scores].sort((a, b) => b.entailment - a.entailment);
  const margin = ranked[0].entailment - ranked[1].entailment;
  if (margin < threshold) return { ok: true, choice: null, confidence: null, margin, abstained: true };
  return {
    ok: true,
    choice: ranked[0].hypothesis,
    confidence: ranked[0].entailment,
    margin,
    abstained: false,
  };
}
