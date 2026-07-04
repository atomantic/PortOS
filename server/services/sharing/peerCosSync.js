/**
 * Federated peer-sync — CoS history + tasks sync (#1650).
 *
 * Advertises a CoS-history archive manifest and a CoS-tasks payload, and (for
 * full-sync peers) diffs + pulls missing archive bytes / merges task rows.
 * Reuses the shared in-flight-pull dedup set + capped-fetch helper from
 * `peerSyncAssets.js`.
 *
 * Split out of the former 4,004-line peerSync.js (#1830).
 */
import { join } from 'path';
import { existsSync } from 'fs';
import { readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { PATHS, atomicWrite, ensureDir, sha256File } from '../../lib/fileUtils.js';
import { isStr } from '../../lib/storyBible.js';
import { isPlainObject } from '../../lib/objects.js';
import { peerBaseUrl } from '../../lib/peerUrl.js';
import { peerFetch } from '../../lib/peerHttpClient.js';
import { withAbortTimeout } from '../../lib/abortTimeout.js';
import { PORTOS_SCHEMA_VERSIONS } from '../../lib/schemaVersions.js';
import { getPeers } from '../instances.js';
import {
  peerCosHistoryManifestSchema,
  peerCosTasksSchema,
  COS_ARCHIVE_DATE_RE,
  COS_AGENT_ID_RE,
  COS_ARCHIVE_FILES,
} from '../../lib/validation.js';
import {
  inflightPulls,
  inflightKey,
  fetchCappedAssetBuffer,
  ASSET_PULL_TIMEOUT_MS,
} from './peerSyncAssets.js';
import { findPeerById, FORCE_REVALIDATE_EVERY, peerSyncEvents } from './peerSyncShared.js';


// --- Completed-agent CoS history federation (#1650) ---------------------
//
// For a declared full-sync peer pair we mirror the STANDALONE completed-agent
// archive tree (data/cos/agents/<YYYY-MM-DD>/<agentId>/{metadata,output,prompt})
// so each peer's CoS history UI is a complete replica. Archives are immutable
// once written (an agent never re-completes; agentIds are globally unique), so
// this is pure append/union byte replication — no merge, no conflict.
//
// Shape mirrors the media-library sweep (#1566): the sender advertises a
// content-addressed manifest at GET /api/peer-sync/cos-history-manifest; a
// receiver (only for peers it flags fullSync) fetches it, diffs vs local disk,
// receiver-pulls the missing archive files via the nested-path byte route
// (GET /api/peer-sync/cos-agent-archive), then merges the lightweight
// agentId→date index so the history UI lists the arrivals. The pull/integrity
// path mirrors the Writers Room draft-body pull (nested paths, sha256-verified).
//
// Running-agent state (state.json slots), live PTY buffers, the in-flight
// spawningTasks guard, and worktree working dirs are deliberately NOT federated
// — only the date-bucketed COMPLETED archives.

// Resolved at CALL TIME (not module load) so a redirected PATHS — the test
// tmpdir pattern, consistent with mediaLibraryDirs reading PATHS live — is honored.
function cosAgentsDir() {
  return join(PATHS.cos, 'agents');
}

// Cap so a pathologically large history can't build an unbounded manifest. Each
// agent contributes up to 3 files; 150k entries ≈ 50k agents, far beyond any
// realistic single-user history. When exceeded we LOG + truncate (CLAUDE.md "no
// silent caps"). Kept in sync with the `entries` cap in peerCosHistoryManifestSchema.
// Chosen so the worst-case serialized manifest (~180 bytes/entry ≈ 27MB) stays
// UNDER COS_HISTORY_MANIFEST_MAX_BYTES below — otherwise this sender-side
// truncation never engages and a receiver instead rejects the whole manifest on
// its content-length check (mirrors media-library's 100k-entries-under-32MB).
const COS_HISTORY_MANIFEST_CAP = 150_000;
// The manifest JSON itself (not the archive bytes — those ride the per-file cap).
const COS_HISTORY_MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
// Per-archive-file hard cap. Agent transcripts (output.txt) can be large; 64MB is
// generous while still bounding a hostile/runaway peer. An oversized file is
// logged + skipped (it stays "missing" and is retried, never silently dropped).
const COS_ARCHIVE_PULL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Build the completed-agent history manifest this instance advertises to
 * full-sync peers. Walks data/cos/agents/<date>/<agentId>/, hashing each of the
 * three archive files that exist, and stamps a `manifestHash` over the sorted
 * entries so a receiver can short-circuit an unchanged history.
 *
 * @returns {Promise<{ schemaVersion:number, manifestHash:string, entries:Array }>}
 */
export async function buildCosHistoryManifest() {
  const root = cosAgentsDir();
  const entries = [];
  let truncated = false;
  // Top level: date buckets only. Skip index.json and any flat (running-agent)
  // dirs — only date-bucketed dirs hold COMPLETED archives.
  const dates = (await readdir(root).catch(() => [])).filter((d) => COS_ARCHIVE_DATE_RE.test(d));
  outer: for (const date of dates.sort()) {
    const dateDir = join(root, date);
    const agentIds = (await readdir(dateDir).catch(() => [])).filter((a) => COS_AGENT_ID_RE.test(a));
    for (const agentId of agentIds.sort()) {
      const agentDir = join(dateDir, agentId);
      for (const file of COS_ARCHIVE_FILES) {
        const full = join(agentDir, file);
        if (!existsSync(full)) continue;
        const sha256 = await sha256File(full).catch(() => null);
        if (!sha256) continue;
        if (entries.length >= COS_HISTORY_MANIFEST_CAP) { truncated = true; break outer; }
        entries.push({ date, agentId, file, sha256 });
      }
    }
  }
  if (truncated) {
    console.log(`⚠️ peerSync: cos-history manifest hit the ${COS_HISTORY_MANIFEST_CAP}-entry cap — truncating (some archives won't federate; pagination is a follow-up)`);
  }
  // Deterministic order so the manifestHash converges across machines regardless
  // of readdir order. (date, agentId already sorted above; sort by file too.)
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1
    : a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1
      : a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const manifestHash = createHash('sha256')
    .update(entries.map((e) => `${e.date}:${e.agentId}:${e.file}:${e.sha256}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosHistory, manifestHash, entries };
}

/**
 * Receiver-side: return the manifest entries whose local archive file is absent
 * or hash-mismatched. Re-validates every path segment (belt-and-suspenders
 * against a future refactor that bypasses the Zod schema) before any FS op.
 */
export async function diffCosHistoryManifestAgainstLocal(manifestEntries) {
  if (!Array.isArray(manifestEntries)) return [];
  const root = cosAgentsDir();
  const missing = [];
  for (const entry of manifestEntries) {
    if (!isPlainObject(entry)) continue;
    const { date, agentId, file, sha256 } = entry;
    if (!COS_ARCHIVE_DATE_RE.test(date || '') || !COS_AGENT_ID_RE.test(agentId || '') || !COS_ARCHIVE_FILES.includes(file)) continue;
    const full = join(root, date, agentId, file);
    if (!existsSync(full)) { missing.push(entry); continue; }
    const localHash = await sha256File(full).catch(() => null);
    if (localHash !== sha256) missing.push(entry);
  }
  return missing;
}

// Receiver-side state — mirrors the media-library sweep's bookkeeping.
const lastCosHistoryManifestHash = new Map(); // peerInstanceId → manifestHash
const cosHistoryUnchangedSkips = new Map(); // peerInstanceId → count
const cosHistorySweepInFlight = new Set(); // peerInstanceId

async function pullMissingCosArchives(senderInstanceId, missing) {
  if (!isStr(senderInstanceId) || !Array.isArray(missing) || missing.length === 0) return [];
  const peer = await findPeerById(senderInstanceId);
  if (!peer) {
    console.log(`⚠️ peerSync: can't pull cos archives — peer ${senderInstanceId} not in registry`);
    return [];
  }
  const base = peerBaseUrl(peer);
  const landed = [];
  for (const entry of missing) {
    const pair = await pullOneCosArchiveFile(peer, base, entry).catch((err) => {
      console.log(`⚠️ peerSync: cos-archive pull ${entry?.agentId}/${entry?.file} from ${peer.name || senderInstanceId} failed: ${err.message}`);
      return null;
    });
    if (pair) landed.push(pair);
  }
  return landed;
}

async function pullOneCosArchiveFile(peer, base, entry) {
  const { date, agentId, file, sha256 } = entry || {};
  // Re-validate segments here even though the diff already did.
  if (!COS_ARCHIVE_DATE_RE.test(date || '') || !COS_AGENT_ID_RE.test(agentId || '') || !COS_ARCHIVE_FILES.includes(file)) return null;
  const safeLabel = `${date}/${agentId}/${file}`;
  const key = inflightKey(peer.instanceId, 'cos-archive', safeLabel);
  if (inflightPulls.has(key)) return null;
  inflightPulls.add(key);
  try {
    const url = `${base}/api/peer-sync/cos-agent-archive?date=${encodeURIComponent(date)}&agentId=${encodeURIComponent(agentId)}&file=${encodeURIComponent(file)}`;
    // allowEmpty: output.txt / prompt.txt can legitimately be 0 bytes.
    const buffer = await fetchCappedAssetBuffer(peer, url, safeLabel, COS_ARCHIVE_PULL_MAX_BYTES, { allowEmpty: true });
    if (!buffer) return null;
    // Integrity: discard a corrupt/wrong download instead of writing it.
    const bufHash = createHash('sha256').update(buffer).digest('hex');
    if (bufHash !== sha256) {
      console.log(`⚠️ peerSync: cos archive ${safeLabel} hash mismatch — discarding (got ${bufHash.slice(0, 8)}, want ${String(sha256).slice(0, 8)})`);
      return null;
    }
    const destDir = join(cosAgentsDir(), date, agentId);
    await ensureDir(destDir);
    await atomicWrite(join(destDir, file), buffer);
    peerSyncEvents.emit('asset-arrived', { filename: safeLabel, kind: 'cos-archive', peerId: peer.instanceId });
    console.log(`📥 peerSync: pulled cos archive ${safeLabel} from ${peer.name || peer.instanceId} (${buffer.length} bytes)`);
    return { date, agentId };
  } finally {
    inflightPulls.delete(key);
  }
}

/**
 * Merge the manifest's completed-agent archives into the local agentId→date
 * index so the CoS history UI lists them. Called ONLY when the manifest's files
 * are confirmed present on disk (the diff returned empty), so every referenced
 * agent — including its metadata.json — exists; a half-pulled agent is never
 * indexed. Dynamic import keeps cosAgents out of peerSync's static graph (mirrors
 * reconcileMediaLibraryIndex). addAgentArchivesToIndex unions and never
 * overwrites a locally-owned id.
 */
async function reconcileCosHistoryIndex(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  // One {date, agentId} pair per agent (entries carry up to 3 files per agent).
  const seen = new Set();
  const pairs = [];
  for (const e of entries) {
    const key = `${e.date}/${e.agentId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ date: e.date, agentId: e.agentId });
  }
  const mod = await import('../cosAgents.js').catch(() => null);
  if (!mod?.addAgentArchivesToIndex) return;
  await mod.addAgentArchivesToIndex(pairs).catch((err) => {
    console.log(`⚠️ peerSync: cos-history index merge failed: ${err.message}`);
  });
}

/**
 * Receiver-pull the standalone completed-agent history from ONE full-sync peer.
 * Best-effort + idempotent (every guard returns rather than throws), mirroring
 * syncMediaLibraryFromPeer. No-op for a non-full-sync peer.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ pulled:number, skipped?:string, missing?:number }>}
 */
export async function syncCosHistoryFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { pulled: 0, skipped: 'not-fullsync' };
  }
  if (cosHistorySweepInFlight.has(peer.instanceId)) return { pulled: 0, skipped: 'in-flight' };
  cosHistorySweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/cos-history-manifest`;
    const res = await withAbortTimeout(ASSET_PULL_TIMEOUT_MS, (signal) =>
      peerFetch(url, { signal, maxBytes: COS_HISTORY_MANIFEST_MAX_BYTES }, peer))
      .catch(() => null);
    if (!res || !res.ok) return { pulled: 0, skipped: 'unreachable' };
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > COS_HISTORY_MANIFEST_MAX_BYTES) {
      console.log(`⚠️ peerSync: cos-history manifest from ${peer.name || peer.instanceId} too large (${declaredLen} > ${COS_HISTORY_MANIFEST_MAX_BYTES}) — skipping`);
      return { pulled: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerCosHistoryManifestSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: cos-history manifest from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { pulled: 0, skipped: 'invalid' };
    }
    const manifest = parsed.data;
    // Schema gate — GENTLE skip (not reject): wait for the local PortOS to
    // upgrade rather than mis-pull against a manifest shape we can't read.
    if (manifest.schemaVersion > PORTOS_SCHEMA_VERSIONS.cosHistory) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} cos-history manifest is schema v${manifest.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.cosHistory} — skipping until this instance updates`);
      return { pulled: 0, skipped: 'schema-ahead' };
    }
    // Unchanged short-circuit, with a periodic forced re-diff so a LOCAL file
    // loss self-heals even while the REMOTE manifest stays put.
    if (lastCosHistoryManifestHash.get(peer.instanceId) === manifest.manifestHash) {
      const skips = (cosHistoryUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        cosHistoryUnchangedSkips.set(peer.instanceId, skips);
        return { pulled: 0, skipped: 'unchanged' };
      }
      cosHistoryUnchangedSkips.set(peer.instanceId, 0); // forced re-diff — fall through
    }
    const missing = await diffCosHistoryManifestAgainstLocal(manifest.entries);
    if (missing.length === 0) {
      // Everything the manifest references is already on disk — reconcile the
      // index BEFORE caching the hash so a present-but-unindexed archive (e.g. a
      // prior sweep landed the bytes but crashed before the index persisted)
      // becomes visible, instead of being skipped forever by the unchanged
      // short-circuit above.
      await reconcileCosHistoryIndex(manifest.entries);
      lastCosHistoryManifestHash.set(peer.instanceId, manifest.manifestHash);
      return { pulled: 0 };
    }
    const requested = missing.length;
    await pullMissingCosArchives(peer.instanceId, missing);
    // Re-diff: a resolved pull does NOT mean every byte landed (peer dropped,
    // 404, size-cap reject) — this is the authoritative signal.
    const stillMissing = await diffCosHistoryManifestAgainstLocal(manifest.entries);
    const pulled = requested - stillMissing.length;
    if (stillMissing.length === 0) {
      // Full manifest now present — reconcile the index from the manifest (every
      // referenced agent, incl. its metadata.json, is confirmed on disk) before
      // caching the hash so the arrivals show in the history UI.
      await reconcileCosHistoryIndex(manifest.entries);
      lastCosHistoryManifestHash.set(peer.instanceId, manifest.manifestHash);
      console.log(`📥 peerSync: cos-history sweep from ${peer.name || peer.instanceId} — pulled ${pulled} archive file(s)`);
    } else {
      // Partial pull — do NOT record the hash, so the next tick re-diffs and
      // retries the still-missing files; the index is reconciled once the
      // manifest is fully present (above), never from a half-pulled agent.
      console.log(`⚠️ peerSync: cos-history sweep from ${peer.name || peer.instanceId} — pulled ${pulled}/${requested}, ${stillMissing.length} still missing; retrying next tick`);
    }
    return { pulled, missing: stillMissing.length };
  } finally {
    cosHistorySweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: sweep completed-agent history from every full-sync peer.
 * Each peer's sweep is independent + best-effort.
 */
export async function syncCosHistoryWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncCosHistoryFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: cos-history sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}

// === Live CoS task-list + claim-metadata federation (#1712) ================
//
// The second half of #1650. Where the completed-agent HISTORY above federates as
// pure append-only byte replication, the LIVE task files (data/COS-TASKS.md /
// data/TASKS.md) are mutated by BOTH peers and carry claim/lease metadata (#1563),
// so they ride a claim-aware per-task LWW MERGE — never a byte/whole-file copy
// that would clobber a peer's fresh claim and re-open the double-spawn hazard.
//
// Transport mirrors the cos-history sweep's receiver-pull shape: the sender
// advertises its backlog at GET /api/peer-sync/cos-tasks; a receiver (only for
// peers it flags fullSync) fetches it, version-gates it, short-circuits on an
// unchanged listHash, and merges per task into its own files via
// cosTaskStore.mergePeerTasks (dynamic import — keeps the CoS task graph out of
// peerSync's static import chain, mirroring reconcileCosHistoryIndex's import of
// cosAgents). The merge itself is the pure cosTaskMerge module.
//
// Running-agent state (state.json slots), live PTY buffers, the in-flight
// spawningTasks guard, and worktree working dirs are deliberately NOT federated —
// only the task RECORDS + their claim metadata.

// The task payload JSON (not bytes — there are none). Generous vs any real
// single-user backlog; the build truncates beyond the entry cap and the receiver
// rejects an over-cap response on its content-length check.
const COS_TASKS_ENTRY_CAP = 50_000;
const COS_TASKS_MAX_BYTES = 32 * 1024 * 1024;

// Reduce a parsed task to its wire entry: the fields the receiver's merge +
// markdown round-trip need, plus the `taskType` discriminator telling it which
// file the task belongs in. Metadata rides verbatim (claim fields included);
// the receiver re-escapes/re-parses it safely on its next file read.
function taskToWireEntry(task, taskType) {
  const entry = {
    id: task.id,
    taskType,
    status: task.status,
    priority: task.priority,
    description: task.description,
    metadata: isPlainObject(task.metadata) ? task.metadata : {},
  };
  if (typeof task.approvalRequired === 'boolean') entry.approvalRequired = task.approvalRequired;
  if (typeof task.autoApproved === 'boolean') entry.autoApproved = task.autoApproved;
  return entry;
}

/**
 * Build the live task payload this instance advertises to full-sync peers.
 * Unions the user (TASKS.md) and internal (COS-TASKS.md) backlogs, stamps a
 * `listHash` over the sorted entries so a receiver can short-circuit an
 * unchanged backlog, and caps the entry count (logs + truncates beyond it).
 *
 * Dynamic import of cosTaskStore keeps the CoS task graph out of peerSync's
 * static import chain (mirrors reconcileCosHistoryIndex).
 *
 * @returns {Promise<{ schemaVersion:number, listHash:string, tasks:Array }>}
 */
export async function buildCosTasksPayload() {
  const empty = { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks, listHash: createHash('sha256').update('').digest('hex'), tasks: [] };
  const mod = await import('../cosTaskStore.js').catch(() => null);
  if (!mod?.getUserTasks || !mod?.getCosTasks) return empty;
  const [userRes, cosRes] = await Promise.all([
    mod.getUserTasks().catch(() => null),
    mod.getCosTasks().catch(() => null),
  ]);
  let entries = [
    ...((userRes?.tasks || []).map((t) => taskToWireEntry(t, 'user'))),
    ...((cosRes?.tasks || []).map((t) => taskToWireEntry(t, 'internal'))),
  ];
  if (entries.length > COS_TASKS_ENTRY_CAP) {
    console.log(`⚠️ peerSync: cos-tasks payload hit the ${COS_TASKS_ENTRY_CAP}-entry cap — truncating (some tasks won't federate this tick)`);
    entries = entries.slice(0, COS_TASKS_ENTRY_CAP);
  }
  // Deterministic order so the listHash is stable across ticks regardless of
  // file/section order. Hash EVERY field the receiver's merge can act on —
  // status, priority, description, approval flags, and metadata (incl. claim
  // metadata) — so any edit the merge would propagate flips the hash and
  // re-triggers a sweep. Omitting description/approval here would let a receiver
  // short-circuit `unchanged` and never pull a same-status content edit until the
  // forced-revalidation window. Pure reordering does not change the hash.
  entries.sort((a, b) => (a.taskType < b.taskType ? -1 : a.taskType > b.taskType ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const listHash = createHash('sha256')
    .update(entries.map((e) => `${e.taskType}:${e.id}:${e.status}:${e.priority}:${e.description || ''}:${e.approvalRequired ?? ''}:${e.autoApproved ?? ''}:${JSON.stringify(e.metadata || {})}`).join('\n'))
    .digest('hex');
  return { schemaVersion: PORTOS_SCHEMA_VERSIONS.cosTasks, listHash, tasks: entries };
}

// Receiver-side bookkeeping — mirrors the cos-history sweep.
const lastCosTasksListHash = new Map(); // peerInstanceId → listHash
const cosTasksUnchangedSkips = new Map(); // peerInstanceId → count
const cosTasksSweepInFlight = new Set(); // peerInstanceId

/**
 * Apply a peer's task payload into the LOCAL task files via a claim-aware merge.
 * Splits the entries by taskType and hands each file's tasks to
 * cosTaskStore.mergePeerTasks (which runs the pure merge under the state lock).
 * Returns the number of files actually changed.
 */
async function mergeCosTasksFromPayload(tasks) {
  const mod = await import('../cosTaskStore.js').catch(() => null);
  if (!mod?.mergePeerTasks) return 0;
  const user = [];
  const internal = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t?.taskType === 'internal') internal.push(t);
    else if (t?.taskType === 'user') user.push(t);
  }
  let changed = 0;
  // Always merge BOTH files (even when one side is empty) so a task the peer
  // resolved/removed from a file converges — an empty list still merges (union
  // keeps local-only tasks, so it never wipes the local backlog).
  const userRes = await mod.mergePeerTasks('user', user).catch((err) => {
    console.log(`⚠️ peerSync: cos-tasks user merge failed: ${err.message}`); return null;
  });
  if (userRes?.changed) changed++;
  const internalRes = await mod.mergePeerTasks('internal', internal).catch((err) => {
    console.log(`⚠️ peerSync: cos-tasks internal merge failed: ${err.message}`); return null;
  });
  if (internalRes?.changed) changed++;
  return changed;
}

/**
 * Receiver-pull the live task backlog from ONE full-sync peer and merge it.
 * Best-effort + idempotent (every guard returns rather than throws), mirroring
 * syncCosHistoryFromPeer. No-op for a non-full-sync peer.
 *
 * @param {object} peer  a peer entry from getPeers()
 * @returns {Promise<{ merged:number, skipped?:string }>}
 */
export async function syncCosTasksFromPeer(peer) {
  if (!isPlainObject(peer) || peer.fullSync !== true || !isStr(peer.instanceId)) {
    return { merged: 0, skipped: 'not-fullsync' };
  }
  if (cosTasksSweepInFlight.has(peer.instanceId)) return { merged: 0, skipped: 'in-flight' };
  cosTasksSweepInFlight.add(peer.instanceId);
  try {
    const url = `${peerBaseUrl(peer)}/api/peer-sync/cos-tasks`;
    const res = await withAbortTimeout(ASSET_PULL_TIMEOUT_MS, (signal) =>
      peerFetch(url, { signal, maxBytes: COS_TASKS_MAX_BYTES }, peer))
      .catch(() => null);
    if (!res || !res.ok) return { merged: 0, skipped: 'unreachable' };
    const declaredLen = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > COS_TASKS_MAX_BYTES) {
      console.log(`⚠️ peerSync: cos-tasks payload from ${peer.name || peer.instanceId} too large (${declaredLen} > ${COS_TASKS_MAX_BYTES}) — skipping`);
      return { merged: 0, skipped: 'too-large' };
    }
    const body = await res.json().catch(() => null);
    const parsed = peerCosTasksSchema.safeParse(body);
    if (!parsed.success) {
      console.log(`⚠️ peerSync: cos-tasks payload from ${peer.name || peer.instanceId} failed validation — skipping`);
      return { merged: 0, skipped: 'invalid' };
    }
    const payload = parsed.data;
    // Schema gate — GENTLE skip (not reject): wait for the local PortOS to
    // upgrade rather than mis-merge against a payload shape we can't read.
    if (payload.schemaVersion > PORTOS_SCHEMA_VERSIONS.cosTasks) {
      console.log(`⏸️ peerSync: ${peer.name || peer.instanceId} cos-tasks payload is schema v${payload.schemaVersion} > local v${PORTOS_SCHEMA_VERSIONS.cosTasks} — skipping until this instance updates`);
      return { merged: 0, skipped: 'schema-ahead' };
    }
    // Unchanged short-circuit, with a periodic forced re-merge so a LOCAL task
    // loss self-heals even while the REMOTE backlog stays put. Unlike cos-history
    // the merge depends on TIME (lease expiry), so the forced re-merge also lets
    // an expired remote claim become re-claimable locally without a remote change.
    if (lastCosTasksListHash.get(peer.instanceId) === payload.listHash) {
      const skips = (cosTasksUnchangedSkips.get(peer.instanceId) || 0) + 1;
      if (skips < FORCE_REVALIDATE_EVERY) {
        cosTasksUnchangedSkips.set(peer.instanceId, skips);
        return { merged: 0, skipped: 'unchanged' };
      }
      cosTasksUnchangedSkips.set(peer.instanceId, 0); // forced re-merge — fall through
    }
    const changed = await mergeCosTasksFromPayload(payload.tasks);
    lastCosTasksListHash.set(peer.instanceId, payload.listHash);
    if (changed > 0) {
      console.log(`📥 peerSync: cos-tasks sweep from ${peer.name || peer.instanceId} — merged ${changed} task file(s)`);
    }
    return { merged: changed };
  } finally {
    cosTasksSweepInFlight.delete(peer.instanceId);
  }
}

/**
 * Periodic driver: merge the live task backlog from every full-sync peer.
 * Each peer's sweep is independent + best-effort.
 */
export async function syncCosTasksWithAllPeers() {
  const peers = await getPeers().catch(() => []);
  const fullSyncPeers = peers.filter((p) => p?.fullSync === true && p?.enabled !== false && isStr(p.instanceId));
  for (const peer of fullSyncPeers) {
    await syncCosTasksFromPeer(peer).catch((err) => {
      console.log(`⚠️ peerSync: cos-tasks sweep for ${peer.name || peer.instanceId} failed: ${err.message}`);
    });
  }
}