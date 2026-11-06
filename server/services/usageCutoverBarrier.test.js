import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEffectiveCategories } from '../lib/instanceSyncCategories.js';

// A three-instance fleet with no network: each instance is a separate module graph
// over its own data dir, so a restart is a fresh graph over the same bytes, and the
// peer API is answered in-process by the instance a fake route points at.
const harness = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks');
  const context = new AsyncLocalStorage();
  return {
    context,
    fleet: new Map(),
    current: () => context.getStore(),
  };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const { makePathsProxy } = await vi.importActual('../lib/mockPathsDataRoot.js');
  return new Proxy(actual, {
    get(target, prop) {
      const dir = harness.current()?.dir;
      if (!dir) return target[prop];
      return makePathsProxy(actual, { dataRoot: dir })[prop];
    },
  });
});

vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  getSelf: async () => ({ instanceId: harness.current().id, name: `name-${harness.current().id}` }),
  loadData: async () => ({ peers: harness.current().peers }),
}));

vi.mock('../lib/peerHttpClient.js', async () => ({
  ...(await vi.importActual('../lib/peerHttpClient.js')),
  peerFetch: async (url, _options, peer) => {
    const target = harness.fleet.get(peer.instanceId);
    if (!target || target.offline) throw new Error('offline');
    if (target.oldRuntime) return new Response('{}', { status: 404 });
    const ack = await target.run(() => target.barrier.getUsageCutoverAck());
    return new Response(JSON.stringify(ack), { status: 200, headers: { 'content-type': 'application/json' } });
  },
}));

const scratch = mkdtempSync(join(tmpdir(), 'portos-usage-cutover-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirCounter = 0;
const EPOCH = 'native-2026-11';
const DAY = new Date().toISOString().slice(0, 10);

const run = (over) => ({ providerId: 'provider-a', model: 'model-a', messages: 1, tokensIn: over, tokensOut: 0, source: 'measured' });

async function boot(id, { peers = [], dir = join(scratch, `instance-${dirCounter++}`) } = {}) {
  const state = { id, dir, peers };
  const instance = { id, dir, peers, offline: false, oldRuntime: false };
  instance.run = (fn) => harness.context.run(state, fn);
  vi.resetModules();
  await instance.run(async () => {
    instance.barrier = await import('./usageCutoverBarrier.js');
    instance.usage = await import('./usage.js');
    instance.peerUsage = await import('./peerUsage.js');
    await instance.usage.loadUsage();
  });
  // Bound to this graph so a later boot's module cache cannot answer for it.
  instance.call = new Proxy({}, {
    get: (_t, module) => new Proxy({}, {
      get: (_m, fn) => (...args) => instance.run(() => instance[module][fn](...args)),
    }),
  });
  instance.ledger = () => readFileSync(join(dir, 'usage.json'), 'utf8');
  instance.ledgerTokens = () => JSON.parse(instance.ledger()).totalTokens.input;
  instance.peerStore = () => {
    try { return readFileSync(join(dir, 'peer-usage.json'), 'utf8'); } catch { return null; }
  };
  harness.fleet.set(id, instance);
  return instance;
}

const peerOf = (id, extra = {}) => ({ instanceId: id, name: id, host: `${id}.example.com`, port: 5555, ...extra });
const usageFromSnapshot = async (from) => (await from.call.peerUsage.getUsageSnapshot()).data;
const pull = async (to, from) => to.call.peerUsage.applyUsageRemote(await usageFromSnapshot(from), { peerId: from.id });

/** A chain a-b-c: a and c only ever meet through b, the case forwarding exists for. */
async function bootChain() {
  const a = await boot('inst-a', { peers: [peerOf('inst-b')] });
  const b = await boot('inst-b', { peers: [peerOf('inst-a'), peerOf('inst-c')] });
  const c = await boot('inst-c', { peers: [peerOf('inst-b')] });
  return { a, b, c, all: [a, b, c] };
}

const acquireAll = (instances) => Promise.all(instances.map((i) => i.call.barrier.acquireUsageCutover({
  migrationEpoch: EPOCH, participants: instances.map(({ id }) => id),
})));

const code = (promise) => promise.then(() => 'resolved', (err) => err.code);

describe('usage writers during a fence', () => {
  it('drains a started write, retains the next, and leaves the ledger bytes alone', async () => {
    const a = await boot('inst-a');
    const started = a.call.usage.recordRunUsage(run(100));
    const status = await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    await started;
    expect(status.state).toBe('fenced');
    expect(a.ledgerTokens()).toBe(100);
    const fenced = a.ledger();

    const claims = [{ path: 'codex-session-a', offset: 7 }];
    expect(await a.call.usage.recordRunUsage(run(50), { reconciledRunId: 'run-a', codexHighWater: claims })).toEqual({ deferred: true });
    expect(await a.call.usage.recordSession('provider-a', 'Provider A', 'model-a')).toEqual({ deferred: true });
    expect(a.ledger()).toBe(fenced);

    const after = await a.call.barrier.getUsageCutoverStatus();
    expect(after.outstanding).toMatchObject({ retainedWrites: 2, deferredRetirements: 0 });
    expect(after.outstanding.inFlight.usageLedger).toBe(0);
    // Without this, a later Codex run in the fence could bill the same transcript growth.
    expect(await a.call.usage.getRecentCodexUsageClaims(0)).toEqual(claims);
  });

  it('refuses recomputable writers and operator resets deterministically', async () => {
    const a = await boot('inst-a');
    await a.call.usage.recordRunUsage(run(100));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    const fenced = a.ledger();
    for (const attempt of [
      () => a.call.usage.applyHistoricalUsageCorrections([{ runId: 'r', day: DAY, providerId: 'provider-a', siblings: [run(1)], siblingScanned: true }]),
      () => a.call.usage.addDatedUsageBatch([{ dayKey: DAY, record: run(1) }]),
      () => a.call.usage.setInteractiveScanState({ watermarks: {} }),
      () => a.call.usage.resetUsage(),
    ]) {
      expect(await code(attempt())).toBe('USAGE_CUTOVER_FENCED');
    }
    expect(a.ledger()).toBe(fenced);
    expect((await a.call.barrier.getUsageCutoverStatus()).outstanding.retainedWrites).toBe(0);
  });

  it('keeps the fence across a restart, without load normalization rewriting the ledger', async () => {
    const a = await boot('inst-a');
    await a.call.usage.recordRunUsage(run(100));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    // Stale cached field: an unfenced load would normalize and rewrite this file.
    const ledger = JSON.parse(a.ledger());
    ledger.earliestActivityDay = '1999-01-01';
    writeFileSync(join(a.dir, 'usage.json'), JSON.stringify(ledger));
    const bytes = a.ledger();

    const restarted = await boot('inst-a', { dir: a.dir });
    expect(restarted.ledger()).toBe(bytes);
    expect((await restarted.call.barrier.getUsageCutoverStatus()).state).toBe('fenced');
    expect(await restarted.call.usage.recordMessages('provider-a', 'model-a', 1, 1, 1)).toEqual({ deferred: true });
    expect(restarted.ledger()).toBe(bytes);
  });

  it('finishes an interrupted fence on retry and refuses a different barrier', async () => {
    const a = await boot('inst-a');
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    const record = JSON.parse(readFileSync(join(a.dir, 'usage-cutover-barrier.json'), 'utf8'));
    writeFileSync(join(a.dir, 'usage-cutover-barrier.json'), JSON.stringify({ ...record, state: 'fencing', fencedAt: undefined }));

    const restarted = await boot('inst-a', { dir: a.dir });
    expect(await code(restarted.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH }))).toBe('USAGE_CUTOVER_NOT_FENCED');
    expect(await restarted.call.usage.recordTokens(1, 1)).toEqual({ deferred: true });
    expect((await restarted.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] })).state).toBe('fenced');
    expect(await code(restarted.call.barrier.acquireUsageCutover({ migrationEpoch: 'other-epoch', participants: ['inst-a'] }))).toBe('USAGE_CUTOVER_BUSY');
  });

  it('fails closed when the barrier record is damaged', async () => {
    const a = await boot('inst-a');
    const b = await boot('inst-b');
    await b.call.usage.recordRunUsage(run(5));
    const payload = await usageFromSnapshot(b);
    await a.call.usage.recordRunUsage(run(100));
    const bytes = a.ledger();
    writeFileSync(join(a.dir, 'usage-cutover-barrier.json'), '{ not json');

    expect(await code(a.call.usage.recordRunUsage(run(1)))).toBe('USAGE_CUTOVER_FENCED');
    expect(a.ledger()).toBe(bytes);
    expect((await a.call.peerUsage.applyUsageRemote(payload, { peerId: 'inst-b' })).refusedByBarrier).toBe('barrier-unreadable');
    expect((await usageFromSnapshot(a)).instances).toEqual({});
    expect((await a.call.barrier.getUsageCutoverStatus()).holdReasons).toEqual(['barrier-unreadable']);
  });

  it('holds the derived transcript store during a fence', async () => {
    const a = await boot('inst-a');
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    const { refreshLocalTranscriptUsage } = await a.run(() => import('./claudeCodeTranscriptUsage.js'));
    const result = await a.run(() => refreshLocalTranscriptUsage({ force: true, root: join(scratch, 'no-such-root') }));
    expect(result.refreshed).toBe(false);
  });

  it('never bills a retained write twice when a release is retried after a mid-replay failure', async () => {
    const a = await boot('inst-a');
    await a.call.usage.recordRunUsage(run(100));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    await a.call.usage.recordRunUsage(run(10));
    await a.call.usage.recordRunUsage(run(20));

    const path = join(a.dir, 'usage-cutover-barrier.json');
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const valid = record.spool[1];
    record.spool[1] = { ...valid, op: 'noSuchWrite' };
    writeFileSync(path, JSON.stringify(record));
    await expect(a.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).rejects.toThrow();
    expect(a.ledgerTokens()).toBe(110);
    expect((await a.call.barrier.getUsageCutoverStatus()).state).toBe('fenced');

    const repaired = JSON.parse(readFileSync(path, 'utf8'));
    repaired.spool[1] = valid;
    writeFileSync(path, JSON.stringify(repaired));
    expect((await a.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).state).toBe('idle');
    expect(a.ledgerTokens()).toBe(130);
    expect(await a.call.usage.recordRunUsage(run(1))).not.toEqual({ deferred: true });
    expect(a.ledgerTokens()).toBe(131);
  });
});

describe('peer usage during a fence', () => {
  it.each([
    ['master sync off', { syncEnabled: false, syncCategories: { usage: true } }],
    ['full sync', { fullSync: true, syncCategories: { usage: false } }],
  ])('refuses direct and forwarded digests under %s', async (_label, peerConfig) => {
    // The premise: neither setting can stop the category, so the gate must not read them.
    expect(resolveEffectiveCategories({ directions: ['outbound'], ...peerConfig }).usage).toBe(true);
    const { a, b, c } = await bootChain();
    b.peers[0] = { ...b.peers[0], ...peerConfig };
    await c.call.usage.recordRunUsage(run(7));
    await pull(b, c);
    await a.call.usage.recordRunUsage(run(100));
    const forwarded = await usageFromSnapshot(b);
    expect(Object.keys(forwarded.instances).sort()).toEqual(['inst-b', 'inst-c']);

    await b.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a', 'inst-b', 'inst-c'] });
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a', 'inst-b', 'inst-c'] });
    const held = a.peerStore();

    const refused = await a.call.peerUsage.applyUsageRemote(forwarded, { peerId: 'inst-b' });
    expect(refused).toEqual({ applied: false, count: 0, refusedByBarrier: 'barrier-fenced' });
    expect(a.peerStore()).toBe(held);
    // A report read during the fence must not write the store a rollback has to prove.
    await a.call.peerUsage.getFleetUsage({});
    expect(a.peerStore()).toBe(held);
  });

  it('withholds its own and forwarded digests, leaving an older reader nothing to merge', async () => {
    const { a, b } = await bootChain();
    await b.call.usage.recordRunUsage(run(7));
    await pull(a, b);
    await a.call.usage.recordRunUsage(run(100));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a', 'inst-b'] });

    const snapshot = await a.call.peerUsage.getUsageSnapshot();
    const manifest = await a.call.peerUsage.getUsageManifest();
    for (const envelope of [snapshot, manifest]) {
      expect(envelope.data).toEqual({
        instances: {}, tombstones: [],
        cutover: { migrationEpoch: EPOCH, state: 'fenced', barrierSchema: 1 },
      });
    }
    expect(snapshot.checksum).toBe(manifest.checksum);
  });

  it('leaves the wire unchanged when no barrier was ever acquired', async () => {
    const { a, b } = await bootChain();
    await b.call.usage.recordRunUsage(run(7));
    const payload = await usageFromSnapshot(b);
    expect(payload.cutover).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['instances', 'tombstones']);
    expect(await a.call.peerUsage.applyUsageRemote(payload, { peerId: 'inst-b' })).toEqual({ applied: true, count: 1 });
    const manifest = await a.call.peerUsage.getUsageManifest();
    expect(manifest.data.cutover).toBeUndefined();
    expect(Object.keys(manifest.data.instances).sort()).toEqual(['inst-a', 'inst-b']);
  });

  it('keeps unrelated categories syncing through the same transport during a fence', async () => {
    const a = await boot('inst-a');
    const dataSync = await a.run(() => import('./dataSync.js'));
    await a.call.usage.recordRunUsage(run(100));
    // The first read versions this instance's projection, moving a watched file.
    await a.run(() => dataSync.getChecksum('usage'));
    const before = await a.run(() => dataSync.getChecksum('usage'));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });

    const usage = await a.run(() => dataSync.applyRemote('usage', { instances: {}, tombstones: [] }, { peerId: 'inst-b' }));
    expect(usage.refusedByBarrier).toBe('barrier-fenced');
    const goals = await a.run(() => dataSync.applyRemote('goals', { goals: [{ id: 'goal-a', title: 'Example goal', updatedAt: '2026-11-01T00:00:00.000Z' }], updatedAt: '2026-11-01T00:00:00.000Z' }, { peerId: 'inst-b' }));
    expect(goals.applied).toBe(true);
    expect((await a.run(() => dataSync.getSnapshot('goals'))).data.goals.map((goal) => goal.id)).toEqual(['goal-a']);
    // A peer holding the old checksum must see the fence, or it would never pull the stamp.
    expect((await a.run(() => dataSync.getChecksum('usage'))).checksum).not.toBe(before.checksum);
  });

  it('keeps a peer removed during the fence retired once the fence lifts', async () => {
    const { a, b } = await bootChain();
    await b.call.usage.recordRunUsage(run(7));
    await pull(a, b);
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    const held = a.peerStore();
    expect(await a.call.peerUsage.forgetInstanceUsage('inst-b')).toEqual({ removed: false, deferred: true });
    expect(a.peerStore()).toBe(held);
    expect((await a.call.barrier.getUsageCutoverStatus()).outstanding.deferredRetirements).toBe(1);

    await a.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH });
    const after = JSON.parse(a.peerStore());
    expect(after.instances['inst-b']).toBeUndefined();
    expect(after.tombstones.map((t) => t.instanceId)).toContain('inst-b');
    expect((await a.call.barrier.getUsageCutoverStatus()).outstanding.deferredRetirements).toBe(0);
  });
});

describe('activation is held until every participant agrees', () => {
  const holdsAfterVerify = async (instance) => (await instance.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH })).holdReasons;

  it('names each mixed, offline or unknown participant and refuses to activate', async () => {
    const { a, b, c, all } = await bootChain();
    for (const i of all) i.run(() => i.barrier.registerUsageCutoverRuntime(EPOCH));
    await acquireAll(all);

    b.offline = true;
    expect(await holdsAfterVerify(a)).toEqual(['participant-offline:inst-b', 'participant-no-route:inst-c']);
    expect(await code(a.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH }))).toBe('USAGE_CUTOVER_HELD');
    expect(await code(a.call.usage.recordTokens(1, 1).then((r) => { if (!r.deferred) throw new Error('wrote'); }))).toBe('resolved');
    b.offline = false;

    b.oldRuntime = true;
    expect(await holdsAfterVerify(a)).toContain('participant-old-runtime:inst-b');
    b.oldRuntime = false;

    // Two hops: a learns c's acknowledgment through b once b has verified.
    expect(await holdsAfterVerify(a)).toEqual(['participant-no-route:inst-c']);
    expect(await holdsAfterVerify(b)).toEqual([]);
    expect(await holdsAfterVerify(a)).toEqual([]);
    expect((await a.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH })).state).toBe('activated');
    await c.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH });
  });

  it('holds on a different participant set, epoch, or schema', async () => {
    const { a, b } = await bootChain();
    a.peers.splice(0, a.peers.length, peerOf('inst-b'));
    a.run(() => a.barrier.registerUsageCutoverRuntime(EPOCH));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a', 'inst-b'] });

    expect(await holdsAfterVerify(a)).toEqual(['participant-epoch-mismatch:inst-b']);
    await b.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-b', 'inst-c'] });
    expect(await holdsAfterVerify(a)).toEqual(['participant-set-mismatch:inst-b']);
  });

  it('holds until the runtime that understands the epoch is declared, here and on peers', async () => {
    const { a, b } = await bootChain();
    a.peers.splice(0, a.peers.length, peerOf('inst-b'));
    b.peers.splice(0, b.peers.length, peerOf('inst-a'));
    await acquireAll([a, b]);
    expect(await holdsAfterVerify(a)).toEqual(['participant-runtime-not-ready:inst-b', 'local-runtime-not-ready']);
    a.run(() => a.barrier.registerUsageCutoverRuntime(EPOCH));
    b.run(() => b.barrier.registerUsageCutoverRuntime(EPOCH));
    expect(await holdsAfterVerify(a)).toEqual([]);
  });

  it('holds for a peer or forwarded origin outside the set, whatever its sync settings', async () => {
    const stranger = peerOf('inst-z', { syncEnabled: false, syncCategories: { usage: false } });
    const a = await boot('inst-a', { peers: [stranger, peerOf('inst-off', { enabled: false })] });
    const b = await boot('inst-b');
    await b.call.usage.recordRunUsage(run(7));
    await pull(a, b);
    a.run(() => a.barrier.registerUsageCutoverRuntime(EPOCH));
    await a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] });
    expect(await holdsAfterVerify(a)).toEqual(['peer-not-participant:inst-z', 'unknown-origin:inst-b']);
    // Removing that peer under the fence answers the hold, though its tombstone waits.
    await a.call.peerUsage.forgetInstanceUsage('inst-b');
    expect(await holdsAfterVerify(a)).toEqual(['peer-not-participant:inst-z']);
  });
});

async function activatedChain() {
  const fleet = await bootChain();
  const { a, b, c, all } = fleet;
  await a.call.usage.recordRunUsage(run(100));
  await b.call.usage.recordRunUsage(run(20));
  await c.call.usage.recordRunUsage(run(3));
  await pull(b, a);
  await pull(b, c);
  await pull(a, b);
  await pull(c, b);
  fleet.oldPayload = await usageFromSnapshot(b);
  for (const i of all) i.run(() => i.barrier.registerUsageCutoverRuntime(EPOCH));
  await acquireAll(all);
  fleet.fencedBytes = Object.fromEntries(all.map((i) => [i.id, { usage: i.ledger(), peers: i.peerStore() }]));
  for (const i of [b, a, c, b]) await i.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH });
  return fleet;
}

const activateAll = async ({ a, b, c }) => {
  await b.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH });
  await a.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH });
  await c.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH });
  await a.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH });
  await c.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH });
};

const fleetRows = async (instance) => Object.fromEntries((await instance.call.peerUsage.getFleetUsage({})).instances
  .map((row) => [row.instanceId, row.totals.tokensIn]));

describe('three instance cutover', () => {
  it('activates without mixing old and new accounting across a forwarded chain', async () => {
    const fleet = await activatedChain();
    const { a, b, c } = fleet;
    await a.call.usage.recordRunUsage(run(9)); // retained during the fence
    await activateAll(fleet);

    // Retained old-accounting writes stay out of the rebuilt partition.
    expect(a.ledgerTokens()).toBe(100);
    expect((await a.call.barrier.getUsageCutoverStatus()).outstanding.retainedWrites).toBe(1);
    // Old digests never surface or travel beside the new epoch.
    expect(Object.keys(await fleetRows(a))).toEqual([]);
    const published = await usageFromSnapshot(a);
    expect(published.instances).toEqual({});
    expect(Object.keys(published.cutover.instances)).toEqual(['inst-a']);

    // a -> b -> c: an origin c never talks to, carried in the stamped envelope.
    expect((await pull(b, a)).applied).toBe(true);
    expect((await pull(c, b)).applied).toBe(true);
    expect(Object.keys((await c.call.peerUsage.getUsageSnapshot()).data.cutover.instances).sort()).toEqual(['inst-a', 'inst-b', 'inst-c']);
    expect(await fleetRows(c)).toEqual({ 'inst-a': 100, 'inst-b': 20, 'inst-c': 3 });
    // A digest lands in its origin's own slot; nothing is ever summed into a ledger.
    expect(c.ledgerTokens()).toBe(3);

    // A digest for an origin outside the bound set cannot ride a valid envelope.
    const smuggled = await usageFromSnapshot(a);
    smuggled.cutover.instances['inst-z'] = { ...smuggled.cutover.instances['inst-a'], instanceId: 'inst-z' };
    await c.call.peerUsage.applyUsageRemote(smuggled, { peerId: 'inst-a' });
    expect(JSON.parse(c.peerStore()).instances['inst-z']).toBeUndefined();
  });

  it('refuses delayed, replayed and stale payloads after activation', async () => {
    const fleet = await activatedChain();
    const { a, b, c } = fleet;
    await activateAll(fleet);
    const before = c.peerStore();

    expect((await c.call.peerUsage.applyUsageRemote(fleet.oldPayload, { peerId: 'inst-b' })).refusedByBarrier).toBe('stale-epoch');
    const stamped = await usageFromSnapshot(b);
    const wrongEpoch = { ...stamped, cutover: { ...stamped.cutover, migrationEpoch: 'older-epoch' } };
    expect((await c.call.peerUsage.applyUsageRemote(wrongEpoch, { peerId: 'inst-b' })).refusedByBarrier).toBe('stale-epoch');
    const wrongSchema = { ...stamped, cutover: { ...stamped.cutover, barrierSchema: 99 } };
    expect((await c.call.peerUsage.applyUsageRemote(wrongSchema, { peerId: 'inst-b' })).refusedByBarrier).toBe('schema-mismatch');
    expect(c.peerStore()).toBe(before);

    // A same-epoch replay is idempotent under the existing per-origin LWW.
    expect((await c.call.peerUsage.applyUsageRemote(stamped, { peerId: 'inst-b' })).applied).toBe(true);
    expect((await c.call.peerUsage.applyUsageRemote(stamped, { peerId: 'inst-b' })).applied).toBe(false);
    // A rebuilt digest replaces an old slot even with an older stamp, without crossing epochs.
    expect((await pull(a, b)).applied).toBe(true);
    expect(JSON.parse(a.peerStore()).instances['inst-b'].migrationEpoch).toBe(EPOCH);
  });

  it('refuses an epoch from an instance that never joined it', async () => {
    const fleet = await activatedChain();
    await activateAll(fleet);
    const outsider = await boot('inst-out');
    const result = await pull(outsider, fleet.a);
    expect(result.refusedByBarrier).toBe('foreign-epoch');
    expect(outsider.peerStore()).toBeNull();
  });

  it('allows live writes and refuses old-accounting backfills once active', async () => {
    const fleet = await activatedChain();
    await activateAll(fleet);
    const { a } = fleet;
    await a.call.usage.recordRunUsage(run(1));
    expect(a.ledgerTokens()).toBe(101);
    expect(await code(a.call.usage.addDatedUsageBatch([{ dayKey: DAY, record: run(1) }]))).toBe('USAGE_CUTOVER_FENCED');
    expect(await code(a.call.usage.resetUsage())).toBe('USAGE_CUTOVER_FENCED');
  });

  it('stays fenced when code rolled back beneath an activated record', async () => {
    const fleet = await activatedChain();
    await activateAll(fleet);
    const { a, b } = fleet;
    // A restart with no runtime declaring the epoch is the older code on this record.
    const restarted = await boot('inst-a', { dir: a.dir, peers: a.peers });
    expect(await restarted.call.usage.recordRunUsage(run(1))).toEqual({ deferred: true });
    expect((await usageFromSnapshot(restarted)).instances).toEqual({});
    expect((await pull(restarted, b)).refusedByBarrier).toBe('barrier-activated');
  });

  it('rolls back every instance before any restores totals, with retained writes counted once', async () => {
    const fleet = await activatedChain();
    const { a, b, c, all } = fleet;
    await a.call.usage.recordRunUsage(run(9));
    const preCutover = { 'inst-a': 100, 'inst-b': 20, 'inst-c': 3 };
    await activateAll(fleet);
    // The rebuilt partition diverges and an epoch digest reaches a peer store.
    await pull(b, a);
    await pull(c, b);
    await b.call.usage.recordRunUsage(run(500));
    const rebuiltB = b.ledger();
    const epochPayload = await usageFromSnapshot(b);

    await b.call.barrier.rollbackUsageCutover({ migrationEpoch: EPOCH, reason: 'Totals did not match' });
    expect(await b.call.usage.recordRunUsage(run(4))).toEqual({ deferred: true });
    expect(b.ledger()).toBe(rebuiltB);

    // An activated peer stops applying as soon as it learns, without an operator race.
    const seen = await pull(c, b);
    expect(seen.refusedByBarrier).toBe('peer-rolling-back');
    expect((await c.call.barrier.getUsageCutoverStatus()).state).toBe('rolling-back');

    // a is still activated: restoring b now could leave peers mixing states.
    await expect(b.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).rejects.toMatchObject({ code: 'USAGE_CUTOVER_HELD' });
    expect((await pull(a, b)).refusedByBarrier).toBe('peer-rolling-back');

    // Every participant acknowledges; b's rebuilt bytes still block a release.
    for (const i of [b, a, c, b]) await i.call.barrier.verifyUsageCutover({ migrationEpoch: EPOCH });
    const blocked = await b.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH }).catch((err) => err);
    expect(blocked.code).toBe('USAGE_CUTOVER_RESTORE_REQUIRED');
    expect(blocked.context.holdReasons).toContain('restore-required:usageLedger');

    for (const i of all) {
      writeFileSync(join(i.dir, 'usage.json'), fleet.fencedBytes[i.id].usage);
      writeFileSync(join(i.dir, 'peer-usage.json'), fleet.fencedBytes[i.id].peers);
    }
    for (const i of [b, a, c]) {
      expect((await i.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).state).toBe('idle');
    }

    // Restored totals plus each retained write exactly once; never the rebuilt 500.
    expect(a.ledgerTokens()).toBe(109);
    expect(b.ledgerTokens()).toBe(24);
    expect(c.ledgerTokens()).toBe(3);

    // A digest still stamped with the retired epoch can never return.
    expect((await a.call.peerUsage.applyUsageRemote(epochPayload, { peerId: 'inst-b' })).refusedByBarrier).toBe('foreign-epoch');
    expect(await code(a.call.barrier.acquireUsageCutover({ migrationEpoch: EPOCH, participants: ['inst-a'] }))).toBe('USAGE_CUTOVER_EPOCH_RETIRED');

    // Old accounting converges again, with per-origin slots rather than sums.
    await pull(b, a);
    await pull(b, c);
    await pull(a, b);
    await pull(c, b);
    expect(await fleetRows(a)).toEqual({ 'inst-a': 109, 'inst-b': 24, 'inst-c': 3 });
    expect(await fleetRows(c)).toEqual({ 'inst-a': 109, 'inst-b': 24, 'inst-c': 3 });
    expect(preCutover['inst-a'] + 9).toBe(109);
  });

  it('aborts before activation only while no participant has activated', async () => {
    const fleet = await activatedChain();
    const { a, b, c } = fleet;
    await b.call.barrier.activateUsageCutover({ migrationEpoch: EPOCH });
    await expect(a.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).rejects.toMatchObject({ code: 'USAGE_CUTOVER_HELD' });
    await b.call.barrier.rollbackUsageCutover({ migrationEpoch: EPOCH, reason: 'Abort' });

    c.offline = true; // an offline participant cannot pin an abort: the epoch rules refuse both ways
    expect((await a.call.barrier.releaseUsageCutover({ migrationEpoch: EPOCH })).state).toBe('idle');
    expect(a.ledgerTokens()).toBe(100);
  });
});
