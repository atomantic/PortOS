/**
 * Repository-wide merge lease for the legacy outside-agent API
 * (`POST /api/cos/merge-admission/external`, #14320). PortOS's own merges
 * (the pending-merge sweep, the quality-snapshot publisher) and its spawned
 * agents take no lease: GitHub serializes merges and refuses a stale head.
 */
import { randomUUID } from 'node:crypto';
import { isPlainObject } from '../lib/objects.js';
import { parsePullRequestUrl } from '../lib/gitForge.js';
import { repositoryKey } from './mergeHandoffOwner.js';
import { createEventLoopLagProbe, formatLoadAttribution, phaseGroup, roundMs, systemClock } from '../lib/eventLoopLagProbe.js';

const retryAfterMs = 5000;
export const ADMISSION_QUEUE_TIMEOUT_MS = 15_000;
// A lease covers only verify-and-merge. Past this deadline it is reclaimable
// even from a running owner: that holder's pinned merge (--match-head-commit)
// cannot land an unverified head, so the worst case is one redundant resync
// rather than a repository blocked behind a hung session. This is not a
// forge-side fence: a merge request already in flight at the deadline may
// still land, with the same exposure as two CLEAN merges.
export const AGENT_LEASE_MAX_HOLD_MS = 5 * 60 * 1000;
export const MERGE_PREPARATION_MAX_HOLD_MS = 20 * 60 * 1000;
const PREPARATION_WAIT_IDLE_MS = 3 * 60 * 1000;
export const MERGE_ADMISSION_OUTCOMES = ['merged', 'leave-open', 'resync'];
// Detect a same-repository acquire/release ABA while an outside forge proof is
// in flight. A restart ends those in-flight requests, so revisions stay local.
const repositoryRevisions = new Map();
const revision = repository => repositoryRevisions.get(repository) ?? 0;
async function saveLeaseState(state, save, repository) {
  await save(state);
  repositoryRevisions.set(repository, revision(repository) + 1);
}
const refuse = (reason) => ({ admitted: false, reason, retryAfterMs });
const validExternalMergeTarget = (target) => isPlainObject(target)
  && ['appId', 'repoPath', 'worktreePath', 'gitDir', 'commonDir', 'checkoutIdentity', 'branch', 'prUrl', 'baseBranch'].every(key =>
    typeof target[key] === 'string' && target[key].length > 0)
  && /^[a-f0-9]{40}$/.test(target.headSha || '') && /^[a-f0-9]{40}$/.test(target.baseSha || '');
const validLease = (lease, repository) => isPlainObject(lease) && lease.repository === repository
  && typeof lease.token === 'string' && lease.token.length > 0 && Number.isFinite(Date.parse(lease.acquiredAt))
  && lease.kind === 'external' && /^[a-f0-9]{64}$/.test(lease.externalOwner || '') && validExternalMergeTarget(lease.target);
const expired = (lease) => Date.now() - Date.parse(lease.acquiredAt) >= AGENT_LEASE_MAX_HOLD_MS;
// Agent and sweep leases persisted before #14319 (their preparation rows just age out)
// have no holder any more; drop them on the next save instead of refusing on them.
const withoutLegacyLeases = (leases) => Object.fromEntries(
  Object.entries(leases).filter(([, lease]) => !(isPlainObject(lease) && ['agent', 'sweep'].includes(lease.kind))));

// A settled transaction is logged only at or above this duration; a deadline,
// pending or failed one always is. See docs/TROUBLESHOOTING.md for the fields.
export const SLOW_ADMISSION_MS = 1000;
let clock = systemClock;
let lagProbe = createEventLoopLagProbe({ clock });

/** Inject a deterministic clock and optional resource counters; `null` restores the system ones. */
export function __setMergeAdmissionClockForTests(next, resources) {
  clock = next ?? systemClock;
  lagProbe = createEventLoopLagProbe({ clock, resources });
}

const REPORTED_PHASES = ['queue', 'trustedState', 'stateLoad', 'origin', 'persistence'];
const REPORTED_STAGES = [['trustedState', 'read'], ['trustedState', 'parse'], ['persistence', 'prepare'],
  ['persistence', 'agents'], ['persistence', 'serialize'], ['persistence', 'write'], ['persistence', 'replace'], ['persistence', 'dirSync']];
const REPORTED_LAG_PHASES = ['queue', 'trustedState', 'persistence'];

// Per record, not per serialized map: the stored rows come back in insertion
// order, which a map that deleted and re-added an id does not keep.
function sameAgentRecords(cached, stored) {
  const ids = Object.keys(cached ?? {});
  return isPlainObject(cached) && ids.length === Object.keys(stored).length
    && ids.every((id) => Object.hasOwn(stored, id) && JSON.stringify(cached[id]) === JSON.stringify(stored[id]));
}

let stateStorePromise;
async function transaction(work, operation) {
  // Lazy: almost every task-generator suite reaches prWatcher, even when no
  // pending merge exists. Admission needs runtime state only on the merge path.
  const { withStateLock, readMergeAdmissionStateForSafetyCheck, loadState, saveState } = await (stateStorePromise ??= import('./cosState.js'));
  const queuedAt = clock.now();
  // Each phase runs until the next begins; `phase.stage` names are its stages.
  const span = lagProbe.begin('queue');
  let started = false;
  let cancelled = false;
  let timerLateMs = 0;
  // Only fixed operation/phase names and bounded numeric timings reach logs.
  const report = (status) => {
    const summary = status === 'pending' ? span.snapshot() : span.end();
    if (status === 'settled' && summary.totalMs < SLOW_ADMISSION_MS) return;
    // Same contract as claim ownership: a queue-timeout or pending report only appears during the
    // event-loop stalls #12852 reopens on, so it stays on stderr; a slow settle is telemetry.
    const log = status === 'failed' ? console.error : status === 'settled' ? console.log : console.warn;
    const phases = REPORTED_PHASES.map((name) => `${name}Ms=${phaseGroup(summary, name).ms}`);
    const stages = REPORTED_STAGES.map(([name, stage]) => `${stage}Ms=${summary.phases[`${name}.${stage}`]?.ms ?? 0}`);
    const lag = REPORTED_LAG_PHASES.map((name) => `${name}LagMs=${phaseGroup(summary, name).lagMs}`);
    log(`🚦 Merge admission operation=${operation} status=${status} phase=${summary.phase.split('.')[0]} phaseMs=${summary.phaseMs} totalMs=${summary.totalMs} ${phases.join(' ')} ${stages.join(' ')} loopLagMs=${summary.lagMs} loopLagMaxMs=${summary.lagMaxMs} ${lag.join(' ')} timerLateMs=${timerLateMs}${formatLoadAttribution(summary.load)}`);
  };
  const measure = async (name, fn) => {
    span.mark(name);
    return fn();
  };
  const stage = (name) => (sub) => span.mark(`${name}.${sub}`);
  const overdue = () => roundMs(clock.now() - queuedAt - ADMISSION_QUEUE_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const expire = () => {
      cancelled = true;
      report('queue-timeout');
      resolve(refuse('state-queue-timeout'));
    };
    // A late timer is itself evidence of event-loop delay: record by how much.
    const timer = clock.setTimer(() => {
      timerLateMs = overdue();
      if (!started) expire();
      else report('pending');
    }, ADMISSION_QUEUE_TIMEOUT_MS);
    const queued = withStateLock(async () => {
      // Check the clock as well: a delayed timer must not let an expired
      // callback mutate a lease when the state queue resumes first.
      if (cancelled) return;
      if (clock.now() - queuedAt >= ADMISSION_QUEUE_TIMEOUT_MS) { timerLateMs = overdue(); expire(); return; }
      started = true;
      const snapshot = await measure('trustedState', () =>
        readMergeAdmissionStateForSafetyCheck({ onStage: stage('trustedState') }).catch(() => null));
      if (!snapshot?.trusted || !isPlainObject(snapshot.agents) || !isPlainObject(snapshot.mergeAdmissions)) {
        return refuse('ownership-unreadable');
      }
      const preparations = Object.hasOwn(snapshot, 'mergePreparations') ? snapshot.mergePreparations : {};
      if (!isPlainObject(preparations)) return refuse('ownership-unreadable');
      const state = await measure('stateLoad', loadState);
      // A recovered/defaulted or externally replaced state is not proof of an
      // empty ownership set. Do not let the cache overwrite contradictory disk.
      if (!sameAgentRecords(state.agents, snapshot.agents)
        || JSON.stringify(state.mergeAdmissions ?? {}) !== JSON.stringify(snapshot.mergeAdmissions)
        || JSON.stringify(state.mergePreparations ?? {}) !== JSON.stringify(preparations)) {
        return refuse('ownership-stale');
      }
      // Copy before mutation: a failed atomic write must not admit from a cache
      // that falsely remembers a successful grant/release.
      const next = { ...state, agents: { ...state.agents }, mergeAdmissions: withoutLegacyLeases(snapshot.mergeAdmissions),
        mergePreparations: structuredClone(preparations) };
      return work(next, (value) => measure('persistence', () => saveState(value, { onStage: stage('persistence') })), measure);
    });
    // Once started, the queue owns the entire transaction through durable
    // settlement. The deadline diagnoses a slow phase but cannot return a
    // refusal while an unfenced acquire/release is still able to commit.
    queued.then((result) => {
      if (!cancelled) { report('settled'); resolve(result); }
    }, (error) => {
      if (!cancelled) { report('failed'); reject(error); }
    }).finally(() => clock.clearTimer(timer));
  });
}

// A preparation turn orders only ready sessions' guards and merge attempts.
// It is not admission: final ownership/head/base/check gates remain mandatory.
// Rows persisted by agent or pending-merge owners before #14319 just age out.
const preparationOwner = owner => `external:${owner.externalOwner}`;
const preparationTarget = owner => JSON.stringify({ ...owner.target, baseSha: null });
const validPreparation = row => isPlainObject(row) && typeof row.owner === 'string'
  && typeof row.token === 'string' && Number.isFinite(row.requestedAt) && Number.isFinite(row.seenAt)
  && (row.grantedAt === null || Number.isFinite(row.grantedAt));
async function prepare(state, save, repository, owner, { yieldTurn = false } = {}) {
  const now = Date.now();
  if (Object.hasOwn(state.mergeAdmissions, repository) && !validLease(state.mergeAdmissions[repository], repository)) {
    return refuse('lease-unreadable');
  }
  const stored = Object.hasOwn(state.mergePreparations, repository) ? state.mergePreparations[repository] : [];
  if (!Array.isArray(stored) || !stored.every(validPreparation)) return refuse('preparation-unreadable');
  const identity = preparationOwner(owner);
  const target = preparationTarget(owner);
  let rows = structuredClone(stored).filter(row => row.grantedAt === null ? now - row.seenAt < PREPARATION_WAIT_IDLE_MS
    : now - row.grantedAt < MERGE_PREPARATION_MAX_HOLD_MS);
  if (rows[0] && rows[0].token !== stored[0]?.token && rows[0].grantedAt === null) rows[0].seenAt = now;
  let row = rows.find(item => item.owner === identity);
  // A changed verified target joins at the tail. Base movement preserves the deadline.
  if (yieldTurn || (row && row.target !== target)) {
    const previous = rows[0]?.token;
    rows = rows.filter(item => item.owner !== identity);
    if (rows[0] && rows[0].token !== previous && rows[0].grantedAt === null) rows[0].seenAt = now;
    row = null;
  }
  if (!yieldTurn) {
    if (!row) {
      row = { owner: identity, target, token: randomUUID(), requestedAt: now, seenAt: now, grantedAt: null };
      rows.push(row);
    }
    if (row.grantedAt === null && now - row.seenAt >= 30_000) row.seenAt = now;
    const held = state.mergeAdmissions[repository];
    if (rows[0] === row && row.grantedAt === null && (!held || expired(held))) row.grantedAt = now;
  }
  state.mergePreparations[repository] = rows;
  // Polls need durable liveness, but never renew the granted turn's deadline.
  if (JSON.stringify(stored) !== JSON.stringify(rows)) await save(state);
  if (yieldTurn) return { yielded: true };
  return row.grantedAt !== null && rows[0] === row
    ? { prepared: true, preparationToken: row.token, expiresAt: new Date(row.grantedAt + MERGE_PREPARATION_MAX_HOLD_MS).toISOString() }
    : { prepared: false, reason: 'preparation-waiting', retryAfterMs };
}
function finishPreparation(state, repository, owner) {
  const rows = state.mergePreparations[repository];
  if (!Array.isArray(rows)) return;
  const next = rows.filter(row => row.owner !== preparationOwner(owner));
  if (next[0] && next[0].token !== rows[0]?.token && next[0].grantedAt === null) next[0].seenAt = Date.now();
  state.mergePreparations[repository] = next;
}

async function admit(state, save, repository, owner, measure) {
  const held = state.mergeAdmissions[repository];
  if (Object.hasOwn(state.mergeAdmissions, repository) && !validLease(held, repository)) return refuse('lease-unreadable');
  const available = !held || expired(held);
  if (held && available) finishPreparation(state, repository, held);
  // Persist the turn and lease together on a grant. Refused waiters still keep
  // their durable place; no second whole-state write is needed on acquisition.
  let changed = false;
  const turn = await prepare(state, async () => { changed = true; }, repository, owner);
  const refuseOrReenter = async result => {
    if (changed) await save(state);
    return result;
  };
  if (!available) return refuseOrReenter(refuse('owner-active-or-unverified'));
  if (!turn.prepared) return refuseOrReenter({ ...refuse(turn.reason), prepared: false });
  const lease = { ...owner, repository, token: randomUUID(), acquiredAt: new Date().toISOString() };
  state.mergeAdmissions[repository] = lease;
  await saveLeaseState(state, save, repository);
  return { admitted: true, token: lease.token, repository };
}

/** A verified operator session owns only the target validated by the server. */
export async function externalMergeAdmission(input, resolveOwner) {
  const { action, token, outcome } = input;
  const operation = ['prepare', 'yield', 'acquire', 'check', 'release'].includes(action) ? `external-${action}` : 'unknown';
  const validMap = state => Object.entries(state.mergeAdmissions).every(([key, held]) => validLease(held, key));
  const prepared = await transaction(async (state, save, measure) => {
    const externalOwner = await resolveOwner();
    if (!/^[a-f0-9]{64}$/.test(externalOwner || '')) return refuse('external-owner-unverified');
    if (!validMap(state)) return refuse('lease-unreadable');
    if (action === 'yield') {
      const match = Object.entries(state.mergePreparations).find(([, rows]) => Array.isArray(rows)
        && rows.some(row => row.owner === `external:${externalOwner}` && row.token === token));
      if (!match) return refuse('preparation-owner-mismatch');
      return prepare(state, save, match[0], { kind: 'external', externalOwner }, { yieldTurn: true });
    }
    const owned = Object.values(state.mergeAdmissions).find(held => held.kind === 'external'
      && held.externalOwner === externalOwner && held.token === token);
    if (!['acquire', 'prepare'].includes(action) && !owned) return refuse('lease-owner-mismatch');
    // Release remains possible after a merge or a changed/deleted checkout.
    if (action === 'release') {
      if (!MERGE_ADMISSION_OUTCOMES.includes(outcome)) return refuse('outcome-required');
      delete state.mergeAdmissions[owned.repository];
      if (outcome !== 'resync') finishPreparation(state, owned.repository, owned);
      await saveLeaseState(state, save, owned.repository);
      return { admitted: false, released: true, outcome };
    }
    if (!['prepare', 'acquire', 'check'].includes(action)) return refuse('action-invalid');
    if (owned && expired(owned)) return refuse('lease-expired');
    const requested = ['prepare', 'acquire'].includes(action) ? input : owned.target;
    const pr = parsePullRequestUrl(requested.prUrl);
    const repository = pr && repositoryKey({ host: pr.host, fullName: `${pr.owner}/${pr.repo}` });
    if (!repository) return refuse('repository-unreadable');
    const held = state.mergeAdmissions[repository];
    // Legacy acquire/check keeps its bounded busy fast path. Prepared callers
    // register order before guard work; unverified targets cannot reserve it.
    if (action !== 'prepare' && held && !(held.kind === 'external'
      && held.externalOwner === externalOwner && !expired(held))
      && !expired(held)) return refuse('owner-active-or-unverified');
    return { requested, repository, externalOwner, revision: revision(repository), agents: Object.values(state.agents) };
  }, operation);
  if (!prepared.requested) return prepared;
  const { inspectExternalMergeTarget, inspectExternalMergeCheckout } = await import('./externalMergeTarget.js');
  const proof = await inspectExternalMergeTarget(prepared.requested, prepared.agents);
  if (proof.reason) return refuse(proof.reason);
  const provedAt = clock.now();
  return transaction(async (state, save, measure) => {
    if (await resolveOwner() !== prepared.externalOwner) return refuse('external-owner-changed');
    if (!validMap(state)) return refuse('lease-unreadable');
    const { repository, target } = proof;
    if (repository !== prepared.repository || revision(repository) !== prepared.revision) return refuse('lease-target-changed');
    const held = state.mergeAdmissions[repository];
    if (action === 'check' && (held?.kind !== 'external' || held.externalOwner !== prepared.externalOwner || held.token !== token)) {
      return refuse('lease-owner-mismatch');
    }
    if (action === 'check' && expired(held)) return refuse('lease-expired');
    // Revalidate local registration, review and live CoS ownership after the
    // network await. Neither a revoked credential nor a replaced checkout may
    // spend the earlier proof; a queued proof also has a bounded lifetime.
    const current = await measure('origin', () => inspectExternalMergeCheckout(target, Object.values(state.agents)));
    if (current.reason) return refuse(current.reason);
    if (JSON.stringify(current.target) !== JSON.stringify(target)) return refuse('lease-target-changed');
    if (await resolveOwner() !== prepared.externalOwner) return refuse('external-owner-changed');
    if (clock.now() - provedAt >= ADMISSION_QUEUE_TIMEOUT_MS) return refuse('external-proof-expired');
    if (action === 'prepare') return prepare(state, save, repository, { kind: 'external', externalOwner: prepared.externalOwner, target });
    if (held?.kind === 'external' && held.externalOwner === prepared.externalOwner && !expired(held)) {
      if (JSON.stringify(held.target) !== JSON.stringify(target)) return refuse('lease-target-changed');
      return { admitted: true, token: held.token, repository, headSha: target.headSha, baseSha: target.baseSha, baseBranch: target.baseBranch };
    }
    if (action === 'check') return refuse('lease-expired');
    const admission = await admit(state, save, repository, { kind: 'external', externalOwner: prepared.externalOwner, target }, measure);
    return admission.admitted ? { ...admission, headSha: target.headSha, baseSha: target.baseSha, baseBranch: target.baseBranch } : admission;
  }, operation);
}
