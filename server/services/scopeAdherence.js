/**
 * Score a filed issue or an opened pull request against what the product says
 * it is for, using the local entailment scorer instead of a chat completion.
 *
 *     screenUntrustedContent()   ← phase 1, Prompt Guard. UNCHANGED.
 *       ↓ safe
 *     retrieve top-k clauses     ← BM25 + RRF over PRD.md / GOALS.md
 *       ↓
 *     decide() per clause        ← phase 2, local. Abstains rather than guessing.
 *       ↓
 *     one advisory line naming the clause
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
 * included in a status or capability payload.
 */

import { join } from 'path';
import { stat } from 'fs/promises';
import { tryReadFileStrict } from '../lib/jsonIo.js';
import { PATHS } from '../lib/paths.js';
import { parsePrdClauses, PRD_CLAUSE_SOURCES } from '../lib/prdClauses.js';
import {
  composeAdherencePremise,
  formatAdherenceAdvisory,
  SCOPE_ADHERENCE_HYPOTHESES,
  SCOPE_ADHERENCE_MIN_MARGIN,
  SCOPE_ADHERENCE_TOP_K,
  selectCandidateClauses,
  verdictForHypothesis,
} from '../lib/scopeAdherence.js';

/** Every way `scoreAdherence` can decline to produce a verdict. */
export const SCOPE_ADHERENCE_FAILURE_CODES = Object.freeze([
  'scope-adherence-disabled',
  'scope-adherence-change-empty',
  'scope-adherence-corpus-missing',
  'scope-adherence-corpus-unreadable',
  'scope-adherence-no-clause',
]);

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

// Cache the parsed corpus per repository, invalidated on either file's mtime.
// Parsing ~400 lines is cheap, but the scorer is called from a UI button and
// re-reading two files on every click for an unchanged checkout is waste.
const corpusCache = new Map();

async function fileStamp(path) {
  return stat(path).then((info) => `${info.mtimeMs}:${info.size}`, () => null);
}

/**
 * Parse `PRD.md` and `GOALS.md` from one checkout into a clause corpus.
 *
 * `ok: false` distinguishes "this repository states no product intent" from
 * "we could not read the files that state it" — the first is a legitimate
 * empty an operator can fix by writing a PRD, the second is a broken install,
 * and collapsing them would advertise the wrong remedy.
 */
export async function loadClauseCorpus(repoPath = PATHS.root) {
  // An app record with no checkout has no product intent to score against, and
  // silently falling back to THIS install's PRD would grade someone else's
  // repository against PortOS's goals.
  if (typeof repoPath !== 'string' || !repoPath.trim()) return failure('scope-adherence-corpus-missing');
  const stamps = await Promise.all(PRD_CLAUSE_SOURCES.map((name) => fileStamp(join(repoPath, name))));
  const key = `${repoPath}|${stamps.join('|')}`;
  const cached = corpusCache.get(repoPath);
  if (cached?.key === key) return cached.result;

  const clauses = [];
  let unreadable = false;
  for (const sourceFile of PRD_CLAUSE_SOURCES) {
    const { ok, value } = await tryReadFileStrict(join(repoPath, sourceFile));
    if (!ok) { unreadable = true; continue; }
    if (typeof value === 'string') clauses.push(...parsePrdClauses(value, { sourceFile }));
  }

  const result = unreadable && !clauses.length
    ? failure('scope-adherence-corpus-unreadable')
    : { ok: true, clauses };
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
 * @param {string} [change.repoPath] Checkout holding the PRD; defaults to this install's.
 * @param {number} [change.topK] Clause budget. Bounds the number of forward passes.
 * @returns {Promise<{ok: true, verdict: 'aligned'|'unrelated'|'contradicts'|'abstained', clauseId: string|null, clause: object|null, margin: number|null, advisory: string, scored: number} | {ok: false, code: string}>}
 */
export async function scoreAdherence({
  kind = 'issue',
  title = '',
  body = '',
  diffSummary = '',
  repoPath = PATHS.root,
  topK = SCOPE_ADHERENCE_TOP_K,
} = {}) {
  // Deferred: `jevRouter` reaches the instance-feature graph and `jev.js`
  // carries the sidecar lifecycle and the 9 GB model contract. An install that
  // never opts in must not pay for either in its static import closure
  // (`server/lib/importScoping.test.js`).
  const { isJevFeatureEnabled } = await import('./jevRouter.js');
  if (!await isJevFeatureEnabled()) return failure('scope-adherence-disabled');

  const change = { kind, title: String(title || '').trim(), body: String(body || '').trim(), diffSummary: String(diffSummary || '').trim() };
  if (!change.title && !change.body) return failure('scope-adherence-change-empty');

  // Phase 1 of the ladder, unchanged and not optional: an issue or PR body is
  // attacker-controlled text, and it reaches a model here the same way it does
  // everywhere else in the untrusted-content contract.
  const { screenUntrustedContent } = await import('./untrustedContent.js');
  const screened = await screenUntrustedContent({
    content: [change.title, change.body].filter(Boolean).join('\n\n'),
    source: kind === 'pr' ? 'github-pr' : 'github-issue',
  });
  if (!screened.ok) return failure(screened.code || 'untrusted-content-screening-failed');

  const corpus = await loadClauseCorpus(repoPath);
  if (!corpus.ok) return corpus;
  if (!corpus.clauses.length) return failure('scope-adherence-corpus-missing');

  const candidates = selectCandidateClauses(corpus.clauses, change, { k: topK });
  if (!candidates.length) return failure('scope-adherence-no-clause');

  const { decide } = await import('./jev.js');
  const decided = [];
  let widestAbstention = null;
  for (const clause of candidates) {
    const premise = composeAdherencePremise({ clause, change });
    if (!premise) continue;
    const scored = await decide({ premise, options: [...SCOPE_ADHERENCE_HYPOTHESES], minMargin: SCOPE_ADHERENCE_MIN_MARGIN });
    // An unavailable scorer is reported once, as itself. Falling through to a
    // chat completion is what the untrusted-content ladder does; there is no
    // such fallback here, because an advisory nobody asked for is not worth
    // provider quota.
    if (!scored.ok) return failure(scored.code);
    if (scored.abstained) {
      if (widestAbstention === null || scored.margin > widestAbstention) widestAbstention = scored.margin;
      continue;
    }
    const verdict = verdictForHypothesis(scored.choice);
    if (verdict) decided.push({ verdict, clause, margin: scored.margin });
  }

  if (!decided.length) {
    return {
      ok: true,
      verdict: 'abstained',
      clauseId: null,
      clause: null,
      margin: widestAbstention,
      advisory: formatAdherenceAdvisory({}),
      scored: candidates.length,
    };
  }

  decided.sort((a, b) => (VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict]) || (b.margin - a.margin));
  const best = decided[0];
  return {
    ok: true,
    verdict: best.verdict,
    clauseId: best.clause.id,
    clause: best.clause,
    margin: best.margin,
    advisory: formatAdherenceAdvisory(best),
    scored: candidates.length,
  };
}
