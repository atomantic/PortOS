import { describe, expect, it } from 'vitest';
import { expireQuotaWindows, groupQuotaCards, mergeRefreshedFamily } from './quotaCards';

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
  });

  it('keeps an older valid reading when a newer scrape failed or is pending', () => {
    const peer = reading({ origin: { self: false, instanceId: 'peer' } });
    const failed = reading({ fetchedAt: '2026-01-03T00:00:00.000Z', limits: [], error: 'Expired' });
    const [card] = groupQuotaCards([failed, peer]);
    expect(card.limits).toMatchObject(peer.limits);
    expect(card.providerIssue).toEqual(failed);
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

  it('retains one observed image refusal when a newer report is empty', () => {
    const blocked = reading({ family: 'imagegen', origin: { self: false, instanceId: 'peer' }, limits: [{ key: 'imagegen-grok', percentUsed: 100 }] });
    const laterBlocked = { ...blocked, fetchedAt: '2026-01-01T12:00:00.000Z', origin: { self: false, instanceId: 'peer-two' } };
    const empty = reading({ family: 'imagegen', fetchedAt: '2026-01-02T00:00:00.000Z', limits: [], metrics: [{ key: 'imagegen-grok', value: 'No renders' }] });
    const [card] = groupQuotaCards([laterBlocked, empty, blocked]);
    expect(card.imageRefusals).toEqual([['imagegen-grok', { label: undefined, fetchedAt: laterBlocked.fetchedAt }]]);
  });

  it('does not treat a billing preference as a verified account identity', () => {
    const local = reading({ plan: 'Pro' });
    const shared = reading({ fetchedAt: '2026-01-02T00:00:00.000Z', plan: 'unknown', origin: { self: false, instanceId: 'shared', usesSubscriptions: true } });
    const other = reading({ fetchedAt: '2026-01-03T00:00:00.000Z', origin: { self: false, instanceId: 'other', usesSubscriptions: false } });
    const cards = groupQuotaCards([local, shared, other]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ plan: 'Pro', origin: { instanceId: 'other' } });
  });

  it('keeps activity-only readings while another source has an error', () => {
    const local = reading({ limits: [], activity: [], error: 'Unavailable' });
    const peer = reading({ limits: [], origin: { self: false, instanceId: 'peer' } });
    const [card] = groupQuotaCards([local, peer]);
    expect(card.activity).toEqual(peer.activity);
    expect(card.providerIssue).toEqual(local);
  });

  it('suppresses a superseded expired reading and retains a provider-level expired state', () => {
    const current = reading({ fetchedAt: '2026-01-03T00:00:00.000Z' });
    const expired = reading({ limits: [], activity: [], quotaStatus: 'expired', error: 'Old window reset',
      origin: { self: false, instanceId: 'old', name: 'synthetic-offline-peer' } });
    const [live] = groupQuotaCards([current, expired]);
    expect(live.limits).toHaveLength(1);
    expect(live.providerIssue).toBeNull();
    expect(live.error).toBeUndefined();
    const [empty] = groupQuotaCards([{ ...current, limits: [] }, expired]);
    expect(empty.error).toMatch(/expired/i);
  });

  it('keeps a newer provider failure but drops an older one', () => {
    const current = reading({ fetchedAt: '2026-01-02T00:00:00.000Z' });
    const failure = reading({ limits: [], activity: [], error: 'Weekly limit reached', quotaStatus: 'limit_reached', quotaScope: 'week', fetchedAt: '2026-01-03T00:00:00.000Z' });
    expect(groupQuotaCards([current, failure])[0].providerIssue).toEqual(failure);
    expect(groupQuotaCards([current, { ...failure, fetchedAt: '2026-01-01T00:00:00.000Z' }])[0].providerIssue).toBeNull();
  });

  it('does not let a newer session window hide a weekly limit condition', () => {
    const weekly = reading({ fetchedAt: '2026-01-01T09:00:00.000Z' });
    const session = reading({ fetchedAt: '2026-01-01T11:00:00.000Z', limits: [{ key: 'session', percentUsed: 10 }] });
    const reached = reading({ fetchedAt: '2026-01-01T10:00:00.000Z', limits: [], activity: [],
      error: 'Weekly limit reached', quotaStatus: 'limit_reached', quotaScope: 'week' });
    expect(groupQuotaCards([weekly, session, reached])[0].providerIssue).toEqual(reached);
  });
});

describe('mergeRefreshedFamily', () => {
  const local = reading();
  const peer = reading({ origin: { self: false, instanceId: 'peer', capturedAt: '2026-01-01T00:00:00.000Z' } });
  it('preserves a newer local result even when federation was unavailable', () => {
    const older = reading({ fetchedAt: '2026-01-01T00:00:00.000Z', limits: [{ key: 'week', percentUsed: 40 }] });
    const newer = reading({ fetchedAt: '2026-01-02T00:00:00.000Z', limits: [{ key: 'week', percentUsed: 80 }] });
    expect(mergeRefreshedFamily([newer], [older], 'grok', { localFullReadApplied: true, federationUnavailable: true })[0].limits)
      .toEqual(newer.limits);
  });

  it('does not revive an expired or disabled local provider', () => {
    const expired = reading({ fetchedAt: '2026-01-02T00:00:00.000Z', limits: [], activity: [],
      error: 'Window reset', quotaStatus: 'expired' });
    const disabled = reading({ supported: false, limits: [], activity: [], note: 'Provider disabled' });
    expect(mergeRefreshedFamily([local], [expired], 'grok')[0]).toEqual(expired);
    const undated = { ...expired, fetchedAt: null };
    expect(mergeRefreshedFamily([local], [undated], 'grok')[0]).toEqual(undated);
    const activityOnly = reading({ fetchedAt: '2026-01-03T00:00:00.000Z', limits: [] });
    expect(mergeRefreshedFamily([activityOnly], [expired], 'grok')[0]).toEqual(expired);
    expect(mergeRefreshedFamily([local], [disabled], 'grok', { localFullReadApplied: true })[0]).toEqual(disabled);
  });

  it('retains only unexpired windows after an error', () => {
    const now = Date.now();
    const previous = reading({ limits: [
      { key: 'session', percentUsed: 20, resetsAt: new Date(now - 1000).toISOString() },
      { key: 'week', percentUsed: 80, resetsAt: new Date(now + 60_000).toISOString() },
    ] });
    const failed = reading({ limits: [], activity: [], error: 'Scrape failed' });
    expect(mergeRefreshedFamily([previous], [failed], 'grok')[0].limits).toEqual([previous.limits[1]]);
  });

  it('retains only windows known to still be live after a newer expiry report', () => {
    const previous = reading({ limits: [
      { key: 'session', percentUsed: 20 },
      { key: 'week', percentUsed: 80, resetsAt: new Date(Date.now() + 60_000).toISOString() },
    ] });
    const expired = reading({ fetchedAt: '2026-01-02T00:00:00.000Z', limits: [], activity: [],
      error: 'Window reset', quotaStatus: 'expired' });
    expect(mergeRefreshedFamily([previous], [expired], 'grok')[0].limits).toEqual([previous.limits[1]]);
  });

  it('leaves unknown resets intact while pruning another expired window', () => {
    const now = Date.now();
    const previous = reading({ limits: [
      { key: 'unknown', percentUsed: 20 },
      { key: 'expired', percentUsed: 80, resetsAt: new Date(now - 1000).toISOString() },
    ] });
    expect(expireQuotaWindows([previous], now)[0].limits).toEqual([previous.limits[0]]);
  });

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
    const expired = { ...peer, limits: [], error: 'Expired', quotaStatus: 'expired' };
    expect(mergeRefreshedFamily([local, peer], [local, expired], 'grok', { fullReadApplied: true })[1]).toMatchObject({ limits: [], error: 'Expired', quotaStatus: 'expired' });
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
