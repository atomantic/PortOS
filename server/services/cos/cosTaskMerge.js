/**
 * CoS Task Merge — claim-aware per-task LWW for cross-peer federation
 *
 * Both full-sync peers mutate the live task queues, and each task carries
 * claim/lease metadata, so a whole-file last-writer-wins would clobber a peer's
 * fresh claim and re-introduce double-spawn. Tasks are merged per id instead.
 *
 * Pure: `mergeTaskLists(local, remote, { now })` takes two arrays of parsed tasks
 * (taskParser shape) and returns the merged array. Persistence and the wire fetch
 * live in the callers (cosTaskStore.mergePeerTasks, peerSync.syncCosTasksFromPeer).
 *
 * Merge rules (identical on both peers so they converge regardless of who sweeps):
 *
 *  1. Union by id. Deletes do NOT propagate (LWW-per-id everywhere in PortOS): a
 *     task is removed by moving it to `completed`, never by dropping the line, or
 *     it would resurrect from the peer on the next sweep.
 *
 *  2. For a task on both sides the higher lifecycle status wins the CONTENT
 *     (pending -> in_progress -> challenged -> completed|blocked), so completion
 *     converges (the owner strips its claim on completion, so a claim alone can't
 *     carry that signal). Two pairings run backward in rank and are exempt:
 *     anything-vs-`challenged` is decided by newest `updatedAt`, and
 *     `in_progress`-vs-`pending` by whether the requeue postdates the spawn. See
 *     pickContentBase.
 *
 *  3. CLAIM metadata resolves independently of content via the live lease: a side
 *     holding an unexpired lease is authoritative so the other peer's spawn guard
 *     yields. If both are live (the sub-second race the lease only narrows), the
 *     later `leaseExpiresAt`, then smaller `claimedBy`, wins so both peers pick the
 *     same owner. A terminal (completed/blocked) task never keeps a claim.
 *
 *  4. After the per-id merge, collapse same-`investigationFingerprint` OPEN
 *     investigation duplicates: two peers can each mint one before the next sweep
 *     and rule 1 keeps both. Keep the `in_progress` copy (never orphan a running
 *     investigation) or else the older/lower-id copy, union every duplicate's
 *     `metadata.affectedTasks` onto it, and flip the other open copies to
 *     `completed` (never delete; a terminal status converges via rule 2).
 *
 *     The survivor keys on the `in_progress` STATUS, not lease liveness: status
 *     replicates via rule 2's rank, whereas a peer seeing a stale lease as expired
 *     could flip a running investigation to `completed`. Still best-effort across
 *     >=3 peers (a pre-claim snapshot can supersede a running copy); acceptable
 *     because investigations are approval-gated diagnostics bounded to one per
 *     peer per cause.
 *
 *  5. SPAWN accounting (`totalSpawnCount`, `lastSpawnedAt`) resolves independently
 *     of content, like the claim: it follows the later dispatch. An edit made on a
 *     copy that predates a dispatch wins the content by its newer `updatedAt`, and
 *     would otherwise carry its older, lower count back and refund spawns the cap
 *     already charged. For the same dispatch the lower count wins, because the
 *     store lets a count fall below what its dispatch charged only through an
 *     explicit reset, so that reset propagates. The pair is a maximum over one
 *     total order, so the result does not depend on which copies meet first.
 */

import { isLeaseLive, getClaimOwner, CLAIM_METADATA_KEYS, parseTimestampMs } from './cosTaskClaim.js';
// Import from taskParser, not cosTaskStore: the store imports THIS module, so
// that would be a circular import.
import { PRIORITY_VALUES } from '../../lib/taskParser.js';
import { isPostSpawnRequeue } from '../../lib/taskRequeue.js';
import { isTerminalTaskStatus } from '../../lib/taskStatusTransition.js';

// Lifecycle rank — higher wins the content tiebreak (rule 2). Distinct ranks so two
// different statuses never tie; the only tie is same-status, where content is equivalent.
//
// `challenged` is non-terminal (keeps a live claim like in_progress) and its rank is
// only a fallback: the challenge lifecycle is non-monotonic, so pickContentBase decides
// any pairing with exactly one `challenged` side by newest `updatedAt`, with
// `completed` immune.
//
// `in_progress`/`pending` carries a narrower caveat: a `pending` side wins only when its
// requeue stamp postdates the other side's spawn; otherwise this rank applies, so an
// ordinary edit on a stale `pending` copy never reverts a running task.
const STATUS_RANK = Object.freeze({ completed: 5, blocked: 4, challenged: 3, in_progress: 2, pending: 1 });
const statusRank = (status) => STATUS_RANK[status] || 0;

// Metadata key of a task's content-edit timestamp: the same-status LWW key. Excluded
// from the content signature like claim metadata.
const EDIT_STAMP_KEY = 'updatedAt';

// Epoch ms of `metadata.updatedAt`, or -Infinity when absent/unparseable, so any real
// stamp beats a legacy un-stamped task ("absent = oldest").
const updatedAtMs = (task) => {
  const ms = parseTimestampMs(task?.metadata?.[EDIT_STAMP_KEY]);
  return ms === null ? -Infinity : ms;
};

const leaseMs = (metadata) => parseTimestampMs(metadata?.leaseExpiresAt);

// The spawn stamp and the count it charged, kept together (rule 5).
const SPAWN_ACCOUNTING_KEYS = Object.freeze(['totalSpawnCount', 'lastSpawnedAt']);

const spawnedAtMs = (task) => parseTimestampMs(task.metadata?.lastSpawnedAt) ?? -Infinity;
const spawnCount = (task) => Number(task.metadata?.totalSpawnCount) || 0;

/** The side whose spawn accounting stands (rule 5), or null when both sides agree. */
function spawnAccountingOwner(local, remote) {
  const localAt = spawnedAtMs(local);
  const remoteAt = spawnedAtMs(remote);
  if (localAt !== remoteAt) return localAt > remoteAt ? local : remote;
  const localCount = spawnCount(local);
  const remoteCount = spawnCount(remote);
  if (localCount !== remoteCount) return localCount < remoteCount ? local : remote;
  return null;
}

/** Authoritative claim triple (claimedBy/claimedAt/leaseExpiresAt) for a task on both sides, or null when neither lease is live. */
function resolveClaim(local, remote, now) {
  const localLive = isLeaseLive(local.metadata, now);
  const remoteLive = isLeaseLive(remote.metadata, now);
  if (localLive && remoteLive) {
    // Deterministic, side-independent winner: later lease, then smaller claimedBy.
    const lExp = leaseMs(local.metadata) ?? 0;
    const rExp = leaseMs(remote.metadata) ?? 0;
    if (lExp !== rExp) return claimTriple(lExp > rExp ? local : remote);
    const lOwner = getClaimOwner(local.metadata) || '';
    const rOwner = getClaimOwner(remote.metadata) || '';
    if (lOwner !== rOwner) return claimTriple(lOwner < rOwner ? local : remote);
    // Same owner and expiry: `claimedAt` can still differ (re-claim), and picking
    // "local" would leave each peer with a different triple forever. Earliest wins.
    const lAt = parseTimestampMs(local.metadata?.claimedAt);
    const rAt = parseTimestampMs(remote.metadata?.claimedAt);
    if (lAt === rAt) return claimTriple(local);
    if (lAt === null) return claimTriple(remote);
    if (rAt === null) return claimTriple(local);
    return claimTriple(lAt < rAt ? local : remote);
  }
  if (localLive) return claimTriple(local);
  if (remoteLive) return claimTriple(remote);
  return null;
}

function claimTriple(task) {
  const out = {};
  for (const key of CLAIM_METADATA_KEYS) {
    if (task.metadata?.[key] != null) out[key] = task.metadata[key];
  }
  return out;
}

/**
 * Choose the content base for a task on both sides: higher lifecycle status wins
 * (rule 2); on a same-status tie newest `updatedAt` wins; then higher priority, then a
 * canonical content signature. Symmetric in (local, remote) so both peers converge on
 * the same record; convergence is the load-bearing property, `updatedAt` just makes
 * the tiebreak newest-wins when a real stamp exists.
 */
function pickContentBase(local, remote) {
  // Challenge lifecycle is non-monotonic: `upheld` regresses `challenged` -> `pending`,
  // and a challenge can be raised on `blocked`. A rank comparison would let a stale
  // `challenged` snapshot permanently revert a newer resolution, so when exactly one
  // side is `challenged` newest edit decides.
  const lChallenged = local.status === 'challenged';
  const rChallenged = remote.status === 'challenged';
  if (lChallenged !== rChallenged) {
    // `completed` never regresses, even against a newer `challenged` snapshot.
    // `blocked` stays on the timestamp path (re-dispute and escalation are both legal).
    if (local.status === 'completed') return local;
    if (remote.status === 'completed') return remote;
    const luc = updatedAtMs(local);
    const ruc = updatedAtMs(remote);
    if (luc !== ruc) return ruc > luc ? remote : local;
    // Equal/absent stamps: prefer the resolved (non-challenged) side.
    return lChallenged ? remote : local;
  }
  // `in_progress` -> `pending` (requeue) is the other non-monotonic transition: a stale
  // pre-requeue `in_progress` snapshot would revert it and discard the resume pointer
  // (`existingBranch` / `resumeWorktreePath`). The exemption is causal, not recency: an
  // ordinary edit landing on a stale `pending` copy must not revert a running task, so
  // `pending` wins only when its requeue stamp is strictly newer than the spawn
  // (`isPostSpawnRequeue`); otherwise fall through to rank.
  if (isPostSpawnRequeue(local, remote)) return local;
  if (isPostSpawnRequeue(remote, local)) return remote;
  const lr = statusRank(local.status);
  const rr = statusRank(remote.status);
  if (rr !== lr) return rr > lr ? remote : local;
  // Same status: newest edit wins (absent stamp = oldest).
  const lu = updatedAtMs(local);
  const ru = updatedAtMs(remote);
  if (lu !== ru) return ru > lu ? remote : local;
  const lp = PRIORITY_VALUES[local.priority] || 0;
  const rp = PRIORITY_VALUES[remote.priority] || 0;
  if (lp !== rp) return rp > lp ? remote : local;
  // Same status + priority: break the tie over all non-claim content (every key affects
  // spawning) via a canonical signature so a content-only edit converges.
  const ls = contentSignature(local);
  const rs = contentSignature(remote);
  if (ls === rs) return local; // identical content — keep local (no-op)
  return rs > ls ? remote : local;
}

/**
 * Canonical, side-independent signature of a task's editable content, excluding claim
 * keys, for the same-status/same-priority tie. Metadata keys are sorted.
 */
function contentSignature(task) {
  const md = (task.metadata && typeof task.metadata === 'object') ? task.metadata : {};
  const nonClaim = {};
  for (const key of Object.keys(md).sort()) {
    // Exclude claim metadata and the edit stamp (already consumed as the LWW key).
    if (CLAIM_METADATA_KEYS.includes(key) || key === EDIT_STAMP_KEY) continue;
    nonClaim[key] = md[key];
  }
  return JSON.stringify([
    task.description || '',
    task.approvalRequired ?? null,
    task.autoApproved ?? null,
    nonClaim,
  ]);
}

/** Merge one task that exists on both sides into a single record. */
function mergeOne(local, remote, now) {
  // (rule 2) content base.
  const base = pickContentBase(local, remote);

  // (rule 3) claim resolved separately so a live claim propagates even when content came
  // from the other side — EXCEPT when the winner is a requeue: updateTask releases the
  // claim in the write that leaves `in_progress`, so the counterpart's pre-requeue lease
  // belongs to the retired run and must not be re-imposed. A claim held by the winning
  // `pending` side is kept (dispatch takes the lease before flipping to `in_progress`).
  const counterpart = base === local ? remote : local;
  const claim = isPostSpawnRequeue(base, counterpart)
    ? (isLeaseLive(base.metadata, now) ? claimTriple(base) : null)
    : resolveClaim(local, remote, now);

  // Re-apply the resolved live claim, never on a terminal status.
  const metadata = { ...(base.metadata || {}) };
  for (const key of CLAIM_METADATA_KEYS) delete metadata[key];
  if (claim && !isTerminalTaskStatus(base.status)) Object.assign(metadata, claim);

  // (rule 5) spawn accounting from the later dispatch, or its reset.
  const accounting = spawnAccountingOwner(local, remote);
  if (accounting && accounting !== base) {
    for (const key of SPAWN_ACCOUNTING_KEYS) {
      if (accounting.metadata?.[key] == null) delete metadata[key];
      else metadata[key] = accounting.metadata[key];
    }
  }

  return { ...base, metadata };
}

/**
 * Normalize a record adopted from the peer. Wire entries carry no `priorityValue`, which
 * `sortByPriority` reads (undefined sorts as NaN and churns order), so re-derive it.
 * `metadata` is optional on the wire but `generateTasksMarkdown` does
 * `Object.entries(task.metadata)`; a throw there would fail the whole file merge on
 * every sweep, so default it to an object.
 */
function normalizeAdopted(task) {
  return {
    ...task,
    priorityValue: PRIORITY_VALUES[task.priority] || 2,
    metadata: (task.metadata && typeof task.metadata === 'object') ? task.metadata : {},
  };
}

// (rule 4) Statuses at which an investigation is still OPEN. MUST mirror
// agentErrorAnalysis.OPEN_INVESTIGATION_STATUSES (importing it would cycle through
// cosTaskStore). Includes `blocked`: a blocked investigation still tracks its cause, so
// the terminal set would let blocked duplicates escape. Only `completed` is settled,
// which keeps the pass idempotent.
const OPEN_INVESTIGATION_STATUSES = new Set(['pending', 'in_progress', 'challenged', 'blocked']);
const isOpenInvestigation = (task) => OPEN_INVESTIGATION_STATUSES.has(task.status);

// Status an OPEN loser is flipped to; `supersededBy` marks it so the collapse is
// auditable and idempotent.
const SUPERSEDED_STATUS = 'completed';
const SUPERSEDED_BY_KEY = 'supersededBy';

// Metadata marker every investigation task carries; only these are ever collapsed.
const FINGERPRINT_KEY = 'investigationFingerprint';
const AFFECTED_TASKS_KEY = 'affectedTasks';

const affectedTaskIds = (task) => {
  const arr = task?.metadata?.[AFFECTED_TASKS_KEY];
  return Array.isArray(arr) ? arr.filter((id) => typeof id === 'string' && id) : [];
};

/**
 * Choose the surviving row among the OPEN copies of one fingerprint. An `in_progress`
 * copy wins so a running investigation is never orphaned; with more than one, return
 * null and skip this sweep (both finish and the group self-heals). Otherwise the
 * lower id wins (ids embed a base36 creation timestamp), side-independent. Keys on
 * status, not lease liveness: see the rule-4 note in the module header.
 */
function pickInvestigationSurvivor(openCopies) {
  const active = openCopies.filter((t) => t.status === 'in_progress');
  if (active.length > 1) return null;
  if (active.length === 1) return active[0];
  return openCopies.reduce((a, b) => (a.id <= b.id ? a : b));
}

/** (rule 4) Collapse same-fingerprint OPEN duplicates. Pure; deterministic over the converged per-id output. */
function dedupeInvestigations(tasks) {
  const groups = new Map();
  for (const t of tasks) {
    const fp = t?.metadata?.[FINGERPRINT_KEY];
    if (typeof fp !== 'string' || !fp) continue;
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(t);
  }

  const rewrites = new Map(); // original task ref -> replacement
  for (const group of groups.values()) {
    const open = group.filter(isOpenInvestigation);
    if (open.length === 0) continue;
    // Act on an open duplicate, or re-fold a prior collapse whose survivor a per-id LWW
    // may have reverted to a partial affectedTasks set.
    const collapsedBefore = group.some((t) => t?.metadata?.[SUPERSEDED_BY_KEY]);
    if (open.length < 2 && !collapsedBefore) continue;

    const survivor = pickInvestigationSurvivor(open);
    if (!survivor) continue; // multiple in-flight copies — don't orphan; wait a sweep

    // Union affectedTasks across every copy; sorted so both peers serialize the same set.
    const affected = new Set();
    for (const t of group) for (const id of affectedTaskIds(t)) affected.add(id);
    const unionAffected = [...affected].sort();

    const currentAffected = affectedTaskIds(survivor);
    const affectedChanged =
      unionAffected.length !== currentAffected.length ||
      unionAffected.some((id, i) => id !== currentAffected[i]);

    // Also list peer-contributed ids in the DESCRIPTION (readers and "What unblocks" use
    // the body). Append only ids not already present, in sorted order, with no
    // agentId/timestamp, so both peers reach an identical body.
    const currentDesc = survivor.description || '';
    const missingMentions = unionAffected.filter((id) => !currentDesc.includes(`\`${id}\``));
    const appended = missingMentions
      .map((id) => `\n- Also blocks task \`${id}\` (same cause; merged across federated peers).`)
      .join('');
    const newDesc = currentDesc + appended;

    if ((affectedChanged || appended) && unionAffected.length > 0) {
      rewrites.set(survivor, {
        ...survivor,
        description: newDesc,
        metadata: { ...(survivor.metadata || {}), [AFFECTED_TASKS_KEY]: unionAffected },
      });
    }

    for (const loser of open) {
      if (loser === survivor) continue;
      const metadata = { ...(loser.metadata || {}) };
      for (const key of CLAIM_METADATA_KEYS) delete metadata[key]; // terminal → no claim
      metadata[SUPERSEDED_BY_KEY] = survivor.id;
      rewrites.set(loser, { ...loser, status: SUPERSEDED_STATUS, metadata });
    }
  }

  if (rewrites.size === 0) return tasks;
  return tasks.map((t) => rewrites.get(t) || t);
}

/**
 * Merge a peer's task list into the local one. Pure: returns a new array, never
 * mutates the inputs. `now` is injectable for deterministic tests.
 *
 * @param {Array} localTasks  parsed local tasks (taskParser shape)
 * @param {Array} remoteTasks parsed peer tasks (same shape; wire-validated)
 * @returns {Array} merged tasks
 */
export function mergeTaskLists(localTasks, remoteTasks, { now = Date.now() } = {}) {
  const local = Array.isArray(localTasks) ? localTasks : [];
  const remote = Array.isArray(remoteTasks) ? remoteTasks : [];
  const remoteById = new Map();
  for (const r of remote) {
    if (r && typeof r.id === 'string' && r.id) remoteById.set(r.id, r);
  }

  const merged = [];
  const seen = new Set();
  for (const l of local) {
    if (!l || typeof l.id !== 'string' || !l.id || seen.has(l.id)) continue;
    seen.add(l.id);
    const r = remoteById.get(l.id);
    if (!r) { merged.push(l); continue; }
    merged.push(normalizeAdopted(mergeOne(l, r, now)));
  }
  // Remote-only tasks — adopt so the backlog replicates both directions.
  for (const r of remote) {
    if (!r || typeof r.id !== 'string' || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    merged.push(normalizeAdopted(r));
  }
  // (rule 4)
  return dedupeInvestigations(merged);
}
