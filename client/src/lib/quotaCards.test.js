import { describe, expect, it } from 'vitest';
import { groupQuotaCards, mergeRefreshedFamily } from './quotaCards';

const reading = (overrides = {}) => ({
  family: 'grok', label: 'Grok', supported: true,
  fetchedAt: '2026-01-01T00:00:00.000Z',
  limits: [{ key: 'week', percentUsed: 20, stale: true }],
  activity: [{ period: 'week', requests: 10, sessions: 1 }],
  origin: { self: true, name: 'This instance' },
  ...overrides,
});

describe('groupQuotaCards', () => {
  it('uses the newest valid reading per window without adding activity', () => {
    const local = reading();
    const peer = reading({ fetchedAt: '2026-01-02T00:00:00.000Z',
      limits: [{ key: 'week', percentUsed: 70, stale: true }],
      activity: [{ period: 'week', requests: 10, sessions: 1 }],
      origin: { self: false, instanceId: 'peer', name: 'Peer' } });
    const [card] = groupQuotaCards([local, peer]);
    expect(card.limits).toMatchObject(peer.limits);
    expect(card.activity).toEqual(peer.activity);
    expect(card.canRefresh).toBe(true);
    expect(card.fleet.count).toBe(2);
  });

  it('keeps an older valid reading when a newer scrape failed or is pending', () => {
    const peer = reading({ origin: { self: false, instanceId: 'peer' } });
    const failed = reading({ fetchedAt: '2026-01-03T00:00:00.000Z', limits: [], error: 'Expired' });
    const [card] = groupQuotaCards([failed, peer]);
    expect(card.limits).toMatchObject(peer.limits);
    expect(card.diagnostics).toEqual([failed]);
    const [pending] = groupQuotaCards([{ ...failed, error: undefined, pending: true }, peer]);
    expect(pending.limits).toMatchObject(peer.limits);
    expect(pending.pending).toBe(true);
  });

  it('retains valid windows missing from a newer report, with their own source and age', () => {
    const older = reading({ origin: { self: false, instanceId: 'peer', name: 'Peer' } });
    const newer = reading({ fetchedAt: '2026-01-02T00:00:00.000Z',
      limits: [{ key: 'session', percentUsed: 30, stale: false }] });
    const [card] = groupQuotaCards([older, newer]);
    expect(card.limits).toMatchObject([
      { key: 'week', percentUsed: 20, stale: true, readAt: older.fetchedAt, readBy: 'peer', readByName: 'Peer' },
      { key: 'session', percentUsed: 30, stale: false, readAt: newer.fetchedAt, readBy: null },
    ]);
    expect(card.mixedReadings).toBe(true);
  });

  it('keeps peer-only providers and does not let an undated reading beat a dated one', () => {
    const old = reading({ origin: { self: false, instanceId: 'one' } });
    const unknown = reading({ fetchedAt: null, origin: { self: false, instanceId: 'two' } });
    const codex = reading({ family: 'codex', origin: { self: false, instanceId: 'three' } });
    const cards = groupQuotaCards([unknown, old, codex]);
    expect(cards.map((card) => card.family)).toEqual(['grok', 'codex']);
    expect(cards[0].origin.instanceId).toBe('one');
    expect(cards[0].canRefresh).toBe(false);
    expect(groupQuotaCards([])).toEqual([]);
  });

  it('retains separate image observations so a newer empty report cannot erase a peer block', () => {
    const blocked = reading({ family: 'imagegen', origin: { self: false, instanceId: 'peer' }, limits: [{ key: 'imagegen-grok', percentUsed: 100 }] });
    const empty = reading({ family: 'imagegen', fetchedAt: '2026-01-02T00:00:00.000Z', limits: [], metrics: [{ key: 'imagegen-grok', value: 'No renders' }] });
    const [card] = groupQuotaCards([blocked, empty]);
    expect(card.observations).toEqual([blocked, empty]);
  });

  it('does not treat a billing preference as a verified account identity', () => {
    const local = reading({ plan: 'Pro' });
    const shared = reading({ fetchedAt: '2026-01-02T00:00:00.000Z', plan: 'unknown', origin: { self: false, instanceId: 'shared', usesSubscriptions: true } });
    const other = reading({ fetchedAt: '2026-01-03T00:00:00.000Z', origin: { self: false, instanceId: 'other', usesSubscriptions: false } });
    const cards = groupQuotaCards([local, shared, other]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ plan: 'Pro', fleet: { count: 3 }, origin: { instanceId: 'other' } });
  });

  it('keeps activity-only readings while another source has an error', () => {
    const local = reading({ limits: [], activity: [], error: 'Unavailable' });
    const peer = reading({ limits: [], origin: { self: false, instanceId: 'peer' } });
    const [card] = groupQuotaCards([local, peer]);
    expect(card.activity).toEqual(peer.activity);
    expect(card.diagnostics).toEqual([local]);
  });
});

describe('mergeRefreshedFamily', () => {
  const local = reading();
  const peer = reading({ origin: { self: false, instanceId: 'peer', capturedAt: '2026-01-01T00:00:00.000Z' } });
  it('accepts a same-version expiry and removes absent peers after a successful read', () => {
    const expired = { ...peer, limits: [], error: 'Expired' };
    expect(mergeRefreshedFamily([local, peer], [local, expired], 'grok')[1]).toEqual(expired);
    expect(mergeRefreshedFamily([local, peer], [local], 'grok')).toEqual([local]);
  });

  it('does not resurrect peers removed by a newer full read or hide them on failure', () => {
    expect(mergeRefreshedFamily([local], [local, peer], 'grok', { fullReadApplied: true })).toEqual([local]);
    expect(mergeRefreshedFamily([local, peer], [local], 'grok', { federationUnavailable: true })).toEqual([local, peer]);
  });

  it('does not replace a newer full-read peer with an older response', () => {
    const newer = { ...peer, origin: { ...peer.origin, capturedAt: '2026-01-02T00:00:00.000Z' } };
    expect(mergeRefreshedFamily([local, newer], [local, peer], 'grok', { fullReadApplied: true })).toEqual([local, newer]);
  });

  it('keeps equal-version expiry monotonic across an intervening full read', () => {
    const expired = { ...peer, limits: [], error: 'Expired' };
    expect(mergeRefreshedFamily([local, peer], [local, expired], 'grok', { fullReadApplied: true })[1]).toMatchObject({ limits: [], error: 'Expired' });
    expect(mergeRefreshedFamily([local, expired], [local, peer], 'grok', { fullReadApplied: true })[1]).toMatchObject({ limits: [], error: 'Expired' });
    const twoWindows = { ...peer, limits: [{ key: 'week' }, { key: 'session' }] };
    const weeklyOnly = { ...peer, limits: [{ key: 'week' }] };
    expect(mergeRefreshedFamily([local, twoWindows], [local, weeklyOnly], 'grok', { fullReadApplied: true })[1].limits).toEqual([{ key: 'week' }]);
  });

  it('does not make the same captured window fresh again when stale status changes', () => {
    const fresh = { ...peer, limits: [{ key: 'week', stale: false }] };
    const stale = { ...peer, limits: [{ key: 'week', stale: true }] };
    expect(mergeRefreshedFamily([local, fresh], [local, stale], 'grok', { fullReadApplied: true })[1].limits[0].stale).toBe(true);
    expect(mergeRefreshedFamily([local, stale], [local, fresh], 'grok', { fullReadApplied: true })[1].limits[0].stale).toBe(true);
  });
});
