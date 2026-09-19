/**
 * The training corpus a project-specific jev head is fit on.
 *
 * Schema is daseinlabs/open-jev's **Route A**: one JSON object per line,
 * `{"context": str, "options": [str, ...], "label": int}`, where `label`
 * indexes `options`. Adopted deliberately rather than invented — it keeps
 * `openjev eval` usable as an independent cross-check on a corpus PortOS
 * built, which is the only outside opinion available on whether a head that
 * beat our baselines actually learned anything.
 *
 * ## What the labels are worth
 *
 * They are WEAK. A merged pull request is evidence that the maintainer wanted
 * it, not a hand-annotation that it advances the clause the retriever paired it
 * with; a closed-unmerged one is evidence they did not. The whole apparatus
 * downstream — a held-out gold split, two baselines, a strictly-better
 * adoption gate — exists because these labels are weak enough that "the head
 * trained fine" proves nothing on its own.
 *
 * ## The split is the safety property
 *
 * `splitCorpus` assigns each example to train or gold by hashing its own
 * content, so the split is deterministic across machines and rebuilds, and an
 * example cannot migrate between splits when the corpus grows around it.
 * `assertSplitDisjoint` then REFUSES a split whose two halves share an example
 * key. A gold set contaminated by its training split reports a score that is
 * partly memorization, and that score is the single number the adoption gate
 * reads — so the refusal is a hard stop, never a warning.
 *
 * Pure: no I/O, no forge access. `services/jevCorpusBuilder.js` runs the
 * queries and writes the file.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

export const JEV_CORPUS_SCHEMA_VERSION = 1;

/**
 * Bounds on one example. `context` is a composed premise, so it inherits the
 * scorer's premise budget; the option list inherits the decision's.
 */
export const JEV_CORPUS_MAX_CONTEXT_CHARS = 32_000;
export const JEV_CORPUS_MAX_OPTIONS = 32;

/**
 * The share of examples held out for the gold set.
 *
 * A third, not the customary tenth: these corpora are small (a few hundred
 * examples on a busy repository, far fewer on a young one), and the gold set
 * has to separate three numbers that may differ by a few points. A 10% split of
 * 200 examples is 20 rows, where one flipped label moves accuracy 5 points.
 */
export const JEV_CORPUS_GOLD_FRACTION = 1 / 3;

/**
 * The fewest examples a corpus may have and still be trained on.
 *
 * Below this the gold set cannot support a comparison against two baselines
 * at all, and the honest answer is "this install has no history to learn
 * from", not a head with a score.
 */
export const JEV_CORPUS_MIN_EXAMPLES = 60;

/** The weak-evidence sources a corpus may draw from. */
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
  // PortOS's own provenance, ignored by `openjev eval`. Kept so a corpus can be
  // audited for source balance without re-running the forge queries.
  source: z.enum(JEV_CORPUS_SOURCES),
}).strict().refine((row) => row.label < row.options.length, { path: ['label'] });

/**
 * A stable identity for one example.
 *
 * Content-addressed, and covering the OPTIONS as well as the context: the same
 * change scored against the same clause under a different option wording is a
 * different question, and collapsing the two would let a re-worded decision
 * silently inherit the old split assignment.
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
 * Hash of the whole corpus, order-independent.
 *
 * Recorded on both the manifest and every head fit from it. Order-independent
 * because the builder's forge queries are paginated and a page boundary moving
 * must not re-key a corpus that contains exactly the same examples.
 */
export function corpusHash(examples) {
  const keys = (Array.isArray(examples) ? examples : [])
    .map((example) => `${corpusExampleKey(example)}:${example?.label}`)
    .sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 32);
}

/**
 * Turn a weakly-labelled observation into a Route A example.
 *
 * `options` is the decision's own hypothesis list, in its own order, so a
 * corpus row asks exactly the question the scorer is asked at inference time.
 * Returns null rather than throwing on anything malformed — the builder pulls
 * from a forge, and one unusable row must not fail a build of four hundred.
 */
export function buildCorpusExample({ context, options, chosen, source } = {}) {
  if (!Array.isArray(options)) return null;
  const label = options.indexOf(chosen);
  if (label < 0) return null;
  const candidate = { context: String(context || '').slice(0, JEV_CORPUS_MAX_CONTEXT_CHARS), options, label, source };
  return jevCorpusExampleSchema.safeParse(candidate).success ? candidate : null;
}

/**
 * Drop examples that ask the same question twice.
 *
 * A repository re-states a goal across `PRD.md` and `GOALS.md` often enough
 * that the retriever pairs one change with two byte-identical clauses. Left in,
 * those duplicates land in different splits by definition of the hash — the
 * same question appearing in both train and gold, which is precisely the
 * contamination `assertSplitDisjoint` exists to catch, arriving through the
 * front door. The FIRST label wins; a duplicate that disagrees is dropped with
 * it, because there is no principled way to pick between two weak labels.
 */
export function dedupeCorpus(examples) {
  const seen = new Map();
  for (const example of Array.isArray(examples) ? examples : []) {
    const key = corpusExampleKey(example);
    if (!seen.has(key)) seen.set(key, example);
  }
  return [...seen.values()];
}

/**
 * Deterministic train/gold split.
 *
 * The bucket comes from the example's OWN content hash, not from a shuffle and
 * not from its position: two builds of the same corpus on two machines must
 * produce the same gold set, or a head's reported score cannot be reproduced by
 * the person reading it.
 */
export function splitCorpus(examples, { goldFraction = JEV_CORPUS_GOLD_FRACTION } = {}) {
  const rows = dedupeCorpus(examples);
  const train = [];
  const gold = [];
  // 16 bits of the key, compared against the same fraction of 65536. Enough
  // resolution that a corpus of a few hundred lands within a point of the
  // requested fraction, and cheap to recompute anywhere.
  const cutoff = Math.round(goldFraction * 0x10000);
  for (const example of rows) {
    const bucket = parseInt(corpusExampleKey(example).slice(0, 4), 16);
    (bucket < cutoff ? gold : train).push(example);
  }
  return { train, gold };
}

/**
 * REFUSE a split whose halves overlap.
 *
 * The gold score is the only evidence the adoption gate reads. An example that
 * appears in both halves makes that score partly a memorization check, and
 * nothing downstream could tell the difference — the head would simply look
 * better than it is and get adopted for it.
 *
 * Also refuses a gold set too small to separate three numbers: with fewer than
 * `JEV_CORPUS_MIN_GOLD` rows, one label flip moves accuracy by more than the
 * margin the gate is deciding on.
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
 * Accuracy of always predicting the most common gold label.
 *
 * One of the two baselines the adoption gate compares against, computed here
 * rather than in the trainer so the Node side can state it without a Python
 * round trip — and so the number an operator is shown comes from the same code
 * path in a test as it does in the panel.
 */
export function majorityClassAccuracy(gold) {
  const rows = Array.isArray(gold) ? gold : [];
  if (!rows.length) return null;
  const counts = new Map();
  for (const row of rows) counts.set(row.label, (counts.get(row.label) || 0) + 1);
  return Math.max(...counts.values()) / rows.length;
}

/** Per-source example counts, for the manifest and the panel's build summary. */
export function summarizeCorpusSources(examples) {
  const counts = Object.fromEntries(JEV_CORPUS_SOURCES.map((source) => [source, 0]));
  for (const example of Array.isArray(examples) ? examples : []) {
    if (Object.hasOwn(counts, example?.source)) counts[example.source] += 1;
  }
  return counts;
}

/** Serialize to JSONL. `source` is kept: it is ours, and `openjev eval` ignores it. */
export const toCorpusJsonl = (examples) => (Array.isArray(examples) ? examples : [])
  .map((example) => JSON.stringify(example))
  .join('\n');

/**
 * Validate one already-parsed JSONL row, or null.
 *
 * Takes an OBJECT, not a line of text: `JSON.parse` throws, and the sanctioned
 * non-throwing wrapper lives in `fileUtils.js`, whose closure reaches `fs` and
 * `child_process`. Keeping the decode in `services/jevCorpusBuilder.js` is what
 * lets this file stay the pure leaf it advertises itself as
 * (`server/lib/importScoping.test.js`).
 */
export function validateCorpusRow(parsed) {
  const result = jevCorpusExampleSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export const JEV_CORPUS_FAILURE_CODES = Object.freeze([
  'jev-corpus-split-overlap',
  'jev-corpus-split-invalid',
  'jev-corpus-gold-too-small',
  'jev-corpus-too-small',
  'jev-corpus-forge-unavailable',
  'jev-corpus-no-clauses',
  'jev-corpus-unreadable',
]);
