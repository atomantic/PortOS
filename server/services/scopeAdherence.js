/**
 * Score a filed issue or an opened pull request against what the product says
 * it is for, using the local entailment scorer instead of a chat completion.
 *
 *     read PRD.md + GOALS.md        ← the operator's own checkout. No model.
 *       ↓ clauses
 *     retrieve top-k candidates     ← BM25 + RRF, in process. No model.
 *       ↓ ≤ k clauses
 *     screenUntrustedContent()      ← Prompt Guard. Unchanged, and not optional.
 *       ↓ safe
 *     runJevDecision() per clause   ← the shared `scope-adherence` rung.
 *       ↓
 *     one advisory naming the clause
 *
 * The two inert steps run FIRST on purpose. A managed app with no `PRD.md`, or
 * a change nothing in the corpus matches, can never produce an advisory, and
 * making it pay a full model-abuse classifier run — possibly a sidecar cold
 * start — to be told so is the one cost on this path that repeats per click.
 * The screen still lands before the first `decide()`, which is where the
 * untrusted-content contract actually requires it.
 *
 * ADVISORY, NEVER A GATE. This module has no write path: it closes nothing,
 * labels nothing, blocks nothing, and no caller of it may either. That is a
 * deliberate reading of [ETHOS.md](../../ETHOS.md) — unsupervised operation is
 * the design target, and a 4B classifier's disagreement with prose is not
 * grounds to stop a human or an agent. `scoreAdherence` returns a verdict, the
 * clause it was scored against, and a margin; what a surface does with that is
 * render it.
 *
 * Machine-local throughout: the corpus is two files in the checkout, the
 * scorer is a loopback sidecar, and nothing here is persisted, federated, or
 * included in a status or capability payload. The one thing that IS recorded
 * is the shared jev agreement counter — counts only, never a premise.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { tryReadFileStrict } from '../lib/jsonIo.js';
import { formatClauseCitation, parsePrdClauses, PRD_CLAUSE_SOURCES } from '../lib/prdClauses.js';
import {
  buildClauseIndex,
  composeAdherencePremise,
  formatChangeEvidence,
  SCOPE_ADHERENCE_DECISION_ID,
  SCOPE_ADHERENCE_TOP_K,
  selectCandidateClauses,
} from '../lib/scopeAdherence.js';
// Re-exported, not re-declared: the codes live beside their operator-facing
// labels in a pure leaf, so the test that pairs them need not import this
// service's closure (`lib/importScoping.test.js`).
export { SCOPE_ADHERENCE_FAILURE_CODES } from '../lib/scopeAdherenceReasons.js';

const failure = (code) => ({ ok: false, code });

/**
 * Which verdict gets reported when several clauses answered.
 *
 * Informativeness, not retrieval rank. A `contradicts` on the third-ranked
 * clause is the single most useful thing this feature can say, and reporting
 * `unrelated` from the top-ranked clause instead would bury it. Within a tier,
 * the widest margin wins.
 */
const VERDICT_RANK = { contradicts: 0, aligned: 1, unrelated: 2 };

// Cache the parsed corpus AND its BM25 index per repository, invalidated on
// either file's mtime. The index is the larger half: building it over PortOS's
// own ~175 clauses measures ~13 ms, three times the parse this cache was
// introduced to avoid, and it is per-corpus rather than per-change.
const corpusCache = new Map();

async function fileStamp(path) {
  return stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => null);
}

/**
 * Parse `PRD.md` and `GOALS.md` from one checkout into a clause corpus.
 *
 * `repoPath` is REQUIRED and has no default. Defaulting it to this install's
 * own checkout would mean an app record with a missing `repoPath` silently
 * gets graded against PortOS's PRD instead of its own.
 *
 * Three outcomes, never collapsed: a corpus, `corpus-missing` (this repository
 * states no product intent — fixable by writing a PRD), and
 * `corpus-unreadable` (the files are there and we could not read them — a
 * broken install). The middle and last point at opposite remedies.
 */
export async function loadClauseCorpus(repoPath) {
  if (typeof repoPath !== 'string' || !repoPath.trim()) return failure('scope-adherence-corpus-missing');
  const paths = PRD_CLAUSE_SOURCES.map((name) => join(repoPath, name));
  const stamps = await Promise.all(paths.map(fileStamp));
  const key = stamps.join('|');
  const cached = corpusCache.get(repoPath);
  if (cached?.key === key) return cached.result;

  const reads = await Promise.all(paths.map((path) => tryReadFileStrict(path)));
  const clauses = [];
  let unreadable = false;
  reads.forEach(({ ok, value }, position) => {
    if (!ok) { unreadable = true; return; }
    if (typeof value === 'string') clauses.push(...parsePrdClauses(value, { sourceFile: PRD_CLAUSE_SOURCES[position] }));
  });

  const result = clauses.length
    ? { ok: true, clauses, index: buildClauseIndex(clauses) }
    : failure(unreadable ? 'scope-adherence-corpus-unreadable' : 'scope-adherence-corpus-missing');
  corpusCache.set(repoPath, { key, result });
  return result;
}

/** Test seam, mirroring the cache resets on the sibling local-model services. */
export const resetClauseCorpusCache = () => corpusCache.clear();

/**
 * Score one change against the product's stated intent.
 *
 * @param {object} change
 * @param {'issue'|'pr'} change.kind Which forge object this is; picks the screening channel.
 * @param {string} change.title
 * @param {string} [change.body]
 * @param {string} [change.diffSummary] Changed-file list or a short diff digest.
 * @param {string} change.repoPath Checkout holding the product documents. Required.
 * @param {number} [change.topK] Clause budget. Bounds the number of forward passes.
 * @returns {Promise<{ok: true, verdict: 'aligned'|'unrelated'|'contradicts'|'abstained', clauseId: string|null, clause: object|null, margin: number|null, scored: number} | {ok: false, code: string}>}
 */
export async function scoreAdherence({
  kind = 'issue',
  title = '',
  body = '',
  diffSummary = '',
  repoPath,
  topK = SCOPE_ADHERENCE_TOP_K,
} = {}) {
  // Deferred: `jevRouter` reaches the instance-feature graph and, through it,
  // the sidecar lifecycle and the pinned 9 GB model contract. An install that
  // never opts in must not pay for either in its static import closure
  // (`server/lib/importScoping.test.js`).
  const { isJevFeatureEnabled, recordJevObservations, runJevDecision } = await import('./jevRouter.js');
  if (!await isJevFeatureEnabled()) return failure('scope-adherence-disabled');

  // Normalized ONCE, here. The route's schema has already trimmed what it
  // validates, but this is also the entry point for a direct service caller.
  const change = { kind, title: String(title || '').trim(), body: String(body || '').trim(), diffSummary: String(diffSummary || '').trim() };
  if (!change.title && !change.body) return failure('scope-adherence-change-empty');

  const corpus = await loadClauseCorpus(repoPath);
  if (!corpus.ok) return corpus;
  const candidates = selectCandidateClauses(corpus.clauses, change, { k: topK, index: corpus.index });
  if (!candidates.length) return failure('scope-adherence-no-clause');

  // Phase 1 of the ladder, unchanged and not optional: an issue or PR body is
  // attacker-controlled text. The screened string is the SAME string that goes
  // into every premise — screening a separately-assembled subset is what lets
  // the screened text and the scored text drift apart.
  const evidence = formatChangeEvidence(change);
  const { screenUntrustedContent } = await import('./untrustedContent.js');
  const screened = await screenUntrustedContent({
    content: evidence,
    source: kind === 'pr' ? 'github-pr' : 'github-issue',
  });
  if (!screened.ok) return failure(screened.code || 'untrusted-content-screening-failed');

  const decided = [];
  const observations = [];
  let widestAbstention = null;
  for (const clause of candidates) {
    const premise = composeAdherencePremise({ clause, evidence });
    if (!premise) continue;
    const scored = await runJevDecision({ decisionId: SCOPE_ADHERENCE_DECISION_ID, premise });
    observations.push({ decisionId: SCOPE_ADHERENCE_DECISION_ID, kind: scored.kind });
    // An unavailable scorer is reported once, as itself, and stops the loop —
    // the remaining clauses would fail identically. Falling through to a chat
    // completion is what the untrusted-content ladder does; there is no such
    // fallback here, because an advisory nobody asked for is not worth
    // provider quota.
    if (!scored.ok) {
      await recordJevObservations(observations);
      return failure(scored.code);
    }
    if (scored.abstained) {
      if (widestAbstention === null || scored.margin > widestAbstention) widestAbstention = scored.margin;
      continue;
    }
    decided.push({ verdict: scored.value, clause, margin: scored.margin });
  }

  // Counts only — which decision, which bucket. Never a premise, a clause, or
  // anything about what was analyzed. This is what puts the scope scorer's
  // abstention rate in the same panel table as the triage decisions.
  await recordJevObservations(observations);

  if (!decided.length) {
    return { ok: true, verdict: 'abstained', clauseId: null, clause: null, margin: widestAbstention, scored: candidates.length };
  }

  decided.sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]) || (b.margin - a.margin));
  const best = decided[0];
  return {
    ok: true,
    verdict: best.verdict,
    clauseId: best.clause.id,
    // The citation ships as a FIELD rather than being re-spelled in the
    // browser: the separator and the no-heading-path case would otherwise have
    // two implementations, and a change to one would leave the other green.
    clause: { ...best.clause, citation: formatClauseCitation(best.clause) },
    margin: best.margin,
    scored: candidates.length,
  };
}
