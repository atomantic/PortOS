/**
 * Pipeline — Head-to-head comparative ranking of a series' issues (#2169, CWQE Phase 5).
 *
 * autonovel's ANTI-PATTERNS doc calls absolute rubric scoring "the rubric trap":
 * "standard 1-10 scoring collapses to a 2-point band regardless of calibration;
 * comparative ranking forces discrimination the judge can't avoid." So instead of
 * (only) scoring each issue in isolation (the Phase 3 judge, #2167), we make the
 * judge choose between two drafts head-to-head — "you are not allowed to call it a
 * tie" — and run a Swiss-style Elo tournament across the series' drafted issues.
 * The resulting ranking gives the Series Autopilot (Phase 7) a reliable
 * weakest-issue selector that a flat qualityScore band can't.
 *
 * The Elo math + Swiss pairing are pure (unit-tested with a deterministic
 * playMatch); the only LLM cost is the per-match forced-pick compare call. The
 * tournament runs ONLY from an explicit user action (the route) or an already-
 * consented autopilot step — never at boot (AI-provider policy).
 *
 * The snapshot persists at `data/pipeline-comparative-rank/{seriesId}.json` and
 * pins the drafted-content `sourceContentHash` (reused from readerPanelDigest) so
 * the Editorial page can flag a stale ranking after edits — mirrors pipelineJudge
 * / readerPanel.
 *
 * Errors bubble (no try/catch) except the deliberate malformed-JSON retry in the
 * compare call, matching pipelineJudge.runJudgeStage.
 */

import { join } from 'path';
import { rm } from 'fs/promises';
import { assertValidSeriesId } from '../../../lib/pipelineIds.js';
import { PATHS, atomicWrite, ensureDir, tryReadFile, safeJSONParse } from '../../../lib/fileUtils.js';
import { runStagedLLM, resolveStageContext } from '../../stageRunner.js';
import { manuscriptContentBudgetChars } from '../../../lib/contextBudget.js';
import { listIssues } from '../issues.js';
import { pickJudgeContent } from '../pipelineJudge.js';
import { computeSourceContentHash } from '../readerPanelDigest.js';

const STAGE = 'pipeline-judge-compare';

// Elo constants. START_RATING is the conventional 1000 seed; K=32 is the
// classic update coefficient (issue spec). SWISS_ROUNDS is autonovel's "~4".
export const START_RATING = 1000;
export const ELO_K = 32;
export const SWISS_ROUNDS = 4;
export const TOURNAMENT_STOP = 'stop';

const nowIso = () => new Date().toISOString();

const rankDir = () => join(PATHS.data, 'pipeline-comparative-rank');
const snapshotPath = (seriesId) => join(rankDir(), `${seriesId}.json`);

// ---------- Elo math (pure) ----------

/**
 * Elo expected score for A against B — the probability-weighted share of the
 * point A "should" win given the rating gap. Symmetric: expected(a,b)+expected(b,a)=1.
 */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * Apply one forced-pick result to a pair of ratings. `winner` is 'a' or 'b'
 * (there are no draws — the compare prompt forbids ties). Zero-sum: whatever A
 * gains, B loses, so the pool's mean rating is conserved.
 */
export function updateRatings(ratingA, ratingB, winner, k = ELO_K) {
  const scoreA = winner === 'a' ? 1 : 0;
  const expA = expectedScore(ratingA, ratingB);
  const delta = k * (scoreA - expA);
  return { a: ratingA + delta, b: ratingB - delta };
}

// ---------- Swiss pairing (pure) ----------

// Order-independent key for a played pair, so a rematch can be detected/avoided.
const pairKey = (a, b) => [a, b].sort().join('\0');

/**
 * Pair one Swiss round. Standings are sorted best-first (score desc, rating desc);
 * players are greedily paired top-down with the nearest opponent they HAVEN'T
 * already played (falling back to a rematch only when every remaining opponent has
 * been played). An odd field gives a bye to the lowest-ranked player who hasn't
 * had one yet (spec: "Swiss-style tournament").
 *
 * Returns `{ pairs: [[idA, idB], …], bye: id|null }`. Pure — no rating mutation.
 */
export function pairSwissRound(standings, playedPairs = new Set(), byesGiven = new Set()) {
  const order = [...standings].sort((x, y) => (y.score - x.score) || (y.rating - x.rating));
  const pool = order.map((s) => s.id);

  let bye = null;
  if (pool.length % 2 === 1) {
    // Prefer the lowest-ranked player who has not already had a bye.
    let idx = -1;
    for (let i = pool.length - 1; i >= 0; i -= 1) {
      if (!byesGiven.has(pool[i])) { idx = i; break; }
    }
    if (idx === -1) idx = pool.length - 1; // everyone has had a bye — give it to the lowest
    bye = pool[idx];
    pool.splice(idx, 1);
  }

  const pairs = [];
  const used = new Set();
  for (let i = 0; i < pool.length; i += 1) {
    const a = pool[i];
    if (used.has(a)) continue;
    used.add(a);
    let partner = null;
    let fallback = null;
    for (let j = i + 1; j < pool.length; j += 1) {
      const b = pool[j];
      if (used.has(b)) continue;
      if (fallback === null) fallback = b;
      if (!playedPairs.has(pairKey(a, b))) { partner = b; break; }
    }
    const chosen = partner ?? fallback;
    if (chosen != null) { used.add(chosen); pairs.push([a, chosen]); }
  }
  return { pairs, bye };
}

// ---------- tournament (pure given a deterministic playMatch) ----------

// How many distinct rounds to run for n entrants — the configured count, capped
// so a tiny field doesn't force a wall of rematches (n-1 distinct opponents max).
export function effectiveRounds(n, rounds = SWISS_ROUNDS) {
  if (n <= 1) return 0;
  return Math.min(rounds, Math.max(1, n - 1));
}

/**
 * Run a Swiss-style Elo tournament. `entrants` is `[{ id, … }]`; `playMatch(a, b)`
 * resolves to `'a'`, `'b'`, or `TOURNAMENT_STOP`. Ratings start at START_RATING
 * and update by K after every completed match. A bye awards a standings point
 * (so the bye player keeps advancing) but does NOT touch Elo (no opponent to take
 * from). A stop outcome ends the current round before any mutation for the
 * declined match and prevents later rounds. Returns `{ ranking, matches,
 * stopped, roundsCompleted }` where `ranking` is best-first by rating.
 *
 * Pure aside from whatever `playMatch` does — with a deterministic playMatch the
 * whole tournament is deterministic, which is what the unit tests exercise.
 */
export async function runSwissTournament(entrants, playMatch, { rounds = SWISS_ROUNDS, k = ELO_K } = {}) {
  const state = new Map(entrants.map((e) => [e.id, {
    id: e.id, rating: START_RATING, score: 0, wins: 0, losses: 0, byes: 0,
  }]));
  const playedPairs = new Set();
  const byesGiven = new Set();
  const matches = [];
  let stopped = false;
  let roundsCompleted = 0;

  const total = effectiveRounds(state.size, rounds);
  for (let r = 0; r < total; r += 1) {
    const { pairs, bye } = pairSwissRound([...state.values()], playedPairs, byesGiven);
    let roundStopped = false;
    for (const [a, b] of pairs) {
      // A forced pick — playMatch must return 'a' or 'b'. Anything else is
      // treated as an 'a' win by the compare-caller's tiebreak (see runMatch).
      // The explicit stop outcome is checked before touching ratings, scores,
      // wins, losses, or the played-pair set for the declined match.
      const outcome = await playMatch(a, b);
      if (outcome === TOURNAMENT_STOP) {
        stopped = true;
        roundStopped = true;
        break;
      }
      const winner = outcome === 'b' ? 'b' : 'a';
      playedPairs.add(pairKey(a, b));
      const A = state.get(a);
      const Bp = state.get(b);
      const next = updateRatings(A.rating, Bp.rating, winner, k);
      A.rating = next.a;
      Bp.rating = next.b;
      if (winner === 'a') { A.score += 1; A.wins += 1; Bp.losses += 1; } else { Bp.score += 1; Bp.wins += 1; A.losses += 1; }
      matches.push({ round: r + 1, a, b, winner: winner === 'a' ? a : b });
    }
    if (roundStopped) break;
    if (bye != null) {
      const B = state.get(bye);
      B.score += 1;
      B.byes += 1;
      byesGiven.add(bye);
    }
    roundsCompleted += 1;
  }

  const ranking = [...state.values()]
    .map((s) => ({ ...s, rating: Math.round(s.rating * 100) / 100 }))
    .sort((x, y) => (y.rating - x.rating) || (y.score - x.score) || String(x.id).localeCompare(String(y.id)));
  return { ranking, matches, stopped, roundsCompleted };
}

// ---------- compare-call winner parsing ----------

/**
 * Parse a forced-pick compare response into `'a' | 'b' | null`. The prompt says
 * ties are not allowed, but LLMs occasionally hedge ("tie", "both", null, a
 * garbled field) — those all return `null` so the caller applies a deterministic
 * tiebreak rather than silently defaulting one side. Accepts the common spellings
 * a model reaches for: A/B, a/b, 1/2, first/second.
 */
export function parseCompareWinner(content) {
  const raw = content && typeof content === 'object' ? content.winner : content;
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'a' || v === '1' || v === 'first' || v === 'issue a' || v === 'a wins') return 'a';
  if (v === 'b' || v === '2' || v === 'second' || v === 'issue b' || v === 'b wins') return 'b';
  return null;
}

// Deterministic tiebreak when the judge refuses to pick (tie / unparseable):
// pick by the pair key's hash parity so it's stable and not systematically
// biased toward whichever side was passed first. Pure.
export function tiebreakWinner(idA, idB) {
  let h = 0;
  for (const ch of pairKey(idA, idB)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  // h even → the id that sorts first wins; odd → the other. Deterministic + balanced.
  const firstWins = h % 2 === 0;
  const aIsFirst = String(idA) < String(idB);
  return (firstWins === aIsFirst) ? 'a' : 'b';
}

// ---------- storage ----------

async function loadSnapshot(seriesId) {
  const content = await tryReadFile(snapshotPath(seriesId));
  if (content === null) return null;
  return safeJSONParse(content, null, { allowArray: false, logError: true, context: snapshotPath(seriesId) });
}

async function saveSnapshot(snapshot) {
  await ensureDir(rankDir());
  await atomicWrite(snapshotPath(snapshot.seriesId), snapshot);
}

async function removeSnapshot(seriesId) {
  await rm(snapshotPath(seriesId), { force: true }).catch(() => {});
}

// A stored ranking is stale when the drafted content it ranked has since moved.
async function isRankStale(snapshot, seriesId) {
  if (!snapshot || snapshot.status !== 'complete' || !snapshot.sourceContentHash) return false;
  const hash = await computeSourceContentHash(seriesId).catch(() => null);
  if (hash === null) return false;
  return hash !== snapshot.sourceContentHash;
}

// ---------- the LLM compare match ----------

// Truncate each side to a comparable char budget so a big issue can't crowd out
// the other and skew the pick (spec: "truncated to a comparable budget via
// lib/contextBudget.js"). Splits the model's usable window in half.
async function resolvePerSideCharBudget({ providerId, model }) {
  const { contextWindow } = await resolveStageContext(STAGE, {
    providerOverride: providerId,
    modelOverride: model,
  }).catch(() => ({ contextWindow: null }));
  const whole = manuscriptContentBudgetChars({
    contextWindow,
    overheadTokens: 1_500,
    outputReserveTokens: 1_200,
  });
  return Math.max(500, Math.floor(whole / 2));
}

const truncateForCompare = (text, maxChars) => (text.length > maxChars
  ? `${text.slice(0, maxChars)}\n\n[truncated for comparison — ${text.length} chars total]`
  : text);

/**
 * Resolve one head-to-head match between two issue records. Runs the forced-pick
 * compare prompt, parses the winner, and applies the deterministic tiebreak when
 * the judge refuses to choose. Returns `'a' | 'b'` — the SIDE (a = issueA).
 */
async function runMatch(issueA, issueB, { providerId, model, perSideChars }) {
  const contentA = truncateForCompare(pickJudgeContent(issueA)?.text || '', perSideChars);
  const contentB = truncateForCompare(pickJudgeContent(issueB)?.text || '', perSideChars);
  const vars = {
    issueA: { number: issueA.number, title: issueA.title, content: contentA },
    issueB: { number: issueB.number, title: issueB.title, content: contentB },
  };
  // One deliberate malformed-JSON retry (mirrors pipelineJudge.runJudgeStage):
  // a forced-pick judge that emits prose-wrapped JSON gets one stricter retry
  // before we fall through to the deterministic tiebreak.
  let parsed = null;
  let deciding = '';
  for (let attempt = 0; attempt < 2 && parsed === null; attempt += 1) {
    const result = await runStagedLLM(STAGE, vars, {
      returnsJson: true,
      providerOverride: providerId,
      modelOverride: model,
      source: 'pipeline-judge-compare',
    }).catch(() => null);
    parsed = parseCompareWinner(result?.content);
    if (parsed !== null && result?.content && typeof result.content === 'object') {
      deciding = typeof result.content.decidingPassage === 'string' ? result.content.decidingPassage : '';
    }
  }
  const winner = parsed ?? tiebreakWinner(issueA.id, issueB.id);
  return { winner, forcedTiebreak: parsed === null, deciding };
}

// ---------- public API ----------

/**
 * Issues eligible for the tournament: those with drafted, judgeable content
 * (prose or a script), ordered by arc position then number so the seeding is
 * stable across runs.
 */
export function eligibleIssues(issues) {
  return [...(Array.isArray(issues) ? issues : [])]
    .filter((i) => i && !!pickJudgeContent(i))
    .sort((a, b) => ((a.arcPosition ?? 9999) - (b.arcPosition ?? 9999)) || ((a.number || 0) - (b.number || 0)));
}

/**
 * Run the head-to-head Elo tournament for a series and persist the ranking.
 *
 * @param {string} seriesId
 * @param {object} [opts]
 * @param {string} [opts.providerId]   compare-judge provider override
 * @param {string} [opts.model]        compare-judge model override
 * @param {number} [opts.rounds]       Swiss rounds (default SWISS_ROUNDS)
 * @param {(match:{a,b})=>Promise<boolean>|boolean} [opts.chargeAction]
 *        billed once per match (autopilot budget); return false to STOP early.
 * @param {Array} [opts.issues]        pre-loaded issue list (tests / callers)
 * @returns {Promise<object>} the stored snapshot, or `{ status:'insufficient' }`
 *          when fewer than two issues have drafted content. A budget-stopped
 *          tournament is persisted as `status:'partial'`.
 */
export async function runComparativeRank(seriesId, opts = {}) {
  assertValidSeriesId(seriesId);
  const { providerId, model, rounds = SWISS_ROUNDS, chargeAction, issues: issuesArg } = opts;
  const issues = Array.isArray(issuesArg) ? issuesArg : await listIssues({ seriesId, withHistory: false });
  const entrants = eligibleIssues(issues);

  if (entrants.length < 2) {
    await removeSnapshot(seriesId);
    return { seriesId, status: 'insufficient', eligible: entrants.length };
  }

  const byId = new Map(entrants.map((i) => [i.id, i]));
  const perSideChars = await resolvePerSideCharBudget({ providerId, model });
  const matchRecords = [];
  let budgetStopped = false;

  const playMatch = async (aId, bId) => {
    if (budgetStopped) return TOURNAMENT_STOP;
    if (chargeAction) {
      const ok = await chargeAction({ a: aId, b: bId });
      if (ok === false) { budgetStopped = true; return TOURNAMENT_STOP; }
    }
    const A = byId.get(aId);
    const B = byId.get(bId);
    const { winner, forcedTiebreak, deciding } = await runMatch(A, B, { providerId, model, perSideChars });
    matchRecords.push({
      a: aId, b: bId, aNumber: A.number, bNumber: B.number,
      winner: winner === 'a' ? aId : bId, forcedTiebreak, deciding: deciding.slice(0, 400),
    });
    return winner;
  };

  const { ranking, roundsCompleted } = await runSwissTournament(entrants, playMatch, { rounds });
  const status = budgetStopped ? 'partial' : 'complete';

  // Merge issue metadata onto the ranking rows for the Editorial page.
  const ranked = ranking.map((row, idx) => {
    const iss = byId.get(row.id);
    return {
      rank: idx + 1,
      issueId: row.id,
      number: iss?.number ?? null,
      arcPosition: iss?.arcPosition ?? null,
      title: iss?.title || '',
      label: iss?.arcPosition != null ? `E${iss.arcPosition}` : `#${iss?.number ?? ''}`,
      rating: row.rating,
      wins: row.wins,
      losses: row.losses,
      byes: row.byes,
    };
  });

  const snapshot = {
    seriesId,
    status,
    sourceContentHash: await computeSourceContentHash(seriesId, { issues }).catch(() => null),
    entrants: entrants.length,
    rounds: effectiveRounds(entrants.length, rounds),
    roundsCompleted,
    k: ELO_K,
    ranking: ranked,
    // Weakest-first slice — only complete rankings are safe revision evidence.
    weakest: status === 'complete' ? [...ranked].reverse().slice(0, 5) : [],
    matches: matchRecords,
    budgetStopped,
    providerId: providerId || null,
    model: model || null,
    createdAt: nowIso(),
    completedAt: nowIso(),
  };
  await saveSnapshot(snapshot);
  console.log(`🏆 comparative rank: series=${seriesId.slice(0, 12)} entrants=${entrants.length} rounds=${snapshot.rounds} matches=${matchRecords.length} top=${ranked[0]?.label || '?'} weakest=${snapshot.weakest[0]?.label || '?'}${budgetStopped ? ' (budget-stopped)' : ''}`);
  return snapshot;
}

/**
 * Load the stored ranking with a `stale` flag. Returns `{ status: 'none' }` when
 * the tournament has never been run for this series.
 */
export async function getComparativeRank(seriesId) {
  assertValidSeriesId(seriesId);
  const snapshot = await loadSnapshot(seriesId);
  if (!snapshot) return { seriesId, status: 'none', ranking: [] };
  return { ...snapshot, stale: await isRankStale(snapshot, seriesId) };
}

export const __testing = { pairKey, isRankStale, runMatch, resolvePerSideCharBudget };
