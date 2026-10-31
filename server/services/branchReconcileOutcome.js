/**
 * Checkout-retirement receipt ledger. Persists `branchReconcileOutcome` on the
 * per-app `task:branch-reconcile` execution record through the schedule store's
 * serialized read-modify-write. Owned apart from taskSchedule.js (the cadence
 * module) so receipt callers do not drag git observation and inventory pruning
 * into every scheduler importer. Must not import taskSchedule.js.
 */

import { createHash } from 'node:crypto';
import { unresolvedRetirements, retainRetirementObligations, sameRetirementCheckout, sameRetirementObservation, matchingRetirementReceipts, hasRetirementReceipt, retirementReceiptSettles } from '../lib/reconcileRetirementEvidence.js';
import { applyLegacyRetirementResolutions } from '../lib/legacyRetirementTransition.js';
import { readCheckoutPathPresence, readLocalBranchPresence } from './repoCleanupObservation.js';
import { isCurrentRetirementCheckout } from '../lib/retirementCheckoutObservation.js';
import { findGoneInventoryRows, isObligationRow } from './branchReconcileInventoryPrune.js';
import { mapWithConcurrency } from '../lib/mapWithConcurrency.js';
import { cosEvents } from './cosEvents.js';
import { getAppById } from './apps.js';
import { ensureExecutionRecord, loadSchedule, resolveExecutionRecord, updateSchedule } from './taskScheduleStore.js';

/** Persist the latest deterministic sweep evidence independently of agent success. */
export async function recordBranchReconcileOutcome(appId, { status, reason, remaining, nextAction, remoteInventory, retirementObligations: additionalObligations = [] }) {
  const outcome = await updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const now = new Date().toISOString();
    const previous = record.branchReconcileOutcome;
    const transition = schedule.retirementPolicyVersion === 2 && !previous?.legacyRetirementTransition
      ? { version: 1, observations: [], resolutions: [] } : previous?.legacyRetirementTransition;
    const existing = unresolvedRetirements(previous);
    const admitted = [];
    const rejected = [];
    for (const row of [...(remaining || []), ...additionalObligations]) {
      if (!isObligationRow(row)) continue;
      if (existing.some(entry => sameRetirementObservation(entry, row))) continue;
      const resolved = previous?.legacyRetirementTransition?.resolutions?.some(entry => sameRetirementObservation(entry.observation, row)
        && (!row.createdAt || row.createdAt === entry.observation.createdAt));
      if (resolved) {
        const app = await getAppById(appId);
        if (app?.repoPath && (!row.path || await readCheckoutPathPresence(row.path) === false)
          && row.branch && await readLocalBranchPresence(app.repoPath, row.branch) === false) {
          rejected.push(row);
          continue;
        }
      }
      const previousIncarnation = existing.some(entry => sameRetirementCheckout(entry, row));
      const receipts = matchingRetirementReceipts(previous, row);
      // Legacy rows without observation identity cannot claim to be recreations.
      if (hasRetirementReceipt(previous, row)
        || ((receipts.length || previousIncarnation) && !Number.isFinite(Date.parse(row.createdAt))
          && (!row.checkoutIdentity || !await isCurrentRetirementCheckout(row).catch(() => false)))) {
        rejected.push(row);
      } else admitted.push(row);
    }
    // A fresh empty scan must not erase the last observation of vanished source.
    const omitted = remaining === undefined ? [] : (previous?.remaining || [])
      .filter(row => !remaining.some(current => sameRetirementCheckout(current, row))
        && !hasRetirementReceipt(previous, row)
        && !rejected.some(entry => sameRetirementObservation(entry, row)));
    const missing = await missingInventoryRows(appId, omitted);
    const retirementObligations = retainRetirementObligations(previous,
      [...admitted, ...missing.map(missingPreservationObligation)], now);
    const inventory = (remaining === undefined ? previous?.remaining ?? null : remaining)
      ?.filter(row => !rejected.some(entry => sameRetirementObservation(entry, row))) ?? null;
    const current = inventory?.map(row => {
      const obligation = retirementObligations.find(entry => sameRetirementObservation(entry, row));
      return obligation ? { ...row, createdAt: obligation.createdAt,
        ...(obligation.checkoutIdentity && { checkoutIdentity: obligation.checkoutIdentity }),
        ...(obligation.observedAt && { observedAt: obligation.observedAt }) } : row;
    }) ?? null;
    const retained = retirementObligations.filter(obligation => !current?.some(row => sameRetirementObservation(row, obligation)));
    record.branchReconcileOutcome = {
      ...previous, status, reason, nextAction, updatedAt: now, retirementObligations,
      ...(transition && { legacyRetirementTransition: transition }),
      ...(remoteInventory !== undefined && { remoteInventory }),
      remaining: retained.length ? [...(current || []), ...retained] : current,
      observedAt: remaining === undefined ? record.branchReconcileOutcome?.observedAt ?? null : now,
      ...(retirementObligations.some(row => row.reason === 'retirement-provenance-unverified') && missingPreservationStatus),
    };
    return { result: record.branchReconcileOutcome, changed: true };
  });
  if (!appId || !unresolvedRetirements(outcome).length) return outcome;
  const app = await getAppById(appId).catch(() => null);
  if (!app?.repoPath) return outcome;
  // Compatibility for stores that have not yet run migration 443. Upgraded and
  // fresh stores always have the transition marker and never require archives.
  if (!outcome.legacyRetirementTransition) {
    const missing = await findGoneInventoryRows(app.repoPath, unresolvedRetirements(outcome), { includeObligations: true }).catch(() => []);
    if (!missing.length) return outcome;
    const { recoverMissingCheckoutPreservations } = await import('./heldCheckoutRecovery.js');
    return recoverMissingCheckoutPreservations({ appId, repoPath: app.repoPath, outcome });
  }
  // Writers are also called while a checkout retirement owns the claim lock.
  // The scan entry points run historical proof work after that lock is released.
  return outcome;
}

export async function recordLegacyRetirementResolutions(appId, expected, resolutions, stillAbsent) {
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    if (JSON.stringify(record.branchReconcileOutcome) !== JSON.stringify(expected) || !await stillAbsent()) {
      return { result: record.branchReconcileOutcome, changed: false };
    }
    const outcome = applyLegacyRetirementResolutions(expected, resolutions, new Date().toISOString());
    record.branchReconcileOutcome = outcome;
    return { result: outcome, changed: outcome !== expected };
  });
}

/** Compare the whole observed inventory and its generation inside the schedule
 * writer. A verifier result never authorizes a newer/recreated checkout.
 */
export async function recordRecoveredCheckoutPreservations(appId, expected, observations, stillAbsent, discovery) {
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const outcome = record.branchReconcileOutcome;
    if (JSON.stringify(outcome) !== JSON.stringify(expected) || !await stillAbsent()) return { result: outcome, changed: false };
    const now = new Date().toISOString();
    const recoveredPreservations = [...(outcome.recoveredPreservations || [])];
    const diagnosed = unresolvedRetirements(outcome).map(release => {
      const observation = observations.find(row => sameRetirementCheckout(row.release, release) && row.release.createdAt === release.createdAt);
      if (!observation) return release;
      const accepted = observation.proof && recoveredPreservations.length < 1000;
      const { recheck: _recheck, releaseFence: _releaseFence, ...proof } = observation.proof || {};
      if (accepted) recoveredPreservations.push({
        branch: release.branch, path: release.path, head: release.head,
        obligationCreatedAt: release.createdAt, ...proof, verified: true, verifiedAt: now,
      });
      return { ...release, preservationEvidence: { status: 'unresolved',
        reason: observation.proof && !accepted ? 'preservation-receipt-budget-exceeded' : observation.reason,
        checkedAt: now, archives: observation.evidence, ...(observation.coverage && { coverage: observation.coverage }), nextAction: observation.nextAction } };
    });
    const retirementObligations = unresolvedRetirements({ retirementObligations: diagnosed, recoveredPreservations });
    const remaining = (outcome.remaining || []).flatMap(row => {
      const diagnosedRow = diagnosed.find(release => sameRetirementCheckout(row, release) && row.createdAt === release.createdAt);
      return diagnosedRow ? retirementObligations.filter(release => sameRetirementCheckout(release, diagnosedRow)) : [row];
    });
    const historical = retirementObligations.find(row => row.preservationEvidence);
    // Recovery proves preservation, not repository convergence. Retire the old
    // diagnosis and let the next sweep establish the aggregate completion state.
    const diagnosis = historical
      ? { status: 'incomplete', reason: 'historical-preservation-unresolved', nextAction: historical.preservationEvidence.nextAction }
      : ['historical-preservation-unresolved', 'retirement-provenance-unverified'].includes(outcome.reason)
        ? { status: 'incomplete', reason: remaining.length ? 'remaining-holds' : 'preservation-recovered',
          nextAction: remaining.length ? 'Resolve the remaining holds, then run branch reconciliation again.'
            : 'Historical preservation verified; run branch reconciliation again to confirm repository completion.' }
        : {};
    record.branchReconcileOutcome = { ...outcome, retirementObligations, recoveredPreservations, remaining, updatedAt: now,
      ...(discovery && { preservationDiscovery: discovery }),
      ...diagnosis,
    };
    return { result: record.branchReconcileOutcome, changed: true };
  });
}

/** Observations are diagnostic only; journals and fresh service proofs own recovery. */
export async function recordInitializedRetirementRecovery(appId, observation) {
  return updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const previous = record.branchReconcileOutcome || {};
    const rows = previous.initializedRetirements || [];
    const index = rows.findIndex(row => row.transactionId === observation.transactionId);
    if (index < 0 && rows.length >= 1000) throw new Error('retirement-observation-budget-exceeded');
    const prior = index < 0 ? null : rows[index];
    if (prior && Object.entries(observation).every(([key, value]) => prior[key] === value)) return { result: prior, changed: false };
    const next = [...rows];
    const row = { ...observation, observedAt: new Date().toISOString() };
    if (index < 0) next.push(row); else next[index] = row;
    record.branchReconcileOutcome = { ...previous, initializedRetirements: next };
    return { result: row, changed: true };
  });
}

export async function getBranchReconcileOutcome(appId) {
  const schedule = await loadSchedule();
  return resolveExecutionRecord(schedule, 'branch-reconcile', appId)?.branchReconcileOutcome ?? null;
}

export async function getBranchReconcileInventory(appId) {
  const outcome = await getBranchReconcileOutcome(appId);
  // Preserve stronger existing receipt bindings before retiring an observation
  // as merely absent. Absence never replaces a real deletion receipt.
  const repaired = ![...(outcome?.remaining || []), ...(outcome?.retirementObligations || [])].some(row => isObligationRow(row))
    ? outcome : await updateSchedule(async schedule => {
      const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
      const before = record.branchReconcileOutcome;
      const after = await repairReceiptObservations(appId, before);
      const changed = after !== before;
      if (changed) record.branchReconcileOutcome = after;
      return { result: after, changed };
    });
  const { reconcileLegacyRetirementRecords } = await import('./legacyRetirementReconciliation.js');
  const current = await reconcileLegacyRetirementRecords(appId, repaired).catch(() => repaired);
  return reconcileMissingInventory(appId, current);
}

const missingPreservationObligation = row => ({ ...row, reason: 'retirement-provenance-unverified' });
const missingPreservationStatus = {
  status: 'incomplete', reason: 'retirement-provenance-unverified',
  nextAction: 'Trace the missing original checkout/ref. Disappearance and merged commits do not prove the retirement service removed it. A service receipt settles it. Do not copy the checkout into an archive.',
};

async function missingInventoryRows(appId, rows, options) {
  if (!appId || !rows.length) return [];
  const app = await getAppById(appId);
  if (!app?.repoPath) return [];
  return findGoneInventoryRows(app.repoPath, rows, options);
}

/** Missing originals remain evidence until an exact service receipt settles them. */
export async function recordMissingInventoryRows(appId, rows) {
  return updateSchedule(async (schedule) => {
    const outcome = ensureExecutionRecord(schedule, 'branch-reconcile', appId).branchReconcileOutcome;
    if (!Array.isArray(outcome?.remaining)) return { result: outcome ?? null, changed: false };
    const missing = outcome.remaining.filter(entry => rows.some(row => sameRetirementCheckout(row, entry)));
    if (!missing.length) return { result: outcome, changed: false };
    const now = new Date().toISOString();
    const obligations = retainRetirementObligations(outcome, missing.map(missingPreservationObligation), now);
    Object.assign(outcome, missingPreservationStatus, { updatedAt: now, retirementObligations: obligations,
      remaining: outcome.remaining.map(row => obligations.find(entry => sameRetirementCheckout(entry, row)) || row),
    });
    return { result: outcome, changed: true };
  });
}

/** Reconcile display inventory with missing source without claiming archival success. */
async function reconcileMissingInventory(appId, outcome) {
  if (!appId || !outcome?.remaining?.length) return outcome;
  const gone = await missingInventoryRows(appId, outcome.remaining, { includeObligations: true }).catch(() => []);
  if (!gone.length) return outcome;
  const unrecorded = gone.filter(row => !isObligationRow(row));
  const current = unrecorded.length ? await recordMissingInventoryRows(appId, unrecorded).catch(() => null) ?? outcome : outcome;
  // The original checkout is gone; flag it so the UI never offers a retire action on it.
  return { ...current, remaining: current.remaining.map(row => ({
    ...row,
    ...(row.path && gone.some(missing => sameRetirementCheckout(missing, row)) && { checkoutMissing: true }),
    ...(!row.path && row.branch && gone.some(missing => sameRetirementCheckout(missing, row)) && { branchMissing: true }),
  })) };
}

/**
 * Annotate a `getScheduleStatus()` result's branch-reconcile outcomes with
 * checkouts that no longer exist on disk, for the schedule API response. Kept
 * out of getScheduleStatus so the cadence module never reaches this ledger.
 */
export async function annotateMissingCheckouts(status) {
  const outcomes = status?.tasks?.['branch-reconcile']?.reconcileOutcomes;
  if (!outcomes) return status;
  status.tasks['branch-reconcile'].reconcileOutcomes = Object.fromEntries(
    await mapWithConcurrency(Object.entries(outcomes), 8, async ([appId, outcome]) => [appId, await reconcileMissingInventory(appId, outcome)])
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
    const retiredDigests = new Set([...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {})]
      .map(receipt => receipt.supersessionDigest).filter(Boolean));
    const currentRows = [...outcome.remaining, ...(outcome.retirementObligations || [])];
    const retained = Object.fromEntries(Object.entries(outcome.supersededSourceEvidence || {}).filter(([digest, saved]) =>
      retiredDigests.has(digest) || currentRows.some(row => sameRetirementObservation(row, saved.proof?.release || {}))));
    const next = { ...retained, [review.digest]: { proof, preservedAt: new Date().toISOString() } };
    // Never evict completed evidence that may contain the only private bytes.
    // Bound the whole encoded store instead; a full store retains the original
    // checkout. Stale, unconsumed preparations are safely pruned on success.
    if (Buffer.byteLength(JSON.stringify(next)) > SUPERSEDED_SOURCE_EVIDENCE_BYTES) return { result: false, changed: false };
    record.branchReconcileOutcome = { ...outcome, supersededSourceEvidence: next };
    return { result: true, changed: true };
  });
}

// This is receipt bookkeeping, never checkout mutation. It can run under the
// schedule writer even when its caller already owns the claim lock: do not
// acquire that lock recursively. Fresh absence/owner checks only narrow repair.
async function repairReceiptObservations(appId, outcome) {
  const { reconcileRecordedReceiptObservations } = await import('./legacyRetirementReconciliation.js');
  return reconcileRecordedReceiptObservations(appId, outcome).catch(() => outcome);
}

/**
 * Drop a retired checkout from the last inventory and keep a short record of
 * where its archive went. Status is untouched: only the next sweep can say the
 * repository converged.
 */
export async function recordHeldCheckoutRetirement(appId, { path, branch, branchDeleted, head, archiveDir, checkoutIdentity, checkoutOnly = false, supersessionDigest = null, validationEvidence = null }) {
  // Only a branchless checkout can be settled without a deleted branch; the
  // receipt then records exactly that and never claims a deletion.
  const checkoutOnlyReceipt = checkoutOnly === true && !branch && branchDeleted !== true;
  const outcome = await updateSchedule(async (schedule) => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const outcome = record.branchReconcileOutcome || {};
    // Display history is bounded; receipt evidence and replay identity are durable. A delayed retry
    // must not become new evidence after its display row has been evicted.
    const identity = receipt => createHash('sha256').update(JSON.stringify([
      // A non-empty archive path stays the historical id. In-place removal has no
      // archive, so the checkout identity distinguishes a recreated tree at the
      // same path, branch and head. An archive path is never replaced by it.
      receipt.archiveDir ?? receipt.checkoutIdentity ?? null,
      receipt.path, receipt.branch ?? null, receipt.head,
      receipt.branchDeleted === true,
      // Appended only for checkout-only receipts so every persisted identity keeps its hash.
      ...(receipt.checkoutOnly === true ? ['checkout-only'] : []),
    ])).digest('hex');
    const receipts = { ...(outcome.retirementReceiptIdentities || {}) };
    const evidence = { ...(outcome.retirementReceiptEvidence || {}) };
    for (const receipt of outcome.retired || []) {
      const recordedArchive = receipt.archiveDir ?? null;
      const archiveKept = recordedArchive === null || (typeof recordedArchive === 'string' && recordedArchive.length > 0);
      if ((retirementReceiptSettles(receipt) || (receipt.branchDeleted === false && receipt.branch && receipt.checkoutIdentity))
        && receipt.retiredAt && archiveKept) {
        const normalized = { ...receipt, archiveDir: recordedArchive };
        if (retirementReceiptSettles(receipt)) receipts[identity(normalized)] ??= receipt.retiredAt;
        evidence[identity(normalized)] ??= normalized;
      }
    }
    const recordedArchive = archiveDir ?? null;
    const archiveKept = recordedArchive === null || (typeof recordedArchive === 'string' && recordedArchive.length > 0);
    const receiptId = (branchDeleted === true || checkoutOnlyReceipt) && archiveKept
      ? identity({ path, branch, head, archiveDir: recordedArchive, branchDeleted, checkoutIdentity, checkoutOnly: checkoutOnlyReceipt }) : null;
    if (branchDeleted === false && branch && checkoutIdentity && archiveKept
      && [...(outcome.retired || []), ...Object.values(evidence)].some(row => sameRetirementCheckout(row, { path, branch, head })
        && row.checkoutIdentity === checkoutIdentity && typeof row.branchDeleted === 'boolean'
        && Number.isFinite(Date.parse(row.retiredAt)))) {
      // Replayed physical removal cannot mint another timestamp or regress a
      // receipt whose surviving ref has already been finalized.
      const repaired = await repairReceiptObservations(appId, { ...outcome,
        retirementReceiptIdentities: receipts, retirementReceiptEvidence: evidence });
      const changed = JSON.stringify(repaired) !== JSON.stringify(outcome);
      if (changed) record.branchReconcileOutcome = repaired;
      return { result: record.branchReconcileOutcome, changed };
    }
    if (receiptId && receipts[receiptId]) {
      // Keep the original timestamp. Fill a missing checkout identity so a
      // later inventory row can match the receipt that already settled this tuple.
      const prior = evidence[receiptId];
      if (prior && checkoutIdentity && !prior.checkoutIdentity) evidence[receiptId] = { ...prior, checkoutIdentity };
      if (evidence[receiptId] && validationEvidence && !evidence[receiptId].validationEvidence) {
        evidence[receiptId] = { ...evidence[receiptId], validationEvidence };
      }
      const repaired = await repairReceiptObservations(appId, { ...outcome, retirementReceiptIdentities: receipts, retirementReceiptEvidence: evidence });
      const changed = JSON.stringify(repaired) !== JSON.stringify(outcome);
      if (changed) record.branchReconcileOutcome = repaired;
      return { result: record.branchReconcileOutcome, changed };
    }
    const retiredAt = new Date().toISOString();
    if (receiptId) receipts[receiptId] = retiredAt;
    const receipt = { path, ...(branch && { branch }), head,
      ...(validationEvidence && { validationEvidence }),
      ...(supersessionDigest && outcome.supersededSourceEvidence?.[supersessionDigest]
        && { disposition: 'superseded-preserved', supersessionDigest }), branchDeleted: checkoutOnlyReceipt ? false : branchDeleted, archiveDir: recordedArchive, retiredAt,
      ...(checkoutOnlyReceipt && { checkoutOnly: true }), ...(checkoutIdentity && { checkoutIdentity }) };
    const retired = [receipt, ...(outcome.retired || [])].slice(0, RETIRED_CHECKOUTS_KEPT);
    if (receiptId) evidence[receiptId] = receipt;
    else if (branchDeleted === false && branch && checkoutIdentity && archiveKept) {
      // Physical removal is durable evidence, but does not settle its surviving ref.
      evidence[identity(receipt)] = receipt;
    }
    const retirementObligations = unresolvedRetirements({ ...outcome, retired, retirementReceiptEvidence: evidence });
    record.branchReconcileOutcome = await repairReceiptObservations(appId, {
      ...outcome, retirementObligations,
      retirementReceiptIdentities: receipts, retirementReceiptEvidence: evidence,
      updatedAt: retiredAt,
      remaining: Array.isArray(outcome.remaining)
        ? outcome.remaining.filter(entry => retirementObligations.some(row => sameRetirementObservation(row, entry))
          || !(sameRetirementObservation(entry, receipt)
            || (!entry.checkoutIdentity && sameRetirementCheckout(entry, receipt))))
        : outcome.remaining ?? null,
      retired,
    });
    return { result: record.branchReconcileOutcome, changed: true };
  });
  if (branchDeleted === true) cosEvents.emit('checkout:retired', { appId, path, branch, head, checkoutIdentity });
  return outcome;
}

/** Finalize a canonical removal receipt after ref CAS or verified ref absence.
 * Keep the physical retirement time; finalization has its own current time. */
export async function recordRetiredCheckoutBranchFinalization(appId, release, kind) {
  if (!['deleted', 'observed-absent'].includes(kind)) throw new Error('retirement-finalization-kind-invalid');
  const receipt = await updateSchedule(async schedule => {
    const record = ensureExecutionRecord(schedule, 'branch-reconcile', appId);
    const outcome = record.branchReconcileOutcome || {};
    const matches = row => row.path === release.path && row.branch === release.branch && row.head === release.head
      && row.checkoutIdentity === release.checkoutIdentity && row.retiredAt === release.retiredAt;
    const rows = [...(outcome.retired || []), ...Object.values(outcome.retirementReceiptEvidence || {})];
    const prior = rows.find(row => matches(row) && row.branchDeleted === true && row.branchFinalizedAt)
      || rows.find(row => matches(row) && row.branchDeleted === false);
    if (!prior) throw new Error('retirement-removal-receipt-changed');
    const now = new Date().toISOString();
    const covered = row => row.branch === release.branch && !row.checkoutIdentity && !row.checkoutIncarnation
      && (row.path == null || row.path === release.path) && (row.head == null || row.head === release.head)
      && [row.observedAt, row.createdAt].every(time => time == null || (Number.isFinite(Date.parse(time)) && Date.parse(time) <= Date.parse(now)));
    const observations = (outcome.remaining || []).filter(covered);
    if (prior.branchDeleted === true && !observations.length) return { result: prior, changed: false };
    const settledObservations = [...(prior.settledObservations || [])];
    for (const observation of observations) {
      if (!settledObservations.some(row => row.settledAt === now && JSON.stringify(row.observation) === JSON.stringify(observation))) {
        settledObservations.push({ observation, settledAt: now });
      }
    }
    if (settledObservations.length > 1000) throw new Error('retirement-settled-observations-limit-exceeded');
    const receipt = { ...prior, branchDeleted: true,
      branchFinalizedAt: prior.branchDeleted === true ? prior.branchFinalizedAt : now,
      branchFinalization: prior.branchDeleted === true ? prior.branchFinalization : { kind },
      ...(settledObservations.length && { settledObservations }) };
    const key = createHash('sha256').update(JSON.stringify([
      receipt.archiveDir ?? receipt.checkoutIdentity ?? null, receipt.path, receipt.branch, receipt.head, true,
    ])).digest('hex');
    const retired = (outcome.retired || []).map(row => matches(row) ? receipt : row);
    const evidence = Object.fromEntries(Object.entries(outcome.retirementReceiptEvidence || {})
      .filter(([, row]) => !(matches(row) && row.branchDeleted === false)));
    evidence[key] = receipt;
    const updated = { ...outcome, retired, updatedAt: now, remaining: (outcome.remaining || []).filter(row => !covered(row)),
      retirementReceiptIdentities: { ...outcome.retirementReceiptIdentities, [key]: prior.retiredAt },
      retirementReceiptEvidence: evidence };
    updated.retirementObligations = unresolvedRetirements(updated);
    record.branchReconcileOutcome = await repairReceiptObservations(appId, updated);
    return { result: receipt, changed: true };
  });
  cosEvents.emit('checkout:retired', { appId, path: receipt.path, branch: receipt.branch,
    head: receipt.head, checkoutIdentity: receipt.checkoutIdentity });
  return receipt;
}

/**
 * Record a checkout retirement across apps observing the exact checkout tuple.
 * Settles stale inventory rows left behind when an active run finishes and removes its worktree.
 */
export async function recordWorkspaceCheckoutRetirement(repoPath, receipt) {
  if (!repoPath || (!receipt?.path && !receipt?.branch)) return null;
  const schedule = await loadSchedule();
  const perApp = schedule?.executions?.['task:branch-reconcile']?.perApp;
  if (!perApp || typeof perApp !== 'object') return null;
  let updated = null;
  for (const [appId, record] of Object.entries(perApp)) {
    const outcome = record?.branchReconcileOutcome;
    if (!outcome) continue;
    const rows = [...(outcome.remaining || []), ...(outcome.retirementObligations || [])];
    if (!rows.some(row => sameRetirementCheckout(row, receipt))) continue;
    const app = await getAppById(appId).catch(() => null);
    if (app?.repoPath !== repoPath) continue;
    updated = await recordHeldCheckoutRetirement(appId, receipt);
  }
  return updated;
}
