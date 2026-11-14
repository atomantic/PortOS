/** Current branch/checkout inventory and bounded recent-retirement display history. */
import { sameRetirementCheckout, sameRetirementObservation, reconcileInventoryRows } from './branchReconcileInventoryPrune.js';
import { readRetirementCheckoutIdentity } from '../lib/retirementCheckoutObservation.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { cosEvents } from './cosEvents.js';
import { getAppById } from './apps.js';
import { ensureExecutionRecord, loadSchedule, resolveExecutionRecord, updateSchedule } from './taskScheduleStore.js';

/** A fresh scan replaces inventory; omitted historical rows grant no authority. */
export async function recordBranchReconcileOutcome(appId, { status, reason, remaining, nextAction, remoteInventory }) {
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const now = new Date().toISOString();
    record.branchReconcileOutcome = { ...record.branchReconcileOutcome, status, reason, nextAction, updatedAt: now,
      ...(remoteInventory !== undefined && { remoteInventory }),
      remaining: remaining === undefined ? record.branchReconcileOutcome?.remaining ?? null : remaining,
      observedAt: remaining === undefined ? record.branchReconcileOutcome?.observedAt ?? null : now };
    return { result: record.branchReconcileOutcome, changed: true };
  });
}

/** Add one freshly observed cleanup target without replacing other inventory. */
export async function recordBranchReconcileCheckout(appId, release) {
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const previous = record.branchReconcileOutcome || {};
    record.branchReconcileOutcome = { ...previous, status: 'incomplete', reason: 'retirement-review-pending',
      updatedAt: new Date().toISOString(), remaining: [...(previous.remaining || []).filter(row =>
        release.path ? row.path !== release.path : row.path || row.branch !== release.branch),
      { ...release, reason: 'retirement-review-pending' }] };
    return { result: record.branchReconcileOutcome, changed: true };
  });
}

export async function getBranchReconcileOutcome(appId) {
  const schedule = await loadSchedule();
  return resolveExecutionRecord(schedule, 'branch-reconcile', appId)?.branchReconcileOutcome ?? null;
}

/** Re-read inside the schedule writer so a stale API read cannot overwrite a scan. */
export async function getBranchReconcileInventory(appId) {
  const app = await getAppById(appId);
  if (!app?.repoPath) return getBranchReconcileOutcome(appId);
  return updateSchedule(async schedule => {
    const record = resolveExecutionRecord(schedule, 'branch-reconcile', appId);
    const outcome = record?.branchReconcileOutcome;
    if (!Array.isArray(outcome?.remaining)) return { result: outcome ?? null, changed: false };
    const remaining = await reconcileInventoryRows(app.repoPath, outcome.remaining);
    const changed = JSON.stringify(remaining) !== JSON.stringify(outcome.remaining);
    if (changed) record.branchReconcileOutcome = { ...outcome, remaining, updatedAt: new Date().toISOString() };
    return { result: record.branchReconcileOutcome, changed };
  });
}

export async function annotateMissingCheckouts(status) {
  const outcomes = status?.tasks?.['branch-reconcile']?.reconcileOutcomes;
  if (!outcomes) return status;
  status.tasks['branch-reconcile'].reconcileOutcomes = Object.fromEntries(
    await mapWithConcurrency(Object.entries(outcomes), 8, async ([appId, outcome]) =>
      [appId, await getBranchReconcileInventory(appId) ?? outcome])
  );
  return status;
}

const RETIRED_CHECKOUTS_KEPT = 20;

/** Preserve bounded checkout-only evidence before an explicitly accepted,
 * published supersession is removed. This is preparation, never a receipt or
 * a claim that the source was merged. Existing inventory obligations stay. */
const SUPERSEDED_SOURCE_EVIDENCE_BYTES = 1024 * 1024;

export async function recordSupersededCheckoutPreservation(appId, release, review) {
  if (review?.kind !== 'preserved-supersession' || !review.preservedSource
    || !sameRetirementObservation(review.release, release) || review.preservedSource.head !== release.head
    || !/^[a-f0-9]{64}$/.test(review.digest || '')) return false;
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const outcome = record.branchReconcileOutcome;
    if (!outcome?.remaining?.some(row => sameRetirementCheckout(row, release))) return { result: false, changed: false };
    const prior = outcome.supersededSourceEvidence?.[review.digest];
    const proof = { release, source: review.preservedSource, replacement: { prUrl: review.forge.prUrl,
      prHead: review.forge.prHead, mergeCommit: review.forge.mergeCommit },
      contentFingerprint: review.contentFingerprint, administrationFingerprint: review.administrationFingerprint };
    if (prior) return { result: JSON.stringify(prior.proof) === JSON.stringify(proof), changed: false };
    const checkoutIdentity = await readRetirementCheckoutIdentity(release.path);
    if (!checkoutIdentity || (release.checkoutIdentity && checkoutIdentity !== release.checkoutIdentity)) return { result: false, changed: false };
    const retained = {};
    for (const [digest, saved] of Object.entries(outcome.supersededSourceEvidence || {})) {
      const source = saved.proof?.release;
      const stale = source && (sameRetirementCheckout(source, release)
        || !outcome.remaining.some(row => sameRetirementCheckout(row, source)));
      // An original pointer still present proves the preparation never retired
      // that checkout. Missing, recreated or unreadable source keeps its bytes,
      // independently of the bounded recent-retirements display history.
      if (stale && saved.checkoutIdentity && await readRetirementCheckoutIdentity(source.path) === saved.checkoutIdentity) continue;
      retained[digest] = saved;
    }
    const next = { ...retained, [review.digest]: { proof, checkoutIdentity, preservedAt: new Date().toISOString() } };
    // Never evict completed evidence that may contain the only private bytes.
    // Bound the whole encoded store instead; a full store retains the original
    // checkout. This source custody is independent of bounded display history.
    if (Buffer.byteLength(JSON.stringify(next)) > SUPERSEDED_SOURCE_EVIDENCE_BYTES) return { result: false, changed: false };
    record.branchReconcileOutcome = { ...outcome, supersededSourceEvidence: next };
    return { result: true, changed: true };
  });
}

/** Display history is bounded and never authorizes or gates cleanup. */
export async function recordHeldCheckoutRetirement(appId, receipt) {
  const outcome = await updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const previous = record.branchReconcileOutcome || {};
    const retiredAt = new Date().toISOString();
    const { branch, ...details } = receipt;
    const row = { ...details, ...(branch && { branch }), archiveDir: receipt.archiveDir ?? null, retiredAt,
      ...(receipt.supersessionDigest && previous.supersededSourceEvidence?.[receipt.supersessionDigest]
        && { disposition: 'superseded-preserved' }) };
    record.branchReconcileOutcome = { ...previous, updatedAt: retiredAt,
      remaining: (previous.remaining || []).filter(entry => receipt.branchDeleted !== true && Boolean(receipt.branch)
        || (!sameRetirementObservation(entry, receipt) && !(!entry.checkoutIdentity && sameRetirementCheckout(entry, receipt)))),
      retired: [row, ...(previous.retired || [])].slice(0, RETIRED_CHECKOUTS_KEPT) };
    return { result: record.branchReconcileOutcome, changed: true };
  });
  if (receipt.branchDeleted === true) cosEvents.emit('checkout:retired', { appId, ...receipt });
  return outcome;
}

export async function recordWorkspaceCheckoutRetirement(repoPath, receipt) {
  if (!repoPath || (!receipt?.path && !receipt?.branch)) return null;
  const schedule = await loadSchedule();
  const perApp = schedule?.executions?.['task:branch-reconcile']?.perApp;
  let updated = null;
  for (const [appId, record] of Object.entries(perApp || {})) {
    if (!record?.branchReconcileOutcome?.remaining?.some(row => sameRetirementCheckout(row, receipt))) continue;
    const app = await getAppById(appId).catch(() => null);
    if (app?.repoPath !== repoPath) continue;
    updated = await recordHeldCheckoutRetirement(appId, receipt);
  }
  return updated;
}
