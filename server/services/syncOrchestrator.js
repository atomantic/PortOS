/**
 * Sync Orchestrator
 *
 * Unified coordinator for all data sync between PortOS peer instances.
 * Supports per-category sync: brain, memory, goals, character, digitalTwin, meatspace.
 * Maintains per-peer cursors and triggers sync on peer connect + interval.
 */

import { writeFile, access } from 'fs/promises';
import { join } from 'path';
import { readJSONFile, ensureDir, PATHS, dataPath, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { instanceEvents } from './instanceEvents.js';
import { getPeers, DEFAULT_SYNC_CATEGORIES, allSyncCategoriesOn, updatePeer, getInstanceId, UNKNOWN_INSTANCE_ID } from './instances.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { peerAuthHeaders } from '../lib/peerHttpClient.js';
import * as brainSync from './brainSync.js';
import { BRAIN_ENTITY_TYPES } from './brainStorage.js';
import * as brainSyncLog from './brainSyncLog.js';
import * as brainReconcile from './brainReconcile.js';
import * as memorySync from './memorySync.js';
import * as catalogSync from './catalogSync.js';
import * as dataSync from './dataSync.js';
import { getBackendName } from './memoryBackend.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';

const CURSORS_FILE = dataPath('instances_sync_cursors.json');
const SYNC_INTERVAL_MS = 60000;
const FETCH_TIMEOUT_MS = 15000;

const withLock = createMutex();
const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;
let syncTimer = null;
let peerOnlineHandler = null;
const syncingPeers = new Set();

// --- Realtime sync progress ---
//
// Emit per-peer sync lifecycle events so the Instances UI can animate a card
// while a sync is actively churning (vs. only updating after a manual probe).
// `socket.js` forwards `sync:progress` to instance subscribers. Phases:
//   { phase: 'start',    peerId }
//   { phase: 'applied',  peerId, category, applied }   // one per category with changes
//   { phase: 'complete', peerId, totalApplied }
// Fire-and-forget; a missing/uninitialized emitter must never break a sync.
function emitSyncProgress(payload) {
  if (typeof instanceEvents?.emit === 'function') instanceEvents.emit('sync:progress', payload);
}

// --- Cursor persistence ---

async function loadCursors() {
  return await readJSONFile(CURSORS_FILE, {});
}

async function saveCursors(cursors) {
  await ensureDir(PATHS.data);
  await atomicWrite(CURSORS_FILE, cursors);
}

async function readCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    return fn(cursors);
  });
}

async function withCursors(fn) {
  return withLock(async () => {
    const cursors = await loadCursors();
    const result = await fn(cursors);
    await saveCursors(cursors);
    return result;
  });
}

// --- Peer fetch helper ---

async function fetchPeer(peer, path) {
  const url = `${peerBaseUrl(peer)}${path}`;
  try {
    const res = await fetchWithTimeout(url, { headers: peerAuthHeaders(peer) }, FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch an image from a peer if we don't have it locally.
 * avatarPath is like "/data/images/uuid.png"
 */
async function syncImageFromPeer(peer, avatarPath) {
  // Validate avatarPath is a safe relative image path under /data/images/
  if (!avatarPath || avatarPath.includes('..') || !avatarPath.startsWith('/data/images/')) return;
  const filename = avatarPath.split('/').pop();
  if (!filename || !/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(filename)) return;
  const localPath = join(PATHS.images, filename);

  // Skip if we already have it
  const exists = await access(localPath).then(() => true).catch(() => false);
  if (exists) return;

  const url = `${peerBaseUrl(peer)}${avatarPath}`;
  try {
    const res = await fetchWithTimeout(url, { headers: peerAuthHeaders(peer) }, FETCH_TIMEOUT_MS);
    if (!res.ok) return;
    const buffer = Buffer.from(await res.arrayBuffer());
    await ensureDir(PATHS.images);
    await writeFile(localPath, buffer);
    console.log(`🔄 Synced avatar image: ${filename}`);
  } catch {
    // Non-critical — avatar will sync on next cycle
  }
}

// --- Status ---

/**
 * Get sync status: local sequences + per-peer cursors + optional local checksums
 */
export async function getSyncStatus({ includeChecksums = false, forPeer = null } = {}) {
  const isPostgres = getBackendName() === 'postgres';
  const snapshotCategories = includeChecksums ? dataSync.getSupportedCategories() : [];
  // Scope the served checksums to the REQUESTING peer (#1077 Bug 3). The peer's
  // cursor caches the `forPeer`-scoped checksum it pulled (source excludes
  // records it pushes per-record), so a self-view UNscoped (global) checksum
  // here would never match the cursor for any per-record-subscribable category
  // (universe/pipeline/mediaCollections) — making them read "behind" forever,
  // even when both sides are empty. An absent `forPeer` (self-view, older peer)
  // keeps the unscoped global checksum (forPeerId: undefined).
  const forPeerId = isNonEmptyStr(forPeer) ? forPeer : undefined;
  const [brainSeq, memorySeq, catalogSeqs, cursors, ...checksumResults] = await Promise.all([
    Promise.resolve(brainSyncLog.getCurrentSeq()),
    isPostgres ? memorySync.getMaxSequence() : Promise.resolve(null),
    isPostgres ? catalogSync.getMaxSequences().catch(() => null) : Promise.resolve(null),
    loadCursors(),
    ...snapshotCategories.map(cat => dataSync.getChecksum(cat, { forPeerId }).catch(() => null))
  ]);
  const local = { brainSeq, memorySeq, catalogSeqs };
  if (includeChecksums) {
    local.checksums = {};
    for (let i = 0; i < snapshotCategories.length; i++) {
      local.checksums[snapshotCategories[i]] = checksumResults[i]?.checksum ?? null;
    }
  }
  const result = { local, cursors };
  // When a peer asks "how much of MY data have you pulled?" (it passes its own
  // instanceId as `forPeer`), return OUR cursor into that peer's data — i.e. how
  // far we've consumed from it. That cursor IS the peer's push-frontier toward
  // us, so the requesting peer can render an outbound "N to push" count without
  // us tracking its local max. Null when we've never synced that peer.
  if (isNonEmptyStr(forPeer)) {
    result.cursorForYou = cursors[forPeer] ?? null;
  }
  return result;
}

// --- Sync logic ---

/**
 * Sync brain data from a peer (pull all changes since cursor)
 */
async function syncBrainFromPeer(peer, cursor) {
  let brainSeq = cursor.brainSeq ?? 0;
  let totalApplied = 0;

  // Loop to consume all batches
  let hasMore = true;
  while (hasMore) {
    const data = await fetchPeer(peer, `/api/brain/sync?since=${brainSeq}&limit=100`);
    if (!data?.changes?.length) break;

    const result = await brainSync.applyRemoteChanges(data.changes);
    totalApplied += result.inserted + result.updated + result.deleted;
    brainSeq = data.maxSeq;
    hasMore = data.hasMore;
  }

  // --- Anti-entropy reconcile (#1077) ---
  // Delta sync alone diverges once log entries are compacted away. After
  // draining the log, compare a whole-brain checksum with the peer; on a
  // mismatch, pull the full snapshot and LWW-merge it (idempotent). This is the
  // ONLY path that re-converges a peer that missed compacted entries. Scoped to
  // brain (no per-record push pipeline), so the snapshot is always the full set.
  //
  // Cheap-path skips, in order:
  //   1. peer too old to expose /reconcile/checksum → null → delta-only (legacy),
  //      leaving the cached checksum untouched.
  //   2. peer checksum === our cached checksum for this peer → nothing changed
  //      on their side since we last reconciled → skip (the init value already
  //      holds it; no work).
  //   3. peer checksum === our CURRENT local checksum → already converged → just
  //      cache the peer checksum so step 2 short-circuits next cycle.
  // Returns `brainChecksum` so the caller caches the converged value on the
  // cursor (cache key is the peer checksum we reconciled against).
  //
  // The cached checksum is VERSIONED by this install's entity-type list
  // (`brainChecksumTypes`): a peer running older code silently skips unknown
  // types when applying a snapshot, yet still caches the remote checksum. If
  // that cache survived an upgrade, step 2 would short-circuit against an
  // unchanged remote and the skipped records (e.g. `songs`) would stay absent
  // until an unrelated remote mutation happened to change the checksum. A
  // signature mismatch (or a legacy cursor with no signature) treats the cache
  // as cold, forcing one full reconcile after any enrollment change.
  const typesSignature = [...BRAIN_ENTITY_TYPES].sort().join(',');
  const cachedChecksum =
    cursor.brainChecksumTypes === typesSignature ? (cursor.brainChecksum ?? null) : null;
  let brainChecksum = cachedChecksum;
  const remote = await fetchPeer(peer, '/api/brain/reconcile/checksum');
  const remoteChecksum = isNonEmptyStr(remote?.checksum) ? remote.checksum : null;
  if (remoteChecksum && remoteChecksum !== cachedChecksum) {
    const localChecksum = await brainReconcile.getBrainChecksum().catch(() => null);
    if (remoteChecksum === localChecksum) {
      // Already converged — record the peer checksum so we skip next cycle.
      brainChecksum = remoteChecksum;
    } else {
      const snapshot = await fetchPeer(peer, '/api/brain/reconcile/snapshot');
      if (snapshot?.records) {
        const result = await brainReconcile.applyBrainSnapshot(snapshot);
        totalApplied += result.inserted + result.updated + result.deleted;
        // Cache the peer's served checksum so an unchanged peer short-circuits
        // at step 2 next cycle. (Our post-merge local checksum may differ from
        // the peer's if WE hold records THEY lack — that asymmetry is fine; the
        // peer reconciles those from us on its own cycle.)
        brainChecksum = isNonEmptyStr(snapshot.checksum) ? snapshot.checksum : remoteChecksum;
      }
    }
  }

  return { brainSeq, totalApplied, brainChecksum, brainChecksumTypes: typesSignature };
}

/**
 * Sync CoS memories from a peer (pull all changes since cursor)
 */
async function syncMemoryFromPeer(peer, cursor) {
  let memorySeq = cursor.memorySeq ?? '0';
  let totalApplied = 0;

  let hasMore = true;
  while (hasMore) {
    const data = await fetchPeer(peer, `/api/memory/sync?since=${memorySeq}&limit=100`);
    if (!data?.memories?.length) break;

    const result = await memorySync.applyRemoteChanges(data.memories);
    totalApplied += result.inserted + result.updated;
    memorySeq = data.maxSequence;
    hasMore = data.hasMore;
  }

  return { memorySeq, totalApplied };
}

// The seven INDEPENDENT BIGSERIAL cursors the catalog sync envelope tracks.
// Each table advances its own sequence, so the receiver carries seven cursors
// (not one) — see catalogSync.js for the protocol rationale.
const CATALOG_CURSOR_KINDS = ['scraps', 'ingredients', 'sources', 'refs', 'relations', 'tags', 'media'];

// Build the `?since[scraps]=A&since[ingredients]=B&...` query string the
// catalog `/sync` route parses back into per-kind cursors. A missing kind
// defaults to '0' server-side, so a legacy cursor (pre-relations/tags/media)
// still pulls the newer kinds from scratch on first run.
function catalogSinceQuery(catalogSeqs) {
  const parts = CATALOG_CURSOR_KINDS.map((kind) => {
    const v = catalogSeqs?.[kind];
    const safe = typeof v === 'string' && /^\d+$/.test(v) ? v : '0';
    return `since[${kind}]=${encodeURIComponent(safe)}`;
  });
  return parts.join('&');
}

/**
 * Sync the creative-ingredients catalog from a peer (pull all changes since
 * cursor, apply locally). Delta-based + PostgreSQL-only, mirroring memory sync
 * — but the catalog is a multi-table relational store, so the cursor is the
 * per-kind `maxSequences` object the peer returns, not a single scalar.
 *
 * A schema-version-ahead peer (newer `catalog` schema) makes applyRemoteChanges
 * throw CatalogSyncVersionMismatchError; we record the gap on the peer record
 * (same surfacing as the snapshot categories) and stop draining so we don't
 * loop on a payload we can't safely apply.
 */
async function syncCatalogFromPeer(peer, peerId, cursor) {
  let catalogSeqs = isPlainObjectShallow(cursor.catalogSeqs) ? { ...cursor.catalogSeqs } : {};
  let totalApplied = 0;
  let blockedBySchema = null;

  let hasMore = true;
  // Only the FIRST fetch can carry a stale saved cursor from a prior session;
  // once we start draining, each cursor came from this peer's own maxSequences
  // and can't exceed them. So the rebuild/reset check runs on the first fetch
  // only (a mid-drain quiet kind legitimately reports a per-page max at/under
  // our just-advanced cursor, which must NOT be read as a reset).
  let firstFetch = true;
  while (hasMore) {
    const data = await fetchPeer(peer, `/api/catalog/sync?${catalogSinceQuery(catalogSeqs)}&limit=100`);
    if (!data) break;

    // Detect a peer catalog rebuild/restore: if our saved cursor for a kind
    // exceeds the peer's TRUE table maximum, that table's sequence was reset,
    // so our `since[kind]=<high>` would skip every row forever. Rewind the
    // affected kinds to 0 and re-fetch from scratch before applying — safe
    // because catalog apply is idempotent (LWW / ON CONFLICT dedup). We compare
    // against `tableMaxSequences` (real MAX per table), NOT `maxSequences`,
    // which falls back to our own inbound cursor on a quiet kind and so could
    // never signal a reset. Absent on a pre-this-version peer → detection is
    // skipped (backward-compatible).
    if (firstFetch && isPlainObjectShallow(data.tableMaxSequences)) {
      let rewound = false;
      for (const kind of CATALOG_CURSOR_KINDS) {
        const ours = catalogSeqs[kind];
        const peerMax = data.tableMaxSequences[kind];
        if (typeof ours === 'string' && /^\d+$/.test(ours)
            && typeof peerMax === 'string' && /^\d+$/.test(peerMax)
            && BigInt(ours) > BigInt(peerMax)) {
          console.log(`🔄 Catalog cursor reset for ${peer.name} (${kind}): cursor ${ours} > peer table max ${peerMax}`);
          catalogSeqs[kind] = '0';
          rewound = true;
        }
      }
      if (rewound) continue; // re-fetch with the rewound cursors before applying
    }
    firstFetch = false;

    // Forward the sender's portosMeta so applyRemoteChanges runs the schema
    // gate BEFORE merging — a sender ahead on `catalog` throws and we persist
    // the gap rather than corrupting local state.
    let stats;
    try {
      stats = await catalogSync.applyRemoteChanges({ ...data, portosMeta: data.portosMeta });
    } catch (err) {
      if (err?.code === 'CATALOG_SCHEMA_VERSION_AHEAD') {
        blockedBySchema = err.diff;
        const ahead = Array.isArray(err.diff?.ahead) ? err.diff.ahead : [];
        await recordPeerSchemaGap(peerId, 'catalog', {
          ahead, behind: [], senderPortosVersion: data?.portosMeta?.portosVersion ?? null,
        }).catch((e) => console.log(`⚠️ syncOrchestrator: persist catalog schema gap failed: ${e.message}`));
        break;
      }
      throw err;
    }

    // Count every applied row across the seven kinds for the heartbeat log.
    // catalogSync owns the per-kind stats shape, so it owns the tally.
    totalApplied += catalogSync.countAppliedFromStats(stats);

    // Advance every cursor the peer reported. The peer falls each quiet kind
    // back to the inbound cursor, so this never moves a cursor backward.
    const before = catalogSinceQuery(catalogSeqs);
    if (isPlainObjectShallow(data.maxSequences)) {
      for (const kind of CATALOG_CURSOR_KINDS) {
        // Don't advance a kind's cursor past a page that had apply failures: a
        // child row (relation/media/ref to an ingredient on a LATER page) fails
        // when its parent isn't applied yet. Leaving the cursor makes the next
        // pull re-request and re-apply it once the parent lands (re-applying the
        // page's already-succeeded rows is idempotent). A quiet/clean kind has
        // failed===0 and still advances normally.
        if ((stats?.[kind]?.failed || 0) > 0) continue;
        const v = data.maxSequences[kind];
        if (typeof v === 'string' && /^\d+$/.test(v)) catalogSeqs[kind] = v;
      }
    }
    // Guard against a buggy/malicious peer that returns `hasMore: true` without
    // advancing ANY cursor — that would loop forever re-pulling the same window.
    // A well-behaved peer always advances at least one kind when hasMore is true
    // (hasMore implies it returned a full page on some table).
    if (catalogSinceQuery(catalogSeqs) === before) break;
    hasMore = data.hasMore === true;
  }

  // Clear any prior gap once we successfully drained (sender either upgraded
  // or the earlier block was transient). Skip when we just recorded a fresh
  // block this cycle.
  if (!blockedBySchema) {
    await clearPeerSchemaGap(peerId, 'catalog')
      .catch((err) => console.log(`⚠️ syncOrchestrator: clear catalog schema gap failed: ${err.message}`));
  }

  return { catalogSeqs, totalApplied, blockedBySchema };
}

/**
 * Safely parse a value to BigInt for BIGSERIAL comparison.
 * Returns 0n for invalid/empty/negative inputs.
 */
function safeBigInt(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : 0n;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? BigInt(Math.trunc(value)) : 0n;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = BigInt(value.trim());
    return parsed;
  }
  return 0n;
}

/**
 * Detect and reset stale cursors when peer's sequence has been reset
 * (e.g. database rebuild). Returns corrected cursor.
 *
 * Uses cached remoteSyncSeqs from periodic peer probing. If null (probe hasn't
 * run yet or failed), we skip detection — a real reset will be caught on the
 * next probe cycle. Stale probe data may trigger a conservative full re-sync
 * (cursor reset to 0), which is safe since sync is idempotent (LWW dedup).
 */
function detectCursorReset(cursor, peer) {
  const corrected = { ...cursor };
  const remote = peer.remoteSyncSeqs;
  if (!remote) return corrected;

  // Brain: integer comparison
  // Only check when peer reports a finite non-negative brainSeq (older peers may omit it)
  const remoteBrainRaw = remote.brainSeq;
  const hasNumericRemoteBrain = typeof remoteBrainRaw === 'number' &&
    Number.isFinite(remoteBrainRaw) &&
    remoteBrainRaw >= 0;
  if (hasNumericRemoteBrain) {
    const cursorBrain = corrected.brainSeq ?? 0;
    if (cursorBrain > 0 && cursorBrain > remoteBrainRaw) {
      console.log(`🔄 Brain cursor reset for ${peer.name}: cursor ${cursorBrain} > peer max ${remoteBrainRaw}`);
      corrected.brainSeq = 0;
    }
  }

  // Memory: BigInt comparison (BIGSERIAL can exceed Number.MAX_SAFE_INTEGER)
  // Only check when peer reports a numeric memorySeq (null means non-Postgres peer)
  const remoteMemRaw = remote.memorySeq;
  const hasNumericRemoteMem = remoteMemRaw != null && (
    typeof remoteMemRaw === 'bigint' ||
    (typeof remoteMemRaw === 'number' && Number.isFinite(remoteMemRaw) && remoteMemRaw >= 0) ||
    (typeof remoteMemRaw === 'string' && /^\d+$/.test(remoteMemRaw.trim()))
  );
  if (hasNumericRemoteMem) {
    const cursorMemStr = corrected.memorySeq ?? '0';
    const cursorMem = safeBigInt(cursorMemStr);
    const peerMem = safeBigInt(remoteMemRaw);
    if (cursorMem > 0n && cursorMem > peerMem) {
      console.log(`🔄 Memory cursor reset for ${peer.name}: cursor ${cursorMemStr} > peer max ${String(remoteMemRaw)}`);
      corrected.memorySeq = '0';
    }
  }

  return corrected;
}

/**
 * Resolve effective sync categories for a peer.
 * Returns object with boolean flags for each category.
 * Falls back to legacy behavior: if syncCategories is absent but syncEnabled is true,
 * enable brain + memory for backward compatibility with older peers.
 */
function getEffectiveCategories(peer) {
  // A full-sync ("mirror everything") peer pulls EVERY snapshot category from
  // its mirror, regardless of the stored per-category map — including a category
  // added in a later version (allSyncCategoriesOn derives off
  // DEFAULT_SYNC_CATEGORIES, so it stays current automatically).
  if (peer.fullSync === true) return allSyncCategoriesOn();
  if (peer.syncCategories) return peer.syncCategories;
  // Legacy fallback: peers without syncCategories but with syncEnabled get brain+memory
  if (peer.syncEnabled !== false) {
    return { ...DEFAULT_SYNC_CATEGORIES, brain: true, memory: true };
  }
  return { ...DEFAULT_SYNC_CATEGORIES };
}

/**
 * Sync a snapshot-based data category from a peer.
 * Fetches checksum first to avoid full data transfer when unchanged.
 */
async function syncDataCategoryFromPeer(peer, peerId, category, cachedChecksums, ourInstanceId) {
  // Pass our own instanceId as `forPeer` so the SOURCE peer can scope the
  // snapshot it serves us: it excludes records it already pushes to us
  // per-record (our inbound coverage) and includes everything else
  // (un-subscribed records + tombstones for torn-down subs). An older source
  // peer ignores the unknown param and returns the full snapshot — safe,
  // applied idempotently. The query string is only appended for the three
  // peer-record-subscribable categories; for goals/character/etc. it's inert
  // server-side, but we still pass it uniformly to keep the URL builder simple.
  const forPeerQs = isNonEmptyStr(ourInstanceId) ? `?forPeer=${encodeURIComponent(ourInstanceId)}` : '';
  // Lightweight checksum check first
  const checksumRes = await fetchPeer(peer, `/api/sync/${category}/checksum${forPeerQs}`);
  if (!checksumRes?.checksum) return { totalApplied: 0, checksum: null };

  const lastChecksum = cachedChecksums?.[category] ?? null;
  if (lastChecksum && lastChecksum === checksumRes.checksum) {
    return { totalApplied: 0, checksum: checksumRes.checksum };
  }

  // Checksum changed — fetch full snapshot (same forPeer scoping as checksum
  // so the snapshot we apply matches the checksum we just cached).
  const snapshot = await fetchPeer(peer, `/api/sync/${category}/snapshot${forPeerQs}`);
  if (!snapshot?.data) return { totalApplied: 0, checksum: null };

  // Forward the sender's portosMeta envelope so applyRemote can run the
  // schema-version gate BEFORE merging. A blocked-by-schema result returns
  // applied=false + the diff payload — we persist the gap on the peer record
  // (instances.json) so the Instances UI surfaces "Peer X is on PortOS vN,
  // can't sync universes" and the user knows what to do.
  const result = await dataSync.applyRemote(category, snapshot.data, {
    portosMeta: snapshot.portosMeta,
    // Attribute any journaled conflict to the peer this snapshot came from so
    // the Conflicts tab shows `via: snapshot (<peerId>)` instead of peerId:null.
    peerId,
  });
  if (result.blockedBySchema) {
    await recordPeerSchemaGap(peerId, category, result.blockedBySchema)
      .catch((err) => console.log(`⚠️ syncOrchestrator: persist schema gap failed: ${err.message}`));
    // Don't advance the cached checksum — when the user upgrades, the
    // category will look "changed" again and we'll re-try the apply.
    return { totalApplied: 0, checksum: null, blockedBySchema: result.blockedBySchema };
  }

  // After character sync, fetch avatar image if we don't have it locally
  if (category === 'character' && snapshot.data?.avatarPath) {
    await syncImageFromPeer(peer, snapshot.data.avatarPath);
  }

  // Clear any prior schema-version gap on this (peer, category) — sender
  // either upgraded or the older check was transient. Best-effort; failures
  // don't fail the apply (we already merged successfully).
  await clearPeerSchemaGap(peerId, category)
    .catch((err) => console.log(`⚠️ syncOrchestrator: clear schema gap failed: ${err.message}`));

  return { totalApplied: result.applied ? result.count : 0, checksum: snapshot.checksum };
}

/**
 * Persist a per-(peer, category) schema-version gap on the peer record.
 * Stored under `peer.schemaGaps[category]` as `{ detectedAt, ahead, behind,
 * senderPortosVersion }`. The Instances UI reads it to render a "Peer is
 * on PortOS vN, you can't sync universes until they upgrade" badge.
 *
 * NOTE: a future PR will move this to a dedicated peer-status file so
 * peers.json stays a pure config surface. For now we co-locate on the peer
 * record because that's the entity the Instances page already renders.
 */
// Look up the local peer row by remote instanceId (the only id we have at
// the orchestrator level) and resolve to the LOCAL `peer.id` that updatePeer
// keys by. Passing `peer.instanceId` straight to updatePeer would silently
// return null because instances.js matches on `p.id === id`.
async function recordPeerSchemaGap(peerId, category, gap) {
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.instanceId === peerId);
  if (!peer) return;
  const existingGaps = isPlainObjectShallow(peer.schemaGaps) ? peer.schemaGaps : {};
  await updatePeer(peer.id, {
    schemaGaps: {
      ...existingGaps,
      [category]: {
        detectedAt: new Date().toISOString(),
        ahead: Array.isArray(gap.ahead) ? gap.ahead : [],
        behind: Array.isArray(gap.behind) ? gap.behind : [],
        senderPortosVersion: typeof gap.senderPortosVersion === 'string' ? gap.senderPortosVersion : null,
      },
    },
  });
}

async function clearPeerSchemaGap(peerId, category) {
  const peers = await getPeers().catch(() => []);
  const peer = peers.find((p) => p.instanceId === peerId);
  if (!peer) return;
  const existingGaps = isPlainObjectShallow(peer.schemaGaps) ? peer.schemaGaps : null;
  if (!existingGaps || !(category in existingGaps)) return;
  const next = { ...existingGaps };
  delete next[category];
  await updatePeer(peer.id, {
    schemaGaps: Object.keys(next).length > 0 ? next : null,
  });
}

const isPlainObjectShallow = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Per-direction peer-sync coverage for a peer, by snapshot CATEGORY.
 *
 * Returns `{ outbound, inbound }` where each is
 * `{ universe: Set<id>, pipeline: Set<id>, mediaCollections: Set<id> }`:
 *
 *   - `outbound` — records WE push to the peer per-record (our local
 *     subscriptions targeting the peer). These flow to the peer via the push
 *     pipeline regardless of the snapshot.
 *   - `inbound` — records the PEER pushes to US per-record (the peer's
 *     subscriptions targeting our instanceId). We can only learn these by
 *     asking the peer, so this is populated from
 *     `GET /api/peer-sync/subscriptions?peerId=<ourId>` on the peer; on any
 *     failure (older peer, offline, network) it stays EMPTY → we pull the
 *     full snapshot (safe, idempotent).
 *
 * This is the fix for the old conflation: the previous coarse boolean used
 * OUR OUTBOUND subs to suppress the INBOUND snapshot pull for an ENTIRE
 * category. Outbound proves only that WE push to the peer — NOT that the peer
 * pushes back. So we now drive the inbound snapshot-pull scoping off the
 * `inbound` set, never the `outbound` set.
 *
 * NOTE — in the live sync path the snapshot pull is actually scoped at the
 * SOURCE (we send `forPeer=<ourId>` and the source excludes records it pushes
 * to us, i.e. ITS outbound = OUR inbound), which needs no extra round-trip and
 * is the authoritative inbound signal. This function exists for callers /
 * tests / future transports that want the explicit per-direction breakdown
 * computed locally; `inbound` here is the best-effort peer-queried mirror of
 * what the source excludes.
 *
 * Mapping: recordKind 'universe' → 'universe'; 'series' → 'pipeline'
 * (series + child issues are one composite, same as getPipelineSnapshot);
 * 'mediaCollection' → 'mediaCollections'.
 */
export async function categoriesCoveredByPeerSync(peerId, peer = null, ourInstanceId = null) {
  // Dynamic import keeps `sharing/peerSync.js` (which transitively pulls
  // every merge*FromSync service + recordEvents) OUT of this orchestrator's
  // module-load graph. Two reasons: (1) shaves the startup cost of evaluating
  // those modules until the first sync cycle actually runs, (2) insurance
  // against a future circular dep — peerSync's graph never needs the
  // orchestrator today, but a top-level import here would manifest as a
  // confusing "undefined" crash at boot the day that changes.
  const { getOutboundCoverageForPeer } = await import('./sharing/peerSync.js');
  const outbound = await getOutboundCoverageForPeer(peerId).catch(() => emptyCoverage());

  // Inbound: ask the peer which records it subscribes US to. The peer's
  // /subscriptions endpoint lists ITS outgoing subs; filtering by our
  // instanceId yields the records it pushes to us. Best-effort — a null
  // response (older peer / offline) leaves inbound empty → full snapshot.
  const inbound = emptyCoverage();
  if (peer && isNonEmptyStr(ourInstanceId)) {
    const res = await fetchPeer(peer, `/api/peer-sync/subscriptions?peerId=${encodeURIComponent(ourInstanceId)}`);
    const subs = Array.isArray(res?.subscriptions) ? res.subscriptions : [];
    for (const sub of subs) {
      const cat = RECORD_KIND_TO_CATEGORY[sub?.recordKind];
      if (cat && isNonEmptyStr(sub?.recordId)) inbound[cat].add(sub.recordId);
    }
  }
  return { outbound, inbound };
}

const RECORD_KIND_TO_CATEGORY = Object.freeze({
  universe: 'universe',
  series: 'pipeline',
  mediaCollection: 'mediaCollections',
});

const emptyCoverage = () => ({ universe: new Set(), pipeline: new Set(), mediaCollections: new Set() });

/**
 * Sync all data from a single peer
 */
export async function syncWithPeer(peer) {
  if (!peer.instanceId) return { brain: { totalApplied: 0 }, memory: { totalApplied: 0 } };

  const peerId = peer.instanceId;

  // Prevent concurrent syncs for the same peer
  if (syncingPeers.has(peerId)) return { brain: { totalApplied: 0 }, memory: { totalApplied: 0 } };
  syncingPeers.add(peerId);

  // Emit an `applied` progress event for a category when it actually moved
  // records — keeps the per-category emits DRY across the delta + snapshot legs.
  const reportApplied = (category, applied) => {
    if (applied > 0) emitSyncProgress({ phase: 'applied', peerId, category, applied });
  };

  // Track whether the normal `complete` emit fired, so the `finally` can settle
  // a card whose sync threw mid-flight instead of leaving it spinning forever.
  let completed = false;

  // Everything after acquiring the lock runs inside the try so the `finally`
  // ALWAYS releases `syncingPeers` and emits a terminal `complete` — even if
  // `getInstanceId`/`readCursors` throws before the sync body. Otherwise a
  // throw here would both leak the per-peer lock (permanent until restart) and
  // strand the card spinning with no `complete`.
  try {
    // Our own instanceId — sent as `forPeer` so the SOURCE peer can scope each
    // snapshot it serves us (excludes records it already pushes to us
    // per-record). Resolved once per sync, best-effort; null/UNKNOWN → no
    // scoping (full snapshots, legacy behavior).
    const ourInstanceId = await getInstanceId().catch(() => null);
    const scopedInstanceId = isNonEmptyStr(ourInstanceId) && ourInstanceId !== UNKNOWN_INSTANCE_ID
      ? ourInstanceId
      : null;

    const categories = getEffectiveCategories(peer);
    const enabledNames = Object.entries(categories).filter(([, on]) => on).map(([k]) => k);
    console.log(`🔄 Sync starting with ${peer.name || peerId}: categories=${enabledNames.join(',') || 'none'}`);
    emitSyncProgress({ phase: 'start', peerId });

    // Read cursor snapshot outside lock so network I/O doesn't block other peers
    // Also detect and reset stale cursors (e.g. peer DB was rebuilt)
    const cursor = await readCursors((cursors) => {
      const raw = { ...(cursors[peerId] || {}) };
      return detectCursorReset(raw, peer);
    });

    // --- Brain sync (delta-based) ---
    let brainResult = { brainSeq: cursor.brainSeq ?? 0, totalApplied: 0 };
    if (categories.brain) {
      brainResult = await syncBrainFromPeer(peer, cursor);
      reportApplied('brain', brainResult.totalApplied);
    }

    // --- Memory sync (delta-based, PostgreSQL only) ---
    let memoryResult = { memorySeq: cursor.memorySeq ?? '0', totalApplied: 0 };
    if (categories.memory) {
      const isPostgres = getBackendName() === 'postgres';
      if (isPostgres) {
        memoryResult = await syncMemoryFromPeer(peer, cursor);
        reportApplied('memory', memoryResult.totalApplied);
      }
    }

    // --- Catalog sync (delta-based, multi-table, PostgreSQL only) ---
    let catalogResult = { catalogSeqs: cursor.catalogSeqs, totalApplied: 0 };
    if (categories.catalog) {
      const isPostgres = getBackendName() === 'postgres';
      if (isPostgres) {
        catalogResult = await syncCatalogFromPeer(peer, peerId, cursor);
        reportApplied('catalog', catalogResult.totalApplied);
      }
    }

    // --- Snapshot-based category syncs (parallel) ---
    const dataCategoryResults = {};
    // We no longer skip whole categories when a peer has SOME per-record
    // subscriptions. The old coarse skip dropped the inbound snapshot for an
    // ENTIRE category whenever ANY record in it had a sub — stranding edits
    // for every UN-subscribed record (partial-subscription gap) and every
    // tombstone whose sub was torn down (ephemeralize-then-delete stall).
    //
    // Instead we ALWAYS pull every enabled snapshot category, but pass our
    // instanceId as `forPeer` so the SOURCE peer excludes exactly the records
    // it already pushes to us per-record (our inbound coverage) — leaving
    // un-subscribed records + torn-down-sub tombstones to ride the snapshot.
    // In the all-or-none common case (every record covered) the source
    // excludes them all → an empty snapshot whose stable checksum the
    // checksum short-circuit skips, so the network cost collapses to one tiny
    // cached checksum fetch (vs. the old full skip). Source-side scoping needs
    // no inbound round-trip and is the authoritative inbound signal.
    const enabledDataCats = dataSync.getSupportedCategories()
      .filter(cat => categories[cat]);
    const cachedChecksums = cursor.checksums || {};

    if (enabledDataCats.length > 0) {
      const settled = await Promise.allSettled(
        enabledDataCats.map(cat =>
          syncDataCategoryFromPeer(peer, peerId, cat, cachedChecksums, scopedInstanceId)
            .catch(err => {
              console.error(`⚠️ ${cat} sync with ${peer.name} failed: ${err.message}`);
              return { totalApplied: 0, checksum: null };
            })
        )
      );
      for (let i = 0; i < enabledDataCats.length; i++) {
        const result = settled[i].status === 'fulfilled' ? settled[i].value : { totalApplied: 0, checksum: null };
        dataCategoryResults[enabledDataCats[i]] = result;
        reportApplied(enabledDataCats[i], result.totalApplied);
      }
    }

    // --- Single consolidated cursor write ---
    await withCursors(async (cursors) => {
      if (!cursors[peerId]) cursors[peerId] = {};
      if (categories.brain) {
        cursors[peerId].brainSeq = brainResult.brainSeq;
        // Cache the reconcile checksum we converged against so an unchanged peer
        // short-circuits the snapshot fetch next cycle (#1077). Only overwrite
        // when we actually resolved one — a failed/legacy probe (null) leaves
        // the prior value so we don't lose the skip-optimization on a blip.
        if (isNonEmptyStr(brainResult.brainChecksum)) {
          cursors[peerId].brainChecksum = brainResult.brainChecksum;
          // Stamp the entity-type signature the cache is valid for — an
          // enrollment change (new brain type) invalidates the cached checksum
          // so the first post-upgrade cycle re-reconciles records that older
          // code skipped as unknown types.
          cursors[peerId].brainChecksumTypes = brainResult.brainChecksumTypes;
        }
      }
      if (memoryResult.memorySeq !== (cursor.memorySeq ?? '0')) cursors[peerId].memorySeq = memoryResult.memorySeq;
      // Persist the per-kind catalog cursor only when the drain wasn't blocked
      // by a schema gap — a blocked cycle leaves the prior cursor so we re-try
      // the same window after the sender upgrades (mirrors the snapshot path).
      if (categories.catalog && !catalogResult.blockedBySchema && isPlainObjectShallow(catalogResult.catalogSeqs)) {
        cursors[peerId].catalogSeqs = catalogResult.catalogSeqs;
      }
      if (!cursors[peerId].checksums) cursors[peerId].checksums = {};
      for (const [cat, result] of Object.entries(dataCategoryResults)) {
        if (result.checksum) cursors[peerId].checksums[cat] = result.checksum;
      }
      cursors[peerId].lastSyncAt = new Date().toISOString();
    });

    // Log summary
    const parts = [];
    if (brainResult.totalApplied > 0) parts.push(`${brainResult.totalApplied} brain`);
    if (memoryResult.totalApplied > 0) parts.push(`${memoryResult.totalApplied} memory`);
    if (catalogResult.totalApplied > 0) parts.push(`${catalogResult.totalApplied} catalog`);
    for (const [cat, result] of Object.entries(dataCategoryResults)) {
      if (result.totalApplied > 0) parts.push(`${result.totalApplied} ${cat}`);
    }
    if (parts.length > 0) {
      console.log(`🔄 Synced with ${peer.name}: ${parts.join(', ')} changes`);
    }

    const totalApplied = brainResult.totalApplied + memoryResult.totalApplied
      + catalogResult.totalApplied
      + Object.values(dataCategoryResults).reduce((sum, r) => sum + (r?.totalApplied || 0), 0);
    completed = true;
    emitSyncProgress({ phase: 'complete', peerId, totalApplied });

    return { brain: brainResult, memory: memoryResult, catalog: catalogResult, ...dataCategoryResults };
  } finally {
    syncingPeers.delete(peerId);
    // If the sync threw before the normal complete emit, still settle the card
    // out of its "syncing" state (a stuck spinner is worse than a silent stop).
    if (!completed) emitSyncProgress({ phase: 'complete', peerId, totalApplied: 0 });
  }
}

/**
 * Check if a peer has any sync category enabled
 */
function hasAnySyncEnabled(peer) {
  if (peer.syncEnabled === false) return false;
  const cats = getEffectiveCategories(peer);
  return Object.values(cats).some(Boolean);
}

/**
 * Sync with all online peers
 */
export async function syncAllPeers() {
  const peers = await getPeers();
  const online = peers.filter(p => p.enabled && hasAnySyncEnabled(p) && p.status === 'online' && p.instanceId);

  if (online.length > 0) {
    const names = online.map(p => p.name || p.instanceId).join(', ');
    console.log(`🔄 Sync cycle: ${online.length} peer${online.length === 1 ? '' : 's'} online (${names})`);
  }

  const settled = await Promise.allSettled(online.map(p => syncWithPeer(p)));

  // Aggregate per-cycle change counts across peers so the heartbeat is loud
  // about totals even when individual per-peer logs short-circuit on no-op.
  let cycleChanges = 0;
  for (const r of settled) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    cycleChanges += (r.value.brain?.totalApplied || 0) + (r.value.memory?.totalApplied || 0);
    for (const [k, v] of Object.entries(r.value)) {
      if (k === 'brain' || k === 'memory') continue;
      cycleChanges += v?.totalApplied || 0;
    }
  }
  if (online.length > 0) {
    console.log(`🔄 Sync cycle complete: ${cycleChanges} change${cycleChanges === 1 ? '' : 's'} applied across ${online.length} peer${online.length === 1 ? '' : 's'}`);
  }

  // Compact the sync log below the point every brain-enabled peer has already
  // consumed FROM US (#1077 Bug 1). The floor MUST be each peer's cursor into
  // OUR log — `peer.remoteSyncSeqs.cursorForYou.brainSeq`, learned during the
  // probe — NOT `cursors[peerId].brainSeq` (our OUTBOUND pull cursor into them).
  // Flooring on the outbound cursor drops entries a peer hasn't pulled yet, so
  // that peer can never learn those records once they're gone (the exact
  // divergence this issue fixes). Include all ENABLED brain peers (not just
  // online) so an offline peer's unconsumed entries are never dropped.
  //
  // A brain-enabled peer that hasn't reported its cursor into us (older peer,
  // never probed with `forPeer`, or never synced) contributes a floor of 0 —
  // we keep everything for it rather than assume it caught up. compactLog still
  // runs (vs. the old skip-when-empty) so a 0 floor is an explicit "keep all",
  // and the anti-entropy reconcile (Part 1) re-converges anyone genuinely behind.
  const brainPeers = peers.filter(p => p.enabled && p.instanceId && getEffectiveCategories(p).brain);
  if (brainPeers.length > 0) {
    const consumedSeqs = brainPeers.map(p => {
      const consumed = p.remoteSyncSeqs?.cursorForYou?.brainSeq;
      return typeof consumed === 'number' && Number.isFinite(consumed) && consumed >= 0 ? consumed : 0;
    });
    const minSeq = Math.min(...consumedSeqs);
    await brainSyncLog.compactLog(minSeq);
  }
}

/**
 * Initialize the sync orchestrator
 */
export function initSyncOrchestrator() {
  // Sync immediately when a peer comes online
  peerOnlineHandler = (peer) => {
    if (!hasAnySyncEnabled(peer)) return;
    syncWithPeer(peer).catch(err => {
      console.error(`❌ Sync with ${peer.name} failed: ${err.message}`);
    });
  };
  instanceEvents.on('peer:online', peerOnlineHandler);

  // Background safety-net interval. The two side-cycle jobs (tombstone GC,
  // future asset-orphan GC) ride the same interval rather than getting their
  // own timer — once-per-minute is plenty given the 24h grace period, and
  // sharing a tick keeps the wake-up cost flat.
  syncTimer = setInterval(() => {
    syncAllPeers().catch(err => {
      console.error(`❌ Periodic sync failed: ${err.message}`);
    });
    // The outer `.catch` is non-optional — runTombstoneSweep is async and
    // can reject BEFORE its inner .catch fires (e.g. if the dynamic import
    // of tombstoneGc.js itself fails). An unhandled rejection on the
    // interval tick would crash the Node process under default settings.
    runTombstoneSweep().catch(err => {
      console.error(`❌ Tombstone sweep tick failed: ${err.message}`);
    });
    // Brain entity tombstones ride the same tick — same once-a-minute cadence,
    // same rejection (a rejected dynamic import would otherwise crash the tick).
    runBrainTombstoneSweep().catch(err => {
      console.error(`❌ Brain tombstone sweep tick failed: ${err.message}`);
    });
  }, SYNC_INTERVAL_MS);

  console.log(`🔄 Sync orchestrator started (${SYNC_INTERVAL_MS / 1000}s interval)`);
}

/**
 * Run a single tombstone GC sweep, fire-and-forget. Dynamic import keeps
 * the GC module's universe / pipeline / sharing dependency graph off the
 * orchestrator's module-load path (same reason as `categoriesCoveredByPeerSync`
 * above). Logs a single-line summary only when something was actually
 * pruned — quiet on no-op cycles.
 */
async function runTombstoneSweep() {
  const { sweepTombstones } = await import('./sharing/tombstoneGc.js');
  const result = await sweepTombstones().catch((err) => {
    console.error(`❌ Tombstone sweep failed: ${err.message}`);
    return null;
  });
  if (result && (result.universes > 0 || result.series > 0 || result.issues > 0 || result.collections > 0)) {
    // "series" is already its own plural so no s-suffix toggle needed there.
    const universes = `${result.universes} universe${result.universes === 1 ? '' : 's'}`;
    const issues = `${result.issues} issue${result.issues === 1 ? '' : 's'}`;
    const collections = `${result.collections} collection${result.collections === 1 ? '' : 's'}`;
    console.log(`🪦 Tombstone GC: pruned ${universes}, ${result.series} series, ${issues}, ${collections}`);
  }
  if (result && result.orphanBaseHashes > 0) {
    console.log(`🧹 Tombstone GC: swept ${result.orphanBaseHashes} orphaned base-hash entr${result.orphanBaseHashes === 1 ? 'y' : 'ies'}`);
  }
  if (result && result.orphanSubscriptions > 0) {
    console.log(`🧹 Tombstone GC: swept ${result.orphanSubscriptions} orphaned peer subscription${result.orphanSubscriptions === 1 ? '' : 's'}`);
  }
}

/**
 * Run a single brain-tombstone GC sweep, fire-and-forget. Dynamic import keeps
 * brainTombstoneGc (→ brainStorage) off the orchestrator's module-load path,
 * matching runTombstoneSweep above. Logs a one-line summary only when something
 * was actually pruned — quiet on no-op cycles.
 */
async function runBrainTombstoneSweep() {
  const { sweepBrainTombstones } = await import('./brainTombstoneGc.js');
  const result = await sweepBrainTombstones().catch((err) => {
    console.error(`❌ Brain tombstone sweep failed: ${err.message}`);
    return null;
  });
  if (result && result.pruned > 0) {
    console.log(`🪦 Brain tombstone GC: pruned ${result.pruned} tombstone${result.pruned === 1 ? '' : 's'}`);
  }
}

/**
 * Stop the sync orchestrator
 */
export function stopSyncOrchestrator() {
  if (peerOnlineHandler) {
    instanceEvents.removeListener('peer:online', peerOnlineHandler);
    peerOnlineHandler = null;
  }
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  console.log('🔄 Sync orchestrator stopped');
}
