/**
 * Layered Intelligence outcome store — closes the loop's feedback gap (#2428).
 *
 * Records every filed proposal and reconciles its outcome from live tracker state so `computeOutcomesReport`
 * (layeredIntelligence.js) can feed merge-rate statistics back into the reasoning prompt.
 *
 * Storage: a `createCollectionStore` collection at `data/cos/li-outcomes/`, one record per (app, slug), with a
 * per-record write queue. Records auto-gc after CLOSED_SUPPRESSION_MS (30 days), the dedup guard's window.
 *
 * Runs outside the request lifecycle (scheduler tick / agent completion), so the LI hooks own the async boundary;
 * helpers degrade a failed read/write to a recorded no-op and callers gate them behind `sources.outcomes`.
 */

import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { PROPOSAL_OUTCOMES, PROPOSAL_EXECUTION_OUTCOMES, CLOSED_SUPPRESSION_MS } from './layeredIntelligence/constants.js';
import { normalizeSlug } from './layeredIntelligence/dedup.js';
import { deriveOutcome } from './layeredIntelligence/outcomes.js';
import { readImplementingPrState } from './layeredIntelligence/forgeFiler.js';
import { classifyRejection, classifyPrFailure, isPrRefinableReason, isPrFailureReason, REJECTION_REASON_VALUES } from './layeredIntelligenceRejections.js';
import { classifyExecutionFailure, EXECUTION_FAILURE_VALUES } from './layeredIntelligenceExecutionFailures.js';

// Longest stored failure-signal token; bounds only hand-edited/corrupt values (real agentErrorAnalysis categories are far shorter).
const FAILURE_SIGNAL_MAX_LEN = 64;

// Where a record's `outcomeAt` came from: 'tracker' = real close time; 'observed' = synthesized from the reconcile
// clock (the `plan` tracker reports none), so only a lower bound on when the human decided.
export const OUTCOME_AT_SOURCES = ['tracker', 'observed'];

// Retention window; equals the dedup suppression window so a proposal stays reported exactly as long as it suppresses re-proposal.
export const OUTCOME_RETENTION_MS = CLOSED_SUPPRESSION_MS;

// On-disk layout version; bump only via a migration that changes the record directory shape.
export const LI_OUTCOMES_SCHEMA_VERSION = 1;

// Federated-task metadata key carrying a hand-off's per-proposal EXECUTION verdict. The executing peer stamps it (the payload
// `recordProposalExecution` consumes) into the terminal task; the originating peer derives `recordProposalExecution` from it
// (cosTaskStore.mergePeerTasks). Only this verdict rides the federated task; the li-outcomes collection is not federated.
// Additive metadata on an existing task shape, so no schema bump.
export const LI_EXECUTION_VERDICT_KEY = 'liExecution';

/**
 * Normalize one on-disk outcome record. Drops anything without a usable appId+slug, coerces the outcome to a known
 * value or null and defaults timestamps. Returning null makes collectionStore treat the row as invalid.
 *
 * `rejectionReason` is three-valued, because the field exists to MEASURE undiagnosed history:
 *   - `null`             — not classified (merged, unresolved or pre-field); reconcile treats it as work to do.
 *   - `'unknown-reason'` — classified, no signal explained it; deliberate, NOT re-derived every run.
 *   - a taxonomy token   — classified with a supporting signal.
 * An unrecognized token coerces to `null` so a hand-edited or future value re-classifies instead of becoming a fake
 * "looked and found nothing".
 */
export function sanitizeOutcomeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appId = typeof raw.appId === 'string' ? raw.appId.trim() : '';
  const slug = normalizeSlug(raw.slug);
  if (!appId || !slug) return null;
  const outcome = PROPOSAL_OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  // A merged proposal has no rejection to explain; a stray token would inflate the rejection tally.
  const rejectable = outcome === 'rejected' || outcome === 'abandoned';
  return {
    appId,
    slug,
    tracker: typeof raw.tracker === 'string' ? raw.tracker : null,
    issueRef: typeof raw.issueRef === 'string' ? raw.issueRef : (raw.issueRef != null ? String(raw.issueRef) : null),
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    filedAt: typeof raw.filedAt === 'string' ? raw.filedAt : null,
    outcome,
    outcomeAt: outcome && typeof raw.outcomeAt === 'string' ? raw.outcomeAt : null,
    // Provenance of `outcomeAt`: approval-funnel metrics need WHEN the human decided, which only a tracker-reported close
    // time says. `plan` reports none, so reconcileOutcomes synthesizes one from the reconcile clock.
    //   - `'tracker'`  — real close time; authoritative.
    //   - `'observed'` — synthesized; a LOWER BOUND, excluded from window/latency math.
    //   - `null`       — unrecognized or pre-field; the funnel treats legacy as `tracker` (forge/jira always report
    //     `closedAt`) rather than blank the metric on every install. They age out within the 30-day retention.
    outcomeAtSource: outcome && OUTCOME_AT_SOURCES.includes(raw.outcomeAtSource) ? raw.outcomeAtSource : null,
    outcomeReason: outcome && typeof raw.outcomeReason === 'string' ? raw.outcomeReason : null,
    rejectionReason: rejectable && REJECTION_REASON_VALUES.includes(raw.rejectionReason) ? raw.rejectionReason : null,
    // Implementing-PR number (positive integer or null; additive, no migration), used to classify
    // `merge-conflict`/`validation-failed`. Kept regardless of outcome; a non-int reads as null.
    implementingPr: Number.isInteger(raw.implementingPr) && raw.implementingPr > 0 ? raw.implementingPr : null,
    // EXECUTION record, orthogonal to `outcome` (the filing fate): whether LI's coding agent implemented the proposal.
    // `null` = not handed off / not executed; unrecognized tokens coerce to null. `executionAt` is kept only with a real executionOutcome.
    executionOutcome: PROPOSAL_EXECUTION_OUTCOMES.includes(raw.executionOutcome) ? raw.executionOutcome : null,
    executionAt: PROPOSAL_EXECUTION_OUTCOMES.includes(raw.executionOutcome) && typeof raw.executionAt === 'string' ? raw.executionAt : null,
    // Execution-FAILURE taxonomy, populated only for a FAILED execution (a stray token elsewhere would inflate the tally):
    //   - `failureCategory` — an EXECUTION_FAILURE_VALUES token or null; unrecognized values coerce to null (re-derivable).
    //   - `failureSignal` — the raw agentErrorAnalysis `category` it was derived from; a short controlled token, bounded; null if none.
    failureCategory: raw.executionOutcome === 'failure' && EXECUTION_FAILURE_VALUES.includes(raw.failureCategory) ? raw.failureCategory : null,
    failureSignal: raw.executionOutcome === 'failure' && typeof raw.failureSignal === 'string' && raw.failureSignal.trim()
      ? raw.failureSignal.trim().slice(0, FAILURE_SIGNAL_MAX_LEN)
      : null
  };
}

// Composite id, one row per (app, slug): appId is `[A-Za-z0-9_-]+` and slug kebab, so it is a valid collectionStore id (sliced to its 128-char ceiling defensively).
function outcomeId(appId, slug) {
  return `${appId}--${slug}`.slice(0, 128);
}

let _store = null;
/** Lazily construct the singleton outcome store so importing this module builds no store or touches PATHS. */
export function outcomesStore() {
  if (!_store) {
    _store = createCollectionStore({
      dir: join(PATHS.cos, 'li-outcomes'),
      type: 'li-outcomes',
      schemaVersion: LI_OUTCOMES_SCHEMA_VERSION,
      sanitizeRecord: sanitizeOutcomeRecord
    });
  }
  return _store;
}

// `saveOne` never writes the type-level index.json (which stamps schemaVersion) and this store ships no migration,
// so stamp it on first write; WeakSet-guarded to once per process.
const _stamped = new WeakSet();
async function ensureTypeIndex(store) {
  if (_stamped.has(store)) return;
  _stamped.add(store);
  await store.saveTypeIndex({}).catch(() => { _stamped.delete(store); });
}

/**
 * Record a freshly-filed proposal (outcome unknown). Idempotent per (app, slug): a re-file resets `filedAt` and clears
 * the outcome. Best-effort — a write failure logs and returns false.
 */
export async function recordFiledProposal({ appId, slug, tracker = null, issueRef = null, scope = null, now = Date.now() } = {}, store = outcomesStore()) {
  const normSlug = normalizeSlug(slug);
  if (!appId || !normSlug) return false;
  const record = {
    appId,
    slug: normSlug,
    tracker,
    issueRef: issueRef != null ? String(issueRef) : null,
    scope,
    filedAt: new Date(now).toISOString(),
    outcome: null,
    outcomeAt: null,
    // No decision yet, so nothing to attribute a decision timestamp to (#3120).
    outcomeAtSource: null,
    outcomeReason: null,
    // Unresolved: nothing has rejected it yet, so there is nothing to diagnose.
    rejectionReason: null,
    // Learned at reconcile time; unknown at filing.
    implementingPr: null,
    // Not executed yet (set by recordProposalExecution).
    executionOutcome: null,
    executionAt: null,
    // No execution has failed yet, so there is no failure to diagnose (#2764 §1).
    failureCategory: null,
    failureSignal: null
  };
  await ensureTypeIndex(store);
  const ok = await store.saveOne(outcomeId(appId, normSlug), record).then(() => true, (err) => {
    console.error(`❌ Layered Intelligence: failed to record outcome for ${appId}/${normSlug}: ${err.message}`);
    return false;
  });
  return ok;
}

/**
 * Record the EXECUTION outcome of a handed-off proposal: stamp whether LI's coding agent succeeded, keyed to (app, slug), so
 * computeExecutionByDomain can group by scope. Merges over the filed record; if it is gone (GC'd or the filing write failed)
 * a minimal record is created from the passed scope. `success` must be a strict boolean (else false, no write).
 * Best-effort: a write failure logs and returns false. The CALLER must filter environmental failures (they say nothing
 * about the domain, same gate as #2618).
 */
export async function recordProposalExecution({ appId, slug, scope = null, success, errorCategory = null, validationPassed = null, requireExisting = false, executedAt = null, now = Date.now() } = {}, store = outcomesStore()) {
  const normSlug = normalizeSlug(slug);
  if (!appId || !normSlug || typeof success !== 'boolean') return false;
  const id = outcomeId(appId, normSlug);
  // Completion time; the federated consume passes the verdict's `executedAt` so idempotency can compare it, the local path uses `now`.
  const executionAtIso = (typeof executedAt === 'string' && executedAt) ? executedAt : new Date(now).toISOString();
  const executionAtMs = Date.parse(executionAtIso);
  // Domain to adopt when none is stored; load-bearing for per-domain aggregation.
  const normScope = typeof scope === 'string' && scope.trim() ? scope.trim() : null;
  // The classifier owns the null-on-success rule. `failureSignal` keeps the raw category even when it maps to no taxonomy
  // token so a later reconcile can re-classify; classification is pure with no provider call (no cold-bootstrap LLM).
  const failureCategory = classifyExecutionFailure({ success, errorCategory, validationPassed });
  const failureSignal = success ? null : (typeof errorCategory === 'string' && errorCategory.trim() ? errorCategory.trim() : null);
  await ensureTypeIndex(store);
  // Fence the read-modify-write in the per-id write queue: a bare loadOne→saveOne would let a concurrent reconcileOutcomes
  // write on the same slug clobber either side. Re-reading inside the fence composes both (reconcile uses the same fence).
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id).catch(() => null);
    const hasExisting = existing && typeof existing === 'object';
    // Cross-peer consume gate: only the originating peer (the one that filed it and holds the record) records a synced
    // verdict; `requireExisting` makes it a no-op on peers that merely adopted the terminal task.
    if (!hasExisting && requireExisting) return false;
    // Stale-filing-generation gate: a re-file after the dedup window stamps a fresh `filedAt` and clears execution fields, but
    // the old terminal task is re-offered on every merge. An execution can only follow its filing, so a verdict whose
    // `executedAt` predates `filedAt` is a prior generation. The 30-day gap dwarfs clock skew, so strict `<` is safe.
    if (requireExisting && hasExisting && existing.filedAt) {
      const filedMs = Date.parse(existing.filedAt);
      if (Number.isFinite(filedMs) && Number.isFinite(executionAtMs) && executionAtMs < filedMs) return false;
    }
    // Durable idempotency for the federated consume: the record's own executionOutcome/executionAt is the consumed-marker, so
    // a re-synced terminal task is a no-op without relying on the in-memory status transition. Only skip when the stored
    // execution is at least as new (a newer re-execution overwrites). The marker lives in THIS peer's unfederated record. Federated path only; local always overwrites.
    if (requireExisting && hasExisting && existing.executionOutcome && existing.executionAt) {
      const storedMs = Date.parse(existing.executionAt);
      if (Number.isFinite(storedMs) && Number.isFinite(executionAtMs) && executionAtMs <= storedMs) return false;
    }
    const base = hasExisting
      ? existing
      : {
          appId, slug: normSlug, tracker: null, issueRef: null,
          scope: normScope,
          filedAt: new Date(now).toISOString(),
          outcome: null, outcomeAt: null, outcomeAtSource: null, outcomeReason: null, rejectionReason: null,
          implementingPr: null
        };
    const next = {
      ...base,
      // Preserve the filed scope; otherwise adopt the hook's domain (missing-record fallback).
      scope: (typeof base.scope === 'string' && base.scope.trim()) ? base.scope : normScope,
      executionOutcome: success ? 'success' : 'failure',
      executionAt: executionAtIso,
      // Always set the failure diagnosis so a success overwrites stale failure fields from an earlier failed run.
      failureCategory,
      failureSignal
    };
    await store.saveOneNow(id, next);
    return true;
  }).catch((err) => {
    console.error(`❌ Layered Intelligence: failed to record execution outcome for ${appId}/${normSlug}: ${err.message}`);
    return false;
  });
}

/**
 * Derive `recordProposalExecution` from a hand-off task's federated EXECUTION verdict (`LI_EXECUTION_VERDICT_KEY`
 * metadata stamped by the executing peer) on the originating peer.
 *
 * `requireExisting: true`: only a peer that FILED the proposal records it. Idempotency is durable and record-level
 * (recordProposalExecution skips a verdict no newer than the stored executionAt), so mergePeerTasks can re-offer every
 * terminal verdict each sweep while a newer `executedAt` still overwrites. Invalid/foreign verdicts are dropped; never throws.
 */
export async function recordProposalExecutionFromVerdict(verdict, store = outcomesStore()) {
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) return false;
  const { appId, slug, scope = null, success, errorCategory = null, validationPassed = null, executedAt = null } = verdict;
  if (typeof success !== 'boolean') return false;
  return recordProposalExecution(
    { appId, slug, scope, success, errorCategory, validationPassed, executedAt, requireExisting: true },
    store
  );
}

/**
 * Load this app's outcome records, GC-ing stale ones so the store stays bounded (mirrors isIssueWithinDedupWindow): an
 * UNRESOLVED record is kept indefinitely like an open issue; a RESOLVED one expires OUTCOME_RETENTION_MS after `outcomeAt`.
 * Returns survivors newest-filed-first. Never throws. Use `listOutcomesResult` when a FAILED read must be distinguishable
 * from an empty history; this wrapper flattens them.
 */
export async function listOutcomes(args = {}, store = outcomesStore()) {
  return (await listOutcomesResult(args, store)).outcomes;
}

/**
 * `listOutcomes` with a discriminated read status:
 *   `{ read: true,  outcomes }`  — read cleanly; empty means nothing was ever filed.
 *   `{ read: false, outcomes: [] }` — the store could NOT be read.
 *   `{ read: false, partial: true, outcomes, failedIds }` — some records failed to load (corrupt/sanitizer-rejected);
 *       the loaded ones are returned for the best-effort flatten path but the list is an untrustworthy undercount.
 *
 * Load-bearing for selfEval: a flattened or short list would tell the reasoner it never filed a proposal and invite
 * re-filing. A partial read is not a clean `read: true` (same sentinel rule as readLiTaskMetrics). Built on
 * `collectionStore.loadAllResult`, which surfaces the `failedIds` `loadAll` drops.
 */
export async function listOutcomesResult({ appId, now = Date.now() } = {}, store = outcomesStore()) {
  // No appId is a caller bug, not a store failure: return an empty successful read.
  if (!appId) return { read: true, outcomes: [] };
  const result = await store.loadAllResult().catch(() => null);
  if (!result || !Array.isArray(result.records)) return { read: false, outcomes: [] };
  const failedIds = Array.isArray(result.failedIds) ? result.failedIds : [];
  const mine = result.records.filter(r => r && r.appId === appId);
  const kept = [];
  for (const r of mine) {
    if (r.outcome) {
      const resolvedMs = Date.parse(r.outcomeAt) || Date.parse(r.filedAt) || NaN;
      if (Number.isFinite(resolvedMs) && (now - resolvedMs) > OUTCOME_RETENTION_MS) {
        await store.deleteOne(outcomeId(r.appId, r.slug)).catch(() => {});
        continue;
      }
    }
    kept.push(r);
  }
  const outcomes = kept.sort((a, b) => (Date.parse(b.filedAt) || 0) - (Date.parse(a.filedAt) || 0));
  // A corrupt record makes the list an untrustworthy undercount, so signal partial (read:false).
  if (failedIds.length > 0) return { read: false, partial: true, outcomes, failedIds };
  return { read: true, outcomes };
}

/**
 * Reconcile outcome records against a FRESH tracker read: when the tracker reports a record's issue closed, persist the
 * derived outcome (`merged` / `rejected` / `abandoned`); open issues never resolve or flip a record. A stored outcome
 * that DIFFERS from the live derivation is reclassified (#2620, self-healing the old any-close-is-merged mapping and
 * reopen/re-close), and a re-close to the SAME outcome with a newer `closedAt` refreshes it so retention (keyed on
 * `outcomeAt`) measures from the latest closure. Returns the number updated. Never throws; one bad row can't abort the rest.
 *
 * With a forge handle (`cli`/`cwd`), a non-merged proposal with an `implementingPr` the free signals left undiagnosed
 * gets ONE bounded `gh pr view` read (`readPrState`, injectable for tests) to classify `merge-conflict`/`validation-failed`.
 */
export async function reconcileOutcomes({ appId, existingIssues = [], now = Date.now(), cli = null, cwd = null, env = undefined, readPrState = readImplementingPrState } = {}, store = outcomesStore()) {
  if (!appId || !Array.isArray(existingIssues) || existingIssues.length === 0) return 0;
  // Index existing issues by normalized slug for O(1) lookup.
  const bySlug = new Map();
  for (const issue of existingIssues) {
    const slug = normalizeSlug(issue?.slug);
    if (slug && !bySlug.has(slug)) bySlug.set(slug, issue);
  }
  const records = await listOutcomes({ appId, now }, store);
  let updated = 0;
  for (const r of records) {
    const issue = bySlug.get(r.slug);
    if (!issue) continue;
    const outcome = deriveOutcome(issue);
    if (!outcome) continue;
    // Diagnose why a non-merged proposal ended, from issue rows already in hand (no extra tracker call); merged/unresolved → null.
    // `closingComment` is the last-resort signal for prose-only closes; forges without comments pass null.
    const base = {
      outcome,
      stateReason: issue.stateReason,
      labels: issue.labels,
      closingComment: issue.closingComment
    };
    let rejectionReason = classifyRejection(base);
    // Read the implementing PR's merge state/checks only when it could change the answer (a PR ref exists, gh-only, and the free
    // signals left a generic reason); a label/specific close-reason/prose rationale already wins and skips the read.
    const implementingPr = Number.isInteger(issue.implementingPr) && issue.implementingPr > 0 ? issue.implementingPr : null;
    if (implementingPr && cli && isPrRefinableReason(rejectionReason)) {
      if (isPrFailureReason(r.rejectionReason) && r.implementingPr === implementingPr) {
        // Already diagnosed from THIS SAME PR and not superseded by the free signals: keep it rather than re-spawn `gh pr view`
        // every tick for the 30-day retention (this also stops the write-guard below downgrading the stored PR token). If the
        // issue was re-linked to a different PR the old diagnosis no longer applies; fall through and read the replacement.
        rejectionReason = r.rejectionReason;
      } else {
        const prView = await readPrState({ cli, cwd, env, number: implementingPr }).catch(() => null);
        const prFailure = classifyPrFailure(prView);
        if (prFailure) rejectionReason = classifyRejection({ ...base, prFailure });
      }
    }
    // Rewrite a same-outcome record only on a NEWER close time (outcomeAt drives retention/GC); timestampless trackers
    // and an unchanged closedAt skip the write.
    const closedMs = Date.parse(issue.closedAt);
    const storedMs = Date.parse(r.outcomeAt);
    const newerClose = Number.isFinite(closedMs) && (!Number.isFinite(storedMs) || closedMs > storedMs);
    // A changed classification is itself a reason to rewrite (backfills pre-taxonomy nulls, re-diagnoses `unknown-reason`
    // once labeled); comparing to the stored token avoids churn. Learning the implementing-PR ref also rewrites, preferring
    // the freshly-read ref so a re-linked PR updates.
    const nextImplementingPr = implementingPr ?? (r.implementingPr ?? null);
    if (outcome === r.outcome && rejectionReason === r.rejectionReason && nextImplementingPr === (r.implementingPr ?? null) && !newerClose) continue;
    const id = outcomeId(appId, r.slug);
    // Fence in the same per-id queue as recordProposalExecution and re-read INSIDE it: `records` came from an upfront read, so a
    // hand-off completion written since would be clobbered by a stale `{...r}`. Recomputed fields come from `issue`, not `fresh`.
    const ok = await store.queueRecordWrite(id, async () => {
      const fresh = (await store.loadOne(id).catch(() => null)) || r;
      // Only a tracker `closedAt` dates the human's decision; otherwise the reconcile clock is a LOWER BOUND, so stamp provenance
      // alongside it so approval-funnel metrics exclude it. A stored timestamp keeps its provenance.
      const outcomeAt = issue.closedAt || fresh.outcomeAt || new Date(now).toISOString();
      const outcomeAtSource = issue.closedAt
        ? 'tracker'
        : (fresh.outcomeAt ? (fresh.outcomeAtSource ?? null) : 'observed');
      const next = {
        ...fresh,
        outcome,
        outcomeAt,
        outcomeAtSource,
        outcomeReason: issue.stateReason || 'auto-derived from tracker state',
        rejectionReason,
        implementingPr: nextImplementingPr
      };
      await store.saveOneNow(id, next);
      return true;
    }).catch(() => false);
    if (ok) updated += 1;
  }
  return updated;
}
