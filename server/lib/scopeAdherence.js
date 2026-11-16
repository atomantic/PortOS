/**
 * The retrieval and premise half of "does this change advance what the product
 * says it is for?".
 *
 * The QUESTION itself — the three hypotheses and the abstention floor — is a
 * `scope-adherence` entry in `lib/jevDecisions.js`, beside the four
 * untrusted-content rungs, because that is PortOS's one registry of closed-set
 * questions the local scorer may answer, and registering there is what gives
 * this decision its agreement counters and its scorability contract test. What
 * lives here is everything that registry deliberately does not model: which
 * CLAUSE to ask about, and how a clause plus a change become one premise.
 *
 * ADVISORY ONLY, BY CONSTRUCTION. Nothing in this module or its service returns
 * a boolean a caller could gate on. [ETHOS.md](../../ETHOS.md) asks that
 * supervision gates be justified before they are added, and a 4B classifier
 * disagreeing with a prose PRD is not a justification. There is no auto-close,
 * no gating label, and no CI check anywhere downstream of this.
 *
 * Pure: no I/O, no scorer, no file reads. `services/scopeAdherence.js` owns the
 * ladder (screen → retrieve → decide → advisory verdict).
 */

import { z } from 'zod';
import { search, buildInvertedIndex } from './bm25.js';
import { fuseRankingsRRF } from './memoryQuery.js';
import { clampToCharLimit } from './textUtils.js';
import { formatClauseCitation } from './prdClauses.js';

/** The `lib/jevDecisions.js` entry this surface asks. */
export const SCOPE_ADHERENCE_DECISION_ID = 'scope-adherence';

/**
 * How many clauses are scored per change.
 *
 * Each clause costs one forward pass per hypothesis through a 4B model —
 * `run_jev.py` holds a global lock and does not batch — so scoring the whole
 * corpus would cost minutes for a verdict that cites one clause. Retrieval
 * picks the few worth asking about.
 */
export const SCOPE_ADHERENCE_TOP_K = 3;

/**
 * Per-premise cap on the CHANGE half.
 *
 * Deliberately close to `PRD_MAX_CLAUSE_CHARS` rather than "whatever is left of
 * the scorer's 32k premise bound": the change text is byte-identical in every
 * one of the k × 3 forward passes, so an unbounded body makes each pass prefill
 * thousands of tokens of the same boilerplate in order to tell apart clauses
 * that differ by at most 2,000 characters. Measured, a 20,000-character issue
 * body turns a ~5 s click into a ~40 s one, and none of the extra tokens are
 * informative.
 */
export const SCOPE_ADHERENCE_MAX_CHANGE_CHARS = 4_000;

/** Weights for the two retrieval views fused below. Narrative leads; code confirms. */
const NARRATIVE_WEIGHT = 1;
const CODE_WEIGHT = 0.7;

const asRanking = (results) => (results || []).map((result) => ({ id: result.docId }));

/**
 * The BM25 index for a clause corpus.
 *
 * Exported so a caller that already caches the parsed corpus can cache this
 * beside it: building the index over PortOS's own ~175 clauses measures ~13 ms,
 * three times the cost of the parse that the corpus cache exists to avoid.
 */
export const buildClauseIndex = (clauses) =>
  buildInvertedIndex(clauses.map((clause) => ({ id: clause.id, text: clause.text })));

/**
 * The scorable clauses and an id lookup over them.
 *
 * Both are per-CORPUS, not per-change, so a caller that runs many changes
 * against one corpus builds them once. The advisory endpoint scores a single
 * change and does not notice; the corpus builder scores up to a thousand forge
 * rows against the same few hundred clauses, which turns an O(C) prep into
 * O(R·C) the moment it is rebuilt inside the loop.
 */
export function prepareClauseCorpus(clauses) {
  const corpus = Array.isArray(clauses) ? clauses.filter((clause) => clause?.id && clause.text) : [];
  return { corpus, byId: new Map(corpus.map((clause) => [clause.id, clause])) };
}

/**
 * Pick the clauses worth scoring, best match first.
 *
 * TWO BM25 rankings, fused with RRF — not one query over a concatenated blob.
 * A change describes itself twice, in different vocabularies: prose in the
 * title and body, and identifiers in the changed-file list. Concatenating them
 * lets whichever is longer dominate the term frequencies; fusing their rankings
 * lets a clause that only one view found still surface. RRF is the same fusion
 * the memory retrieval stack already uses, so this reuses `fuseRankingsRRF`
 * rather than re-deriving rank arithmetic.
 *
 * @param {Array} clauses The corpus.
 * @param {{title?: string, body?: string, diffSummary?: string}} change Already normalized.
 * @param {{k?: number, index?: object, prepared?: {corpus: Array, byId: Map}}} options
 *   A prebuilt `index` skips the BM25 rebuild; a prebuilt `prepared`
 *   (`prepareClauseCorpus`) skips the per-call filter and id map. Both matter
 *   only to a caller in a loop — see `prepareClauseCorpus`.
 * @returns {Array} up to `k` clauses, in fused-rank order.
 */
export function selectCandidateClauses(clauses, change, { k = SCOPE_ADHERENCE_TOP_K, index, prepared } = {}) {
  const { corpus, byId } = prepared || prepareClauseCorpus(clauses);
  if (!corpus.length || k <= 0) return [];

  const narrative = [change?.title, change?.body].filter(Boolean).join('\n');
  const code = change?.diffSummary || '';
  if (!narrative && !code) return [];

  const bm25Index = index || buildClauseIndex(corpus);
  // Over-fetch each view: RRF ranks by agreement, so a clause that placed 5th
  // in both views can legitimately beat one that placed 1st in a single view.
  const limit = Math.max(k * 4, 12);
  const fused = fuseRankingsRRF(
    asRanking(narrative ? search(narrative, bm25Index, { limit }) : []),
    asRanking(code ? search(code, bm25Index, { limit }) : []),
    { ftsWeight: NARRATIVE_WEIGHT, vectorWeight: CODE_WEIGHT },
  );

  return [...fused.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, k)
    .map(([id]) => byId.get(id))
    .filter(Boolean);
}

/**
 * The change, rendered as the evidence half of a premise.
 *
 * Built ONCE and handed to both the untrusted-content screen and every
 * premise. Screening a separately-assembled subset of the same fields is what
 * lets the screened text and the scored text drift apart, and
 * `services/untrustedContent.js` states the invariant this inherits: the
 * scorer never sees content phase 1 has not seen.
 */
export function formatChangeEvidence(change) {
  const lines = [`Proposed change (${change?.kind === 'pr' ? 'pull request' : 'issue'}):`];
  if (change?.title) lines.push(`Title: ${change.title}`);
  if (change?.body) lines.push(`Description: ${change.body}`);
  if (change?.diffSummary) lines.push(`Changed files: ${change.diffSummary}`);
  return clampToCharLimit(lines.join('\n'), SCOPE_ADHERENCE_MAX_CHANGE_CHARS).text;
}

/**
 * Build the premise for one (clause, evidence) pair.
 *
 * The clause is stated FIRST and in full. Both halves are already capped well
 * below the scorer's premise bound, so nothing is clipped here — a clipped goal
 * would have the scorer answering about half a requirement with no way to tell
 * that it had.
 */
export function composeAdherencePremise({ clause, evidence } = {}) {
  if (!clause?.text || !evidence?.trim()) return null;
  return `Stated product goal (${formatClauseCitation(clause)}):\n${clause.text}\n\n${evidence}`;
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
