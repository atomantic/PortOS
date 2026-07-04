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
 *     only ever advances pending → in_progress → (completed|blocked), so the
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
 */

import { isLeaseLive, getClaimOwner, CLAIM_METADATA_KEYS, parseTimestampMs } from './cosTaskClaim.js';
// Import from taskParser (the lowest task module) rather than cosTaskStore: the
// store imports THIS module for mergeTaskLists, so pulling its PRIORITY_VALUES
// here would form a circular import. taskParser has no cos-module deps.
import { PRIORITY_VALUES } from '../lib/taskParser.js';

// Lifecycle rank — higher wins the content tiebreak (rule 2). Each status has a
// distinct rank so two DIFFERENT statuses never tie (full convergence); the only
// genuine tie is same-status-both-sides, where the content is already equivalent.
const STATUS_RANK = Object.freeze({ completed: 4, blocked: 3, in_progress: 2, pending: 1 });
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
  return merged;
}
