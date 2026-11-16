/**
 * The training corpus a project-specific jev head is fit on.
 *
 * Schema is daseinlabs/open-jev's **Route A**: one JSON object per line,
 * `{"context": str, "options": [str, ...], "label": int}`, where `label`
 * indexes `options`. Kept so `openjev eval` stays usable as an independent
 * cross-check on a corpus PortOS built.
 *
 * ## What the labels are worth
 *
 * They are WEAK: a merged pull request is evidence the maintainer wanted it,
 * not a hand-annotation that it advances the clause paired with it. Hence the
 * held-out gold split, two baselines and a strictly-better adoption gate.
 *
 * ## The split is the safety property
 *
 * `splitCorpus` assigns each example to train or gold by hashing its own
 * content, so the split is deterministic across machines and rebuilds and an
 * example cannot migrate when the corpus grows. `assertSplitDisjoint` REFUSES a
 * split whose halves share an example key: a contaminated gold score is partly
 * memorization and is the single number the adoption gate reads, so it is a
 * hard stop, never a warning.
 *
 * Pure: no I/O, no forge access. `services/jevCorpusBuilder.js` runs the
 * queries and writes the file.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

export const JEV_CORPUS_SCHEMA_VERSION = 1;

// Bounds on one example: `context` inherits the scorer's premise budget, the
// option list the decision's.
export const JEV_CORPUS_MAX_CONTEXT_CHARS = 32_000;
export const JEV_CORPUS_MAX_OPTIONS = 32;

/**
 * The share of examples held out for the gold set. A third, not a tenth: these
 * corpora are small and the gold set must separate three numbers that may
 * differ by a few points (10% of 200 is 20 rows; one flip moves 5 points).
 */
export const JEV_CORPUS_GOLD_FRACTION = 1 / 3;

/**
 * The fewest examples a corpus may have and still be trained on; below this the
 * gold set cannot support a comparison against two baselines.
 */
export const JEV_CORPUS_MIN_EXAMPLES = 60;

export const JEV_CORPUS_SOURCES = Object.freeze([
  'merged-pr',
  'closed-unmerged-pr',
  'closed-not-planned-issue',
  'parked-issue',
]);

export const jevCorpusExampleSchema = z.object({
  context: z.string().min(1).max(JEV_CORPUS_MAX_CONTEXT_CHARS),
  options: z.array(z.string().min(1)).min(2).max(JEV_CORPUS_MAX_OPTIONS),
  label: z.number().int().min(0),
  // PortOS's own provenance, ignored by `openjev eval`.
  source: z.enum(JEV_CORPUS_SOURCES),
}).strict().refine((row) => row.label < row.options.length, { path: ['label'] });

/**
 * A stable, content-addressed identity for one example. Covers the OPTIONS as
 * well as the context: a re-worded decision is a different question and must
 * not inherit the old split assignment.
 */
export function corpusExampleKey(example) {
  return createHash('sha256')
    .update(String(example?.context || ''))
    .update('\u0000')
    .update((example?.options || []).join('\u0000'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Order-independent hash of the whole corpus, so paginated forge queries can't
 * re-key a corpus with the same examples.
 */
export function corpusHash(examples) {
  const keys = (Array.isArray(examples) ? examples : [])
    .map((example) => `${corpusExampleKey(example)}:${example?.label}`)
    .sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
}

/**
 * Turn a weakly-labelled observation into a Route A example. `options` is the
 * decision's own hypothesis list in its own order, so a row asks the question
 * the scorer is asked at inference. Returns null rather than throwing: one
 * unusable forge row must not fail the whole build.
 */
export function buildCorpusExample({ context, options, chosen, source } = {}) {
  if (!Array.isArray(options)) return null;
  const label = options.indexOf(chosen);
  if (label < 0) return null;
  const candidate = { context: String(context || '').slice(0, JEV_CORPUS_MAX_CONTEXT_CHARS), options, label, source };
  return jevCorpusExampleSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * Drop examples that ask the same question twice. A goal restated across
 * `PRD.md` and `GOALS.md` can pair one change with two byte-identical clauses;
 * left in, the hash would put them in different splits, the contamination
 * `assertSplitDisjoint` exists to catch. The FIRST label wins; a disagreeing
 * duplicate is dropped, since there is no principled way to pick between two
 * weak labels.
 */
export function dedupeCorpus(examples) {
  return [...keyedCorpus(examples).values()];
}

/**
 * Deduplicated examples by key, so a caller needing both does not hash twice
 * (a context can be 32 KB, so the SHA-256 is not free).
 */
function keyedCorpus(examples) {
  const seen = new Map();
  for (const example of Array.isArray(examples) ? examples : []) {
    const key = corpusExampleKey(example);
    if (!seen.has(key)) seen.set(key, example);
  }
  return seen;
}

/**
 * Deterministic train/gold split. The bucket comes from the example's OWN
 * content hash, not a shuffle or its position, so the same corpus yields the
 * same gold set on any machine and a head's score is reproducible.
 */
export function splitCorpus(examples, { goldFraction = JEV_CORPUS_GOLD_FRACTION } = {}) {
  const train = [];
  const gold = [];
  // 16 bits of the key against the same fraction of 65536: fine enough for a
  // corpus of a few hundred to land within a point of the requested fraction.
  const cutoff = Math.round(goldFraction * 0x10000);
  for (const [key, example] of keyedCorpus(examples)) {
    (parseInt(key.slice(0, 4), 16) < cutoff ? gold : train).push(example);
  }
  return { train, gold };
}

/**
 * REFUSE a split whose halves overlap: the gold score is the only evidence the
 * adoption gate reads, and an overlap would make the head look better than it
 * is with nothing downstream able to tell.
 *
 * Also refuses a gold set under `JEV_CORPUS_MIN_GOLD` rows, where one label
 * flip moves accuracy by more than the margin the gate decides on.
 */
export const JEV_CORPUS_MIN_GOLD = 20;

export function assertSplitDisjoint({ train, gold } = {}) {
  if (!Array.isArray(train) || !Array.isArray(gold)) return { ok: false, code: 'jev-corpus-split-invalid' };
  const trainKeys = new Set(train.map(corpusExampleKey));
  const overlap = gold.filter((example) => trainKeys.has(corpusExampleKey(example)));
  if (overlap.length) return { ok: false, code: 'jev-corpus-split-overlap', overlap: overlap.length };
  if (gold.length < JEV_CORPUS_MIN_GOLD) return { ok: false, code: 'jev-corpus-gold-too-small' };
  if (!train.length) return { ok: false, code: 'jev-corpus-split-invalid' };
  return { ok: true, train: train.length, gold: gold.length };
}

/**
 * Accuracy of always predicting the most common gold label — one of the two
 * adoption-gate baselines, computed here so Node needs no Python round trip.
 */
export function majorityClassAccuracy(gold) {
  const rows = Array.isArray(gold) ? gold : [];
  if (!rows.length) return null;
  const counts = new Map();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) || 0) + 1);
  return Math.max(...counts.values()) / rows.length;
}

export function summarizeCorpusSources(examples) {
  const counts = Object.fromEntries(JEV_CORPUS_SOURCES.map((source) => [source, 0]));
  for (const example of Array.isArray(examples) ? examples : []) {
    if (Object.hasOwn(counts, example?.source)) counts[example.source] += 1;
  }
  return counts;
}

export const toCorpusJsonl = (examples) => (Array.isArray(examples) ? examples : [])
  .map((example) => JSON.stringify(example))
  .join('\n');

/**
 * Validate one already-parsed JSONL row, or null. Takes an OBJECT, not a line:
 * the non-throwing JSON wrapper lives in `fileUtils.js`, whose closure reaches
 * `fs` and `child_process`, so decoding stays in `services/jevCorpusBuilder.js`
 * to keep this file a pure leaf (`server/lib/importScoping.test.js`).
 */
export function validateCorpusRow(parsed) {
  const result = jevCorpusExampleSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
