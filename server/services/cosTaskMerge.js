/**
 * CoS Task Merge — claim-aware per-task LWW for cross-peer federation (#1712)
 *
 * The second half of #1650: where the completed-agent HISTORY federates as pure
 * append-only byte replication, the live task files (data/COS-TASKS.md /
 * data/TASKS.md) are the opposite — BOTH full-sync peers mutate them, and each
 * task carries claim/lease metadata (`claimedBy`/`claimedAt`/`leaseExpiresAt`
 * from #1563). A naive whole-file last-writer-wins would clobber a peer's fresh
 * claim and re-introduce the exact double-spawn hazard the lease exists to
 * prevent. So a peer's task list is merged into the local one per task, not
 * copied over it.
 *
 * Pure + side-effect-free: `mergeTaskLists(local, remote, { now })` takes two
 * arrays of parsed tasks (taskParser.parseTasksMarkdown shape) and returns the
 * merged array. Persistence + the wire fetch live in the callers
 * (cosTaskStore.mergePeerTasks, peerSync.syncCosTasksFromPeer).
 *
 * Merge rules (run identically on BOTH peers so they converge to the same
 * result regardless of which side initiates the sweep):
 *
 *  1. Union by id. A task present on only one side is kept as-is — that's how
 *     each peer learns the other's backlog. (Deletes do NOT propagate, matching
 *     PortOS's LWW-per-id model everywhere else — a task is "removed" by moving
 *     it to `completed`, never by dropping the line; an omitted id would just
 *     resurrect from the peer on the next sweep. See cosTaskStore.deleteTask.)
 *
 *  2. For a task on BOTH sides, choose the CONTENT by lifecycle rank: a task
 *     advances pending → in_progress → (challenged) → (completed|blocked), so the
 *     higher-ranked status is the newer truth and wins. This makes completion
 *     converge: once either peer marks a task done, the other adopts it instead
 *     of holding it `in_progress` forever (a live claim alone can't carry that
 *     signal — the owner strips the claim when it completes).
 *
 *  3. Resolve the CLAIM metadata independently of content via the live lease:
 *     a side holding an unexpired lease is authoritative (the other peer must
 *     see that claim so its spawn guard yields). If BOTH hold a live lease (the
 *     sub-second claim race the lease only narrows, never eliminates), break the
 *     tie deterministically — later `leaseExpiresAt`, then smaller `claimedBy` —
 *     so both peers pick the SAME owner and the loser yields on its next spawn
 *     guard. A claim is never kept on a terminal (completed/blocked) task —
 *     that mirrors cosTaskStore's release-on-transition so a finished task is
 *     freely re-claimable.
 *
 *  4. After the per-id merge, collapse same-`investigationFingerprint` OPEN
 *     investigation duplicates (#2628). The per-process fingerprint dedup in
 *     agentErrorAnalysis (#2615) is serialized on a module-level tail, so a single
 *     install never mints two open investigations for one failure cause — but two
 *     federated peers can each mint one before the next sweep, and rule 1's
 *     union-by-id keeps BOTH. A deterministic, side-independent post-pass folds
 *     them to a single active row: keep the copy that is `in_progress` (an agent
 *     is running it — never orphan an in-flight investigation) or, when none is,
 *     the older/lower-id copy; union every duplicate's `metadata.affectedTasks`
 *     onto it, and flip the other open copies to `completed` (never delete — LWW
 *     sync never propagates deletions; a terminal status converges via rule 2's
 *     status rank). Runs identically on both peers over the converged per-id set,
 *     so they reach the same single survivor regardless of which side sweeps.
 *
 *     The no-orphan guarantee keys on the `in_progress` STATUS rather than lease
 *     liveness on purpose: status propagates through rule 2's rank, so once both
 *     peers have the converged view they agree an actively-worked copy is the
 *     survivor even if its lease timestamp hasn't replicated yet — whereas keying
 *     on `isLeaseLive` would let a peer whose copy still shows an (unexpired-
 *     elsewhere) lease as expired flip a running investigation to `completed`. It
 *     is still best-effort across ≥3 peers: a peer holding a pre-claim snapshot
 *     (never yet saw the `in_progress` transition) can supersede a copy another
 *     peer is running. That residual race is acceptable — investigation tasks are
 *     approval-gated diagnostics that execute nothing on their own, and the storm
 *     is already bounded to at most one per peer per cause.
 */

import { isLeaseLive, getClaimOwner, CLAIM_METADATA_KEYS, parseTimestampMs } from './cosTaskClaim.js';
// Import from taskParser (the lowest task module) rather than cosTaskStore: the
// store imports THIS module for mergeTaskLists, so pulling its PRIORITY_VALUES
// here would form a circular import. taskParser has no cos-module deps.
import { PRIORITY_VALUES } from '../lib/taskParser.js';

// Lifecycle rank — higher wins the content tiebreak (rule 2). Each status has a
// distinct rank so two DIFFERENT statuses never tie (full convergence); the only
// genuine tie is same-status-both-sides, where the content is already equivalent.
//
// `challenged` (#2441) is placed above in_progress and below the terminal states,
// but NOTE its rank is only a fallback: the challenge lifecycle is non-monotonic
// (upheld regresses challenged→pending; blocked↔challenged both directions are
// legal), so `pickContentBase` resolves any pairing where exactly one side is
// `challenged` by newest `updatedAt` — NOT by this rank — with `completed` held
// immune there. This rank still governs challenged-vs-challenged-adjacent cases
// that never actually arise (both-challenged goes to the same-status path). It is
// NOT terminal (the dispute resolves back to pending or forward to blocked), so it
// keeps a live claim the same way in_progress does.
const STATUS_RANK = Object.freeze({ completed: 5, blocked: 4, challenged: 3, in_progress: 2, pending: 1 });
const statusRank = (status) => STATUS_RANK[status] || 0;
const isTerminalStatus = (status) => status === 'completed' || status === 'blocked';

// The metadata key carrying a task's content-edit timestamp (#1714). Stamped in
// cosTaskStore's write paths on every content edit and used here as the
// same-status LWW key. Excluded from the content signature (it's the edit *key*,
// not content) the same way claim metadata is.
const EDIT_STAMP_KEY = 'updatedAt';

// Epoch ms of a task's content-edit stamp (`metadata.updatedAt`), or -Infinity
// when absent/unparseable. -Infinity (not 0) so ANY real stamp beats a legacy
// task that predates the field — an older peer that never stamps always loses a
// same-status tie to a peer that did ("absent = oldest"), and two un-stamped
// sides compare equal and fall through to the deterministic comparator.
const updatedAtMs = (task) => {
  const ms = parseTimestampMs(task?.metadata?.[EDIT_STAMP_KEY]);
  return ms === null ? -Infinity : ms;
};

const leaseMs = (metadata) => parseTimestampMs(metadata?.leaseExpiresAt);

/**
 * Pick the authoritative claim metadata for a task present on both sides, or
 * null when neither side holds a live lease. Returns just the claim triple
 * (claimedBy/claimedAt/leaseExpiresAt), never the full task.
 */
function resolveClaim(local, remote, now) {
  const localLive = isLeaseLive(local.metadata, now);
  const remoteLive = isLeaseLive(remote.metadata, now);
  if (localLive && remoteLive) {
    // Both claimed — deterministic, side-independent winner so the two peers
    // converge on one owner. Later lease wins (the most-recently-renewed claim
    // is the live worker); exact-tie falls back to the smaller claimedBy.
    const lExp = leaseMs(local.metadata) ?? 0;
    const rExp = leaseMs(remote.metadata) ?? 0;
    if (lExp !== rExp) return claimTriple(lExp > rExp ? local : remote);
    const lOwner = getClaimOwner(local.metadata) || '';
    const rOwner = getClaimOwner(remote.metadata) || '';
    return claimTriple(lOwner <= rOwner ? local : remote);
  }
  if (localLive) return claimTriple(local);
  if (remoteLive) return claimTriple(remote);
  return null;
}

function claimTriple(task) {
  const out = {};
  for (const key of CLAIM_METADATA_KEYS) {
    if (task.metadata?.[key] !== undefined) out[key] = task.metadata[key];
  }
  return out;
}

/**
 * Choose the content base for a task on both sides. Higher lifecycle status wins
 * (rule 2). On a SAME-status tie, newest-EDIT wins via the per-task `updatedAt`
 * stamp (#1714): the side whose content was edited most recently is authoritative.
 * The stamp is threaded through cosTaskStore's write paths, so a same-status
 * content edit (priority/description/approval/metadata) on one machine carries a
 * larger `updatedAt` and is adopted by the other. This is symmetric — machine A
 * compares (A,B) and machine B compares (B,A), both prefer the larger stamp, so
 * they converge on the SAME record regardless of which side initiates the sweep.
 *
 * When the stamps tie (equal, or both absent on legacy/older-peer tasks) we fall
 * back to a deterministic, side-independent comparator — higher priority, then a
 * canonical content signature — so a content edit still converges even with no
 * usable timestamp. Convergence is the load-bearing property; `updatedAt` just
 * upgrades the tiebreak from "deterministic" to "deterministic AND newest-wins"
 * whenever a real stamp is present.
 */
function pickContentBase(local, remote) {
  // Challenge lifecycle is NOT monotonic (#2441): an `upheld` resolution regresses
  // `challenged` → `pending`, and a challenge can be raised on a `blocked` task —
  // both BACKWARD in status rank. A pure status-rank comparison would let a stale
  // `challenged` snapshot on the other peer permanently revert a newer resolution
  // (rank 3 beats pending rank 1) and never converge. So when EXACTLY one side is
  // `challenged`, decide by newest edit instead — every challenge write goes
  // through updateTask and bumps `updatedAt`, so both the dispute and its
  // resolution propagate by recency. This is symmetric (depends only on the pair),
  // so both peers converge on the same record.
  const lChallenged = local.status === 'challenged';
  const rChallenged = remote.status === 'challenged';
  if (lChallenged !== rChallenged) {
    // `completed` is truly terminal and must NEVER regress — once either peer
    // marks a task done, the other adopts it (rule 2 monotonic completion). So a
    // `completed` counterpart wins outright, even against a newer `challenged`
    // snapshot the other peer raised before completion propagated. `blocked` stays
    // on the timestamp path below: blocked→challenged (re-dispute) and
    // challenged→blocked (escalation) are both legal, so recency decides.
    if (local.status === 'completed') return local;
    if (remote.status === 'completed') return remote;
    const luc = updatedAtMs(local);
    const ruc = updatedAtMs(remote);
    if (luc !== ruc) return ruc > luc ? remote : local;
    // Equal/absent stamps (legacy un-stamped peer): prefer the RESOLVED
    // (non-challenged) side so an overturn still converges deterministically.
    return lChallenged ? remote : local;
  }
  const lr = statusRank(local.status);
  const rr = statusRank(remote.status);
  if (rr !== lr) return rr > lr ? remote : local;
  // Same lifecycle status: newest content edit wins (absent stamp = oldest).
  const lu = updatedAtMs(local);
  const ru = updatedAtMs(remote);
  if (lu !== ru) return ru > lu ? remote : local;
  const lp = PRIORITY_VALUES[local.priority] || 0;
  const rp = PRIORITY_VALUES[remote.priority] || 0;
  if (lp !== rp) return rp > lp ? remote : local;
  // Same status + priority: break the tie over ALL remaining editable content
  // (description, approval flags, AND non-claim metadata — `app`, `context`,
  // `reviewers`, `useWorktree`, … which all affect how a task is spawned) via a
  // canonical, side-independent signature so a content-only edit converges.
  // Claim metadata is excluded — it's resolved separately by lease in resolveClaim.
  const ls = contentSignature(local);
  const rs = contentSignature(remote);
  if (ls === rs) return local; // identical content — keep local (no-op)
  return rs > ls ? remote : local;
}

/**
 * Canonical, side-independent signature of a task's editable content used to
 * break a same-status/same-priority merge tie. Sorts metadata keys (so two
 * representations of the same logical metadata compare equal) and excludes the
 * claim keys (resolved separately by lease). Two machines computing this over the
 * same pair therefore pick the same winner, so a content-only edit converges.
 */
function contentSignature(task) {
  const md = (task.metadata && typeof task.metadata === 'object') ? task.metadata : {};
  const nonClaim = {};
  for (const key of Object.keys(md).sort()) {
    // Exclude claim metadata (resolved separately by lease) AND the edit stamp
    // (it's the LWW key consumed in pickContentBase before we ever reach the
    // signature — including it here would just re-introduce a timestamp into the
    // "content" comparison the signature is meant to isolate).
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

/**
 * Merge one task that exists on both sides into a single record.
 */
function mergeOne(local, remote, now) {
  // (rule 2) content base — higher lifecycle status wins; a same-status tie is
  // broken deterministically so both peers converge (see pickContentBase).
  const base = pickContentBase(local, remote);

  // (rule 3) claim metadata resolved separately so a live claim propagates even
  // when content came from the other side.
  const claim = resolveClaim(local, remote, now);

  // Strip any claim keys from the base's metadata, then re-apply the resolved
  // live claim — unless the merged status is terminal, where a claim must never
  // linger (mirrors cosTaskStore release-on-transition).
  const metadata = { ...(base.metadata || {}) };
  for (const key of CLAIM_METADATA_KEYS) delete metadata[key];
  if (claim && !isTerminalStatus(base.status)) Object.assign(metadata, claim);

  return { ...base, metadata };
}

/**
 * Normalize a record adopted from the peer (a remote-only task, or a merged
 * record sourced from the remote side). Wire entries carry no `priorityValue`
 * (it's derivable), but `generateTasksMarkdown` orders each section via
 * `sortByPriority`, which reads `priorityValue` — so an undefined value would
 * sort as NaN and churn the output order. Re-derive it from the (authoritative)
 * `priority` string. `section` is left as-is: the generator buckets purely by
 * `status`, so it never reads `section`.
 *
 * Also guarantees `metadata` is an object: the wire schema marks it optional, so
 * a cross-version / forked peer can legitimately advertise a task with no
 * metadata. `generateTasksMarkdown` does `Object.entries(task.metadata)`, which
 * throws on undefined — and that throw would fail the WHOLE file merge (not just
 * the one task) on every sweep, permanently stalling convergence. Default it.
 */
function normalizeAdopted(task) {
  return {
    ...task,
    priorityValue: PRIORITY_VALUES[task.priority] || 2,
    metadata: (task.metadata && typeof task.metadata === 'object') ? task.metadata : {},
  };
}

// (rule 4) The terminal status an OPEN investigation loser is flipped to when a
// same-fingerprint winner is chosen. `completed` (not `blocked`) — the duplicate
// is subsumed, not stuck; it needs no further work. Marked with `supersededBy` so
// the collapse is auditable and the pass stays idempotent (a superseded copy is
// terminal, so it never re-enters the open-duplicate set on the next sweep).
const SUPERSEDED_STATUS = 'completed';
const SUPERSEDED_BY_KEY = 'supersededBy';

// The metadata marker every investigation task carries (#2615). Grouping keys off
// this so only real investigation duplicates are ever collapsed.
const FINGERPRINT_KEY = 'investigationFingerprint';
const AFFECTED_TASKS_KEY = 'affectedTasks';

const affectedTaskIds = (task) => {
  const arr = task?.metadata?.[AFFECTED_TASKS_KEY];
  return Array.isArray(arr) ? arr.filter((id) => typeof id === 'string' && id) : [];
};

/**
 * Choose the surviving row among the OPEN (non-terminal) copies of one
 * investigation fingerprint. An `in_progress` copy wins outright so an in-flight
 * investigation (an agent is running it) is never orphaned by the collapse; if
 * MORE than one is `in_progress` (two peers both spawned in the sub-second claim
 * window), return null to skip the collapse this sweep — both run to completion
 * and the group self-heals as each turns terminal, rather than killing a running
 * agent. With no `in_progress` copy, the older/lower-id copy wins deterministically
 * (investigation ids embed a base36 creation timestamp, so lower id == older),
 * side-independent so both peers agree.
 *
 * Keys on the `in_progress` STATUS, not lease liveness: the status replicates via
 * rule 2's rank, so a peer whose lease timestamp is stale still recognizes an
 * actively-worked copy and won't flip it to terminal. See the rule-4 note in the
 * module header for the residual (pre-claim-snapshot) race this narrows but can't
 * fully close across ≥3 peers.
 */
function pickInvestigationSurvivor(openCopies) {
  const active = openCopies.filter((t) => t.status === 'in_progress');
  if (active.length > 1) return null;
  if (active.length === 1) return active[0];
  return openCopies.reduce((a, b) => (a.id <= b.id ? a : b));
}

/**
 * (rule 4) Collapse same-fingerprint OPEN investigation duplicates that rule 1's
 * union-by-id let survive across two peers. Pure: returns a new array (new objects
 * only for the rows it rewrites), never mutates inputs. Deterministic over the
 * converged per-id merge output, so both peers reach the same single survivor.
 */
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
    const open = group.filter((t) => !isTerminalStatus(t.status));
    if (open.length === 0) continue;
    // Act on a genuine open duplicate, OR to re-fold a prior collapse whose
    // survivor a mid-propagation per-id LWW may have reverted to a partial
    // affectedTasks set (a terminal `supersededBy` sibling marks that history).
    const collapsedBefore = group.some((t) => t?.metadata?.[SUPERSEDED_BY_KEY]);
    if (open.length < 2 && !collapsedBefore) continue;

    const survivor = pickInvestigationSurvivor(open);
    if (!survivor) continue; // multiple in-flight copies — don't orphan; wait a sweep

    // Union affectedTasks across EVERY copy (open + already-superseded) so the one
    // surviving row names every task blocked on this cause. Sorted so both peers
    // serialize an identical set (their group order differs by local-first).
    const affected = new Set();
    for (const t of group) for (const id of affectedTaskIds(t)) affected.add(id);
    const unionAffected = [...affected].sort();

    const currentAffected = affectedTaskIds(survivor);
    const affectedChanged =
      unionAffected.length !== currentAffected.length ||
      unionAffected.some((id, i) => id !== currentAffected[i]);
    if (affectedChanged && unionAffected.length > 0) {
      rewrites.set(survivor, {
        ...survivor,
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
  // (rule 4) Collapse same-fingerprint OPEN investigation duplicates that the
  // per-id union above let survive across two peers (#2628).
  return dedupeInvestigations(merged);
}
