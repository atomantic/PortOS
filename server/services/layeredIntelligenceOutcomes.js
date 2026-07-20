/**
 * Layered Intelligence outcome store — closes the loop's feedback gap (#2428).
 *
 * The LI reasoner files improvement proposals as tracker issues but historically
 * never read back whether those proposals were merged, rejected, or abandoned —
 * so it proposed in a vacuum, re-suggesting scopes with a 0% adoption rate. This
 * store records every filed proposal and reconciles its outcome from the live
 * tracker state, so `computeOutcomesReport` (in layeredIntelligence.js) can feed
 * merge-rate statistics back into the reasoning prompt.
 *
 * Storage: a `createCollectionStore` collection at `data/cos/li-outcomes/`, one
 * record per (app, slug). Per-record write queue → concurrent apps' outcomes
 * never clobber each other. Records auto-gc after CLOSED_SUPPRESSION_MS (30 days)
 * so the store stays bounded — the same window the dedup guard already uses.
 *
 * Runs OUTSIDE the request lifecycle (scheduler tick / agent completion), so per
 * the CLAUDE.md no-try/catch rule the LI hooks own the async boundary; these
 * helpers stay defensive (a failed read/write degrades to a recorded no-op) and
 * are gated behind the `sources.outcomes` config toggle by their callers.
 */

import { join } from 'path';
import { PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';
import { normalizeSlug, deriveOutcome, readImplementingPrState, PROPOSAL_OUTCOMES, PROPOSAL_EXECUTION_OUTCOMES, CLOSED_SUPPRESSION_MS } from './layeredIntelligence.js';
import { classifyRejection, classifyPrFailure, isPrRefinableReason, isPrFailureReason, REJECTION_REASON_VALUES } from './layeredIntelligenceRejections.js';
import { classifyExecutionFailure, EXECUTION_FAILURE_VALUES } from './layeredIntelligenceExecutionFailures.js';

// Longest raw failure-signal token stored on a record. The signal is one of
// agentErrorAnalysis's controlled `category` tokens (e.g. `test-failure`), so this
// only bounds a hand-edited/corrupt value — the real tokens are far shorter.
const FAILURE_SIGNAL_MAX_LEN = 64;

// The report/retention window. Reuses the dedup suppression window so a proposal
// stays in the outcome report exactly as long as it still suppresses re-proposal —
// the two "LI remembers this" windows move in lockstep.
export const OUTCOME_RETENTION_MS = CLOSED_SUPPRESSION_MS;

// The collection's on-disk layout version. Bump only via a migration that
// changes the record directory shape (there is none yet).
export const LI_OUTCOMES_SCHEMA_VERSION = 1;

/**
 * Normalize one on-disk outcome record. Drops anything without a usable
 * appId+slug (the identity), coerces the outcome to a known value or null, and
 * defaults the timestamps. Returning null makes collectionStore treat the row as
 * invalid (loadOne → null), so a hand-corrupted file can't poison the report.
 *
 * `rejectionReason` (#2689) carries the structured diagnosis and is deliberately
 * three-valued — the sentinel rule, which matters here because the whole point of
 * the field is to MEASURE how much history is undiagnosed:
 *   - `null`             — not classified (a merged record, an unresolved one, or
 *                          a record written before this field existed). Reconcile
 *                          treats it as work to do.
 *   - `'unknown-reason'` — classified, and no signal explained the rejection. A
 *                          real, deliberate answer; NOT re-derived every run.
 *   - a taxonomy token   — classified with a supporting signal.
 * An unrecognized token coerces to `null` rather than `'unknown-reason'`, so a
 * hand-edited or future-version value re-classifies on the next reconcile instead
 * of being laundered into a fake "we looked and found nothing".
 */
export function sanitizeOutcomeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const appId = typeof raw.appId === 'string' ? raw.appId.trim() : '';
  const slug = normalizeSlug(raw.slug);
  if (!appId || !slug) return null;
  const outcome = PROPOSAL_OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  // A merged proposal has no rejection to explain, so its slot stays null however
  // the file reads — a stray token there would inflate the rejection tally.
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
    outcomeReason: outcome && typeof raw.outcomeReason === 'string' ? raw.outcomeReason : null,
    rejectionReason: rejectable && REJECTION_REASON_VALUES.includes(raw.rejectionReason) ? raw.rejectionReason : null,
    // Implementing-PR handle (#2748, deliverable 2) — the number of the PR that was
    // meant to implement this proposal, so a later reconcile can read its merge
    // state/checks and classify `merge-conflict`/`validation-failed`. Additive with a
    // null default (no record-shape migration): a positive integer or null. Kept
    // regardless of outcome — it is a fact about the proposal, and a merged proposal's
    // PR ref is harmless — so a coerced non-int/absent value simply reads as null.
    implementingPr: Number.isInteger(raw.implementingPr) && raw.implementingPr > 0 ? raw.implementingPr : null,
    // Per-proposal-domain EXECUTION record (#2765) — orthogonal to `outcome` (the
    // FILING fate): whether LI's own coding agent implemented the proposal after the
    // Engine-A hand-off. `null` = never handed off / not yet executed; a token only
    // when it is a recognized execution outcome, so a hand-edited/future value coerces
    // to null (re-derivable on the next run) rather than a fake result. `executionAt`
    // is kept only alongside a real executionOutcome.
    executionOutcome: PROPOSAL_EXECUTION_OUTCOMES.includes(raw.executionOutcome) ? raw.executionOutcome : null,
    executionAt: PROPOSAL_EXECUTION_OUTCOMES.includes(raw.executionOutcome) && typeof raw.executionAt === 'string' ? raw.executionAt : null,
    // Execution-FAILURE taxonomy (#2764 §1) — the structured "why" for a failed
    // hand-off, orthogonal to the binary executionOutcome above. Both fields are
    // three-valued in the same spirit as rejectionReason, and only ever populated
    // for a FAILED execution (a success/unresolved has nothing to diagnose, so a
    // stray token there would inflate the failure tally):
    //   - `failureCategory` — an EXECUTION_FAILURE_VALUES token, or null. An
    //     unrecognized/future token coerces to null (re-derivable on the next
    //     execution write) rather than being laundered into a fake `unknown-failure`.
    //   - `failureSignal` — the raw agentErrorAnalysis `category` the classification
    //     was derived from (the root-cause signal #2764 §1 asks to keep), a short
    //     controlled token bounded defensively; null when none was captured.
    failureCategory: raw.executionOutcome === 'failure' && EXECUTION_FAILURE_VALUES.includes(raw.failureCategory) ? raw.failureCategory : null,
    failureSignal: raw.executionOutcome === 'failure' && typeof raw.failureSignal === 'string' && raw.failureSignal.trim()
      ? raw.failureSignal.trim().slice(0, FAILURE_SIGNAL_MAX_LEN)
      : null
  };
}

// Composite record id — one row per (app, slug). appId matches the app-id regex
// (`[A-Za-z0-9_-]+`) and slug is normalized kebab, so the joined id is always a
// valid collectionStore id; sliced to the store's 128-char ceiling defensively.
function outcomeId(appId, slug) {
  return `${appId}--${slug}`.slice(0, 128);
}

let _store = null;
/**
 * Lazily construct the singleton outcome collection store. Lazy so the module
 * graph doesn't build a store (and touch PATHS) at import time; the boot-time
 * verifier in server/index.js and the LI hooks both call this.
 */
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

// `saveOne` writes the per-record file but never the type-level index.json (the
// slot that stamps schemaVersion). Since this store ships with no migration to
// create it, stamp it on the first write so the boot verifier reports the real
// version and a future schemaVersion bump can detect existing v1 data. Guarded
// per store instance (WeakSet) so it runs once per process, not on every record.
const _stamped = new WeakSet();
async function ensureTypeIndex(store) {
  if (_stamped.has(store)) return;
  _stamped.add(store);
  await store.saveTypeIndex({}).catch(() => { _stamped.delete(store); });
}

/**
 * Record a freshly-filed proposal (outcome unknown). Idempotent per (app, slug):
 * a re-file overwrites the row with a fresh `filedAt` and clears the outcome, so
 * a re-opened proposal is tracked from its newest filing. Best-effort — a write
 * failure logs and returns false rather than throwing into the LI hook.
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
    outcomeReason: null,
    // Unresolved: nothing has rejected it yet, so there is nothing to diagnose.
    rejectionReason: null,
    // Learned at reconcile time from the tracker's closedByPullRequestsReferences
    // (#2748, deliverable 2); unknown at filing.
    implementingPr: null,
    // Not executed yet — set only if this proposal is later handed off and its agent
    // run completes (recordProposalExecution, #2765).
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
 * Record the EXECUTION outcome of a handed-off proposal (#2765): once LI's own
 * coding agent finishes implementing a proposal it filed, stamp whether the run
 * succeeded, keyed to the proposal's (app, slug) — so computeExecutionByDomain can
 * later group these by the proposal's domain (scope). Merges over the existing filed
 * record (preserving its filing outcome, scope, and refs); if the record is gone
 * (GC'd, or the filing write failed) a minimal record is created from the passed
 * scope so the execution signal isn't silently lost. `success` must be a strict
 * boolean — a non-boolean is a caller bug and returns false without writing.
 * Best-effort: a write failure logs and returns false rather than throwing into the
 * completion hook. Environmental failures must be filtered by the CALLER (they say
 * nothing about the domain — same gate as #2618); this helper records whatever it is
 * given.
 */
export async function recordProposalExecution({ appId, slug, scope = null, success, errorCategory = null, validationPassed = null, now = Date.now() } = {}, store = outcomesStore()) {
  const normSlug = normalizeSlug(slug);
  if (!appId || !normSlug || typeof success !== 'boolean') return false;
  const id = outcomeId(appId, normSlug);
  // The domain to adopt when we don't already have one — the load-bearing field for
  // per-domain aggregation. Normalized once and reused by both the missing-record
  // fallback and the scope-preservation merge below.
  const normScope = typeof scope === 'string' && scope.trim() ? scope.trim() : null;
  // Diagnose WHY a failed hand-off failed (#2764 §1) from the failure signal the
  // caller already computed. The classifier owns the null-on-success rule (it
  // returns null unless success is strictly false), so no outer guard here.
  // `failureSignal` keeps the raw category (root-cause signal) even when it doesn't
  // map to a taxonomy token, so a later reconcile could re-classify without
  // re-running the task. Classification is deterministic and pure — no provider
  // round-trip (the "no cold-bootstrap LLM" policy).
  const failureCategory = classifyExecutionFailure({ success, errorCategory, validationPassed });
  const failureSignal = success ? null : (typeof errorCategory === 'string' && errorCategory.trim() ? errorCategory.trim() : null);
  await ensureTypeIndex(store);
  // Fence the whole read-modify-write in the per-id write queue (#2765, codex P2). A bare
  // loadOne→saveOne lets a concurrent reconcileOutcomes write on the same slug interleave
  // between our read and write and clobber either the executionOutcome we're setting or
  // the reconciled filing outcome. queueRecordWrite tail-chains per id, so re-reading
  // INSIDE the fence sees the other write path's committed record and the two compose
  // (reconcile uses the same fence). Best-effort — a failure logs and returns false
  // rather than throwing into the completion hook.
  return store.queueRecordWrite(id, async () => {
    const existing = await store.loadOne(id).catch(() => null);
    const base = existing && typeof existing === 'object'
      ? existing
      : {
          appId, slug: normSlug, tracker: null, issueRef: null,
          scope: normScope,
          filedAt: new Date(now).toISOString(),
          outcome: null, outcomeAt: null, outcomeReason: null, rejectionReason: null,
          implementingPr: null
        };
    const next = {
      ...base,
      // Preserve the filed scope when the record already carries one; otherwise adopt
      // the domain the completion hook passed (a missing-record fallback).
      scope: (typeof base.scope === 'string' && base.scope.trim()) ? base.scope : normScope,
      executionOutcome: success ? 'success' : 'failure',
      executionAt: new Date(now).toISOString(),
      // Set the failure diagnosis (#2764 §1) unconditionally so a success overwrites
      // any stale failure fields from a prior failed run that later re-ran and passed.
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
 * Load this app's outcome records, GC-ing stale ones from disk so the store stays
 * bounded. GC mirrors the dedup window (isIssueWithinDedupWindow): an UNRESOLVED
 * record (outcome still null) is kept indefinitely — like an open issue — so a
 * proposal that stays open past the window can still be learned once it finally
 * closes. A RESOLVED record expires OUTCOME_RETENTION_MS after its resolution
 * (outcomeAt), not its filing, so a long-open-then-merged proposal isn't dropped
 * the moment it resolves. Returns survivors sorted newest-filed-first. Never throws.
 *
 * Prefer `listOutcomesResult` when the caller must be able to tell a FAILED store
 * read from a genuinely empty history — this wrapper flattens the two together for
 * back-compat with callers that can't act on the difference anyway.
 */
export async function listOutcomes(args = {}, store = outcomesStore()) {
  return (await listOutcomesResult(args, store)).outcomes;
}

/**
 * `listOutcomes` with a discriminated read status (#2700, #2728):
 *   `{ read: true,  outcomes: [...] }`                       — the store was read
 *       cleanly; the list is the truth (an empty one means nothing was ever filed).
 *   `{ read: false, outcomes: [] }`                          — the store could NOT
 *       be read at all (a total failure).
 *   `{ read: false, partial: true, outcomes: [...], failedIds: [...] }` — the store
 *       was read but ONE OR MORE records failed to load (corrupt/unparseable/
 *       sanitizer-rejected). The `outcomes` we DID load are returned for the
 *       best-effort flatten path, but `read` is false because the list is an
 *       untrustworthy undercount.
 *
 * The distinction is load-bearing for selfEval, which reports LI's merge rate to the
 * reasoner: a corrupt/unreadable store flattened to `[]` (or silently short) would
 * tell the loop "you have never filed a proposal" (or fewer than you did) and invite
 * it to re-file work it already filed, on evidence that doesn't exist. Same sentinel
 * rule as readLiTaskMetrics — a partial read is NOT a clean `read: true`, so a
 * single corrupt record taints the whole read (we can't know which app's history it
 * belonged to). Built on `collectionStore.loadAllResult` (#2728), which surfaces the
 * `failedIds` `loadAll` throws away.
 */
export async function listOutcomesResult({ appId, now = Date.now() } = {}, store = outcomesStore()) {
  // No appId is a caller bug, not a store failure: nothing was asked for, so the
  // honest answer is an empty (successful) read, not "the store is broken".
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
  // A corrupt record makes the surviving list an untrustworthy undercount — signal
  // partial (read:false) so callers reasoning over the whole history don't treat a
  // short list as "these are all the proposals ever filed".
  if (failedIds.length > 0) return { read: false, partial: true, outcomes, failedIds };
  return { read: true, outcomes };
}

/**
 * Reconcile outcome records against a FRESH tracker read. For each stored record,
 * find the matching existing issue (by slug) and, when the tracker now reports it
 * closed, persist the derived outcome (`merged` / `rejected` / `abandoned`). Open
 * issues never resolve — or flip back — a record. A record whose stored outcome
 * DIFFERS from what the live closed state derives is reclassified (#2620): this
 * self-heals records persisted under the old any-close-is-merged mapping (e.g.
 * `merged` with a duplicate-close reason) instead of letting them inflate the
 * merge rate until they expire, and it tracks a reopened-then-re-closed issue's
 * latest fate. A re-close to the SAME outcome with a newer `closedAt` also
 * refreshes the record, so retention/GC (which keys on `outcomeAt`) measures
 * from the latest closure, not the first. Returns the number of records
 * updated. Never throws — a per-record write failure is swallowed so one bad
 * row can't abort the whole reconciliation.
 *
 * When a forge handle (`cli`/`cwd`) is supplied, a non-merged proposal that carries
 * an `implementingPr` ref and was left undiagnosed by the free signals gets ONE
 * bounded `gh pr view` read (`readPrState`, gh-only) to classify
 * `merge-conflict`/`validation-failed` from the implementing PR's merge state/checks
 * (#2748, deliverable 2). `readPrState` is injectable so tests never hit the network.
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
    // Diagnose WHY a non-merged proposal ended that way (#2689). Derived from the
    // issue rows the reconciler already has, so classification costs no extra
    // tracker call. Merged/unresolved → null. `closingComment` (#2748) is the
    // deterministic last-resort signal for a close stated only in prose; forges
    // that don't surface comments simply pass null.
    const base = {
      outcome,
      stateReason: issue.stateReason,
      labels: issue.labels,
      closingComment: issue.closingComment
    };
    let rejectionReason = classifyRejection(base);
    // Implementing-PR failure refinement (#2748, deliverable 2). Only read the PR's
    // merge state/checks when it could actually change the answer: there is a PR ref
    // (gh-only), and the free signals left the proposal on a generic/undiagnosed
    // reason a mechanical PR fact is allowed to sharpen. This bounds the one extra
    // tracker fetch classification makes to the small set of records it can move — a
    // label / specific close-reason / prose rationale already wins and skips the read.
    const implementingPr = Number.isInteger(issue.implementingPr) && issue.implementingPr > 0 ? issue.implementingPr : null;
    if (implementingPr && cli && isPrRefinableReason(rejectionReason)) {
      if (isPrFailureReason(r.rejectionReason)) {
        // Already diagnosed from THIS PR on a prior tick, and the free signals still
        // don't supersede it — a new authoritative label/close-reason would have made
        // the free classification specific (not refinable), taking the branch above.
        // Keep the settled diagnosis instead of re-spawning `gh pr view` on every tick
        // for the record's whole 30-day retention (codex P2). Preserving it here (rather
        // than just skipping the fetch) also stops the write-guard below from downgrading
        // the stored PR token back to the generic free reason.
        rejectionReason = r.rejectionReason;
      } else {
        const prView = await readPrState({ cli, cwd, env, number: implementingPr }).catch(() => null);
        const prFailure = classifyPrFailure(prView);
        if (prFailure) rejectionReason = classifyRejection({ ...base, prFailure });
      }
    }
    // A same-outcome record is only rewritten when the tracker reports a NEWER
    // close time (closed → reopened → re-closed): outcomeAt drives retention/GC,
    // so it must track the latest closure. Timestampless trackers (plan) and an
    // unchanged closedAt skip the write — no churn on every reconcile.
    const closedMs = Date.parse(issue.closedAt);
    const storedMs = Date.parse(r.outcomeAt);
    const newerClose = Number.isFinite(closedMs) && (!Number.isFinite(storedMs) || closedMs > storedMs);
    // A changed classification is its own reason to rewrite — same self-heal as
    // the outcome reclassification above (#2620). It BACKFILLS records written
    // before the taxonomy existed (stored null, now a token) and re-diagnoses an
    // `unknown-reason` record once someone finally labels the issue. Comparing the
    // derived token to the stored one (rather than writing unconditionally) keeps
    // a settled record from churning on every reconcile.
    // Learning the implementing-PR ref (#2748, deliverable 2) is itself a reason to
    // rewrite — it BACKFILLS the additive field on records filed before it existed,
    // and prefers the freshly-read ref over a stored one so a re-linked PR updates.
    const nextImplementingPr = implementingPr ?? (r.implementingPr ?? null);
    if (outcome === r.outcome && rejectionReason === r.rejectionReason && nextImplementingPr === (r.implementingPr ?? null) && !newerClose) continue;
    const id = outcomeId(appId, r.slug);
    // Fence the per-record write in the same per-id queue recordProposalExecution uses
    // (#2765, codex P2), and re-read INSIDE the fence: `records` came from an upfront
    // listOutcomes read, so a hand-off completion that wrote `executionOutcome` after that
    // read but before here would be clobbered by a stale `{...r}`. Merging over the FRESH
    // record (loadOne, falling back to `r` only if GC'd mid-flight) preserves the execution
    // fields while still applying the recomputed filing outcome. The recomputed fields come
    // from `issue`, not `fresh`, so a concurrent execution write can't revert them either.
    const ok = await store.queueRecordWrite(id, async () => {
      const fresh = (await store.loadOne(id).catch(() => null)) || r;
      const next = {
        ...fresh,
        outcome,
        outcomeAt: issue.closedAt || fresh.outcomeAt || new Date(now).toISOString(),
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
