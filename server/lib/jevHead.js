/**
 * Static contract for a PROJECT-SPECIFIC trained head on the frozen jev encoder.
 *
 * Phase 1 of scope adherence (#7643) scores a change against the repository's
 * own `PRD.md` / `GOALS.md` clauses with the checkpoint's stock zero-shot NLI
 * classifier. This module describes the optional alternative: a small head fit
 * on THIS install's history, sitting on the same frozen encoder.
 *
 * Three properties are load-bearing and none of them is negotiable:
 *
 *  1. **The head emits the checkpoint's OWN three labels.** `JEV_LABELS`, in
 *     that order. Everything downstream — `normalizeJevScores`,
 *     `decideFromScores`, every per-option abstention floor in
 *     `jevDecisions.js` — is byte-identical whether a head is adopted or not.
 *     A head changes which numbers come out of the encoder, never what the
 *     numbers mean or what may be decided from them.
 *  2. **A head names the encoder revision it was fit on.** Embeddings from a
 *     different checkpoint are a different vector space; a head applied across
 *     one would produce confident nonsense with nothing to signal it. The
 *     loader refuses a mismatch rather than degrading.
 *  3. **A head cannot be adopted unless it beats BOTH baselines** on the
 *     held-out gold set — the stock zero-shot classifier AND the majority
 *     class. Beating only the majority class means it learned the label prior;
 *     beating only zero-shot on a corpus whose prior it memorized means the
 *     same thing from the other side.
 *
 * A head is also a DERIVED RECORD OF PRIVATE DATA: it encodes the operator's
 * merged pull requests, closed issues and their own judgement calls. Weights
 * live under `data/jev/` and are machine-local — see the ADR
 * [privacy records machine-local](../../docs/decisions/2026-08-08-privacy-records-machine-local.md).
 *
 * Pure: no I/O, no process state. `services/jevHeads.js` owns the files.
 */

import { z } from 'zod';
import { JEV_LABELS } from './jev.js';
import { JEV_DECISION_IDS } from './jevDecisions.js';

export const JEV_HEAD_SCHEMA_VERSION = 1;

/**
 * Architectures a head may declare.
 *
 * `linear` is the default and the honest one: a 3-way logistic regression over
 * a frozen 4B encoder's pooled state. `mlp1` buys one hidden layer for a
 * corpus large enough to support it. Nothing deeper ships — the issue's own
 * out-of-scope list rules out touching the encoder, and a deep head on a few
 * hundred weak labels is a memorizer with a validation score.
 */
export const JEV_HEAD_ARCHITECTURES = Object.freeze(['linear', 'mlp1']);

/**
 * Hard ceiling on a head's parameter count.
 *
 * Weights ship as JSON so the compatibility check, the backup retention
 * decision and code review are all inspectable without a numpy import. That
 * only stays true while the artifact is small: 2M parameters is ~40 MB of
 * JSON, which is already past "inspectable" and far past anything a few
 * hundred weakly-labelled examples can fit. A trainer that wants more is
 * asking the wrong question.
 */
export const JEV_HEAD_MAX_PARAMS = 2_000_000;

/** Hidden width `mlp1` may declare. Bounded for the same reason. */
export const JEV_HEAD_MAX_HIDDEN = 256;

/**
 * The pooling both sides must agree on.
 *
 * openjev's 4B NLI checkpoint is a causal decoder, so the LAST non-padding
 * token is the only position that has attended to the whole pair. Declared in
 * the artifact rather than assumed, so a future pooling change makes an old
 * head unloadable instead of silently re-pooled — `scripts/jev_head_kit.py`
 * mirrors this string and refuses one it does not implement.
 */
export const JEV_HEAD_POOLING = 'last-token';

/**
 * The charset a head's on-disk slug may use.
 *
 * A head is addressed by SLUG — its decision id — and the sidecar resolves that
 * slug inside a directory the Node service owns. A slug is not a path, and this
 * is what keeps it from becoming one. `jevHead.test.js` asserts every shipped
 * decision id satisfies it, so a future decision named with a colon or a slash
 * fails at test time rather than at the first adoption.
 */
export const JEV_HEAD_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const finite = () => z.number().finite();
const vector = () => z.array(finite()).min(1);

const layerSchema = z.object({
  // Row-major `[out][in]`, matching `numpy.dot(weight, x) + bias`.
  weight: z.array(vector()).min(1),
  bias: vector(),
}).strict();

/**
 * The three numbers an operator is shown before adopting anything, and the
 * three the adoption gate reads. All are accuracy on the SAME held-out gold
 * split, so they are directly comparable.
 */
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
  // The frozen encoder this head's input space belongs to. `revision` is the
  // gate; the other two are for the operator reading the panel.
  baseModel: z.object({
    id: z.string().min(1),
    repository: z.string().min(1),
    revision: z.string().min(1),
  }).strict(),
  // Declared, then checked against the first layer: a head whose stated input
  // width disagrees with its own weights would fail deep inside a forward pass.
  hiddenSize: z.number().int().min(1),
  labels: z.array(z.enum(JEV_LABELS)).length(JEV_LABELS.length),
  layers: z.array(layerSchema).min(1).max(2),
  metrics: jevHeadMetricsSchema,
  // Which corpus produced it, so a head can be traced back to a build without
  // the corpus itself having to survive.
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

/**
 * Validate a head artifact's SHAPE — schema, dimensions, size bound.
 *
 * Separate from `isHeadCompatible` on purpose: a structurally broken head is a
 * trainer bug an operator cannot fix, while an incompatible one is a correct
 * artifact for a different encoder. They point at opposite remedies, so they
 * report different codes.
 */
export function parseJevHead(raw) {
  const result = jevHeadSchema.safeParse(raw);
  if (!result.success) return { ok: false, code: 'jev-head-invalid' };
  const head = result.data;
  if (head.labels.join('\u0000') !== JEV_LABELS.join('\u0000')) return { ok: false, code: 'jev-head-invalid' };

  const first = head.layers[0];
  if (first.weight.some((row) => row.length !== head.hiddenSize)) return { ok: false, code: 'jev-head-invalid' };
  // Every layer's bias must be one entry per output row, and each layer's
  // output width must be the next layer's input width.
  for (const [position, layer] of head.layers.entries()) {
    if (layer.bias.length !== layer.weight.length) return { ok: false, code: 'jev-head-invalid' };
    const next = head.layers[position + 1];
    if (next && next.weight.some((row) => row.length !== layer.weight.length)) return { ok: false, code: 'jev-head-invalid' };
  }
  const last = head.layers.at(-1);
  if (last.weight.length !== JEV_LABELS.length) return { ok: false, code: 'jev-head-invalid' };
  if (head.architecture === 'linear' && head.layers.length !== 1) return { ok: false, code: 'jev-head-invalid' };
  if (head.architecture === 'mlp1') {
    if (head.layers.length !== 2) return { ok: false, code: 'jev-head-invalid' };
    if (head.layers[0].weight.length > JEV_HEAD_MAX_HIDDEN) return { ok: false, code: 'jev-head-invalid' };
  }
  if (countHeadParams(head) > JEV_HEAD_MAX_PARAMS) return { ok: false, code: 'jev-head-too-large' };
  return { ok: true, head };
}

/**
 * Whether a head may be applied on this machine's installed encoder.
 *
 * Revision equality, not "close enough". The head's inputs are hidden states
 * from one specific checkpoint; a different revision is a different vector
 * space, and applying a head across one yields confident numbers with nothing
 * anywhere to signal that they are meaningless.
 */
export function isHeadCompatible(head, { repository, revision } = {}) {
  if (!head?.baseModel) return false;
  return head.baseModel.revision === revision && head.baseModel.repository === repository;
}

/**
 * THE ADOPTION GATE.
 *
 * A trained head is worth running only if it beats the stock zero-shot
 * classifier AND the majority-class baseline on the held-out gold set. Both,
 * strictly.
 *
 * Beating only the majority class means it learned the label prior and nothing
 * about the product. Beating only zero-shot, while losing to a constant
 * prediction, means the gold split is so skewed that accuracy is not measuring
 * anything — a head that "wins" there would be adopted on the strength of the
 * corpus's imbalance. Ties lose: the stock classifier needs no corpus, no
 * training run, and no privacy argument, so it wins every draw.
 */
export function headBeatsBaselines(metrics) {
  const parsed = jevHeadMetricsSchema.safeParse(metrics);
  if (!parsed.success) return false;
  const { trained, stockZeroShot, majorityClass } = parsed.data;
  return trained > stockZeroShot && trained > majorityClass;
}

/**
 * The one-line verdict the panel renders beside the numbers.
 *
 * Returns the reason a head is NOT adoptable, or `null` when it is. Naming the
 * losing baseline matters: "did not beat the stock scorer" and "did not beat
 * always guessing the most common label" send an operator to different places.
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
 * Route input for starting a training run.
 *
 * Validated from HERE rather than through `lib/validation.js`, for the same
 * reason `jevScoreRequestSchema` is: re-exporting a one-route schema through
 * that barrel drags this module into the static import closure of every suite
 * that reaches it (`server/lib/importScoping.test.js`).
 *
 * `.strict()`, and deliberately carrying NO repository path: a head is trained
 * on THIS install's own checkout, and a client-supplied path would turn a
 * training button into an arbitrary-directory reader with a `gh` token beside
 * it. Same reasoning as `scopeAdherenceRequestSchema`.
 */
export const jevHeadTrainRequestSchema = z.object({
  architecture: z.enum(JEV_HEAD_ARCHITECTURES).optional(),
}).strict();

/** Route input for adopting or discarding an artifact. */
export const jevHeadActionRequestSchema = z.object({
  decisionId: z.enum(JEV_DECISION_IDS),
  // Which artifact to discard. Ignored by adoption, which only ever promotes a
  // candidate.
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
