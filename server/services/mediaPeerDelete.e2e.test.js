/**
 * Two machines, end to end: realtime delete frames, the snapshot safety net,
 * remote delete on the owner, the owner's refusal, and the safety-net cadence.
 *
 * Each machine is a worker thread (../test/peerMachine.js) with its own module
 * graph, temp data root, identity and peer registry, serving the real
 * authGate + sync + peer-media + video-gen routes and a real Socket.IO server
 * on loopback; each dials the other with the real peer relay. Nothing on the
 * event path is mocked. Waits are event-driven (a machine's own history
 * invalidation or frame delivery); the cadence cases shift one machine's
 * Date.now instead of sleeping.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Worker } from 'node:worker_threads';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';
import { DISPOSABLE_ROOT_MARKER } from '../lib/dataRoot.js';

const SAFETY_NET_INTERVAL_MS = 5 * 60 * 1000;
const SECRET = 'example-pair-secret-'.padEnd(48, 'x');

function startMachine(name) {
  const root = createTempDataRoot(`portos-e2e-${name}-`);
  writeFileSync(join(root, DISPOSABLE_ROOT_MARKER), '');
  // NODE_ENV=test stays (file backend, database write guard). VITEST goes, as
  // for start.test.js's boot: the real-data write guard resolves "real" through
  // PORTOS_DATA_ROOT, which here is the disposable temp root itself.
  const env = { ...process.env, PORTOS_DATA_ROOT: root };
  delete env.VITEST;
  const worker = new Worker(new URL('../test/peerMachine.js', import.meta.url), {
    workerData: { root, name },
    env,
    stdout: true,
    stderr: true,
  });
  const output = [];
  worker.stdout.on('data', (chunk) => output.push(String(chunk)));
  worker.stderr.on('data', (chunk) => output.push(String(chunk)));
  const pending = new Map();
  let seq = 0;
  const ready = new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (message) => {
      if (message.ready) return resolve();
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (!message.error) return call.resolve(message.result);
      const err = new Error(`${name}: ${message.error.message}`);
      Object.assign(err, { status: message.error.status, code: message.error.code });
      call.reject(err);
    });
  });
  const call = (cmd, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, args });
  });
  return { root, ready, call, output, terminate: () => worker.terminate() };
}

const peerRecord = (m, port) => ({
  id: `rec-${m}`, instanceId: `inst-${m}`, name: `Machine ${m.toUpperCase()}`, address: '127.0.0.1', port,
  enabled: true, status: 'online', syncSecret: SECRET, peerAuthAccepted: true, mediaDeleteAllowed: true,
  syncCategories: { videoHistory: true, goals: true },
});

let a;
let b;

// The other machine applied (or this one committed) a video add/delete.
async function whenApplied(machine, op, id, trigger) {
  const { token } = await machine.call('armHistoryChange', { op, id });
  const result = await trigger();
  await machine.call('awaitHistoryChange', { token });
  return result;
}

const ids = async (machine) => (await machine.call('rows')).map((row) => row.id);
const row = async (machine, id) => (await machine.call('rows')).find((r) => r.id === id);
const syncPulls = (requests, category) => requests.filter((r) => r === `GET /api/sync/${category}/checksum`).length;

// A renders `id` while B's relay is subscribed to A, so B holds A's row.
async function renderOnAHeldByB(id) {
  await whenApplied(b, 'upsert', id, () => a.call('seedVideo', { id }));
  expect(await row(b, id)).toMatchObject({ originInstanceId: 'inst-a' });
}

beforeAll(async () => {
  a = startMachine('a');
  b = startMachine('b');
  await Promise.all([a.ready, b.ready]);
  const [{ port: portA }, { port: portB }] = await Promise.all([a.call('listen'), b.call('listen')]);
  await a.call('writeRegistry', { self: { instanceId: 'inst-a', name: 'Machine A' }, peers: [peerRecord('b', portB)] });
  await b.call('writeRegistry', { self: { instanceId: 'inst-b', name: 'Machine B' }, peers: [peerRecord('a', portA)] });
}, 120_000);

afterAll(async () => {
  for (const machine of [a, b]) {
    if (!machine) continue;
    await machine.call('stop').catch(() => {});
    await machine.terminate();
    rmSync(machine.root, { recursive: true, force: true });
  }
});

describe('media deletes between two machines', () => {
  it('delete on A removes the row on B within the event path without a snapshot', async () => {
    await b.call('connectRelay', { peerId: 'rec-a' });
    await renderOnAHeldByB('v-event');
    await a.call('takeRequests');

    const result = await whenApplied(b, 'delete', 'v-event', () => a.call('deleteVideo', { id: 'v-event' }));

    expect(result.status).toBe('deleted');
    expect(await a.call('files', { id: 'v-event' })).toEqual({ video: false, thumbnail: false });
    expect(await ids(b)).not.toContain('v-event');
    expect(await b.call('tombstones')).toContain('v-event');
    // B never pulled a snapshot from A: the frame alone carried the delete.
    expect((await a.call('takeRequests')).filter((r) => r.startsWith('GET /api/sync/'))).toEqual([]);
    await b.call('disconnectRelay', { peerId: 'rec-a' });
  });

  it('B offline during delete converges on reconnect via snapshot', async () => {
    await b.call('connectRelay', { peerId: 'rec-a' });
    await renderOnAHeldByB('v-offline');
    await b.call('disconnectRelay', { peerId: 'rec-a' });

    await a.call('deleteVideo', { id: 'v-offline' });
    expect((await a.call('awaitDelivery', { op: 'delete', id: 'v-offline' })).sockets).toBe(0);
    expect(await ids(b)).toContain('v-offline');

    // B comes back: the orchestrator's peer:online handler pulls A's snapshot,
    // whose tombstone retires the row.
    await b.call('startOrchestrator');
    await a.call('takeRequests');
    const sync = await whenApplied(b, 'delete', 'v-offline', () => b.call('emitPeerOnline', { peerId: 'rec-a' }));
    await b.call('stopOrchestrator');

    expect(sync.error ?? null).toBeNull();

    expect(await ids(b)).not.toContain('v-offline');
    expect(await b.call('tombstones')).toContain('v-offline');
    expect(await a.call('takeRequests')).toContain('GET /api/sync/videoHistory/snapshot');
  });

  it('delete on B of an A-owned video removes files on A and the row on both', async () => {
    await b.call('connectRelay', { peerId: 'rec-a' });
    await renderOnAHeldByB('v-remote');
    await a.call('takeRequests');

    const result = await b.call('deleteVideo', { id: 'v-remote' });

    expect(result).toMatchObject({ status: 'deleted', peerName: 'Machine A' });
    expect(await a.call('takeRequests')).toContain('POST /api/peer-media/delete');
    expect(await a.call('files', { id: 'v-remote' })).toEqual({ video: false, thumbnail: false });
    expect(await ids(a)).not.toContain('v-remote');
    expect(await ids(b)).not.toContain('v-remote');
    expect(await a.call('tombstones')).toContain('v-remote');
    expect(await b.call('tombstones')).toContain('v-remote');
    // The owner announced its own delete, and the frame reached B's relay.
    expect((await a.call('awaitDelivery', { op: 'delete', id: 'v-remote' })).sockets).toBe(1);
    await b.call('disconnectRelay', { peerId: 'rec-a' });
  });

  it("capability off on A refuses B's delete", async () => {
    await b.call('connectRelay', { peerId: 'rec-a' });
    await renderOnAHeldByB('v-refused');
    await a.call('setPeerFields', { peerId: 'rec-b', fields: { mediaDeleteAllowed: false } });

    const response = await b.call('deleteVideoFromUi', { id: 'v-refused' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MEDIA_DELETE_FORBIDDEN');
    expect(await a.call('files', { id: 'v-refused' })).toEqual({ video: true, thumbnail: true });
    expect(await ids(a)).toContain('v-refused');
    expect(await a.call('tombstones')).not.toContain('v-refused');
    expect(await b.call('tombstones')).not.toContain('v-refused');
    // B's card is back to normal: no pending-delete badge, not hidden.
    const held = await row(b, 'v-refused');
    expect(held.pendingDelete).toBeUndefined();
    expect(held.hidden).not.toBe(true);
    await a.call('setPeerFields', { peerId: 'rec-b', fields: { mediaDeleteAllowed: true } });
    await b.call('disconnectRelay', { peerId: 'rec-a' });
  });
});

describe('safety-net cadence', () => {
  afterAll(async () => {
    await a?.call('shiftClock', { ms: 0 });
    await a?.call('disconnectRelay', { peerId: 'rec-b' });
  });

  it('the safety-net tick does not re-sync a realtime-connected peer within 5 minutes but does after', async () => {
    await a.call('connectRelay', { peerId: 'rec-b' });
    await b.call('takeRequests');

    // First sync with the peer in this process: always pulls.
    await a.call('syncTick');
    let pulled = await b.call('takeRequests');
    expect(syncPulls(pulled, 'videoHistory')).toBe(1);
    expect(syncPulls(pulled, 'goals')).toBe(1);

    await a.call('shiftClock', { ms: 60_000 });
    await a.call('syncTick');
    pulled = await b.call('takeRequests');
    expect(syncPulls(pulled, 'videoHistory')).toBe(0);
    expect(syncPulls(pulled, 'goals')).toBe(1);

    // peer:online and a manual sync still pull every category.
    await a.call('syncWithPeer', { peerId: 'rec-b' });
    expect(syncPulls(await b.call('takeRequests'), 'videoHistory')).toBe(1);

    await a.call('shiftClock', { ms: 60_000 + SAFETY_NET_INTERVAL_MS + 1000 });
    await a.call('syncTick');
    expect(syncPulls(await b.call('takeRequests'), 'videoHistory')).toBe(1);
  });

  it('a peer without a realtime subscription keeps the 60s cadence', async () => {
    // Same peer, freshly synced, but no live subscription (an older peer never
    // advertises one; an unpaired one is never sent frames).
    await a.call('disconnectRelay', { peerId: 'rec-b' });
    expect(await a.call('realtimeSince', { peerId: 'rec-b' })).toBeNull();
    await b.call('takeRequests');

    await a.call('syncTick');
    expect(syncPulls(await b.call('takeRequests'), 'videoHistory')).toBe(1);
    await a.call('shiftClock', { ms: 60_000 + SAFETY_NET_INTERVAL_MS + 61_000 });
    await a.call('syncTick');
    expect(syncPulls(await b.call('takeRequests'), 'videoHistory')).toBe(1);
  });
});
