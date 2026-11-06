/**
 * Usage cutover barrier (#15098): the one gate between old accounting state and a
 * rebuilt partition during the native-history replacement planned in #15031.
 *
 * Machine-local and file-primary (docs/USAGE_CUTOVER_BARRIER.md, docs/STORAGE.md).
 * Nothing here runs at boot; every transition is an explicit operator action.
 *
 * The record is re-read from disk at every gate rather than cached, so a restart,
 * a CLI backfill in its own process and a damaged file all see the fence. Usage
 * writes already rewrite the whole ledger, so this read is never the hot cost.
 *
 * Evaluated independently of `syncEnabled`, `fullSync` and the category map: those
 * decide what a peer is asked for, this decides what may land.
 *
 * Lock order is always usage queue -> peer lock -> barrier lock. This module never
 * awaits a participant's drain, replay or retirement while holding its own lock.
 *
 * Leaf module: usage.js is reached by most of the server, so writers register here
 * instead of being imported, and peer I/O stays behind dynamic imports.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { ServerError } from '../lib/errorHandler.js';
import { isPlainObject } from '../lib/objects.js';
import { PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';

// Resolved per call: this leaf is reached by suites whose fileUtils mock has no data root.
export const usageCutoverBarrierFile = () => join(PATHS.data, 'usage-cutover-barrier.json');
export const USAGE_CUTOVER_FENCED = 'USAGE_CUTOVER_FENCED';

const RECORD_VERSION = 1;
const BARRIER_SCHEMA = PORTOS_SCHEMA_VERSIONS.usageCutover;
const ACK_TIMEOUT_MS = 10_000;
const ACK_MAX_BYTES = 256 * 1024;
const HELD_STATES = new Set(['fencing', 'fenced', 'rolling-back']);
const KNOWN_STATES = new Set(['idle', 'activated', ...HELD_STATES]);
// A barrier cannot be acquired without both of these able to drain.
const REQUIRED_PARTICIPANTS = ['usageLedger', 'peerDigests'];

const withBarrierLock = createMutex();
const registered = new Map();
const compatibleRuntimes = new Set();
const announcedRefusals = new Set();

const idleRecord = ({ retiredEpochs = [], deferredRetirements = [] } = {}) => ({
  version: RECORD_VERSION,
  state: 'idle',
  migrationEpoch: null,
  participants: [],
  acks: {},
  holdReasons: [],
  fingerprints: null,
  spool: [],
  nextSeq: 1,
  retiredEpochs,
  deferredRetirements,
});

async function readRecord() {
  const raw = await fs.readFile(usageCutoverBarrierFile(), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw === null) return idleRecord();
  const record = JSON.parse(raw);
  if (record?.version !== RECORD_VERSION || !KNOWN_STATES.has(record.state)) {
    throw new Error(`Unsupported usage cutover record (version ${record?.version}, state ${record?.state})`);
  }
  return record;
}

// A fence must never lift because its record became unreadable: every gate treats
// this sentinel as held, and an operator action refuses until it is repaired.
const loadRecord = () => readRecord().catch((err) => ({ state: 'unreadable', error: err.message, migrationEpoch: null, spool: [] }));

const writeRecord = (record) => {
  announcedRefusals.clear();
  return atomicWrite(usageCutoverBarrierFile(), record);
};

const heldBy = (record) => record.state === 'unreadable' || HELD_STATES.has(record.state)
  // Code rolled back beneath an activated record must not resume old writers.
  || (record.state === 'activated' && !compatibleRuntimes.has(record.migrationEpoch));

const fencedError = (subject, record) => new ServerError(
  `${subject} refused: usage cutover barrier is ${record.state}${record.migrationEpoch ? ` (epoch ${record.migrationEpoch})` : ''}. See docs/USAGE_CUTOVER_BARRIER.md.`,
  { status: 409, code: USAGE_CUTOVER_FENCED, severity: 'warning' },
);

export const isUsageCutoverFenced = (err) => err?.code === USAGE_CUTOVER_FENCED;

/**
 * A writer's handle on the barrier. `drain` settles queued work, `inFlight` feeds
 * operator status, `fingerprintPath` is bound at fence time so a release can prove
 * the matched data is back, and `replay`, `heldOrigins`, `retire` serve release.
 */
export function registerUsageCutoverParticipant({ name, ...hooks }) {
  registered.set(name, hooks);
}

/**
 * Declared by the runtime that understands a rebuilt partition (#15031). Activation
 * refuses without it, so this barrier-only code cannot activate any epoch, and a
 * later code rollback leaves an activated record fenced rather than writing.
 */
export function registerUsageCutoverRuntime(migrationEpoch) {
  compatibleRuntimes.add(migrationEpoch);
}

const participantHook = (hook) => [...registered.values()].map((entry) => entry[hook]).find(Boolean);

/** True while nothing may touch usage state on disk: load normalization, derived stores. */
export async function usageLedgerFenced() {
  return heldBy(await loadRecord());
}

/**
 * The write boundary, called inside the ledger queue so anything queued before a
 * fence is decided here and anything already running is what the drain waits for.
 *
 * Retainable writes are live run accounting: real money data with no other durable
 * home, so a fence holds them in the record and answers `{ admitted: false }`.
 * The rest are recomputable from native sources or are operator commands, and are
 * refused outright: their callers' watermarks have not advanced, so nothing is lost.
 * After activation those stay refused, because they add to old counters.
 */
export async function admitUsageWrite(op, args, { retainable }) {
  const record = await loadRecord();
  if (record.state === 'idle') return { admitted: true };
  if (!retainable || record.state === 'unreadable') throw fencedError(`Usage write ${op}`, record);
  if (!heldBy(record)) return { admitted: true };
  return withBarrierLock(async () => {
    const current = await readRecord();
    if (!heldBy(current)) return { admitted: true };
    const seq = current.nextSeq++;
    current.spool.push({ seq, op, args, at: new Date().toISOString() });
    await writeRecord(current);
    console.log(`⏸️ Usage cutover: retained ${op} as write ${seq} of epoch ${current.migrationEpoch}`);
    return { admitted: false };
  });
}

/** Writes held by the fence, without exposing them to status or peers. */
export async function readRetainedUsageWrites() {
  return (await loadRecord()).spool;
}

/** A peer removed during a fence keeps its retirement until the fence lifts. */
export async function deferUsageRetirement(instanceId) {
  return withBarrierLock(async () => {
    const record = await loadRecord();
    if (!heldBy(record)) return false;
    if (record.state === 'unreadable') throw fencedError('Usage retirement', record);
    if (!record.deferredRetirements.includes(instanceId)) record.deferredRetirements.push(instanceId);
    await writeRecord(record);
    return true;
  });
}

const stampOf = (record) => ({ migrationEpoch: record.migrationEpoch, state: record.state, barrierSchema: BARRIER_SCHEMA });

/**
 * What this instance may publish. `null` means no barrier and an unchanged wire.
 * Otherwise an old runtime sees empty `instances` whatever else happens, because
 * epoch data travels only inside the stamp it cannot read.
 */
export async function describeOutboundUsage() {
  const record = await loadRecord();
  if (record.state === 'idle') return null;
  return { withhold: heldBy(record), stamp: stampOf(record) };
}

const refuse = (record, reason, peerId) => {
  const key = `${record.migrationEpoch}|${reason}|${peerId}`;
  if (!announcedRefusals.has(key)) {
    announcedRefusals.add(key);
    console.log(`🚫 Usage cutover: refused peer payload from ${peerId || 'unknown peer'} (${reason})`);
  }
  return { admitted: false, reason };
};

async function holdForPeerRollback(migrationEpoch, peerId) {
  await withBarrierLock(async () => {
    const current = await readRecord();
    if (current.state !== 'activated' || current.migrationEpoch !== migrationEpoch) return;
    current.state = 'rolling-back';
    current.rollback = { at: new Date().toISOString(), reason: `Participant ${peerId || 'unknown'} is rolling back` };
    current.holdReasons = ['not-verified'];
    await writeRecord(current);
    console.log(`⏸️ Usage cutover: holding epoch ${migrationEpoch} because a participant is rolling back`);
  });
}

/**
 * The inbound gate, for direct, forwarded, delayed and replayed payloads alike.
 * Called inside the peer-digest lock against current state, never a captured one.
 * The stamp is envelope-level: a relay only ever holds what it admitted itself.
 */
export async function admitInboundUsage(stamp, { peerId = null } = {}) {
  const record = await loadRecord();
  const stamped = isPlainObject(stamp);
  if (heldBy(record)) return refuse(record, `barrier-${record.state}`, peerId);
  if (record.state === 'idle') {
    if (!stamped) return { admitted: true, migrationEpoch: null, participants: null };
    return refuse(record, stamp.state === 'activated' ? 'foreign-epoch' : 'peer-held', peerId);
  }
  if (!stamped) return refuse(record, 'stale-epoch', peerId);
  if (stamp.barrierSchema !== BARRIER_SCHEMA) return refuse(record, 'schema-mismatch', peerId);
  if (stamp.migrationEpoch !== record.migrationEpoch) return refuse(record, 'stale-epoch', peerId);
  if (stamp.state === 'rolling-back') {
    await holdForPeerRollback(record.migrationEpoch, peerId);
    return refuse(record, 'peer-rolling-back', peerId);
  }
  if (stamp.state !== 'activated') return refuse(record, 'peer-held', peerId);
  return { admitted: true, migrationEpoch: record.migrationEpoch, participants: new Set(record.participants) };
}

/** Which stored digests belong to the current view; old ones stay on disk for rollback. */
export async function visibleUsageEpoch() {
  const record = await loadRecord();
  return record.state === 'activated' ? record.migrationEpoch : null;
}

async function selfInstanceId() {
  const { getSelf, UNKNOWN_INSTANCE_ID } = await import('./instanceIdentity.js');
  const self = await getSelf().catch(() => null);
  const id = self?.instanceId;
  return typeof id === 'string' && id && id !== UNKNOWN_INSTANCE_ID ? id : null;
}

const refusal = (message, code, holdReasons = []) => new ServerError(
  holdReasons.length ? `${message}: ${holdReasons.join(', ')}` : message,
  { status: 409, code, severity: 'warning', context: { holdReasons } },
);

const requireRecord = async () => {
  const record = await loadRecord();
  if (record.state === 'unreadable') {
    throw new ServerError(`Usage cutover record is unreadable and stays fenced: ${record.error}`, { status: 409, code: 'USAGE_CUTOVER_UNREADABLE' });
  }
  return record;
};

const requireEpoch = async (migrationEpoch) => {
  const record = await requireRecord();
  if (record.migrationEpoch !== migrationEpoch) {
    throw refusal(`No barrier for epoch ${migrationEpoch} on this instance`, 'USAGE_CUTOVER_EPOCH_MISMATCH');
  }
  return record;
};

async function fileFingerprint(path) {
  const bytes = await fs.readFile(path).catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  return bytes ? createHash('sha256').update(bytes).digest('hex') : 'missing';
}

async function currentFingerprints() {
  const out = {};
  for (const [name, { fingerprintPath }] of registered) {
    if (fingerprintPath) out[name] = await fileFingerprint(fingerprintPath);
  }
  return out;
}

// Waits for every transaction that began before the fence. Once the drain returns,
// a later write can only reach the admission gate above.
async function drainAndBind(migrationEpoch) {
  for (const { drain } of registered.values()) await drain?.();
  const fingerprints = await currentFingerprints();
  await withBarrierLock(async () => {
    const current = await readRecord();
    if (current.migrationEpoch !== migrationEpoch) return;
    current.fingerprints ??= fingerprints;
    if (current.state === 'fencing') {
      current.state = 'fenced';
      current.fencedAt = new Date().toISOString();
    }
    await writeRecord(current);
  });
}

/** Fence this instance. Retrying the same epoch and set resumes an interrupted drain. */
export async function acquireUsageCutover({ migrationEpoch, participants }) {
  const missing = REQUIRED_PARTICIPANTS.filter((name) => !registered.has(name));
  if (missing.length) throw new ServerError(`Usage writers not loaded: ${missing.join(', ')}`, { status: 500 });
  const selfId = await selfInstanceId();
  if (!selfId) throw refusal('This instance has no federation identity yet', 'USAGE_CUTOVER_NO_IDENTITY');
  const set = [...new Set(participants)].sort();
  if (!set.includes(selfId)) throw refusal('Participants must include this instance', 'USAGE_CUTOVER_SELF_MISSING');
  await requireRecord();
  await withBarrierLock(async () => {
    const current = await readRecord();
    if (current.state === 'idle') {
      if (current.retiredEpochs.includes(migrationEpoch)) throw refusal(`Epoch ${migrationEpoch} was already retired; choose a new one`, 'USAGE_CUTOVER_EPOCH_RETIRED');
      await writeRecord({
        ...idleRecord(current),
        state: 'fencing',
        migrationEpoch,
        participants: set,
        holdReasons: ['not-verified'],
        acquiredAt: new Date().toISOString(),
      });
      console.log(`⏸️ Usage cutover: acquired fence for epoch ${migrationEpoch} with ${set.length} participant(s)`);
      return;
    }
    if (current.migrationEpoch !== migrationEpoch || current.participants.join() !== set.join()) {
      throw refusal(`A barrier for epoch ${current.migrationEpoch} already holds this instance`, 'USAGE_CUTOVER_BUSY');
    }
    if (!HELD_STATES.has(current.state) || current.state === 'rolling-back') {
      throw refusal(`Barrier is ${current.state}; it cannot be re-acquired`, 'USAGE_CUTOVER_BUSY');
    }
  });
  await drainAndBind(migrationEpoch);
  return getUsageCutoverStatus();
}

const projectAck = (selfId, record) => ({
  instanceId: selfId,
  barrierSchema: BARRIER_SCHEMA,
  state: record.state,
  migrationEpoch: record.migrationEpoch,
  participants: record.participants ?? [],
  drained: HELD_STATES.has(record.state) ? record.state !== 'fencing' : record.state === 'activated',
  runtimeReady: compatibleRuntimes.has(record.migrationEpoch),
  retiredEpochs: record.retiredEpochs ?? [],
  // Lets an instance with no direct route to a participant still learn its state.
  observedAcks: Object.fromEntries(Object.entries(record.acks ?? {}).filter(([, ack]) => ack.outcome === 'ok')
    .map(([id, { observedAcks: _nested, ...ack }]) => [id, ack])),
});

/** The acknowledgment a participant reads over the peer API. Bounded: no usage data. */
export async function getUsageCutoverAck() {
  return projectAck(await selfInstanceId(), await loadRecord());
}

async function loadAckTransport() {
  const { peerFetch, readPeerBody } = await import('../lib/peerHttpClient.js');
  const { peerBaseUrl } = await import('../lib/peerUrl.js');
  const { withAbortTimeout } = await import('../lib/abortTimeout.js');
  return { peerFetch, readPeerBody, peerBaseUrl, withAbortTimeout };
}

async function fetchParticipantAck(peer, { peerFetch, readPeerBody, peerBaseUrl, withAbortTimeout }) {
  const observedAt = new Date().toISOString();
  const response = await withAbortTimeout(ACK_TIMEOUT_MS, (signal) => peerFetch(`${peerBaseUrl(peer)}/api/sync/usage/cutover`, { signal }, peer)).catch(() => null);
  if (!response) return { outcome: 'offline', observedAt };
  if (response.status === 404) return { outcome: 'old-runtime', observedAt };
  if (!response.ok) return { outcome: 'refused', status: response.status, observedAt };
  const body = await readPeerBody(response, 'json', { maxBytes: ACK_MAX_BYTES }).catch(() => null);
  if (!isPlainObject(body) || !Number.isInteger(body.barrierSchema)) return { outcome: 'old-runtime', observedAt };
  // A reused address answering as someone else has not acknowledged anything.
  if (body.instanceId !== peer.instanceId) return { outcome: 'wrong-instance', observedAt };
  return { ...body, outcome: 'ok', via: 'direct', observedAt };
}

const OUTCOME_HOLDS = { offline: 'participant-offline', 'old-runtime': 'participant-old-runtime', refused: 'participant-refused', 'wrong-instance': 'participant-wrong-instance' };

function participantHolds(id, ack, record) {
  if (!ack) return [`participant-no-route:${id}`];
  if (ack.outcome !== 'ok') return [`${OUTCOME_HOLDS[ack.outcome]}:${id}`];
  if (ack.barrierSchema !== BARRIER_SCHEMA) return [`participant-schema-mismatch:${id}`];
  if (record.state === 'rolling-back') {
    const rolledBack = ack.state === 'idle' ? ack.retiredEpochs?.includes(record.migrationEpoch)
      : ack.state === 'rolling-back' && ack.migrationEpoch === record.migrationEpoch;
    return rolledBack ? [] : [`participant-not-rolling-back:${id}`];
  }
  if (ack.migrationEpoch !== record.migrationEpoch) return [`participant-epoch-mismatch:${id}`];
  if ((ack.participants ?? []).join() !== record.participants.join()) return [`participant-set-mismatch:${id}`];
  if (ack.state !== 'fenced' && ack.state !== 'activated') return [`participant-not-fenced:${id}`];
  if (!ack.drained) return [`participant-not-drained:${id}`];
  return ack.runtimeReady ? [] : [`participant-runtime-not-ready:${id}`];
}

/** Checks peers and held origins, whatever their category map or sync switch says. */
async function coverageHolds(record, peers) {
  const inSet = new Set(record.participants);
  const holds = [];
  for (const peer of peers) {
    if (peer.enabled === false) continue;
    if (!peer.instanceId) holds.push(`peer-unidentified:${peer.name || peer.host || 'unnamed'}`);
    else if (!inSet.has(peer.instanceId)) holds.push(`peer-not-participant:${peer.instanceId}`);
  }
  // A retirement deferred by the fence is the operator's answer for that origin.
  const held = await participantHook('heldOrigins')?.() ?? [];
  for (const origin of held) {
    if (!inSet.has(origin) && !record.deferredRetirements.includes(origin)) holds.push(`unknown-origin:${origin}`);
  }
  return [...new Set(holds)];
}

/**
 * Reads every participant once and records why cutover is held. Explicit only: a
 * peer that cannot be asked is a hold, so silence can never be read as agreement.
 */
export async function verifyUsageCutover({ migrationEpoch }) {
  const record = await requireEpoch(migrationEpoch);
  const selfId = await selfInstanceId();
  const { loadData } = await import('./instanceIdentity.js');
  const peers = (await loadData()).peers ?? [];
  const others = record.participants.filter((id) => id !== selfId);
  const acks = {};
  const transport = await loadAckTransport();
  await Promise.all(others.map(async (id) => {
    const peer = peers.find((candidate) => candidate.instanceId === id && candidate.enabled !== false);
    if (peer) acks[id] = await fetchParticipantAck(peer, transport);
  }));
  for (const id of others) {
    if (acks[id]?.outcome === 'ok') continue;
    const relayed = Object.entries(acks).map(([via, ack]) => ({ via, ack: ack.observedAcks?.[id] })).find(({ ack }) => ack?.outcome === 'ok');
    if (relayed) acks[id] = { ...relayed.ack, via: relayed.via };
    // Rolling back only ever ends in that epoch being retired, so this stays true
    // after the relay that carried it has released and forgotten it.
    else if (record.state === 'rolling-back' && record.acks[id]?.outcome === 'ok' && record.acks[id].state === 'rolling-back') acks[id] = record.acks[id];
  }
  const holds = others.flatMap((id) => participantHolds(id, acks[id], record));
  if (record.state === 'fencing') holds.push('local-not-drained');
  if (record.state === 'fenced') {
    if (!compatibleRuntimes.has(migrationEpoch)) holds.push('local-runtime-not-ready');
    holds.push(...await coverageHolds(record, peers));
  }
  await withBarrierLock(async () => {
    const current = await readRecord();
    if (current.migrationEpoch !== migrationEpoch) return;
    current.acks = acks;
    current.holdReasons = holds;
    current.verifiedAt = new Date().toISOString();
    await writeRecord(current);
  });
  return getUsageCutoverStatus();
}

async function flushDeferredRetirements() {
  const pending = (await readRecord()).deferredRetirements;
  const retire = participantHook('retire');
  if (!pending.length || !retire) return;
  for (const id of pending) await retire(id);
  await withBarrierLock(async () => {
    const current = await readRecord();
    current.deferredRetirements = current.deferredRetirements.filter((id) => !pending.includes(id));
    await writeRecord(current);
  });
}

/**
 * Resume under the new epoch. Retained writes stay retained: they were recorded
 * against old accounting, and replaying them would add to the rebuilt partition.
 */
export async function activateUsageCutover({ migrationEpoch }) {
  const before = await requireEpoch(migrationEpoch);
  if (before.state === 'activated') return getUsageCutoverStatus();
  if (before.state !== 'fenced') throw refusal(`Barrier is ${before.state}; only a fenced instance can activate`, 'USAGE_CUTOVER_NOT_FENCED');
  const verified = await verifyUsageCutover({ migrationEpoch });
  if (verified.holdReasons.length) throw refusal('Activation held', 'USAGE_CUTOVER_HELD', verified.holdReasons);
  await withBarrierLock(async () => {
    const current = await readRecord();
    if (current.state !== 'fenced' || current.migrationEpoch !== migrationEpoch) throw refusal('Barrier changed during activation', 'USAGE_CUTOVER_NOT_FENCED');
    current.state = 'activated';
    current.activatedAt = new Date().toISOString();
    current.holdReasons = [];
    await writeRecord(current);
    console.log(`✅ Usage cutover: epoch ${migrationEpoch} activated on this instance`);
  });
  await flushDeferredRetirements();
  return getUsageCutoverStatus();
}

/** Re-fence after a failed cutover. The barrier stays until `release` proves the restore. */
export async function rollbackUsageCutover({ migrationEpoch, reason }) {
  const before = await requireEpoch(migrationEpoch);
  if (before.state !== 'rolling-back') {
    await withBarrierLock(async () => {
      const current = await readRecord();
      if (current.migrationEpoch !== migrationEpoch) throw refusal('Barrier changed during rollback', 'USAGE_CUTOVER_EPOCH_MISMATCH');
      current.state = 'rolling-back';
      current.rollback = { at: new Date().toISOString(), reason };
      current.holdReasons = ['not-verified'];
      await writeRecord(current);
    });
    console.log(`⏸️ Usage cutover: rolling back epoch ${migrationEpoch}`);
  }
  await drainAndBind(migrationEpoch);
  return getUsageCutoverStatus();
}

async function releaseGuards(record) {
  const verified = await verifyUsageCutover({ migrationEpoch: record.migrationEpoch });
  if (record.state === 'rolling-back') {
    if (verified.holdReasons.length) throw refusal('Release held until every participant has rolled back', 'USAGE_CUTOVER_HELD', verified.holdReasons);
  } else {
    // Aborting before activation is safe with a participant offline, because the
    // epoch rules refuse both directions. One already activated needs a rollback.
    const activated = verified.participants.filter((entry) => entry.ack?.state === 'activated').map((entry) => `participant-activated:${entry.instanceId}`);
    if (activated.length) throw refusal('Roll back activated participants first', 'USAGE_CUTOVER_HELD', activated);
  }
  const fingerprints = await currentFingerprints();
  const changed = Object.keys(record.fingerprints ?? {}).filter((name) => fingerprints[name] !== record.fingerprints[name]);
  if (changed.length) {
    throw refusal('Restore the matched backup before releasing', 'USAGE_CUTOVER_RESTORE_REQUIRED', changed.map((name) => `restore-required:${name}`));
  }
}

/**
 * Lift the fence back to old accounting. Retained writes replay into the proven
 * restored ledger and the epoch is retired, so any payload still stamped with it
 * stays refused here for good. Re-running after a crash is safe at every step.
 */
export async function releaseUsageCutover({ migrationEpoch }) {
  const record = await requireRecord();
  if (record.state === 'idle') {
    if (!record.retiredEpochs.includes(migrationEpoch)) throw refusal(`No barrier for epoch ${migrationEpoch} on this instance`, 'USAGE_CUTOVER_EPOCH_MISMATCH');
    await flushDeferredRetirements();
    return getUsageCutoverStatus();
  }
  if (record.migrationEpoch !== migrationEpoch) throw refusal(`No barrier for epoch ${migrationEpoch} on this instance`, 'USAGE_CUTOVER_EPOCH_MISMATCH');
  if (record.state === 'fencing') throw refusal('Fence is still draining; retry acquire', 'USAGE_CUTOVER_NOT_FENCED');
  if (record.state === 'activated') throw refusal('An activated epoch is left through rollback', 'USAGE_CUTOVER_ACTIVATED');
  // Replay moves the ledger off its bound fingerprint, so a retry after a crash
  // mid-replay is past the proof rather than failing it.
  if (!record.replayStarted) await releaseGuards(record);
  await participantHook('replay')(async (replay) => withBarrierLock(async () => {
    const current = await readRecord();
    if (current.state !== record.state || current.migrationEpoch !== migrationEpoch) throw refusal('Barrier changed during release', 'USAGE_CUTOVER_BUSY');
    if (!current.replayStarted) await writeRecord({ ...current, replayStarted: true });
    await replay(migrationEpoch, current.spool);
    await writeRecord(idleRecord({
      retiredEpochs: [...current.retiredEpochs, migrationEpoch],
      deferredRetirements: current.deferredRetirements,
    }));
    console.log(`✅ Usage cutover: released epoch ${migrationEpoch}, replayed ${current.spool.length} retained write(s)`);
  }));
  await flushDeferredRetirements();
  return getUsageCutoverStatus();
}

/** Read-only operator status. Never contacts a peer and never exposes retained records. */
export async function getUsageCutoverStatus() {
  const record = await loadRecord();
  const inFlight = Object.fromEntries([...registered].filter(([, hooks]) => hooks.inFlight).map(([name, hooks]) => [name, hooks.inFlight()]));
  const base = { barrierSchema: BARRIER_SCHEMA, state: record.state, migrationEpoch: record.migrationEpoch };
  if (record.state === 'unreadable') {
    return { ...base, participants: [], holdReasons: ['barrier-unreadable'], error: record.error, outstanding: { inFlight, retainedWrites: null, deferredRetirements: null } };
  }
  const selfId = await selfInstanceId();
  return {
    ...base,
    runtimeReady: compatibleRuntimes.has(record.migrationEpoch),
    participants: record.participants.map((instanceId) => {
      const { observedAcks: _nested, participants: _set, ...ack } = record.acks[instanceId] ?? {};
      return { instanceId, self: instanceId === selfId, ack: record.acks[instanceId] ? ack : null };
    }),
    holdReasons: record.holdReasons,
    verifiedAt: record.verifiedAt ?? null,
    acquiredAt: record.acquiredAt ?? null,
    fencedAt: record.fencedAt ?? null,
    activatedAt: record.activatedAt ?? null,
    rollback: record.rollback ?? null,
    fingerprints: record.fingerprints,
    retiredEpochs: record.retiredEpochs,
    writersHeld: heldBy(record),
    outstanding: {
      inFlight,
      retainedWrites: record.spool.length,
      retainedFrom: record.spool[0]?.at ?? null,
      retainedTo: record.spool.at(-1)?.at ?? null,
      deferredRetirements: record.deferredRetirements.length,
    },
  };
}
