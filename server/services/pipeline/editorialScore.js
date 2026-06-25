/**
 * Pipeline — Editorial health score + revision-trend tracking (#1316).
 *
 * Turns the point-in-time manuscript-review findings (manuscriptReview.js) into
 * something the author can *manage* the draft with:
 *
 *  - a transparent, deterministic HEALTH SCORE (per-issue + per-series) computed
 *    from the OPEN findings weighted by severity — no black box, the formula is
 *    `100 − Σ weight(severity)` clamped to 0..100 (weights below);
 *  - a "READY" signal — a configurable convergence gate (default: no open `high`
 *    findings) the autopilot editorial loop and the UI read as "manuscript clean";
 *  - a per-run REVISION-TREND ledger — each editorial-checks / completeness run is
 *    a revision boundary; we snapshot the open-finding counts by severity +
 *    category so the UI can render "continuity 8→5→2" trends and flag categories
 *    that REGRESSED after an edit pass.
 *
 * Scoring is PURE (unit-testable in isolation); the trend ledger persists at
 * `data/pipeline-editorial-health/{seriesId}.json` (atomic write, per-series
 * tail) mirroring the editorialAnalysis snapshot pattern. Errors bubble (no
 * try/catch) — callers own their boundary.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { getReview } from './manuscriptReview.js';

// Storage-layout version for the trend ledger. Bump + migrate if the snapshot
// shape changes in a way older peers can't read. (Trend snapshots are local
// telemetry — they do NOT ride peer sync, so this is install-local.)
const SCHEMA_VERSION = 1;

const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

// Transparent severity penalty weights. A draft starts at 100 and loses points
// per OPEN finding: a `high` finding costs as much as a dozen `low` nits. These
// are the published formula — surfaced in the API + UI so the score is never a
// black box. Accepted (fixed) and dismissed (waived) findings cost nothing.
export const SEVERITY_WEIGHTS = Object.freeze({ high: 12, medium: 5, low: 1 });

// Readiness gates — the convergence signal the autopilot + UI read as "clean".
// `noOpenHigh` (default) is the manuscript-not-clean threshold; the stricter
// gate also blocks on mediums; `none` disables the gate (always ready).
export const READINESS_GATES = Object.freeze(['noOpenHigh', 'noOpenHighOrMedium', 'none']);
export const DEFAULT_READINESS_GATE = 'noOpenHigh';

// Cap on the persisted revision-trend ledger. Each run appends one snapshot; the
// oldest roll off so the file can't grow unbounded over a long series' life.
const MAX_TREND_SNAPSHOTS = 100;

const nowIso = () => new Date().toISOString();

// Defense-in-depth: refuse path-traversal-shaped ids before interpolating into
// the on-disk ledger path. Series ids are `ser-<uuid>` — restrict to a safe
// charset (mirrors editorialAnalysis.assertValidIssueId).
function assertValidSeriesId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`Invalid series id: ${id}`);
  }
}

const healthDir = () => join(PATHS.data, 'pipeline-editorial-health');
const ledgerPath = (seriesId) => join(healthDir(), `${seriesId}.json`);

// ---------------------------------------------------------------------------
// Pure scoring.
// ---------------------------------------------------------------------------

// Default an unknown/absent severity to 'medium' to match manuscriptReview's
// sanitizeComment (so the two never disagree on how an odd value scores). Stored
// comments are always already high/medium/low, so this only guards a hand-edited
// or older-peer record.
const normalizeSeverity = (s) => (SEVERITIES.includes(s) ? s : 'medium');
const emptySeverityCounts = () => ({ high: 0, medium: 0, low: 0 });

// Resolve the readiness gate to one of READINESS_GATES, falling back to the
// default for an absent/unknown value — so a hand-edited settings blob can't
// silently disable the gate with a typo (it falls through to noOpenHigh).
export function resolveReadinessGate(gate) {
  return READINESS_GATES.includes(gate) ? gate : DEFAULT_READINESS_GATE;
}

// Is a set of open-severity counts "ready" under the given gate?
export function isReadyUnderGate(openBySeverity, gate) {
  const g = resolveReadinessGate(gate);
  const counts = openBySeverity || emptySeverityCounts();
  if (g === 'none') return true;
  if (g === 'noOpenHighOrMedium') return (counts.high || 0) === 0 && (counts.medium || 0) === 0;
  return (counts.high || 0) === 0; // noOpenHigh
}

// The weighted health score for a list of OPEN findings: 100 minus the summed
// severity penalty, clamped to 0..100. Pure + deterministic.
export function scoreFromOpen(openBySeverity) {
  const counts = openBySeverity || emptySeverityCounts();
  const penalty = SEVERITIES.reduce((sum, sev) => sum + (counts[sev] || 0) * SEVERITY_WEIGHTS[sev], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}

// A finding is OPEN unless explicitly accepted (fixed) or dismissed (waived) —
// the store defaults an unknown/absent status to 'open', so anything else counts
// as a live blocker (can't under-count). Shared so the scorer and the autopilot
// gate's residual filter agree on what "open" means.
export const isOpenFinding = (comment) =>
  comment?.status !== 'accepted' && comment?.status !== 'dismissed';

/**
 * The OPEN findings that block a given readiness gate — the residual a caller
 * (e.g. the autopilot gate) surfaces when a series isn't "ready". Mirrors
 * `computeHealth`'s open-detection + severity normalization exactly so the
 * blocker list can never disagree with the `ready` verdict. Returns [] for the
 * 'none' gate (nothing blocks).
 */
export function openBlockers(comments, gate = DEFAULT_READINESS_GATE) {
  const g = resolveReadinessGate(gate);
  if (g === 'none') return [];
  const blocking = g === 'noOpenHighOrMedium' ? new Set(['high', 'medium']) : new Set(['high']);
  return (Array.isArray(comments) ? comments : []).filter(
    (c) => c && typeof c === 'object' && isOpenFinding(c) && blocking.has(normalizeSeverity(c.severity)),
  );
}

// Tally one finding into an accumulator. OPEN findings drive the score +
// breakdowns; accepted/dismissed are counted only for context (resolved totals).
function tally(acc, comment) {
  acc.total += 1;
  const status = comment?.status;
  if (status === 'accepted') { acc.accepted += 1; return; }
  if (status === 'dismissed') { acc.dismissed += 1; return; }
  // Any non-accepted/dismissed status (incl. legacy/absent) is open — see
  // isOpenFinding; this can't under-count blockers.
  const sev = normalizeSeverity(comment?.severity);
  acc.open += 1;
  acc.openBySeverity[sev] += 1;
  const category = (typeof comment?.category === 'string' && comment.category) ? comment.category : 'other';
  acc.openByCategory[category] = (acc.openByCategory[category] || 0) + 1;
  const checkId = (typeof comment?.checkId === 'string' && comment.checkId) ? comment.checkId : 'completeness';
  acc.openByCheck[checkId] = (acc.openByCheck[checkId] || 0) + 1;
}

const newAcc = () => ({
  total: 0,
  open: 0,
  accepted: 0,
  dismissed: 0,
  openBySeverity: emptySeverityCounts(),
  openByCategory: {},
  openByCheck: {},
});

// Finalize an accumulator into a scored metric block (adds score + ready).
function finalize(acc, gate) {
  return {
    score: scoreFromOpen(acc.openBySeverity),
    ready: isReadyUnderGate(acc.openBySeverity, gate),
    total: acc.total,
    open: acc.open,
    accepted: acc.accepted,
    dismissed: acc.dismissed,
    openBySeverity: acc.openBySeverity,
    openByCategory: acc.openByCategory,
    openByCheck: acc.openByCheck,
  };
}

/**
 * Compute the editorial health score from a review's comments — a per-series
 * roll-up plus a per-issue breakdown (keyed by issueNumber). Pure: pass in the
 * comments + the resolved readiness gate.
 *
 * @param {Array} comments — manuscriptReview comment records
 * @param {string} [gate] — readiness gate (default DEFAULT_READINESS_GATE)
 * @returns {{ score, ready, ...series-rollup, gate, weights, perIssue: [] }}
 */
export function computeHealth(comments, gate = DEFAULT_READINESS_GATE) {
  const resolvedGate = resolveReadinessGate(gate);
  const list = Array.isArray(comments) ? comments : [];
  const seriesAcc = newAcc();
  const byIssue = new Map();
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    tally(seriesAcc, c);
    // Per-issue breakdown — findings with no issueNumber bucket under `null`
    // (series-scoped findings like naming collisions).
    const key = Number.isInteger(c.issueNumber) ? c.issueNumber : null;
    if (!byIssue.has(key)) byIssue.set(key, newAcc());
    tally(byIssue.get(key), c);
  }
  const perIssue = [...byIssue.entries()]
    .map(([issueNumber, acc]) => ({ issueNumber, ...finalize(acc, resolvedGate) }))
    // Stable order: real issue numbers ascending, the null (series-scoped) bucket last.
    .sort((a, b) => (a.issueNumber ?? Infinity) - (b.issueNumber ?? Infinity));
  return {
    ...finalize(seriesAcc, resolvedGate),
    gate: resolvedGate,
    weights: SEVERITY_WEIGHTS,
    perIssue,
  };
}

// ---------------------------------------------------------------------------
// Revision-trend ledger (persisted per series).
// ---------------------------------------------------------------------------

// Per-series write tail (the ledger file is distinct per series, so each only
// serializes against itself). Mirrors manuscriptReview's queue pattern.
const ledgerQueues = new Map();
function queueLedgerWrite(seriesId, fn) {
  const key = typeof seriesId === 'string' && seriesId ? seriesId : '__unknown__';
  let q = ledgerQueues.get(key);
  if (!q) { q = createFileWriteQueue(); ledgerQueues.set(key, q); }
  return q(fn);
}

const emptyLedger = (seriesId) => ({ schemaVersion: SCHEMA_VERSION, seriesId, snapshots: [] });

function sanitizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const at = typeof raw.at === 'string' ? raw.at : null;
  if (!at) return null;
  const sevRaw = raw.openBySeverity && typeof raw.openBySeverity === 'object' ? raw.openBySeverity : {};
  const openBySeverity = {
    high: Number.isFinite(sevRaw.high) ? sevRaw.high : 0,
    medium: Number.isFinite(sevRaw.medium) ? sevRaw.medium : 0,
    low: Number.isFinite(sevRaw.low) ? sevRaw.low : 0,
  };
  const byCat = raw.openByCategory && typeof raw.openByCategory === 'object' ? raw.openByCategory : {};
  const openByCategory = {};
  for (const [k, v] of Object.entries(byCat)) if (Number.isFinite(v)) openByCategory[k] = v;
  // Per-check open counts (#1597). Additive + local-only telemetry: snapshots
  // recorded before this shipped simply lack the map (defaults to {}), so the
  // per-check trend starts accumulating from the first run after upgrade — no
  // schema bump needed (older readers ignore the field; this reader tolerates
  // its absence).
  const byCheck = raw.openByCheck && typeof raw.openByCheck === 'object' ? raw.openByCheck : {};
  const openByCheck = {};
  for (const [k, v] of Object.entries(byCheck)) if (Number.isFinite(v)) openByCheck[k] = v;
  return {
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    at,
    score: Number.isFinite(raw.score) ? raw.score : scoreFromOpen(openBySeverity),
    ready: raw.ready === true,
    open: Number.isFinite(raw.open) ? raw.open : (openBySeverity.high + openBySeverity.medium + openBySeverity.low),
    openBySeverity,
    openByCategory,
    openByCheck,
  };
}

function sanitizeLedger(raw, seriesId) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.snapshots)) return emptyLedger(seriesId);
  return {
    schemaVersion: SCHEMA_VERSION,
    seriesId,
    snapshots: raw.snapshots.map(sanitizeSnapshot).filter(Boolean),
  };
}

async function readLedger(seriesId) {
  const raw = await readJSONFile(ledgerPath(seriesId), null);
  return raw == null ? emptyLedger(seriesId) : sanitizeLedger(raw, seriesId);
}

/**
 * Read the persisted revision-trend ledger for a series (never null — an empty
 * ledger when none has been recorded yet).
 */
export async function getTrendLedger(seriesId) {
  assertValidSeriesId(seriesId);
  return readLedger(seriesId);
}

/**
 * Record a revision-trend snapshot for a series from its CURRENT review state.
 * Called after each editorial-checks / completeness run (the run is the
 * revision boundary). Reads the freshest review, derives the open-finding
 * counts, and appends a snapshot.
 *
 * De-duped by `runId`: a second record for the SAME run id replaces its point
 * rather than doubling it (defensive — guards a route + its SSE runner both
 * firing for one invocation). NOTE this does NOT collapse a completeness pass and
 * an editorial-checks pass into one point — those mint independent run ids, so a
 * user who runs both in an editing cycle gets two trend points (completeness then
 * checks), which is intended: each is a distinct revision boundary. A null runId
 * always appends. The ledger is capped at MAX_TREND_SNAPSHOTS (oldest roll off).
 *
 * @param {string} seriesId
 * @param {object} [opts]
 *   - runId: the run that produced this revision (snapshot identity)
 *   - gate: readiness gate to stamp the snapshot's `ready` flag
 *   - comments: pre-loaded review comments (skips the getReview round-trip)
 * @returns {Promise<object>} the appended snapshot
 */
export async function recordTrendSnapshot(seriesId, { runId = null, gate = DEFAULT_READINESS_GATE, comments } = {}) {
  assertValidSeriesId(seriesId);
  const list = Array.isArray(comments) ? comments : (await getReview(seriesId)).comments;
  const health = computeHealth(list, gate);
  const snapshot = {
    runId: typeof runId === 'string' ? runId : null,
    at: nowIso(),
    score: health.score,
    ready: health.ready,
    open: health.open,
    openBySeverity: health.openBySeverity,
    openByCategory: health.openByCategory,
    openByCheck: health.openByCheck,
  };
  return queueLedgerWrite(seriesId, async () => {
    const ledger = await readLedger(seriesId);
    // De-dupe by runId: a re-entrant seed for the SAME run replaces its point
    // (so two write paths in one run — e.g. completeness then checks — don't
    // each leave a snapshot for the same runId). A null runId always appends.
    const kept = snapshot.runId
      ? ledger.snapshots.filter((s) => s.runId !== snapshot.runId)
      : ledger.snapshots;
    const next = {
      schemaVersion: SCHEMA_VERSION,
      seriesId,
      snapshots: [...kept, snapshot].slice(-MAX_TREND_SNAPSHOTS),
    };
    await atomicWrite(ledgerPath(seriesId), next);
    // Returned for callers/tests that want the appended point; the fire-and-forget
    // triggers ignore it.
    return snapshot;
  });
}

// ---------------------------------------------------------------------------
// Trend / regression projection (pure).
// ---------------------------------------------------------------------------

// Per-bucket regressions: every key whose open count is higher in `latest` than
// in `previous` (a bucket absent from `previous` counts as 0 prior). Shared by
// the per-category and per-check (#1597) regression projections so the two can
// never disagree on what "regressed" means. Returns `[{ [keyName], from, to }]`
// sorted by the size of the increase, descending.
function regressionsBetween(latest, previous, mapField, keyName) {
  const out = [];
  if (!latest || !previous) return out;
  for (const [key, to] of Object.entries(latest[mapField] || {})) {
    const from = previous[mapField]?.[key] || 0;
    if (to > from) out.push({ [keyName]: key, from, to });
  }
  return out.sort((a, b) => (b.to - b.from) - (a.to - a.from));
}

/**
 * Project a ledger's snapshots into a trend view: the score/open time-series
 * (each point also carrying its per-severity, per-category, and per-check open
 * counts so the UI can build per-bucket sparklines) plus per-category and
 * per-check REGRESSIONS (a bucket whose open-finding count rose between the two
 * most recent snapshots — i.e. it got WORSE after an edit pass). Pure so the
 * route + UI + tests share one definition.
 *
 * @param {Array} snapshots — the ledger's snapshots (chronological, oldest first)
 * @returns {{ points: [], regressions: [], checkRegressions: [], latest, previous, delta }}
 */
export function computeTrend(snapshots) {
  const list = Array.isArray(snapshots) ? snapshots.map(sanitizeSnapshot).filter(Boolean) : [];
  const points = list.map((s) => ({
    runId: s.runId,
    at: s.at,
    score: s.score,
    open: s.open,
    openBySeverity: s.openBySeverity,
    openByCheck: s.openByCheck,
  }));
  const latest = list[list.length - 1] || null;
  const previous = list.length >= 2 ? list[list.length - 2] : null;
  // Score delta between the two most recent revisions (positive = improving).
  const delta = latest && previous ? latest.score - previous.score : 0;
  const regressions = regressionsBetween(latest, previous, 'openByCategory', 'category');
  const checkRegressions = regressionsBetween(latest, previous, 'openByCheck', 'checkId');
  return { points, regressions, checkRegressions, latest, previous, delta };
}

/**
 * The full health payload for a series: the current score/breakdown, the
 * readiness signal, and the revision trend + regressions. The single read the
 * route + UI consume.
 */
export async function getSeriesHealth(seriesId, { gate = DEFAULT_READINESS_GATE } = {}) {
  assertValidSeriesId(seriesId);
  const [review, ledger] = await Promise.all([getReview(seriesId), readLedger(seriesId)]);
  const health = computeHealth(review.comments, gate);
  const trend = computeTrend(ledger.snapshots);
  return { seriesId, ...health, trend, generatedAt: nowIso() };
}

export const __testing = { sanitizeSnapshot, sanitizeLedger, MAX_TREND_SNAPSHOTS };
