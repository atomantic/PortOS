/**
 * The closed-set question "does this change advance what the product says it
 * is for?", expressed the way an entailment cross-encoder can answer it.
 *
 * ADVISORY ONLY, BY CONSTRUCTION. Nothing in this module or its service
 * returns a boolean a caller could gate on. The output is a verdict, the
 * clause it was scored against, and a margin — a named clause a human can go
 * read and argue with. [ETHOS.md](../../ETHOS.md) asks that supervision gates
 * be justified before they are added, and a 4B classifier disagreeing with a
 * prose PRD is not a justification. There is no auto-close, no gating label,
 * and no CI check anywhere downstream of this.
 *
 * Pure: no I/O, no scorer, no file reads. `services/scopeAdherence.js` owns
 * the ladder (screen → jev → advisory verdict).
 */

import { z } from 'zod';
import { search, buildInvertedIndex } from './bm25.js';
import { fuseRankingsRRF } from './memoryQuery.js';
import { JEV_MAX_PREMISE_CHARS } from './jev.js';
import { formatClauseCitation } from './prdClauses.js';

/**
 * The hypotheses, frozen here rather than inlined at the call site.
 *
 * These are PROMPTS — the entire instruction surface of the feature — and
 * they follow the same rule as `lib/jevDecisions.js`: wording lives in one
 * reviewable module, versioned with the file, because a caller that inlined
 * its own phrasing would drift from the wording any recorded verdict was
 * produced under.
 *
 * Kept OUT of `JEV_DECISIONS`: every entry there is a rung of the
 * untrusted-content ladder and is contractually bound to an
 * `UNTRUSTED_CONTENT_SOURCES` channel and to that ladder's enum machinery.
 * Scope adherence answers a question about the operator's own product, not
 * about a message that arrived from somewhere.
 */
export const SCOPE_ADHERENCE_OPTIONS = Object.freeze([
  Object.freeze({
    verdict: 'aligned',
    hypothesis: 'The proposed change advances the stated product goal.',
  }),
  Object.freeze({
    verdict: 'unrelated',
    hypothesis: 'The proposed change is unrelated to the stated product goal.',
  }),
  Object.freeze({
    verdict: 'contradicts',
    hypothesis: 'The proposed change works against the stated product goal.',
  }),
]);

export const SCOPE_ADHERENCE_HYPOTHESES = Object.freeze(SCOPE_ADHERENCE_OPTIONS.map((option) => option.hypothesis));

/**
 * Abstention floor.
 *
 * Wider than the scorer's 0.15 default: `unrelated` and `contradicts` read
 * very differently to a human, and telling an operator their PR "works
 * against" a goal on a hair's separation would burn the feature's credibility
 * faster than staying quiet ever could.
 */
export const SCOPE_ADHERENCE_MIN_MARGIN = 0.2;

/**
 * How many clauses are scored per change.
 *
 * The corpus is a few hundred clauses and each one is a separate forward pass
 * through a 4B model, so scoring them all would cost minutes for a verdict
 * that only ever cites one clause. Retrieval picks the few worth asking about.
 */
export const SCOPE_ADHERENCE_TOP_K = 3;

/** Weights for the two retrieval views fused below. Narrative leads; code confirms. */
const NARRATIVE_WEIGHT = 1;
const CODE_WEIGHT = 0.7;

const changeText = (change) => [change?.title, change?.body].filter(Boolean).join('\n').trim();
const changeCode = (change) => String(change?.diffSummary || '').trim();

const asRanking = (results) => (results || []).map((result) => ({ id: result.docId }));

/**
 * Pick the clauses worth scoring, newest-relevance first.
 *
 * TWO BM25 rankings, fused with RRF — not one query over a concatenated blob.
 * A change describes itself twice, in different vocabularies: prose in the
 * title and body, and identifiers in the changed-file list. Concatenating them
 * lets whichever is longer dominate the term frequencies; fusing their
 * rankings lets a clause that only one view found still surface. RRF is the
 * same fusion the memory retrieval stack already uses, so this reuses
 * `fuseRankingsRRF` rather than re-deriving rank arithmetic.
 *
 * @returns {Array} up to `k` clauses, in fused-rank order.
 */
export function selectCandidateClauses(clauses, change, { k = SCOPE_ADHERENCE_TOP_K } = {}) {
  const corpus = Array.isArray(clauses) ? clauses.filter((clause) => clause?.id && clause.text) : [];
  if (!corpus.length || k <= 0) return [];

  const narrative = changeText(change);
  const code = changeCode(change);
  if (!narrative && !code) return [];

  const index = buildInvertedIndex(corpus.map((clause) => ({ id: clause.id, text: clause.text })));
  // Over-fetch each view: RRF ranks by agreement, so a clause that placed 5th
  // in both views can legitimately beat one that placed 1st in a single view.
  const limit = Math.max(k * 4, 12);
  const fused = fuseRankingsRRF(
    asRanking(narrative ? search(narrative, index, { limit }) : []),
    asRanking(code ? search(code, index, { limit }) : []),
    { ftsWeight: NARRATIVE_WEIGHT, vectorWeight: CODE_WEIGHT },
  );

  const byId = new Map(corpus.map((clause) => [clause.id, clause]));
  return [...fused.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, k)
    .map(([id]) => byId.get(id))
    .filter(Boolean);
}

/** A change rendered as the evidence half of a premise, with a hard budget. */
function formatChange(change, budget) {
  const kindLabel = change?.kind === 'pr' ? 'pull request' : 'issue';
  const lines = [`Proposed change (${kindLabel}):`];
  if (change?.title) lines.push(`Title: ${change.title}`);
  if (change?.body) lines.push(`Description: ${change.body}`);
  if (change?.diffSummary) lines.push(`Changed files: ${change.diffSummary}`);
  const text = lines.join('\n');
  return text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
}

/**
 * Build the premise for one (clause, change) pair.
 *
 * The clause is stated FIRST and in full; the change is what gets truncated
 * when the pair does not fit. A clipped goal would have the scorer answering
 * about half a requirement without any way to tell that it had.
 */
export function composeAdherencePremise({ clause, change, maxChars = JEV_MAX_PREMISE_CHARS } = {}) {
  if (!clause?.text) return null;
  const head = `Stated product goal (${formatClauseCitation(clause)}):\n${clause.text}\n\n`;
  const budget = maxChars - head.length;
  if (budget < 1) return null;
  const tail = formatChange(change, budget);
  return tail.trim() ? `${head}${tail}` : null;
}

/** The verdict a returned hypothesis stands for, or null if it is not ours. */
export function verdictForHypothesis(hypothesis) {
  return SCOPE_ADHERENCE_OPTIONS.find((option) => option.hypothesis === hypothesis)?.verdict ?? null;
}

/**
 * The one-line advisory a surface renders.
 *
 * Always names the clause. A bare `0.31` is noise; "contradicts PRD.md §
 * Out of Scope" is something a human can act on — including by deciding the
 * classifier is wrong.
 */
export function formatAdherenceAdvisory({ verdict, clause, margin } = {}) {
  if (!clause || !verdict) return 'No scope advisory: the scorer could not separate the options.';
  const phrase = { aligned: 'advances', unrelated: 'is unrelated to', contradicts: 'works against' }[verdict];
  const confidence = Number.isFinite(margin) ? ` (margin ${margin.toFixed(2)})` : '';
  return `Advisory: this change ${phrase} ${formatClauseCitation(clause)}${confidence}. Not a gate — read the clause and decide.`;
}

/**
 * Route input for the advisory endpoint.
 *
 * Validated from HERE rather than through `lib/validation.js`, for the same
 * reason `jevScoreRequestSchema` is: re-exporting a one-route schema through
 * that barrel drags this module into the static import closure of every suite
 * that reaches it, which is exactly the growth `lib/importScoping.test.js`
 * exists to catch.
 *
 * `.strict()` — the endpoint is advisory and fixed-shape, so an unexpected key
 * is a caller reaching for a knob that does not exist, not something to drop.
 * There is deliberately no `repoPath` and no `appId`: the checkout comes from
 * the route's own loaded app record, because a client-supplied path would turn
 * an advisory endpoint into an arbitrary-file reader.
 */
export const scopeAdherenceRequestSchema = z.object({
  kind: z.enum(['issue', 'pr']),
  title: z.string().trim().min(1).max(1_000),
  body: z.string().max(100_000).optional(),
  diffSummary: z.string().max(20_000).optional(),
}).strict();
