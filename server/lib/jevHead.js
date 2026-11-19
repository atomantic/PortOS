/**
 * Static contract for a PROJECT-SPECIFIC trained head on the frozen jev encoder.
 *
 * The artifact contract for a project-specific head trained on the FROZEN jev encoder: `jevHeadSchema`
 * + `parseJevHead` (shape, chained layer widths, a bounded parameter count so weights stay inspectable
 * JSON), `isHeadCompatible` (exact encoder-revision equality — a different checkpoint is a different
 * vector space), and THE ADOPTION GATE, `headBeatsBaselines` / `headAdoptionBlocker`: a head must beat
 * BOTH the stock zero-shot classifier and the majority class on the held-out gold set, strictly, or it
 * cannot be adopted through any surface. A head emits the checkpoint's own three labels, so every
 * abstention floor downstream is unchanged. Also `JEV_HEAD_SLUG` and the train/adopt route schemas.
 * Pure; the store is `services/jevHeads.js`.
 *
 * This is the optional alternative to scope adherence's stock zero-shot NLI
 * classifier: a small head fit on THIS install's history over the same frozen
 * encoder. Three properties are load-bearing:
 *
 *  1. **The head emits the checkpoint's OWN three labels** (`JEV_LABELS`, in
 *     that order), so everything downstream — `normalizeJevScores`,
 *     `decideFromScores`, every abstention floor in `jevDecisions.js` — is
 *     byte-identical whether a head is adopted or not.
 *  2. **A head names the encoder revision it was fit on.** A different
 *     checkpoint is a different vector space; the loader refuses a mismatch
 *     rather than degrading.
 *  3. **A head cannot be adopted unless it beats BOTH baselines** (stock
 *     zero-shot AND majority class) on the held-out gold set; beating only one
 *     means it learned the label prior or a skewed corpus.
 *
 * A head is also a DERIVED RECORD OF PRIVATE DATA (merged PRs, closed issues,
 * the operator's judgement calls). Weights live under `data/jev/` and are
 * machine-local — see the ADR
 * [privacy records machine-local](../../docs/decisions/2026-08-08-privacy-records-machine-local.md).
 *
 * Pure: no I/O, no process state. `services/jevHeads.js` owns the files.
 */

import { z } from 'zod';
import { JEV_LABELS } from './jev.js';
import { JEV_DECISION_IDS } from './jevDecisions.js';

export const JEV_HEAD_SCHEMA_VERSION = 1;

/**
 * Architectures a head may declare: `linear` (3-way logistic regression over the
 * frozen encoder's pooled state, the default) or `mlp1` (one hidden layer, for a
 * larger corpus). Nothing deeper: on a few hundred weak labels it just memorizes.
 */
export const JEV_HEAD_ARCHITECTURES = Object.freeze(['linear', 'mlp1']);

/**
 * Hard ceiling on a head's parameter count. Weights ship as JSON so they stay
 * inspectable without numpy, which holds only while small: 2M parameters is
 * ~40 MB of JSON, far past what a few hundred weak labels can fit.
 */
export const JEV_HEAD_MAX_PARAMS = 2_000_000;

/** Hidden width `mlp1` may declare. Bounded for the same reason. */
export const JEV_HEAD_MAX_HIDDEN = 256;

/**
 * The pooling both sides must agree on. The checkpoint is a causal decoder, so
 * the LAST non-padding token is the only position that has attended to the
 * whole pair. Declared in the artifact so a future change makes an old head
 * unloadable instead of silently re-pooled; `scripts/jev_head_kit.py` mirrors
 * this string and refuses one it does not implement.
 */
export const JEV_HEAD_POOLING = 'last-token';

/**
 * The charset a head's on-disk slug may use. The sidecar resolves the slug
 * (the decision id) inside a directory the Node service owns; this keeps it
 * from becoming a path. `jevHead.test.js` asserts every decision id satisfies it.
 */
const JEV_HEAD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The slug a decision's head is addressed by, or null if the id cannot be one.
 * The mapping is identity today, decided only here so a non-slug-safe id fails
 * here rather than producing a filename nobody meant to write.
 */
export const jevHeadSlug = (decisionId) => (
  typeof decisionId === 'string' && JEV_HEAD_SLUG.test(decisionId) ? decisionId : null
);

/** The on-disk filename for a decision's adopted or candidate head. */
export function jevHeadFileName(decisionId, { candidate = false } = {}) {
  const slug = jevHeadSlug(decisionId);
  return slug === null ? null : `${slug}${candidate ? '.candidate' : ''}.json`;
}

const finite = () => z.number().finite();
const vector = () => z.array(finite()).min(1);

const layerSchema = z.object({
  // Row-major `[out][in]`, matching `numpy.dot(weight, x) + bias`.
  weight: z.array(vector()).min(1),
  bias: vector(),
}).strict();

/** The accuracies shown before adoption and read by the gate, all on the SAME gold split. */
export const jevHeadMetricsSchema = z.object({
  trained: z.number().min(0).max(1),
  stockZeroShot: z.number().min(0).max(1),
  majorityClass: z.number().min(0).max(1),
  goldSize: z.number().int().min(1),
  trainSize: z.number().int().min(1),
}).strict();

export const jevHeadSchema = z.object({
  schemaVersion: z.literal(JEV_HEAD_SCHEMA_VERSION),
  decisionId: z.enum(JEV_DECISION_IDS),
  architecture: z.enum(JEV_HEAD_ARCHITECTURES),
  pooling: z.literal(JEV_HEAD_POOLING),
  // The frozen encoder this head's input space belongs to; `revision` is the gate.
  baseModel: z.object({
    id: z.string().min(1),
    repository: z.string().min(1),
    revision: z.string().min(1),
  }).strict(),
  // Checked against the first layer so a mismatch fails at parse, not in a forward pass.
  hiddenSize: z.number().int().min(1),
  labels: z.array(z.enum(JEV_LABELS)).length(JEV_LABELS.length),
  layers: z.array(layerSchema).min(1).max(2),
  metrics: jevHeadMetricsSchema,
  // Traces a head to its corpus build without the corpus surviving.
  corpusHash: z.string().min(8),
  corpusSources: z.array(z.string().min(1)).min(1),
  trainedAt: z.string().min(1),
}).strict();

/** Total scalar parameters in `layers`. */
export function countHeadParams(head) {
  if (!Array.isArray(head?.layers)) return 0;
  return head.layers.reduce((total, layer) => {
    const rows = Array.isArray(layer?.weight) ? layer.weight : [];
    const cells = rows.reduce((sum, row) => sum + (Array.isArray(row) ? row.length : 0), 0);
    return total + cells + (Array.isArray(layer?.bias) ? layer.bias.length : 0);
  }, 0);
}

// Validate a head artifact's SHAPE (schema, dimensions, size bound) in
// `parseJevHead`. Separate from `isHeadCompatible`: a structurally broken head is
// a trainer bug the operator cannot fix, an incompatible one a correct artifact
// for a different encoder, so they report different codes. Every structural
// rejection shares this one frozen value.
const INVALID = Object.freeze({ ok: false, code: 'jev-head-invalid' });

export function parseJevHead(raw) {
  const result = jevHeadSchema.safeParse(raw);
  if (!result.success) return INVALID;
  const head = result.data;
  if (head.labels.join('\u0000') !== JEV_LABELS.join('\u0000')) return INVALID;

  const first = head.layers[0];
  if (first.weight.some((row) => row.length !== head.hiddenSize)) return INVALID;
  // One bias per output row; each layer's output width is the next one's input width.
  for (const [position, layer] of head.layers.entries()) {
    if (layer.bias.length !== layer.weight.length) return INVALID;
    const next = head.layers[position + 1];
    if (next && next.weight.some((row) => row.length !== layer.weight.length)) return INVALID;
  }
  const last = head.layers.at(-1);
  if (last.weight.length !== JEV_LABELS.length) return INVALID;
  if (head.architecture === 'linear' && head.layers.length !== 1) return INVALID;
  if (head.architecture === 'mlp1') {
    if (head.layers.length !== 2) return INVALID;
    if (head.layers[0].weight.length > JEV_HEAD_MAX_HIDDEN) return INVALID;
  }
  if (countHeadParams(head) > JEV_HEAD_MAX_PARAMS) return { ok: false, code: 'jev-head-too-large' };
  return { ok: true, head };
}

/**
 * Whether a head may be applied on this machine's installed encoder. Revision
 * equality, not "close enough": a different revision is a different vector
 * space and would yield confident, meaningless numbers.
 */
export function isHeadCompatible(head, { repository, revision } = {}) {
  if (!head?.baseModel) return false;
  return head.baseModel.revision === revision && head.baseModel.repository === repository;
}

/**
 * THE ADOPTION GATE.
 *
 * A trained head must strictly beat BOTH the stock zero-shot classifier and the
 * majority-class baseline on the held-out gold set. Beating only the majority
 * class means it learned the label prior; beating only zero-shot while losing
 * to a constant means the split is too skewed for accuracy to measure
 * anything. Ties lose: the stock classifier needs no corpus, training run or
 * privacy argument.
 */
export function headBeatsBaselines(metrics) {
  const parsed = jevHeadMetricsSchema.safeParse(metrics);
  if (!parsed.success) return false;
  const { trained, stockZeroShot, majorityClass } = parsed.data;
  return trained > stockZeroShot && trained > majorityClass;
}

/**
 * The reason a head is NOT adoptable, or `null` when it is. Names the losing
 * baseline because each sends an operator somewhere different.
 */
export function headAdoptionBlocker(metrics) {
  const parsed = jevHeadMetricsSchema.safeParse(metrics);
  if (!parsed.success) return 'jev-head-metrics-invalid';
  const { trained, stockZeroShot, majorityClass } = parsed.data;
  if (trained <= stockZeroShot) return 'jev-head-below-zero-shot';
  if (trained <= majorityClass) return 'jev-head-below-majority-class';
  return null;
}

/**
 * Route input for starting a training run. Validated from HERE, not through
 * a shared validation module, which would drag this module into every suite's
 * static import closure (`server/lib/importScoping.test.js`).
 *
 * `.strict()` and deliberately NO repository path: a client-supplied path would
 * turn a training button into an arbitrary-directory reader with a `gh` token
 * beside it. Same as `scopeAdherenceRequestSchema`.
 */
export const jevHeadTrainRequestSchema = z.object({
  architecture: z.enum(JEV_HEAD_ARCHITECTURES).optional(),
}).strict();

/** Route input for adopting or discarding an artifact. */
export const jevHeadActionRequestSchema = z.object({
  decisionId: z.enum(JEV_DECISION_IDS),
  // Which artifact to discard; ignored by adoption, which only promotes a candidate.
  adopted: z.boolean().optional(),
}).strict();

/** Every failure the head store, trainer and loader can report. */
export const JEV_HEAD_FAILURE_CODES = Object.freeze([
  'jev-head-invalid',
  'jev-head-too-large',
  'jev-head-revision-mismatch',
  'jev-head-not-found',
  'jev-head-below-zero-shot',
  'jev-head-below-majority-class',
  'jev-head-metrics-invalid',
  'jev-head-unreadable',
  'jev-head-training-failed',
  'jev-head-runtime-unavailable',
]);
