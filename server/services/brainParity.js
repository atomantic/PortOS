/**
 * Brain Parity Check (federation anti-entropy AUDIT)
 *
 * `brainReconcile.js` already *heals* divergence: every sync cycle compares a
 * whole-brain checksum with the peer and, on a mismatch, pulls the full
 * snapshot and LWW-merges it. That converges state, but it is silent and
 * PULL-only — it reports nothing per record, and it can only fix records the
 * OTHER side holds. If our peer never runs its own cycle toward us (sync
 * disabled that direction, brain category off, an install that has been offline
 * for a month), the two brains stay divergent and both cards still read
 * "synced", because the Instances page shows delta-log cursor positions, not
 * verified row-level parity (issue #4519).
 *
 * This module is the audit layer that makes divergence VISIBLE:
 *
 *   - `buildBrainManifest()` — one lightweight row per record per type,
 *     `{ id, updatedAt, deleted }`, tombstones included. Ids and clocks only —
 *     deliberately NO record bodies or names, so the manifest a peer pulls
 *     carries no brain content.
 *   - `checkPeerBrainParity(peer)` — fetch the peer's manifest, diff it against
 *     ours PER TYPE with the shared `computeRecordIntegrity`, and classify each
 *     record as in-parity / local-only / peer-only / diverged. Also compares the
 *     whole-brain checksum, which catches the one case a manifest can't:
 *     matching ids AND matching `updatedAt` but different record bodies (a
 *     partial write, or a field a peer's older schema silently dropped).
 *   - `runBrainParityCheck({ peerId })` — the operation the user (or a future
 *     schedule) triggers: run the check against one peer or every sync-enabled
 *     peer, persist the results, return them.
 *   - `getBrainParityReports()` — the last stored result per peer, so the
 *     Instances page can render parity state without re-hitting every peer.
 *
 * Deliberately NOT wired into the sync cycle: it is a distinct on-demand
 * operation so a routine sync never pays for a full manifest exchange.
 *
 * Backward compatible in both directions. A peer too old to serve
 * `/api/brain/reconcile/manifest` (404) is reported as `peer-too-old` rather
 * than as divergence, and older peers simply never call our manifest route.
 */

import { readJSONFile, ensureDir, atomicWrite, dataPath, PATHS } from '../lib/fileUtils.js';
import { computeRecordIntegrity, INTEGRITY_STATUS } from '../lib/syncIntegrity.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import * as brainStorage from './brainStorage.js';
import * as brainReconcile from './brainReconcile.js';
import { getPeers } from './instances.js';

const { BRAIN_ENTITY_TYPES } = brainStorage;

const REPORTS_FILE = dataPath('brain_parity_reports.json');

// How many out-of-parity record ids to PERSIST per type. The live response
// carries the full list; the stored copy is what the Instances page renders on
// load, and a badly diverged install could otherwise write tens of thousands of
// ids into a file re-read on every page load. `truncated` tells the UI the
// stored sample is partial so it can prompt for a fresh run.
const STORED_RECORDS_PER_TYPE = 25;

// Peer fetches are bounded so an unresponsive peer can't wedge an audit run.
// Generous relative to the sync cycle's 15s budget: the snapshot fallback below
// pulls a peer's ENTIRE brain, which is legitimately slow on a large install.
const PEER_FETCH_TIMEOUT_MS = 30000;

const isNonEmptyStr = (v) => typeof v === 'string' && v.length > 0;

/**
 * Build this instance's brain manifest: `{ types: { [type]: [row] } }` where a
 * row is `{ id, updatedAt, deleted }`. Tombstones are included (deleted:true) so
 * a delete one side applied and the other missed surfaces as a real difference
 * instead of looking like a local-only record.
 */
export async function buildBrainManifest() {
  const types = {};
  for (const type of [...BRAIN_ENTITY_TYPES].sort()) {
    const records = await brainStorage.getRawRecords(type);
    types[type] = Object.keys(records).sort().map((id) => {
      const record = records[id];
      return {
        id,
        updatedAt: record?.updatedAt ?? null,
        deleted: record?._deleted === true,
      };
    });
  }
  return { types };
}

/**
 * Coerce an untrusted peer manifest into `{ [type]: [row] }`.
 *
 * The peer response is untrusted the same way `sharing/integrity` treats its
 * manifest: `computeRecordIntegrity` reads `r.id` and keys a Map on it, so a
 * malformed row (null, a scalar, an id-less object) would throw and 500 the
 * caller. Rows are rebuilt field-by-field rather than passed through, because
 * `computeRecordIntegrity` also inspects `assetHashes`/`metadataMissing` — a
 * peer that sent those (a newer version, or a hostile one) could otherwise push
 * a brain record into an asset status that has no meaning here and no counter.
 * Unknown types are dropped rather than reported — a newer peer with an entity
 * store we don't have yet is not divergence, it's a version gap.
 */
function normalizeRemoteManifest(body) {
  const out = {};
  const types = body?.types;
  if (!types || typeof types !== 'object') return out;
  for (const type of BRAIN_ENTITY_TYPES) {
    const rows = types[type];
    if (!Array.isArray(rows)) continue;
    out[type] = rows
      .filter((r) => r && typeof r === 'object' && isNonEmptyStr(r.id))
      .map((r) => ({ id: r.id, updatedAt: r.updatedAt ?? null, deleted: r.deleted === true }));
  }
  return out;
}

/**
 * Derive a manifest from a full `/reconcile/snapshot` payload.
 *
 * The fallback for a peer that predates the manifest route: it already serves
 * the whole raw record map for anti-entropy, and the manifest is a projection of
 * exactly that. Heavier over the wire, but it means parity is auditable against
 * every peer that supports reconcile at all, not just upgraded ones.
 */
function manifestFromSnapshot(snapshot) {
  const out = {};
  const records = snapshot?.records;
  if (!records || typeof records !== 'object') return out;
  for (const type of BRAIN_ENTITY_TYPES) {
    const byId = records[type];
    if (!byId || typeof byId !== 'object') continue;
    out[type] = Object.entries(byId)
      .filter(([, rec]) => rec && typeof rec === 'object')
      .map(([id, rec]) => ({ id, updatedAt: rec.updatedAt ?? null, deleted: rec._deleted === true }));
  }
  return out;
}

async function fetchPeerJson(peer, path) {
  const res = await peerFetch(
    `${peerBaseUrl(peer)}${path}`,
    { signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS) },
    peer,
  ).catch(() => null);
  // Distinguish unreachable (peerFetch threw → null) from a 404 (peer online but
  // running older code). Collapsing them would tell the user "upgrade the peer"
  // when the peer is simply down, and vice versa.
  if (!res) return { reason: 'peer-unreachable', body: null };
  if (res.status === 404) return { reason: 'peer-too-old', body: null };
  if (!res.ok) return { reason: 'fetch-failed', body: null };
  const body = await res.json().catch(() => null);
  if (!body) return { reason: 'fetch-failed', body: null };
  return { reason: null, body };
}

/**
 * Pull the peer's manifest, falling back to projecting one out of the peer's
 * full reconcile snapshot when it is too old to expose the manifest route.
 */
async function fetchRemoteManifest(peer) {
  const direct = await fetchPeerJson(peer, '/api/brain/reconcile/manifest');
  if (!direct.reason) return { reason: null, byType: normalizeRemoteManifest(direct.body) };
  if (direct.reason !== 'peer-too-old') return { reason: direct.reason, byType: null };

  const snapshot = await fetchPeerJson(peer, '/api/brain/reconcile/snapshot');
  if (snapshot.reason) {
    // The snapshot route missing too means the peer has no reconcile support at
    // all — still "too old", just further back.
    return { reason: snapshot.reason === 'peer-too-old' ? 'peer-too-old' : snapshot.reason, byType: null };
  }
  return { reason: null, byType: manifestFromSnapshot(snapshot.body) };
}

const emptyCounts = () => ({
  total: 0,
  [INTEGRITY_STATUS.IN_PARITY]: 0,
  [INTEGRITY_STATUS.LOCAL_ONLY]: 0,
  [INTEGRITY_STATUS.PEER_ONLY]: 0,
  [INTEGRITY_STATUS.DIVERGED]: 0,
});

const addCounts = (into, from) => {
  for (const key of Object.keys(into)) into[key] += from[key] ?? 0;
  return into;
};

/**
 * Diff a local manifest against a remote one, per entity type.
 *
 * Per-TYPE rather than one flat pass: brain ids are only unique within a store,
 * so a single global diff could pair an `ideas` record with an unrelated
 * `people` record that happened to share an id. Diffing per type also gives the
 * UI its breakdown for free.
 *
 * Returns `{ summary, byType }`, where `byType` lists only the records that are
 * NOT in parity — the actionable set. A type in full parity is still reported
 * (with its counts) so "checked and clean" is distinguishable from "not checked".
 */
export function diffBrainManifests(localByType, remoteByType) {
  const summary = emptyCounts();
  const byType = [];

  for (const type of [...BRAIN_ENTITY_TYPES].sort()) {
    const local = localByType?.[type] ?? [];
    const remote = remoteByType?.[type] ?? [];
    if (local.length === 0 && remote.length === 0) continue;

    const rows = computeRecordIntegrity(local, remote);
    const counts = emptyCounts();
    const records = [];
    for (const row of rows) {
      counts.total += 1;
      if (counts[row.status] !== undefined) counts[row.status] += 1;
      if (row.status !== INTEGRITY_STATUS.IN_PARITY) records.push({ id: row.id, status: row.status });
    }
    addCounts(summary, counts);
    byType.push({ type, counts, records });
  }

  return { summary, byType };
}

/**
 * Compare the whole-brain checksums.
 *
 * This is the signal the manifest cannot produce: two peers can hold the same
 * ids with the same `updatedAt` and still differ in a record BODY (a partial
 * write, a field an older peer's schema dropped on apply). `match: false` with
 * zero divergent records in the manifest diff means exactly that — worth
 * surfacing rather than reporting a clean bill of health.
 *
 * A peer too old to serve `/reconcile/checksum` yields `peer: null,
 * match: null` — unknown, never a false "diverged".
 */
async function compareChecksums(peer) {
  const [local, remote] = await Promise.all([
    brainReconcile.getBrainChecksum().catch(() => null),
    fetchPeerJson(peer, '/api/brain/reconcile/checksum'),
  ]);
  const peerChecksum = isNonEmptyStr(remote.body?.checksum) ? remote.body.checksum : null;
  return {
    local: local ?? null,
    peer: peerChecksum,
    match: local && peerChecksum ? local === peerChecksum : null,
  };
}

/**
 * Run a full record-level parity check against ONE peer.
 *
 * @param {object} peer - Peer registry record.
 * @returns {Promise<object>} report — see module docblock for the shape.
 */
export async function checkPeerBrainParity(peer) {
  const base = {
    peerId: peer?.id ?? null,
    peerInstanceId: peer?.instanceId ?? null,
    peerName: peer?.name ?? null,
    checkedAt: new Date().toISOString(),
  };

  const remote = await fetchRemoteManifest(peer);
  if (remote.reason) {
    return { ...base, available: false, reason: remote.reason, checksums: null, summary: emptyCounts(), byType: [] };
  }

  // Only reached once the peer answered — an unreachable peer never costs a
  // read of every brain store. The manifest build and the checksum comparison
  // each walk the whole brain, so run them together rather than back to back.
  const [local, checksums] = await Promise.all([buildBrainManifest(), compareChecksums(peer)]);
  const { summary, byType } = diffBrainManifests(local.types, remote.byType);

  return { ...base, available: true, checksums, summary, byType };
}

async function loadReports() {
  const stored = await readJSONFile(REPORTS_FILE, {});
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
}

async function saveReports(reports) {
  await ensureDir(PATHS.data);
  await atomicWrite(REPORTS_FILE, reports);
}

/** Cap the per-type record lists before persisting. See STORED_RECORDS_PER_TYPE. */
function forStorage(report) {
  return {
    ...report,
    byType: report.byType.map((t) => ({
      ...t,
      records: t.records.slice(0, STORED_RECORDS_PER_TYPE),
      truncated: t.records.length > STORED_RECORDS_PER_TYPE,
    })),
  };
}

/**
 * The last stored parity report per peer, keyed by the peer's `instanceId`
 * (the stable cross-machine identity the sync cursors are keyed by, so a peer
 * re-added to the registry keeps its history).
 */
export async function getBrainParityReports() {
  return loadReports();
}

/**
 * Run the parity check and persist the results.
 *
 * @param {{ peerId?: string }} [opts] - Local peer-registry id. Omitted runs
 *   every federating peer.
 * @returns {Promise<{ reports: object[] }>}
 */
export async function runBrainParityCheck({ peerId } = {}) {
  const peers = await getPeers().catch(() => []);
  // The sweep deliberately does NOT filter on the peer's brain sync CATEGORY.
  // A peer whose brain category was turned off (or never turned on) is exactly
  // where silent divergence accumulates — filtering it out would hide the case
  // the audit exists to find. An un-probed peer (no instanceId) is skipped
  // because there is no stable key to file its report under.
  const targets = isNonEmptyStr(peerId)
    ? peers.filter((p) => p.id === peerId)
    : peers.filter((p) => p.syncEnabled !== false && isNonEmptyStr(p.instanceId));

  if (isNonEmptyStr(peerId) && targets.length === 0) {
    return { reports: [{ peerId, available: false, reason: 'peer-not-found', checkedAt: new Date().toISOString() }] };
  }

  const reports = [];

  // Sequential, not Promise.all: each peer costs a manifest fetch plus a full
  // read of every local brain store, and a user with several peers shouldn't
  // fan that out at once.
  for (const peer of targets) {
    const report = await checkPeerBrainParity(peer);
    reports.push(report);
    // Read-modify-write per peer rather than once around the whole sweep. A
    // sweep can span minutes (each peer gets its own 30s fetch budget), and
    // holding one in-memory copy across all of it would drop a report the user
    // triggered from a peer card mid-sweep — and would lose every result if the
    // sweep were interrupted before the final write.
    const key = report.peerInstanceId || report.peerId;
    if (key) {
      const stored = await loadReports();
      stored[key] = forStorage(report);
      await saveReports(stored);
    }
    const detail = report.available
      ? `${report.summary[INTEGRITY_STATUS.LOCAL_ONLY]} local-only, ${report.summary[INTEGRITY_STATUS.PEER_ONLY]} peer-only, ${report.summary[INTEGRITY_STATUS.DIVERGED]} diverged`
      : report.reason;
    console.log(`🧠🔍 Brain parity vs ${peer.name || peer.id}: ${detail}`);
  }

  return { reports };
}
