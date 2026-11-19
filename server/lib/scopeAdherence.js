/**
 * The retrieval and premise half of "does this change advance what the product says it is for?".
 *
 * The QUESTION (three hypotheses plus abstention floor) is a `scope-adherence` entry in `lib/jevDecisions.js`, PortOS's one registry of closed-set questions the local scorer may answer (which gives it agreement counters and a scorability contract test); what lives here is what that registry doesn't model: which CLAUSE to ask about, and how a clause plus a change become one premise.
 *
 * ADVISORY ONLY, BY CONSTRUCTION: nothing here or in its service returns a boolean a caller could gate on ([ETHOS.md](../../ETHOS.md) wants supervision gates justified, and a 4B classifier disagreeing with a
 * prose PRD isn't one). No auto-close, gating label or CI check downstream. Pure (no I/O, scorer or file reads); `services/scopeAdherence.js` owns the ladder (screen → retrieve → decide → advisory verdict).
 */

import { z } from 'zod';
import { search, buildInvertedIndex } from './bm25.js';
import { fuseRankingsRRF } from './memoryQuery.js';
import { clampToCharLimit } from './textUtils.js';
import { formatClauseCitation } from './prdClauses.js';

/** The `lib/jevDecisions.js` entry this surface asks. */
export const SCOPE_ADHERENCE_DECISION_ID = 'scope-adherence';

/** How many clauses are scored per change: each costs one forward pass per hypothesis through a 4B model (`run_jev.py` holds a global lock, no batching), so scoring the whole corpus would cost minutes for a verdict citing one clause. */
export const SCOPE_ADHERENCE_TOP_K = 3;

/**
 * Per-premise cap on the CHANGE half, close to `PRD_MAX_CLAUSE_CHARS` rather than the scorer's 32k bound: the change text is byte-identical in all k × 3 forward passes, so an unbounded body makes each pass prefill
 * thousands of identical tokens to tell apart clauses differing by at most 2,000 chars (a 20,000-char issue body turned a ~5 s click into ~40 s, none of it informative).
 */
export const SCOPE_ADHERENCE_MAX_CHANGE_CHARS = 4_000;

/** Weights for the two retrieval views fused below. Narrative leads; code confirms. */
const NARRATIVE_WEIGHT = 1;
const CODE_WEIGHT = 0.7;

const asRanking = (results) => (results || []).map((result) => ({ id: result.docId }));

/** The BM25 index for a clause corpus; exported so a caller caching the parsed corpus can cache this beside it (building it over PortOS's ~175 clauses costs ~13 ms, three times the parse the corpus cache avoids). */
export const buildClauseIndex = (clauses) =>
  buildInvertedIndex(clauses.map((clause) => ({ id: clause.id, text: clause.text })));

/**
 * The scorable clauses and an id lookup, per-CORPUS not per-change, so a caller running many changes builds them once (the corpus builder scores up to a thousand forge rows against a few hundred clauses;
 * rebuilding inside the loop turns an O(C) prep into O(R·C)).
 */
export function prepareClauseCorpus(clauses) {
  const corpus = Array.isArray(clauses) ? clauses.filter((clause) => clause?.id && clause.text) : [];
  return { corpus, byId: new Map(corpus.map((clause) => [clause.id, clause])) };
}

/**
 * Pick the clauses worth scoring, best match first. TWO BM25 rankings fused with RRF, not one query over a concatenated blob: a change describes itself in two vocabularies (prose in title/body, identifiers in the
 * changed-file list), concatenation lets the longer dominate term frequencies, and fusing lets a clause only one view found still surface. Reuses `fuseRankingsRRF` from the memory retrieval stack.
 *
 * @param {Array} clauses The corpus.
 * @param {{title?: string, body?: string, diffSummary?: string}} change Already normalized.
 * @param {{k?: number, index?: object, prepared?: {corpus: Array, byId: Map}}} options
 *   A prebuilt `index` skips the BM25 rebuild and `prepared` (`prepareClauseCorpus`) skips the per-call filter and id map; both matter only in a loop.
 * @returns {Array} up to `k` clauses, in fused-rank order.
 */
export function selectCandidateClauses(clauses, change, { k = SCOPE_ADHERENCE_TOP_K, index, prepared } = {}) {
  const { corpus, byId } = prepared || prepareClauseCorpus(clauses);
  if (!corpus.length || k <= 0) return [];

  const narrative = [change?.title, change?.body].filter(Boolean).join('\n');
  const code = change?.diffSummary || '';
  if (!narrative && !code) return [];

  const bm25Index = index || buildClauseIndex(corpus);
  // Over-fetch each view: RRF ranks by agreement, so a clause 5th in both views can beat one 1st in a single view.
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

/** The change, rendered as the evidence half of a premise. Built ONCE for both the untrusted-content screen and every premise, so the screened and scored text can't drift (`services/untrustedContent.js`: the scorer never sees content phase 1 hasn't seen). */
export function formatChangeEvidence(change) {
  const lines = [`Proposed change (${change?.kind === 'pr' ? 'pull request' : 'issue'}):`];
  if (change?.title) lines.push(`Title: ${change.title}`);
  if (change?.body) lines.push(`Description: ${change.body}`);
  if (change?.diffSummary) lines.push(`Changed files: ${change.diffSummary}`);
  return clampToCharLimit(lines.join('\n'), SCOPE_ADHERENCE_MAX_CHANGE_CHARS).text;
}

/** Build the premise for one (clause, evidence) pair. The clause is stated FIRST and in full; both halves are capped well below the scorer's bound so nothing is clipped (a clipped goal would be scored as half a requirement unawares). */
export function composeAdherencePremise({ clause, evidence } = {}) {
  if (!clause?.text || !evidence?.trim()) return null;
  return `Stated product goal (${formatClauseCitation(clause)}):\n${clause.text}\n\n${evidence}`;
}

/**
 * Route input for the advisory endpoint. Validated from HERE, not a shared validation module (as `jevScoreRequestSchema`): re-exporting a one-route schema through one grows every suite's static import closure
 * (`lib/importScoping.test.js`). `.strict()`: the endpoint is advisory and fixed-shape, so an unexpected key is a caller reaching for a nonexistent knob. No `repoPath`/`appId`: the checkout comes from the route's
 * loaded app record, since a client-supplied path would make an advisory endpoint an arbitrary-file reader.
 */
export const scopeAdherenceRequestSchema = z.object({
  kind: z.enum(['issue', 'pr']),
  title: z.string().trim().min(1).max(1_000),
  body: z.string().max(100_000).optional(),
  diffSummary: z.string().max(20_000).optional(),
}).strict();
