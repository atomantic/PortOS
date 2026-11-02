import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFile } from 'fs/promises';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-usage-' });
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// peerUsage resolves this machine's identity through a dynamic import of
// instanceIdentity.js (#6836; kept off dataSync's module graph); the digest
// itself is whatever usage.js currently holds.
const self = { instanceId: 'inst-self', name: 'Workshop' };
let configuredPeers = [];
// importActual so UNKNOWN_INSTANCE_ID stays the REAL sentinel — a hand-written
// copy here would let the real one drift and silently stop being filtered.
vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  getSelf: vi.fn(async () => self),
  loadData: vi.fn(async () => ({ peers: configuredPeers })),
}));

let localUsage;
vi.mock('./usage.js', async () => {
  const actual = await vi.importActual('./usage.js');
  return { ...actual, getUsage: () => localUsage };
});

const { buildUsageDigest, buildUsageReport } = await import('./usage.js');
const { familyForProviderId } = await import('../lib/providerFamilies.js');
const {
  getUsageSnapshot,
  getUsageManifest,
  applyUsageRemote,
  getFleetUsage,
  getFleetQuotaEntries,
  getFleetClaudeCodeModels,
  getFleetRollingCost,
  getFleetMonthlyUsage,
  forgetInstanceUsage,
  PEER_USAGE_FILE,
} = await import('./peerUsage.js');
const { TRANSCRIPT_USAGE_FILE } = await import('./claudeCodeTranscriptUsage.js');
const { recordLocalQuotaCards, readLocalQuotaCards, PROVIDER_QUOTAS_FILE } = await import('./providerQuotaShare.js');

afterAll(cleanup);

// A minimal but realistic usage shape: one provider/model day bucket plus the
// all-time totals the report folds in on an unbounded window.
const usageFixture = ({ day = '2026-08-30', tokensOut = 1000, lastUpdated = '2026-08-30T12:00:00.000Z' } = {}) => ({
  totalSessions: 2,
  totalMessages: 5,
  totalToolCalls: 7,
  totalTokens: { input: 500, output: tokensOut },
  byProvider: { anthropic: { name: 'Anthropic', sessions: 2, messages: 5, tokens: tokensOut } },
  byModel: { 'claude-opus-5': { sessions: 2, messages: 5, tokens: tokensOut } },
  dailyActivity: {
    [day]: {
      sessions: 2,
      messages: 5,
      tokens: tokensOut,
      byProvider: {
        anthropic: {
          name: 'Anthropic',
          sessions: 2,
          messages: 5,
          tokensIn: 500,
          tokensOut,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          source: 'measured',
          byModel: {
            'claude-opus-5': {
              sessions: 2, messages: 5, tokensIn: 500, tokensOut,
              cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured',
            },
          },
        },
      },
    },
  },
  monthlyActivity: {},
  hourlyActivity: Array(24).fill(0),
  earliestActivityDay: day,
  lastUpdated,
  // Machine-local idempotency bookkeeping keyed by LOCAL run ids — meaningless
  // on a peer, and the largest field in the file.
  reconciledRuns: { 'run-1': '2026-08-30T12:00:00.000Z' },
});

const peerEntry = (overrides = {}) => {
  const usage = overrides.usage || buildUsageDigest(usageFixture({ tokensOut: 4000 }));
  const ids = new Set(Object.values({ ...usage.dailyActivity, ...usage.monthlyActivity })
    .flatMap((bucket) => Object.keys(bucket.byProvider || {})));
  const providerClasses = Object.fromEntries([...ids].map((id) => [id, { free: false, family: familyForProviderId(id) }]));
  return { instanceId: 'inst-peer', name: 'Studio', capturedAt: '2026-08-30T09:00:00.000Z', usage, providerClasses, ...overrides };
};

const readStoreFile = async () => JSON.parse(await readFile(PEER_USAGE_FILE, 'utf8'));

beforeEach(async () => {
  localUsage = usageFixture();
  // Reset the stores between cases — every test starts with no peer digests
  // and no quota readings of our own.
  const { atomicWrite } = await import('../lib/fileUtils.js');
  await atomicWrite(PEER_USAGE_FILE, { instances: {} });
  await atomicWrite(PROVIDER_QUOTAS_FILE, { quotas: [] });
  await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: {}, updatedAt: null });
  configuredPeers = [];
});

const quotaCard = (over = {}) => ({
  family: 'claude',
  label: 'Claude Code',
  supported: true,
  plan: 'subscription',
  limits: [{ key: 'week', label: 'Current week', percentUsed: 40, percentRemaining: 60, resetsAt: null, timezone: null }],
  activity: [{ period: 'Last 24h', requests: 10, sessions: 1, notes: [] }],
  fetchedAt: '2026-08-31T00:00:00.000Z',
  ...over,
});

describe('federated usage digest', () => {
  // The wire shape is an allowlist. `reconciledRuns` is local run-id bookkeeping
  // (meaningless on a peer, and the biggest field in the file); all-time
  // byProvider/byModel are a coarser restatement of the day buckets that already
  // ride along. Both would otherwise be pure recurring wire weight.
  it('ships an allowlist, not the whole usage file', () => {
    const digest = buildUsageDigest(usageFixture());
    expect(Object.keys(digest).sort()).toEqual([
      'dailyActivity', 'earliestActivityDay', 'hourlyActivity', 'lastUpdated',
      'monthlyActivity', 'totalMessages', 'totalSessions', 'totalTokens', 'totalToolCalls',
    ]);
  });

  it('folds days past the wire retention window into their month, preserving counts', () => {
    const source = usageFixture({ day: '2026-01-05' });
    const digest = buildUsageDigest(source, { retentionDays: 30, now: new Date('2026-08-30T00:00:00Z') });
    expect(digest.dailyActivity['2026-01-05']).toBeUndefined();
    expect(digest.monthlyActivity['2026-01'].byProvider.anthropic.tokensOut).toBe(1000);
    // Pure: the rollup runs over a shallow copy, so the caller's maps survive.
    expect(source.dailyActivity['2026-01-05']).toBeTruthy();
    expect(source.monthlyActivity).toEqual({});
  });
});

describe('usage sync category', () => {
  it('publishes this instance under its own id', async () => {
    const { data } = await getUsageSnapshot();
    expect(Object.keys(data.instances)).toEqual(['inst-self']);
    expect(data.instances['inst-self'].name).toBe('Workshop');
    expect(Date.parse(data.instances['inst-self'].capturedAt)).toBeGreaterThan(Date.parse(localUsage.lastUpdated));
  });

  it('keeps the checksum stable while local usage has not moved', async () => {
    const a = await getUsageSnapshot();
    const b = await getUsageSnapshot();
    expect(b.checksum).toBe(a.checksum);
  });

  it('persists a monotonic version for projection-only changes and preserves peer writes', async () => {
    const first = await getUsageSnapshot();
    const firstStamp = first.data.instances['inst-self'].capturedAt;
    expect((await getUsageSnapshot()).data.instances['inst-self'].capturedAt).toBe(firstStamp);
    await recordLocalQuotaCards([quotaCard()]);
    await Promise.all([
      getUsageSnapshot(),
      applyUsageRemote({ instances: { 'inst-peer': peerEntry() } }),
    ]);
    const second = await getUsageSnapshot();
    expect(Date.parse(second.data.instances['inst-self'].capturedAt)).toBeGreaterThan(Date.parse(firstStamp));
    expect(second.data.instances['inst-peer']).toBeDefined();
    expect((await readStoreFile()).selfVersion.capturedAt).toBe(second.data.instances['inst-self'].capturedAt);
    expect((await getUsageSnapshot()).checksum).toBe(second.checksum);
  });

  it('stores a peer digest side by side instead of summing it into local usage', async () => {
    const result = await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    expect(result).toEqual({ applied: true, count: 1 });

    const store = await readStoreFile();
    expect(store.instances['inst-peer'].usage.totalTokens.output).toBe(4000);
    // The local file's own counters are untouched — summing them would
    // double-count on the very next round trip.
    expect(localUsage.totalTokens.output).toBe(1000);
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-self'].usage.totalTokens.output).toBe(1000);
  });

  it('re-applying the same snapshot is a no-op', async () => {
    const snapshot = { instances: { 'inst-peer': peerEntry() } };
    await applyUsageRemote(snapshot);
    expect(await applyUsageRemote(snapshot)).toEqual({ applied: false, count: 0 });
  });

  it('replaces a peer digest only when the incoming one is newer', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });

    const stale = peerEntry({
      capturedAt: '2026-08-29T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 1 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-peer': stale } })).toEqual({ applied: false, count: 0 });
    expect((await readStoreFile()).instances['inst-peer'].usage.totalTokens.output).toBe(4000);

    const fresh = peerEntry({
      capturedAt: '2026-08-31T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 9000 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-peer': fresh } })).toEqual({ applied: true, count: 1 });
    expect((await readStoreFile()).instances['inst-peer'].usage.totalTokens.output).toBe(9000);
  });

  it('ignores a peer echoing a stale copy of US back', async () => {
    const echo = peerEntry({
      instanceId: 'inst-self',
      name: 'Workshop',
      capturedAt: '2099-01-01T00:00:00.000Z',
      usage: buildUsageDigest(usageFixture({ tokensOut: 999999 })),
    });
    expect(await applyUsageRemote({ instances: { 'inst-self': echo } })).toEqual({ applied: false, count: 0 });
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-self'].usage.totalTokens.output).toBe(1000);
  });

  it('rejects an entry whose instanceId does not match the key it arrived under', async () => {
    const spoofed = peerEntry({ instanceId: 'inst-self' });
    expect(await applyUsageRemote({ instances: { 'inst-peer': spoofed } })).toEqual({ applied: false, count: 0 });
  });

  it('forwards known peer digests so a third instance propagates through us', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const { data } = await getUsageSnapshot();
    expect(Object.keys(data.instances).sort()).toEqual(['inst-peer', 'inst-self']);
  });
});

describe('usage sync manifest (#5759)', () => {
  const otherEntry = (overrides = {}) => peerEntry({
    instanceId: 'inst-other',
    name: 'Render Box',
    capturedAt: '2026-08-30T08:00:00.000Z',
    ...overrides,
  });

  it('publishes one capturedAt per instance instead of the digests', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });

    const { data } = await getUsageManifest();
    expect(data.instances).toEqual({
      'inst-self': expect.any(String),
      'inst-peer': '2026-08-30T09:00:00.000Z',
      'inst-other': '2026-08-30T08:00:00.000Z',
    });
  });

  // The two endpoints must agree or the puller caches a checksum for state it
  // never fetched. A pre-manifest peer only ever sees the snapshot's, so this
  // is also what keeps ITS short-circuit honest.
  it('reports the same checksum as the snapshot, whole or slot-scoped', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });

    const manifest = await getUsageManifest();
    expect((await getUsageSnapshot()).checksum).toBe(manifest.checksum);
    expect((await getUsageSnapshot({ slots: ['inst-peer'] })).checksum).toBe(manifest.checksum);
  });

  it('changes only when an instance digest actually advances', async () => {
    const before = (await getUsageManifest()).checksum;
    // A digest that loses the LWW race moves no capturedAt, so nothing to fetch.
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const withPeer = (await getUsageManifest()).checksum;
    expect(withPeer).not.toBe(before);

    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ capturedAt: '2026-08-29T00:00:00.000Z' }) } });
    expect((await getUsageManifest()).checksum).toBe(withPeer);
  });

  it('serves only the requested slots, so one instance advancing moves one digest', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });

    const { data } = await getUsageSnapshot({ slots: ['inst-peer'] });
    expect(Object.keys(data.instances)).toEqual(['inst-peer']);
    expect(data.instances['inst-peer'].usage.totalTokens.output).toBe(4000);
  });

  it('still serves everything when no slots are named (a pre-manifest peer)', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });

    for (const slots of [undefined, [], null]) {
      const { data } = await getUsageSnapshot({ slots });
      expect(Object.keys(data.instances).sort()).toEqual(['inst-other', 'inst-peer', 'inst-self']);
    }
  });

  // A retirement advances no slot's capturedAt, so it can only reach a peer by
  // riding every response — the slot-scoped one included.
  it('rides tombstones on the manifest and on a slot-scoped snapshot', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });
    await forgetInstanceUsage('inst-peer');

    expect((await getUsageManifest()).data.tombstones).toEqual([
      { instanceId: 'inst-peer', deletedAt: expect.any(String) },
    ]);
    expect((await getUsageSnapshot({ slots: ['inst-other'] })).data.tombstones).toHaveLength(1);
  });

  // The whole round trip, both directions, against the shipped merge: a puller
  // that fetches ONLY the diffed slot converges exactly as a whole-payload one.
  it('converges a receiver that fetches only the advanced slot', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry(), 'inst-other': otherEntry() } });
    const held = (await getUsageManifest()).data.instances;

    // A source peer whose `inst-other` digest moved on; everything else is level.
    const advanced = otherEntry({ capturedAt: '2026-09-02T00:00:00.000Z', usage: buildUsageDigest(usageFixture({ tokensOut: 7777 })) });
    const remoteManifest = { ...held, 'inst-other': advanced.capturedAt };
    const { diffManifestSlots } = await import('../lib/syncManifest.js');
    const stale = diffManifestSlots(remoteManifest, held);
    expect(stale).toEqual(['inst-other']);

    const partial = { instances: Object.fromEntries(stale.map((id) => [id, advanced])) };
    expect(await applyUsageRemote(partial)).toEqual({ applied: true, count: 1 });
    const store = await readStoreFile();
    expect(store.instances['inst-other'].usage.totalTokens.output).toBe(7777);
    // The slot we did NOT fetch is untouched, not dropped.
    expect(store.instances['inst-peer'].usage.totalTokens.output).toBe(4000);
  });
});

describe('untrusted digest handling', () => {
  it('skips a peer-chosen __proto__ instance key instead of re-parenting the instance map', async () => {
    // Computed key: a literal `__proto__:` would set the prototype and never reach Object.entries.
    // instanceId must match the key, or sanitizeEntry drops the entry before the store is touched.
    const payload = { instances: { ['__proto__']: peerEntry({ instanceId: '__proto__' }), 'inst-peer': peerEntry() } };
    expect(Object.hasOwn(payload.instances, '__proto__')).toBe(true);
    expect(await applyUsageRemote(payload)).toEqual({ applied: true, count: 1 });
    const stored = await readStoreFile();
    expect(Object.getPrototypeOf(stored.instances)).toBe(Object.prototype);
    expect(Object.keys(stored.instances)).toEqual(['inst-peer']);
    expect(({}).capturedAt).toBeUndefined();
  });

  // canonicalStringify (this category's checksum) recurses in JS, with a far
  // smaller depth budget than native JSON.stringify — so a digest that survives
  // atomicWrite but blows that recursion would 500 the snapshot endpoint for
  // every peer, permanently and across restarts. The digest is rebuilt to the
  // known shallow shape rather than stored as it arrived, so depth is fixed.
  it('rebuilds a hostile digest to the wire shape instead of storing it', async () => {
    let deep = { tokensOut: 1 };
    for (let i = 0; i < 5000; i++) deep = { nested: deep };
    const hostile = peerEntry({ usage: { ...buildUsageDigest(usageFixture()), evil: deep } });

    expect(await applyUsageRemote({ instances: { 'inst-peer': hostile } })).toEqual({ applied: true, count: 1 });
    expect((await readStoreFile()).instances['inst-peer'].usage.evil).toBeUndefined();
    // The checksum must still be computable — this is the failure being pinned.
    await expect(getUsageSnapshot()).resolves.toMatchObject({ checksum: expect.any(String) });
  });

  it('drops junk bucket keys and coerces non-numeric counts', async () => {
    const junk = peerEntry({ usage: {
      ...buildUsageDigest(usageFixture()),
      dailyActivity: { 'not-a-day': { tokensOut: 5 }, '2026-08-30': { tokensOut: '900', sessions: 2 } },
    } });
    await applyUsageRemote({ instances: { 'inst-peer': junk } });

    const stored = (await readStoreFile()).instances['inst-peer'].usage.dailyActivity;
    expect(stored['not-a-day']).toBeUndefined();
    expect(stored['2026-08-30']).toEqual({ sessions: 2 }); // the string count is dropped, not NaN'd
  });
});

describe('retiring an instance', () => {
  // Our snapshot forwards every digest we hold, so a plain delete is undone by
  // the next peer that still has it — the decommissioned machine's spend would
  // sit in the fleet total forever.
  it('tombstones a removed instance so a peer cannot hand it back', async () => {
    const entry = peerEntry();
    await applyUsageRemote({ instances: { 'inst-peer': entry } });
    await forgetInstanceUsage('inst-peer');
    expect((await readStoreFile()).instances['inst-peer']).toBeUndefined();

    // A peer that hasn't seen the removal re-forwards the same digest.
    expect(await applyUsageRemote({ instances: { 'inst-peer': entry } })).toEqual({ applied: false, count: 0 });
    expect((await readStoreFile()).instances['inst-peer']).toBeUndefined();
  });

  it('propagates the retirement to a peer that still holds the digest', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-peer']).toBeTruthy();

    // The remote retired it; its snapshot carries the tombstone.
    const result = await applyUsageRemote({ instances: {}, tombstones: [{ instanceId: 'inst-peer', deletedAt: '2026-08-31T00:00:00.000Z' }] });
    expect(result.count).toBe(1);
    expect((await readStoreFile()).instances['inst-peer']).toBeUndefined();
  });

  it('persists a tombstone for an instance this machine never held, and a newer re-delete', async () => {
    const first = { instanceId: 'inst-gone', deletedAt: '2026-08-30T00:00:00.000Z' };
    expect(await applyUsageRemote({ instances: {}, tombstones: [first] })).toEqual({ applied: false, count: 0 });
    expect((await readStoreFile()).tombstones).toEqual([first]);

    const newer = { instanceId: 'inst-gone', deletedAt: '2026-08-31T00:00:00.000Z' };
    await applyUsageRemote({ instances: {}, tombstones: [newer] });
    expect((await readStoreFile()).tombstones).toEqual([newer]);
  });

  it('lets a machine that comes back supersede its own tombstone', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    await forgetInstanceUsage('inst-peer');

    const returned = peerEntry({ capturedAt: '2099-01-01T00:00:00.000Z' });
    expect(await applyUsageRemote({ instances: { 'inst-peer': returned } })).toEqual({ applied: true, count: 1 });
    expect((await readStoreFile()).instances['inst-peer']).toBeTruthy();
  });
});

describe('fleet report', () => {
  it('keeps the local report when no peer digest has synced', async () => {
    expect(await getFleetUsage({ providers: [] })).toMatchObject({
      instances: [], totals: null, report: { totals: { sessions: 2 } },
      coverage: { instanceCount: 1, missingInstances: [] },
    });
  });

  it('reports one row per instance plus the combined totals', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const fleet = await getFleetUsage({ providers: [] });

    expect(fleet.instances.map((i) => i.instanceId)).toEqual(['inst-self', 'inst-peer']);
    expect(fleet.instances[0].self).toBe(true);
    expect(fleet.instances[1].capturedAt).toBe('2026-08-30T12:00:00.000Z');
    expect(fleet.totals.tokensOut).toBe(5000);
    expect(fleet.totals.sessions).toBe(4);
    expect(fleet.instances.every((i) => i.usesSubscriptions)).toBe(true);
  });

  // A machine that pays API rates is still listed — the spend is real — but
  // must not inflate the combined "what subscriptions covered" total.
  it('leaves an API-billed instance listed but out of the combined total', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const fleet = await getFleetUsage({ providers: [], apiBilledInstanceIds: ['inst-peer'] });

    expect(fleet.instances.map((i) => [i.instanceId, i.usesSubscriptions])).toEqual([
      ['inst-self', true],
      ['inst-peer', false],
    ]);
    expect(fleet.totals.tokensOut).toBe(1000);
    expect(fleet.totals.sessions).toBe(2);
    expect(fleet.report.totals.sessions).toBe(4);
    expect(fleet.subscriptionReport.totals.sessions).toBe(2);
  });

  it('combines origin snapshots once and keeps period, provider, model and monthly totals consistent', async () => {
    const peer = peerEntry();
    await applyUsageRemote({ instances: { 'inst-peer': peer } });
    await applyUsageRemote({ instances: { 'inst-peer': peer, 'inst-self': peerEntry({ instanceId: 'inst-self' }) } });
    const fleet = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30', providers: [{ id: 'anthropic', type: 'api' }] });
    const [provider] = fleet.report.providers;
    expect(fleet.coverage.instanceCount).toBe(2);
    expect(fleet.report.totals).toMatchObject({ sessions: 4, messages: 10, tokensIn: 1000, tokensOut: 5000 });
    expect(provider).toMatchObject({ id: 'anthropic', sessions: 4, tokensOut: 5000 });
    expect(provider.models[0]).toMatchObject({ model: 'claude-opus-5', sessions: 4, tokensOut: 5000 });
    expect(fleet.activity).toEqual([expect.objectContaining({ date: '2026-08-30', label: '08-30', sessions: 4 })]);
    expect(fleet.monthly.history[0]).toMatchObject({ month: '2026-08', tokens: 6000, estimatedCost: fleet.report.totals.estimatedCost });
    const empty = await getFleetUsage({ from: '2026-09-01', to: '2026-09-01' });
    expect(empty.report.totals.sessions).toBe(0);
    expect(empty.report.providers).toEqual([]);
    expect(empty.activity[0].sessions).toBe(0);
  });

  it('reports peers that have never supplied a snapshot', async () => {
    configuredPeers = [{ instanceId: 'inst-missing', name: 'Missing', directions: ['outbound'] }];
    const fleet = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(fleet.coverage.missingInstances).toEqual(['Missing']);
    expect(fleet.report.totals.sessions).toBe(2);
  });

  it('uses each origin’s provider classification even when provider ids collide', async () => {
    const rename = (usage) => {
      const source = structuredClone(usage);
      const day = source.dailyActivity['2026-08-30'];
      day.byProvider.shared = day.byProvider.anthropic;
      delete day.byProvider.anthropic;
      return source;
    };
    localUsage = rename(usageFixture());
    const peer = peerEntry({ usage: buildUsageDigest(rename(usageFixture({ tokensOut: 4000 }))), providerClasses: { shared: { free: false, family: 'codex' } } });
    await applyUsageRemote({ instances: { 'inst-peer': peer } });
    const result = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30', providers: [{ id: 'shared', ollamaBacked: true }] });
    expect(result.report.providers).toHaveLength(2);
    expect(result.report.providers.find((row) => row.free)).toMatchObject({ tokensOut: 1000, estimatedCost: 0 });
    expect(result.report.providers.find((row) => row.family === 'codex')).toMatchObject({ tokensOut: 4000, classificationKnown: true });
    expect(result.report.providers.find((row) => row.family === 'codex').estimatedCost).toBeGreaterThan(0);
  });

  it('does not price an older peer whose classification was never reported', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ providerClasses: null }) } });
    const result = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30', providers: [{ id: 'anthropic', type: 'api' }] });
    expect(result.coverage).toMatchObject({ pricingIncomplete: true, classificationUnreported: ['Studio'] });
    expect(result.report.providers.find((row) => !row.classificationKnown)).toMatchObject({ estimatedCost: null, tokensOut: 4000 });
  });

  it('keeps external transcript usage and empty months in the selected monthly chart', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({
      claudeCode: { updatedAt: '2026-09-30T12:00:00Z', days: { '2026-09-15': { 'claude-opus-5': { output: 1000 } } } },
    }) } });
    const fleet = await getFleetUsage({ from: '2026-08-01', to: '2026-10-31' });
    expect(fleet.monthly.history.map((row) => row.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(fleet.monthly.history[1].tokens).toBe(1000);
    expect(fleet.monthly.history[2].tokens).toBe(0);
  });

  it('does not add a transcript again to its rolled-up ledger month', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    const source = usageFixture({ day: '2026-03-01', tokensOut: 0 });
    source.dailyActivity['2026-03-01'].byProvider['claude-code'] = source.dailyActivity['2026-03-01'].byProvider.anthropic;
    delete source.dailyActivity['2026-03-01'].byProvider.anthropic;
    const provider = source.dailyActivity['2026-03-01'].byProvider['claude-code'];
    provider.tokensIn = 31;
    provider.byModel['claude-opus-5'].tokensIn = 31;
    localUsage = buildUsageDigest(source, { retentionDays: 1, now: new Date('2026-04-15T00:00:00Z') });
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { updatedAt: '2026-04-16T00:00:00Z', days: {
      '2026-03-01': { 'claude-opus-5': { messages: 1, input: 31, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } });
    const fleet = await getFleetUsage({ from: '2026-03-01', to: '2026-03-31', providers: [{ id: 'claude-code', command: 'claude', type: 'cli' }] });
    expect(fleet.monthly.history[0].tokens).toBe(31);
  });

  it('keeps separately configured API usage apart from Claude Code transcripts', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    const day = localUsage.dailyActivity['2026-08-30'];
    day.tokens = 0;
    day.byProvider['claude-api'] = day.byProvider.anthropic;
    delete day.byProvider.anthropic;
    const provider = day.byProvider['claude-api'];
    provider.tokensIn = 1_000_000;
    provider.tokensOut = 0;
    provider.byModel['claude-opus-5'].tokensIn = 1_000_000;
    provider.byModel['claude-opus-5'].tokensOut = 0;
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { updatedAt: '2026-09-02T00:00:00Z', days: {
      '2026-08-30': { 'claude-opus-5': { messages: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } });
    const fleet = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30', providers: [{ id: 'claude-api', type: 'api' }] });
    expect(fleet.monthly.history[0]).toMatchObject({ tokens: 2_000_000, estimatedCost: 10 });
  });

  it('accumulates sub-cent transcript costs over the selected month', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    localUsage = { dailyActivity: {}, monthlyActivity: {}, lastUpdated: null };
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { updatedAt: '2026-09-02T00:00:00Z', days: {
      '2026-08-29': { 'claude-opus-5': { messages: 1, input: 800, output: 0, cacheRead: 0, cacheWrite: 0 } },
      '2026-08-30': { 'claude-opus-5': { messages: 1, input: 800, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } });
    const fleet = await getFleetUsage({ from: '2026-08-01', to: '2026-08-31' });
    expect(fleet.monthly.history[0]).toMatchObject({ tokens: 1600, estimatedCost: 0.01 });
  });

  it('preserves mixed provider and model rows and counts undated legacy totals only for all time', async () => {
    localUsage.totalSessions = 5;
    localUsage.totalMessages = 8;
    const other = usageFixture({ tokensOut: 3000 });
    const provider = other.dailyActivity['2026-08-30'].byProvider.anthropic;
    delete other.dailyActivity['2026-08-30'].byProvider.anthropic;
    other.dailyActivity['2026-08-30'].byProvider['codex-cli'] = provider;
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(other) }) } });
    const selected = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(selected.report.providers.map((row) => row.id).sort()).toEqual(['anthropic', 'codex-cli']);
    expect(selected.report.totals.sessions).toBe(4);
    expect(selected.report.providers.find((row) => row.id === 'codex-cli').family).toBe('codex');
    const all = await getFleetUsage();
    expect(all.report.totals).toMatchObject({ sessions: 7, messages: 13 });
    expect(all.report.providers.find((row) => row.id === 'legacy')).toMatchObject({ sessions: 3, messages: 3 });
    expect(all.activity.find((row) => row.date === 'undated')?.sessions).toBe(3);
  });

  it('rounds after combining instance costs, keeping fleet and report totals consistent', async () => {
    const small = usageFixture({ tokensOut: 0 });
    small.totalTokens.input = 1000;
    const provider = small.dailyActivity['2026-08-30'].byProvider.anthropic;
    provider.tokensIn = 1000;
    provider.byModel['claude-opus-5'].tokensIn = 1000;
    localUsage = small;
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(small) }) } });
    const fleet = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30', providers: [{ id: 'anthropic', type: 'api' }] });
    expect(fleet.instances.map((row) => row.totals.estimatedCost)).toEqual([0.01, 0.01]);
    expect(fleet.totals.estimatedCost).toBe(0.01);
    expect(fleet.report.totals.estimatedCost).toBe(0.01);
    expect(fleet.monthly.history[0].estimatedCost).toBe(0.01);
  });

  // The wire digest folds days past its retention window into WHOLE months, and
  // buildUsageReport includes a month bucket whole whenever its month overlaps
  // the range. Routing this machine's own row through the digest therefore made
  // the "This machine" row report a whole month where the headline above it
  // reported ten days — measured at 10x. The self row must read the live maps.
  it('prices this machine from live usage, not from its own wire digest', async () => {
    localUsage = usageFixture({ day: '2026-01-05', tokensOut: 1000 });
    localUsage.dailyActivity['2026-01-15'] = { sessions: 1, messages: 1, tokens: 100, byProvider: {
      anthropic: { name: 'Anthropic', sessions: 1, messages: 1, tokensIn: 50, tokensOut: 100, cacheReadTokens: 0, cacheWriteTokens: 0, source: 'measured', byModel: {} },
    } };
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });

    const fleet = await getFleetUsage({ from: '2026-01-10', to: '2026-01-20', providers: [] });
    const selfRow = fleet.instances.find((i) => i.self);
    // Only the 2026-01-15 bucket is in range; the 2026-01-05 one is not.
    expect(selfRow.totals.tokensOut).toBe(100);
  });

  // buildUsageReport folds an OVERLAPPING month bucket in whole. Locally that is
  // safe (months only exist past the 400-day daily retention, far outside any
  // range anyone asks for), but a peer's digest rolls up at 120 days — well
  // inside a reachable window — so a narrow explicit from/to over a rolled-up
  // month would silently count days outside it.
  it('does not count a rolled-up month the window only clips', async () => {
    const rolledUp = peerEntry({
      usage: buildUsageDigest(usageFixture({ day: '2026-05-02', tokensOut: 7000 }), {
        retentionDays: 30, now: new Date('2026-09-01T00:00:00Z'),
      }),
    });
    await applyUsageRemote({ instances: { 'inst-peer': rolledUp } });
    expect(rolledUp.usage.monthlyActivity['2026-05']).toBeTruthy();

    const clipped = await getFleetUsage({ from: '2026-05-10', to: '2026-05-15', providers: [] });
    expect(clipped.totals.tokensOut).toBe(0);
    expect(clipped.coverage.incompleteMonths).toEqual(['2026-05']);
    expect(clipped.monthly.history).toEqual([expect.objectContaining({ month: '2026-05', tokens: 0, partial: true })]);

    // A window that covers the whole month still reports it.
    const whole = await getFleetUsage({ from: '2026-05-01', to: '2026-05-31', providers: [] });
    expect(whole.totals.tokensOut).toBe(7000);
    expect(whole.activity).toEqual([expect.objectContaining({ date: '2026-05', label: '2026-05', sessions: 2 })]);
  });

  it('carries a peer\'s media units and long-context subsets through the wire digest', async () => {
    const usage = usageFixture({ day: '2026-01-15', tokensOut: 100 });
    const bucket = usage.dailyActivity['2026-01-15'].byProvider.anthropic;
    Object.assign(bucket, { images: 3, videoSeconds: 12, inputImages: 2, longTokensIn: 40, longTokensOut: 5 });
    Object.assign(bucket.byModel['claude-opus-5'], { images: 3, videoSeconds: 12, inputImages: 2, longTokensIn: 40, longTokensOut: 5 });
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(usage, { now: new Date('2026-01-20T00:00:00Z') }) }) } });

    const { data } = await getUsageSnapshot();
    const stored = data.instances['inst-peer'].usage.dailyActivity['2026-01-15'].byProvider.anthropic;
    expect(stored).toMatchObject({ images: 3, videoSeconds: 12, inputImages: 2, longTokensIn: 40, longTokensOut: 5 });
    expect(stored.byModel['claude-opus-5']).toMatchObject({ images: 3, videoSeconds: 12, inputImages: 2, longTokensIn: 40 });
  });

  it('scopes every instance to the same report window', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const outside = await getFleetUsage({ from: '2026-09-01', to: '2026-09-30', providers: [] });
    expect(outside.totals.tokensOut).toBe(0);
  });

  it('derives the all-time subscription window from the included instances', async () => {
    const earlier = usageFixture({ day: '2026-01-01' });
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(earlier, { now: new Date('2026-01-10T00:00:00Z') }) }) } });
    const all = await getFleetUsage();
    const excluded = await getFleetUsage({ apiBilledInstanceIds: ['inst-peer'] });
    expect(all.subscriptionFirstActivityDay).toBe('2026-01-01');
    expect(excluded.subscriptionFirstActivityDay).toBe('2026-08-30');
    expect(excluded.firstActivityDay).toBe('2026-01-01');
  });
});

describe('selected-period hourly and image observations', () => {
  it('sums daily hours across instances, filters dates and flags legacy buckets', async () => {
    const localHours = Array(24).fill(0); localHours[8] = 2;
    localUsage.dailyActivity['2026-08-30'].hourlyActivity = localHours;
    const remote = usageFixture();
    const remoteHours = Array(24).fill(0); remoteHours[9] = 2;
    remote.dailyActivity['2026-08-30'].hourlyActivity = remoteHours;
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(remote) }) } });
    const selected = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(selected.hourlyActivity[8]).toBe(2);
    expect(selected.hourlyActivity[9]).toBe(2);
    expect(selected.coverage.hourlyIncomplete).toBe(false);
    const empty = await getFleetUsage({ from: '2026-09-01', to: '2026-09-02' });
    expect(empty.hourlyActivity.reduce((a, b) => a + b, 0)).toBe(0);
    localUsage.dailyActivity['2026-08-30'] = { byProvider: { example: { sessions: 1 } } };
    const legacy = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(legacy.coverage.hourlyIncomplete).toBe(true);
    localUsage.totalSessions = 0;
    expect((await getFleetUsage()).coverage.hourlyIncomplete).toBe(true);
  });

  it('deduplicates projected image outputs, filters output dates, and reports missing peers', async () => {
    const receipt = { id: 'a'.repeat(64), renderKey: 'b'.repeat(64), occurredAt: '2026-08-30T23:00:00.000Z', identitySource: 'codex-session', driverTotal: 12, privatePrompt: 'do not transmit' };
    const next = { ...receipt, id: 'c'.repeat(64), occurredAt: '2026-08-31T01:00:00.000Z' };
    const projection = { complete: true, receipts: [receipt, next] };
    await applyUsageRemote({ instances: {
      'inst-peer': peerEntry({ imageReceipts: projection }),
      'inst-two': peerEntry({ instanceId: 'inst-two', imageReceipts: projection }),
    } });
    const snapshot = await getUsageSnapshot();
    expect(JSON.stringify(snapshot.data.instances['inst-peer'].imageReceipts)).not.toContain('do not transmit');
    const first = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(first.imageRenders).toMatchObject({ codexSessions: 1, savedOutputs: 1, incomplete: false, driverTokens: { reportedTotal: 12, sessionsMeasured: 1 } });
    const second = await getFleetUsage({ from: '2026-08-31', to: '2026-08-31' });
    expect(second.imageRenders).toMatchObject({ codexSessions: 0, savedOutputs: 1 });
    configuredPeers = [{ instanceId: 'offline', name: 'Offline' }];
    expect((await getFleetUsage()).imageRenders.incomplete).toBe(true);
  });

  it('reports per-origin block observations in the selected period without sharing error prose', async () => {
    localUsage.blockEvents = [{ providerId: 'anthropic', model: 'example', at: Date.parse('2026-08-30T12:00:00Z'), message: 'private error content' }];
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ blockEvents: [
      { providerId: 'anthropic', model: 'example', at: Date.parse('2026-08-30T13:00:00Z'), resetHint: 'private hint' },
      { providerId: 'anthropic', at: Date.parse('2026-08-31T13:00:00Z') },
    ] }) } });
    const result = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks.map((block) => block.originName).sort()).toEqual(['Studio', 'Workshop']);
    expect(JSON.stringify((await getUsageSnapshot()).data)).not.toMatch(/private (?:error content|hint)/);
  });
});

describe('fleet rolling 30-day cost', () => {
  const fixtureProviders = [{ id: 'anthropic', type: 'api' }, { id: 'claude-code', type: 'cli', command: 'claude' }];
  const dayCost = (usage, day) => buildUsageReport({ [day]: usage.dailyActivity[day] }, { providers: fixtureProviders }).totals.estimatedCost;

  it('marks removed local provider classifications incomplete instead of guessing', async () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const chart = await getFleetRollingCost({ providers: [], now });
    expect(chart.pricingIncomplete).toBe(true);
    expect(chart.points.at(-1).cost).toBe(0);
  });

  // Every instance counts — including one marked API-billed, whose spend at API
  // rates is exactly what this chart totals — and a day leaves the window 30
  // days later.
  it('sums every instance over a trailing 30-day window', async () => {
    const peer = peerEntry();
    await applyUsageRemote({ instances: { 'inst-peer': peer } });
    const both = dayCost(localUsage, '2026-08-30') + dayCost(peer.usage, '2026-08-30');
    expect(both).toBeGreaterThan(0);

    const series = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-28T12:00:00Z') });
    expect(series.instanceCount).toBe(2);
    expect(series.points).toHaveLength(90);
    const at = (date) => series.points.find((p) => p.date === date).cost;
    expect(series.points.at(-1).date).toBe('2026-09-28');
    expect(at('2026-08-29')).toBe(0);
    expect(at('2026-08-30')).toBeCloseTo(both, 2);
    expect(at('2026-09-28')).toBeCloseTo(both, 2);

    // Split by plan; a provider no subscription family claims stands alone.
    expect(series.series).toEqual([{ key: 'provider:anthropic', label: 'Anthropic' }]);
    expect(series.points.at(-1).values[0]).toBeCloseTo(both, 2);

    const later = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-29T00:00:00Z') });
    expect(later.points.at(-1).cost).toBe(0);
  });

  // Past a peer's 120-day day retention only month buckets remain; their cost
  // is spread over the month so a long range still totals correctly.
  it('spreads a rolled-up month over its days on a long range', async () => {
    const rolledUp = peerEntry({
      usage: buildUsageDigest(usageFixture({ day: '2026-03-10', tokensOut: 7000 }), {
        retentionDays: 30, now: new Date('2026-09-01T00:00:00Z'),
      }),
    });
    await applyUsageRemote({ instances: { 'inst-peer': rolledUp } });
    const monthCost = buildUsageReport({}, { monthlyActivity: rolledUp.usage.monthlyActivity, providers: fixtureProviders }).totals.estimatedCost;
    expect(monthCost).toBeGreaterThan(0);

    const series = await getFleetRollingCost({ providers: fixtureProviders, range: 'all', now: new Date('2026-09-01T00:00:00Z') });
    const at = (date) => series.points.find((p) => p.date === date).cost;
    expect(series.range).toBe('all');
    expect(series.points[0].date).toBe('2026-03-01');
    // 31 March days share the month; the window ending Mar 30 holds 30 of them.
    expect(at('2026-03-30')).toBeCloseTo((monthCost * 30) / 31, 1);
    expect(at('2026-08-30')).toBeCloseTo(dayCost(localUsage, '2026-08-30'), 2);

    const year = await getFleetRollingCost({ providers: fixtureProviders, range: '1y', now: new Date('2026-09-01T00:00:00Z') });
    expect(year.points).toHaveLength(365);
  });

  // Two provider records on the same plan (here one only a peer has configured)
  // stack as one Claude Code area.
  it('stacks providers of one plan together', async () => {
    const asProvider = (usage, id) => {
      const out = structuredClone(usage);
      for (const day of Object.values(out.dailyActivity)) day.byProvider = { [id]: day.byProvider.anthropic };
      return out;
    };
    localUsage = asProvider(usageFixture(), 'claude-code');
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({ usage: buildUsageDigest(asProvider(usageFixture({ tokensOut: 4000 }), 'claude-opus-cli')) }) } });
    const series = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-01T00:00:00Z') });
    expect(series.series).toEqual([{ key: 'claude', label: 'Claude Code' }]);
    expect(series.points.at(-1).values).toEqual([series.points.at(-1).cost]);
  });

  it('invalidates the rolling chart when a provider changes subscription family', async () => {
    const bucket = localUsage.dailyActivity['2026-08-30'];
    bucket.byProvider['claude-api'] = bucket.byProvider.anthropic;
    delete bucket.byProvider.anthropic;
    const now = new Date('2026-09-01T00:00:00Z');
    const api = await getFleetRollingCost({ now, providers: [{ id: 'claude-api', type: 'api' }] });
    const cli = await getFleetRollingCost({ now, providers: [{ id: 'claude-api', type: 'cli', command: 'claude' }] });
    expect(api.series[0].key).toBe('provider:claude-api');
    expect(cli.series[0].key).toBe('claude');
  });

  it('keeps transcript dates when a rolled-up month contains only another provider', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    localUsage = { dailyActivity: {}, monthlyActivity: { '2026-03': { byProvider: {
      'codex-cli': { tokensIn: 1_000_000, byModel: { 'gpt-5': { tokensIn: 1_000_000 } } },
    } } }, lastUpdated: '2026-03-30T00:00:00Z' };
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { updatedAt: '2026-03-30T00:00:00Z', days: {
      '2026-03-15': { 'claude-opus-5': { messages: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
    } });
    const chart = await getFleetRollingCost({ now: new Date('2026-03-30T00:00:00Z'), range: '1m' });
    const claude = chart.series.findIndex((row) => row.key === 'claude');
    expect(chart.points.find((row) => row.date === '2026-03-14').values[claude]).toBe(0);
    expect(chart.points.find((row) => row.date === '2026-03-15').values[claude]).toBeGreaterThan(0);
  });

  // Transcripts hold every Claude Code session on the machine, PortOS's own
  // runs included, and the ledger holds a subset of them: each day takes the
  // larger, never the sum.
  it('counts Claude Code from transcripts where they exceed the ledger, never on top', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    const { summarizeTranscriptDays } = await import('./claudeCodeModelReport.js');
    localUsage = usageFixture();
    const bucket = localUsage.dailyActivity['2026-08-30'];
    bucket.byProvider = { 'claude-code': bucket.byProvider.anthropic };
    const ledger = dayCost(localUsage, '2026-08-30');
    const counts = (output) => ({ messages: 4, input: 2_000_000, output, cacheRead: 0, cacheWrite: 0 });
    const transcript = { '2026-08-30': { 'claude-opus-5': counts(3_000_000) }, '2026-08-29': { 'claude-opus-5': counts(1_000_000) } };
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: transcript, updatedAt: '2026-08-31T00:00:00.000Z' });
    const dayTranscript = (day) => summarizeTranscriptDays({ [day]: transcript[day] }).totals.estimatedCost;
    expect(dayTranscript('2026-08-30')).toBeGreaterThan(ledger);

    const series = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-01T00:00:00Z') });
    expect(series.series).toEqual([{ key: 'claude', label: 'Claude Code' }]);
    expect(series.points.at(-1).cost).toBeCloseTo(dayTranscript('2026-08-30') + dayTranscript('2026-08-29'), 1);

    // A day where the ledger already holds more keeps the ledger's figure.
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: { '2026-08-30': { 'claude-opus-5': { messages: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }, updatedAt: '2026-08-31T01:00:00.000Z' });
    const lower = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-01T00:00:00Z') });
    expect(lower.points.at(-1).cost).toBeCloseTo(ledger, 2);
  });

  it('charts this machine alone before any peer has synced', async () => {
    const series = await getFleetRollingCost({ providers: fixtureProviders, now: new Date('2026-09-01T00:00:00Z') });
    expect(series.instanceCount).toBe(1);
    expect(series.points.at(-1).cost).toBeCloseTo(dayCost(localUsage, '2026-08-30'), 2);
  });
});

describe('fleet calendar-month usage', () => {
  it('includes local and peer transcripts and ledgers without counting overlapping Claude sessions twice', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    localUsage = usageFixture({ day: '2026-09-10' });
    const day = localUsage.dailyActivity['2026-09-10'];
    day.byProvider = { 'claude-code': day.byProvider.anthropic };
    localUsage.dailyActivity['2026-09-11'] = structuredClone(day);
    const counts = (input, output) => ({ messages: 2, input, output, cacheRead: 100, cacheWrite: 20 });
    await atomicWrite(TRANSCRIPT_USAGE_FILE, {
      days: { '2026-09-10': { 'claude-opus-5': counts(2000, 4000) }, '2026-09-11': { 'claude-opus-5': counts(1, 1) } },
      updatedAt: '2026-09-30T00:00:00Z',
    });
    const peerUsage = usageFixture({ day: '2026-09-12', tokensOut: 4000 });
    const peerDay = peerUsage.dailyActivity['2026-09-12'];
    peerDay.byProvider = { 'codex-cli': peerDay.byProvider.anthropic };
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry({
      usage: buildUsageDigest(peerUsage),
      claudeCode: { days: { '2026-09-12': { 'claude-opus-5': counts(7000, 8000) } }, updatedAt: '2026-09-30T00:00:00Z' },
    }) } });

    const now = new Date('2026-09-30T23:59:59Z');
    const providers = [{ id: 'claude-code', type: 'cli', command: 'claude' }];
    const monthly = await getFleetMonthlyUsage({ now, providers });
    const rolling = await getFleetRollingCost({ now, providers });
    expect(monthly.instanceCount).toBe(2);
    expect(monthly.series.map((row) => row.key).sort()).toEqual(['claude', 'codex']);
    expect(monthly.history).toHaveLength(1);
    expect(monthly.history[0]).toMatchObject({ month: '2026-09', tokens: 6120 + 1500 + 4500 + 15120, partial: true });
    expect(monthly.history[0].estimatedCost).toBe(rolling.points.at(-1).cost);
    expect(monthly.history[0].values.reduce((sum, cost) => sum + cost, 0)).toBeCloseTo(monthly.history[0].estimatedCost, 2);
  });

  it('preserves rolled-up months, cache tokens, empty months and the twelve-month limit', async () => {
    localUsage = usageFixture({ day: '2025-06-01' });
    localUsage.dailyActivity['2025-06-01'] = { byProvider: { example: { tokensIn: 10, tokensOut: 20, cacheReadTokens: 30, cacheWriteTokens: 40, source: 'measured' } } };
    localUsage.monthlyActivity = { '2025-04': { tokensIn: 1000000, tokens: 2000000 } };
    const monthly = await getFleetMonthlyUsage({ now: new Date('2025-06-30T23:59:59Z'), providers: [{ id: 'legacy', type: 'api' }, { id: 'example', type: 'api' }] });
    expect(monthly.history).toEqual([
      { month: '2025-04', estimatedCost: 33, values: [33, 0], tokens: 3000000, partial: false },
      { month: '2025-05', estimatedCost: 0, values: [0, 0], tokens: 0, partial: false },
      { month: '2025-06', estimatedCost: 0, values: [0, 0], tokens: 100, partial: true },
    ]);
    const later = await getFleetMonthlyUsage({ now: new Date('2026-06-01T00:00:00Z') });
    expect(later.history).toHaveLength(12);
    expect(later.history[0].month).toBe('2025-07');
    expect(later.history.at(-1).month).toBe('2026-06');
  });

  it('folds smaller providers into Other while retaining free-provider tokens', async () => {
    localUsage = usageFixture({ day: '2026-09-01' });
    const bucket = localUsage.dailyActivity['2026-09-01'];
    bucket.byProvider = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`example-${i}`, { tokensOut: (i + 1) * 1000000 }]));
    bucket.byProvider.ollama = { tokensOut: 5000000 };
    bucket.tokens = 26000000;
    const monthly = await getFleetMonthlyUsage({ now: new Date('2026-09-30T00:00:00Z'), providers: [{ id: 'ollama', type: 'ollama' }, ...Array.from({ length: 6 }, (_, i) => ({ id: `example-${i}`, type: 'api' }))] });
    expect(monthly.series).toHaveLength(5);
    expect(monthly.series.at(-1)).toEqual({ key: 'other', label: 'Other' });
    expect(monthly.history[0]).toMatchObject({ estimatedCost: 315, tokens: 26000000 });
    expect(monthly.history[0].values.reduce((sum, cost) => sum + cost, 0)).toBe(315);
  });

  it('returns empty history before any usage is recorded', async () => {
    localUsage = { dailyActivity: {}, monthlyActivity: {}, lastUpdated: null };
    expect(await getFleetMonthlyUsage()).toEqual({ instanceCount: 1, series: [], history: [] });
  });
});

describe('federated subscription-quota readings', () => {
  it('replaces an obsolete quota with an explicitly unsupported provider', async () => {
    await recordLocalQuotaCards([quotaCard()]);
    await recordLocalQuotaCards([{ family: 'claude', label: 'Claude', supported: false, limits: [], activity: [], fetchedAt: '2026-09-01T00:00:00.000Z' }], { families: ['claude'], complete: true });
    expect((await readLocalQuotaCards()).quotas[0]).toMatchObject({ supported: false, limits: [] });
  });
  it('distinguishes a partial family refresh from a complete empty scan and retires disabled families', async () => {
    await recordLocalQuotaCards([quotaCard()]);
    expect((await readLocalQuotaCards()).reported).toBe(false);
    await recordLocalQuotaCards([quotaCard({ family: 'codex' })], { families: ['codex'], complete: true });
    expect((await readLocalQuotaCards()).quotas.map((card) => card.family)).toEqual(['codex']);
    expect((await readLocalQuotaCards()).reported).toBe(true);
    await recordLocalQuotaCards([], { families: [], complete: true });
    expect(await readLocalQuotaCards()).toMatchObject({ quotas: [], reported: true });
  });

  it('publishes this machine\'s readings and advances the LWW stamp past them', async () => {
    await recordLocalQuotaCards([quotaCard()]);
    const { data } = await getUsageSnapshot();
    const self = data.instances['inst-self'];
    expect(self.quotas).toEqual([expect.objectContaining({ family: 'claude', plan: 'subscription' })]);
    // A quota refresh with no new AI runs must still move the slot, or no peer
    // would ever pull it: `capturedAt` is both the LWW stamp and the manifest.
    expect(Date.parse(self.capturedAt)).toBeGreaterThanOrEqual(Date.parse('2026-08-31T00:00:00.000Z'));
  });

  // `capturedAt` is the manifest fingerprint, so it has to move whenever the
  // entry does. Deriving it from the freshest card's `fetchedAt` only worked
  // while every adapter stamped its read clock: a Codex card carries the
  // timestamp of the turn that produced it, so a corrected Codex reading can
  // sit behind a sibling card's stamp and — without a write clock — leave the
  // slot pinned, so no peer ever pulls the correction.
  it('moves the LWW stamp when a card changes behind a newer sibling card', async () => {
    await recordLocalQuotaCards([
      quotaCard({ fetchedAt: '2026-08-31T12:00:00.000Z' }),
      quotaCard({ family: 'codex', label: 'Codex', fetchedAt: '2026-08-30T08:00:00.000Z' }),
    ]);
    const before = (await readLocalQuotaCards()).capturedAt;

    // New Codex telemetry, still older than the claude card's stamp.
    const spent = [{ key: 'week', label: 'Current week', percentUsed: 100, percentRemaining: 0, resetsAt: null, timezone: null }];
    const write = await recordLocalQuotaCards([
      quotaCard({ family: 'codex', label: 'Codex', fetchedAt: '2026-08-30T09:00:00.000Z', limits: spent }),
    ]);
    expect(write.changed).toBe(true);
    expect(Date.parse(write.capturedAt)).toBeGreaterThan(Date.parse(before));
  });

  it('publishes a new observation time without rewriting identical cached or derived reads', async () => {
    expect((await recordLocalQuotaCards([quotaCard()])).changed).toBe(true);
    expect((await recordLocalQuotaCards([quotaCard()])).changed).toBe(false);
    const later = quotaCard({ fetchedAt: '2026-08-31T01:00:00.000Z' });
    expect((await recordLocalQuotaCards([later])).changed).toBe(true);
    expect((await readLocalQuotaCards()).quotas[0].fetchedAt).toBe(later.fetchedAt);
    expect((await recordLocalQuotaCards([quotaCard({ fetchedAt: later.fetchedAt, limits: [] })])).changed).toBe(true);

    const image = quotaCard({ family: 'imagegen', label: 'Image Gen' });
    expect((await recordLocalQuotaCards([image])).changed).toBe(true);
    expect((await recordLocalQuotaCards([{ ...image, fetchedAt: later.fetchedAt }])).changed).toBe(false);

    const unsupported = { family: 'grok', label: 'Grok', supported: false, limits: [], activity: [], fetchedAt: quotaCard().fetchedAt };
    expect((await recordLocalQuotaCards([unsupported])).changed).toBe(true);
    expect((await recordLocalQuotaCards([{ ...unsupported, fetchedAt: later.fetchedAt }])).changed).toBe(false);
  });

  // Codex cards are stamped with the TELEMETRY that produced them, not the
  // clock they were read at, so a rollout-log tail can arrive AFTER a live
  // account reading while describing an older moment. Letting it through would
  // publish a reading this machine already knows is superseded.
  it('keeps the newer reading when an older card for the same family arrives after it', async () => {
    const spent = [{ key: 'week', label: 'Current week', percentUsed: 100, percentRemaining: 0, resetsAt: null, timezone: null }];
    const live = quotaCard({ family: 'codex', label: 'Codex', fetchedAt: '2026-08-31T12:00:00.000Z', limits: spent });
    const stale = quotaCard({ family: 'codex', label: 'Codex', fetchedAt: '2026-08-29T09:00:00.000Z' });
    expect((await recordLocalQuotaCards([live])).changed).toBe(true);
    expect((await recordLocalQuotaCards([stale])).changed).toBe(false);
    const { quotas } = await readLocalQuotaCards();
    expect(quotas.find((q) => q.family === 'codex').limits[0].percentUsed).toBe(100);
  });

  it('merges a narrowed read instead of retiring the families it skipped', async () => {
    await recordLocalQuotaCards([quotaCard(), quotaCard({ family: 'codex', label: 'Codex' })]);
    await recordLocalQuotaCards([quotaCard({ activity: [{ period: 'Last 24h', requests: 99, sessions: 3, notes: [] }] })]);
    const { quotas } = await readLocalQuotaCards();
    expect(quotas.map((q) => q.family).sort()).toEqual(['claude', 'codex']);
    expect(quotas.find((q) => q.family === 'claude').activity[0].requests).toBe(99);
  });

  it('rebuilds a peer\'s readings to the wire shape and excludes API-billed instances', async () => {
    await applyUsageRemote({
      instances: {
        'inst-peer': peerEntry({ quotas: [quotaCard({ raw: 'transcript', limits: [{ key: 'week', percentUsed: 90 }] })] }),
        'inst-billed': peerEntry({ instanceId: 'inst-billed', name: 'Rented Box', quotas: [quotaCard()] }),
      },
    });
    const all = await getFleetQuotaEntries();
    expect(all.map((e) => e.instanceId).sort()).toEqual(['inst-billed', 'inst-peer']);
    const peer = all.find((e) => e.instanceId === 'inst-peer');
    expect(Object.hasOwn(peer.quotas[0], 'raw')).toBe(false);
    expect(peer.quotas[0].limits[0].percentRemaining).toBe(10);

    const kept = await getFleetQuotaEntries({ excludeInstanceIds: ['inst-billed'] });
    expect(kept.map((e) => e.instanceId)).toEqual(['inst-peer']);
  });

  it('leaves out a peer that published no readings', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    expect(await getFleetQuotaEntries()).toEqual([]);
  });
});

describe('federated Claude Code tokens per model', () => {
  const counts = (o) => ({ messages: 2, input: 1_000_000, output: o, cacheRead: 0, cacheWrite: 0 });
  const days = (o) => ({ '2026-09-10': { 'claude-opus-5-5': counts(o) }, '2026-08-01': { 'claude-opus-5-5': counts(o) } });

  it('publishes this machine\'s history, moves the LWW stamp with it, and totals it with a peer', async () => {
    const { atomicWrite } = await import('../lib/fileUtils.js');
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: days(1_000_000), updatedAt: '2026-09-20T00:00:00.000Z' });
    const { data } = await getUsageSnapshot();
    expect(data.instances['inst-self'].claudeCode.days['2026-09-10']['claude-opus-5-5'].output).toBe(1_000_000);
    expect(Date.parse(data.instances['inst-self'].capturedAt)).toBeGreaterThanOrEqual(Date.parse('2026-09-20T00:00:00.000Z'));

    await applyUsageRemote({ instances: { 'inst-peer': { ...peerEntry(), claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: days(3_000_000) } } } });
    const fleet = await getFleetClaudeCodeModels({ from: '2026-09-01', to: '2026-09-30' });
    expect(fleet.instances.map((i) => i.instanceId).sort()).toEqual(['inst-peer', 'inst-self']);
    // Window scoping: the 2026-08-01 day is excluded from every row and the total.
    expect(fleet.models).toEqual([expect.objectContaining({ model: 'claude-opus-5-5', messages: 4, output: 4_000_000 })]);
    expect(fleet.totals.estimatedCost).toBeGreaterThan(0);
  });

  it('includes API-billed instances in the combined figures and tolerates a peer with no history', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': { ...peerEntry(), claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: days(3_000_000) } }, 'inst-old': peerEntry() } });
    const fleet = await getFleetClaudeCodeModels({ apiBilledInstanceIds: ['inst-peer'] });
    expect(fleet.instances).toEqual([expect.objectContaining({ instanceId: 'inst-peer', usesSubscriptions: false })]);
    expect(fleet.totals.total).toBe(8_000_000);
  });

  it('distinguishes a completed empty transcript scan from an unavailable peer', async () => {
    await applyUsageRemote({ instances: {
      'inst-peer': peerEntry({ claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: {} } }),
      'inst-old': peerEntry({ instanceId: 'inst-old', name: 'Old' }),
    } });
    const fleet = await getFleetUsage({ from: '2026-08-30', to: '2026-08-30' });
    expect(fleet.coverage.transcriptUnreported).toEqual(['Old']);
    expect((await getFleetClaudeCodeModels()).pendingInstances).toEqual(['Old']);
  });

  it('rebuilds a hostile peer history to the fixed shape', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': { ...peerEntry(), claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: { '2026-09-10': { m: { messages: 1, evil: 5 } }, junk: {} } } } } });
    expect((await readStoreFile()).instances['inst-peer'].claudeCode.days).toEqual({ '2026-09-10': { m: { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  });

  it('discards prototype-polluting keys in peer buckets without polluting Object.prototype', async () => {
    const maliciousUsage = {
      dailyActivity: {
        '2026-09-10': {
          byProvider: {
            __proto__: { cost: 100 },
            constructor: { cost: 100 },
            prototype: { cost: 100 },
            openai: {
              byModel: {
                __proto__: { messages: 100 },
                constructor: { messages: 100 },
                prototype: { messages: 100 },
                'gpt-4': { messages: 1, inputTokens: 10 },
              },
            },
          },
        },
      },
    };

    await applyUsageRemote({
      instances: {
        'inst-peer': peerEntry({
          capturedAt: '2026-09-22T00:00:00.000Z',
          usage: maliciousUsage,
        }),
      },
    });

    expect(Object.prototype.cost).toBeUndefined();
    expect(Object.prototype.messages).toBeUndefined();
    expect(Object.prototype.inputTokens).toBeUndefined();
    const stored = (await readStoreFile()).instances['inst-peer'];
    const provs = stored.usage.dailyActivity['2026-09-10'].byProvider;
    expect(Object.hasOwn(provs, '__proto__')).toBe(false);
    expect(Object.hasOwn(provs, 'constructor')).toBe(false);
    expect(Object.hasOwn(provs, 'prototype')).toBe(false);
    expect(Object.keys(provs)).toEqual(['openai']);
    expect(Object.keys(provs.openai.byModel)).toEqual(['gpt-4']);
  });
});
