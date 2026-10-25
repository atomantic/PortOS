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
// importActual so UNKNOWN_INSTANCE_ID stays the REAL sentinel — a hand-written
// copy here would let the real one drift and silently stop being filtered.
vi.mock('./instanceIdentity.js', async () => ({
  ...(await vi.importActual('./instanceIdentity.js')),
  getSelf: vi.fn(async () => self),
}));

let localUsage;
vi.mock('./usage.js', async () => {
  const actual = await vi.importActual('./usage.js');
  return { ...actual, getUsage: () => localUsage };
});

const { buildUsageDigest, buildUsageReport } = await import('./usage.js');
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
  await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: {}, updatedAt: null });
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
});

describe('fleet rolling 30-day cost', () => {
  const dayCost = (usage, day) => buildUsageReport({ [day]: usage.dailyActivity[day] }, { providers: [] }).totals.estimatedCost;

  // Every instance counts — including one marked API-billed, whose spend at API
  // rates is exactly what this chart totals — and a day leaves the window 30
  // days later.
  it('sums every instance over a trailing 30-day window', async () => {
    const peer = peerEntry();
    await applyUsageRemote({ instances: { 'inst-peer': peer } });
    const both = dayCost(localUsage, '2026-08-30') + dayCost(peer.usage, '2026-08-30');
    expect(both).toBeGreaterThan(0);

    const series = await getFleetRollingCost({ providers: [], now: new Date('2026-09-28T12:00:00Z') });
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

    const later = await getFleetRollingCost({ providers: [], now: new Date('2026-09-29T00:00:00Z') });
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
    const monthCost = buildUsageReport({}, { monthlyActivity: rolledUp.usage.monthlyActivity, providers: [] }).totals.estimatedCost;
    expect(monthCost).toBeGreaterThan(0);

    const series = await getFleetRollingCost({ providers: [], range: 'all', now: new Date('2026-09-01T00:00:00Z') });
    const at = (date) => series.points.find((p) => p.date === date).cost;
    expect(series.range).toBe('all');
    expect(series.points[0].date).toBe('2026-03-01');
    // 31 March days share the month; the window ending Mar 30 holds 30 of them.
    expect(at('2026-03-30')).toBeCloseTo((monthCost * 30) / 31, 1);
    expect(at('2026-08-30')).toBeCloseTo(dayCost(localUsage, '2026-08-30'), 2);

    const year = await getFleetRollingCost({ providers: [], range: '1y', now: new Date('2026-09-01T00:00:00Z') });
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
    const series = await getFleetRollingCost({ providers: [], now: new Date('2026-09-01T00:00:00Z') });
    expect(series.series).toEqual([{ key: 'claude', label: 'Claude Code' }]);
    expect(series.points.at(-1).values).toEqual([series.points.at(-1).cost]);
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

    const series = await getFleetRollingCost({ providers: [], now: new Date('2026-09-01T00:00:00Z') });
    expect(series.series).toEqual([{ key: 'claude', label: 'Claude Code' }]);
    expect(series.points.at(-1).cost).toBeCloseTo(dayTranscript('2026-08-30') + dayTranscript('2026-08-29'), 1);

    // A day where the ledger already holds more keeps the ledger's figure.
    await atomicWrite(TRANSCRIPT_USAGE_FILE, { days: { '2026-08-30': { 'claude-opus-5': { messages: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }, updatedAt: '2026-08-31T01:00:00.000Z' });
    const lower = await getFleetRollingCost({ providers: [], now: new Date('2026-09-01T00:00:00Z') });
    expect(lower.points.at(-1).cost).toBeCloseTo(ledger, 2);
  });

  it('charts this machine alone before any peer has synced', async () => {
    const series = await getFleetRollingCost({ providers: [], now: new Date('2026-09-01T00:00:00Z') });
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
    const monthly = await getFleetMonthlyUsage({ now });
    const rolling = await getFleetRollingCost({ now });
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
    const monthly = await getFleetMonthlyUsage({ now: new Date('2025-06-30T23:59:59Z') });
    expect(monthly.history).toEqual([
      { month: '2025-04', estimatedCost: 33, values: [33], tokens: 3000000, partial: false },
      { month: '2025-05', estimatedCost: 0, values: [0], tokens: 0, partial: false },
      { month: '2025-06', estimatedCost: 0, values: [0], tokens: 100, partial: true },
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
    const monthly = await getFleetMonthlyUsage({ now: new Date('2026-09-30T00:00:00Z'), providers: [{ id: 'ollama', type: 'ollama' }] });
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

  it('re-records only what changed, so a repeated read is not a new slot to pull', async () => {
    expect((await recordLocalQuotaCards([quotaCard()])).changed).toBe(true);
    // Same reading, later clock: the claim is unchanged, so the file is not.
    expect((await recordLocalQuotaCards([quotaCard({ fetchedAt: '2026-08-31T01:00:00.000Z' })])).changed).toBe(false);
    expect((await recordLocalQuotaCards([quotaCard({ limits: [] })])).changed).toBe(true);
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

  it('keeps an API-billed instance listed but out of the combined figures, and tolerates a peer with no history', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': { ...peerEntry(), claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: days(3_000_000) } }, 'inst-old': peerEntry() } });
    const fleet = await getFleetClaudeCodeModels({ apiBilledInstanceIds: ['inst-peer'] });
    expect(fleet.instances).toEqual([expect.objectContaining({ instanceId: 'inst-peer', usesSubscriptions: false })]);
    expect(fleet.totals.total).toBe(0);
  });

  it('rebuilds a hostile peer history to the fixed shape', async () => {
    await applyUsageRemote({ instances: { 'inst-peer': { ...peerEntry(), claudeCode: { updatedAt: '2026-09-21T00:00:00.000Z', days: { '2026-09-10': { m: { messages: 1, evil: 5 } }, junk: {} } } } } });
    expect((await readStoreFile()).instances['inst-peer'].claudeCode.days).toEqual({ '2026-09-10': { m: { messages: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } });
  });
});
