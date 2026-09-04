import { describe, it, expect } from 'vitest';
import { sanitizeQuotaCards, mergeFleetQuotaCards, mergeQuotaCard, latestFetchedAt } from './fleetQuotas.js';

const limit = (key, percentUsed, extra = {}) => ({
  key, label: key, percentUsed, percentRemaining: 100 - percentUsed, resetsAt: null, timezone: null, ...extra,
});

const localCard = (over = {}) => ({
  family: 'claude',
  label: 'Claude Code',
  supported: true,
  plan: 'subscription',
  limits: [limit('session', 20)],
  activity: [{ period: 'Last 24h', requests: 100, sessions: 4, notes: ['note'] }],
  approximate: true,
  fetchedAt: '2026-09-03T10:00:00.000Z',
  note: 'This machine only — other federated instances have not reported a reading yet.',
  ...over,
});

const peerEntry = (over = {}) => ({
  instanceId: 'peer-1',
  name: 'Example Box',
  capturedAt: '2026-09-03T11:00:00.000Z',
  quotas: [{
    family: 'claude',
    label: 'Claude Code',
    plan: 'subscription',
    limits: [limit('session', 65)],
    activity: [{ period: 'Last 24h', requests: 20, sessions: 1, notes: [] }],
    fetchedAt: '2026-09-03T11:00:00.000Z',
  }],
  ...over,
});

describe('sanitizeQuotaCards', () => {
  it('rebuilds a peer payload to the wire shape and drops what cannot be merged', () => {
    const [card] = sanitizeQuotaCards([
      { family: 'claude', label: 'Claude', limits: [{ key: 'week', percentUsed: 140, label: 'Week' }, { percentUsed: 5 }], activity: [{ requests: 3 }], fetchedAt: '2026-09-03T10:00:00.000Z', raw: 'secret transcript' },
      { label: 'no family', limits: [limit('week', 1)] },
      { family: 'empty', limits: [], activity: [] },
    ]);
    expect(sanitizeQuotaCards([]).length).toBe(0);
    // Only the first card survives: no family / nothing to contribute are dropped.
    expect(card.family).toBe('claude');
    expect(Object.hasOwn(card, 'raw')).toBe(false);
    // A keyless limit has nothing to merge on; a percentage is clamped.
    expect(card.limits).toEqual([{ key: 'week', label: 'Week', percentUsed: 100, percentRemaining: 0, resetsAt: null, timezone: null }]);
    // An activity entry with no period can't be summed against anything.
    expect(card.activity).toEqual([]);
  });

  it('ignores a non-array payload', () => {
    expect(sanitizeQuotaCards({ family: 'claude' })).toEqual([]);
  });
});

describe('latestFetchedAt', () => {
  it('returns the newest parseable stamp, or null', () => {
    expect(latestFetchedAt([{ fetchedAt: '2026-09-01T00:00:00.000Z' }, { fetchedAt: '2026-09-02T00:00:00.000Z' }, { fetchedAt: 'nope' }]))
      .toBe('2026-09-02T00:00:00.000Z');
    expect(latestFetchedAt([{ fetchedAt: 'nope' }])).toBeNull();
    expect(latestFetchedAt(null)).toBeNull();
  });
});

describe('mergeQuotaCard', () => {
  it('leaves a single-instance card untouched, caption included', () => {
    const card = localCard();
    expect(mergeQuotaCard(card, [])).toBe(card);
    // A peer with nothing to contribute is not a contributor.
    expect(mergeQuotaCard(card, [{ instanceId: 'p', name: 'p', limits: [], activity: [] }])).toBe(card);
  });

  it('takes the freshest meter and sums the activity across instances', () => {
    const merged = mergeFleetQuotaCards([localCard()], [peerEntry()])[0];
    // Meters are account-wide: the newest reading wins rather than 20 + 65.
    expect(merged.limits).toEqual([expect.objectContaining({ key: 'session', percentUsed: 65, readBy: 'peer-1', readByName: 'Example Box' })]);
    // Activity is per-machine, so it adds up.
    expect(merged.activity).toEqual([{ period: 'Last 24h', requests: 120, sessions: 5, notes: ['note'] }]);
    expect(merged.note).toBe('Across 2 federated instances (this machine, Example Box) — meters show the freshest reading, activity is summed.');
    expect(merged.fleet).toEqual({
      count: 2,
      instances: [
        { instanceId: null, name: null, self: true, fetchedAt: '2026-09-03T10:00:00.000Z' },
        { instanceId: 'peer-1', name: 'Example Box', self: false, fetchedAt: '2026-09-03T11:00:00.000Z' },
      ],
    });
  });

  it('keeps the local reading on a tie and appends a window only a peer reported', () => {
    const peer = peerEntry({ quotas: [{ ...peerEntry().quotas[0], limits: [limit('session', 65), limit('week', 80)], fetchedAt: '2026-09-03T10:00:00.000Z' }] });
    const merged = mergeFleetQuotaCards([localCard()], [peer])[0];
    expect(merged.limits.map((l) => [l.key, l.percentUsed])).toEqual([['session', 20], ['week', 80]]);
  });

  it('fills a card this machine could not read from a peer that could', () => {
    const merged = mergeFleetQuotaCards(
      [localCard({ limits: [], activity: [], pending: true, error: null, note: 'Reading the Claude Code /usage panel…' })],
      [peerEntry()],
    )[0];
    expect(merged.pending).toBe(false);
    expect(merged.limits).toEqual([expect.objectContaining({ key: 'session', percentUsed: 65 })]);
  });

  it('leaves a still-unreadable card reporting its own failure', () => {
    const merged = mergeFleetQuotaCards(
      [localCard({ limits: [], activity: [], error: 'No quota data found.' })],
      [peerEntry({ quotas: [{ family: 'claude', limits: [], activity: [{ period: 'Last 24h', requests: 5, sessions: 1, notes: [] }], fetchedAt: '2026-09-03T11:00:00.000Z' }] })],
    )[0];
    expect(merged.error).toBe('No quota data found.');
    expect(merged.note).toBe('Across 2 federated instances (this machine, Example Box) — meters show the freshest reading, activity is summed.');
  });

  it('never invents a card for a family this install has not enabled', () => {
    const cards = mergeFleetQuotaCards([localCard()], [peerEntry({ quotas: [{ ...peerEntry().quotas[0], family: 'grok' }] })]);
    expect(cards.map((c) => c.family)).toEqual(['claude']);
    expect(cards[0].fleet).toBeUndefined();
  });

  it('says only what it combined when no instance reported activity', () => {
    const noActivity = (card) => ({ ...card, activity: [] });
    const merged = mergeFleetQuotaCards(
      [noActivity(localCard())],
      [peerEntry({ quotas: [noActivity(peerEntry().quotas[0])] })],
    )[0];
    expect(merged.note).toBe('Across 2 federated instances (this machine, Example Box) — meters show the freshest reading across them.');
  });

  it('collapses the name list past three instances', () => {
    const peers = ['a', 'b', 'c', 'd'].map((id) => peerEntry({ instanceId: id, name: id.toUpperCase() }));
    expect(mergeFleetQuotaCards([localCard()], peers)[0].note)
      .toBe('Across 5 federated instances (this machine, A, B +2 more) — meters show the freshest reading, activity is summed.');
  });
});
