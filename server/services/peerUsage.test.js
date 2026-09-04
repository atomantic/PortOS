import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readFile } from 'fs/promises';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-peer-usage-' });
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// peerUsage resolves this machine's identity through a dynamic import of
// instances.js (kept off dataSync's module graph); the digest itself is
// whatever usage.js currently holds.
const self = { instanceId: 'inst-self', name: 'Workshop' };
// importActual so UNKNOWN_INSTANCE_ID stays the REAL sentinel — a hand-written
// copy here would let the real one drift and silently stop being filtered.
vi.mock('./instances.js', async () => ({
  ...(await vi.importActual('./instances.js')),
  getSelf: vi.fn(async () => self),
}));

let localUsage;
vi.mock('./usage.js', async () => {
  const actual = await vi.importActual('./usage.js');
  return { ...actual, getUsage: () => localUsage };
});

const { buildUsageDigest, getUsage } = await import('./usage.js');
const {
  getUsageSnapshot,
  getUsageManifest,
  applyUsageRemote,
  getFleetUsage,
  getFleetQuotaEntries,
  forgetInstanceUsage,
  PEER_USAGE_FILE,
} = await import('./peerUsage.js');
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

const peerEntry = (overrides = {}) => ({
  instanceId: 'inst-peer',
  name: 'Studio',
  capturedAt: '2026-08-30T09:00:00.000Z',
  usage: buildUsageDigest(usageFixture({ tokensOut: 4000 })),
  ...overrides,
});

const readStoreFile = async () => JSON.parse(await readFile(PEER_USAGE_FILE, 'utf8'));

beforeEach(async () => {
  localUsage = usageFixture();
  // Reset the stores between cases — every test starts with no peer digests
  // and no quota readings of our own.
  const { atomicWrite } = await import('../lib/fileUtils.js');
  await atomicWrite(PEER_USAGE_FILE, { instances: {} });
  await atomicWrite(PROVIDER_QUOTAS_FILE, { quotas: [] });
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
    expect(data.instances['inst-self'].capturedAt).toBe('2026-08-30T12:00:00.000Z');
  });

  it('keeps the checksum stable while local usage has not moved', async () => {
    const a = await getUsageSnapshot();
    const b = await getUsageSnapshot();
    expect(b.checksum).toBe(a.checksum);
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
      'inst-self': '2026-08-30T12:00:00.000Z',
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

  it('lets a machine that comes back supersede its own tombstone', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    await forgetInstanceUsage('inst-peer');

    const returned = peerEntry({ capturedAt: '2099-01-01T00:00:00.000Z' });
    expect(await applyUsageRemote({ instances: { 'inst-peer': returned } })).toEqual({ applied: true, count: 1 });
    expect((await readStoreFile()).instances['inst-peer']).toBeTruthy();
  });
});

describe('fleet report', () => {
  it('is empty until a peer digest has synced', async () => {
    expect(await getFleetUsage({ providers: [] })).toEqual({ instances: [], totals: null });
  });

  it('reports one row per instance plus the combined totals', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const fleet = await getFleetUsage({ providers: [] });

    expect(fleet.instances.map((i) => i.instanceId)).toEqual(['inst-self', 'inst-peer']);
    expect(fleet.instances[0].self).toBe(true);
    expect(fleet.instances[1].capturedAt).toBe('2026-08-30T09:00:00.000Z');
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

    // A window that covers the whole month still reports it.
    const whole = await getFleetUsage({ from: '2026-05-01', to: '2026-05-31', providers: [] });
    expect(whole.totals.tokensOut).toBe(7000);
  });

  it('scopes every instance to the same report window', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': peerEntry() } });
    const outside = await getFleetUsage({ from: '2026-09-01', to: '2026-09-30', providers: [] });
    expect(outside.totals.tokensOut).toBe(0);
  });
});

describe('federated subscription-quota readings', () => {
  it('publishes this machine\'s readings and advances the LWW stamp past them', async () => {
    await recordLocalQuotaCards([quotaCard()]);
    const { data } = await getUsageSnapshot();
    const self = data.instances['inst-self'];
    expect(self.quotas).toEqual([expect.objectContaining({ family: 'claude', plan: 'subscription' })]);
    // A quota refresh with no new AI runs must still move the slot, or no peer
    // would ever pull it: `capturedAt` is both the LWW stamp and the manifest.
    expect(self.capturedAt).toBe('2026-08-31T00:00:00.000Z');
  });

  it('re-records only what changed, so a repeated read is not a new slot to pull', async () => {
    expect((await recordLocalQuotaCards([quotaCard()])).changed).toBe(true);
    // Same reading, later clock: the claim is unchanged, so the file is not.
    expect((await recordLocalQuotaCards([quotaCard({ fetchedAt: '2026-08-31T01:00:00.000Z' })])).changed).toBe(false);
    expect((await recordLocalQuotaCards([quotaCard({ limits: [] })])).changed).toBe(true);
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
