import { describe, it, expect, vi } from 'vitest';

// Sharing.jsx pulls in socket.io-client at module scope (auto-connects).
// Stub it so the test runner doesn't try to open a network socket.
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../services/api', () => ({
  listShareBuckets: vi.fn(),
  createShareBucket: vi.fn(),
  updateShareBucket: vi.fn(),
  deleteShareBucket: vi.fn(),
  listShareInbox: vi.fn(),
  promoteShareInboxItem: vi.fn(),
  dismissShareInboxItem: vi.fn(),
  listShareActivity: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));

import { isLiveSubscription } from './Sharing';

const NOW = Date.parse('2026-05-18T12:00:00Z');

describe('isLiveSubscription', () => {
  it('returns true for a subscription row received within the live window', () => {
    const item = {
      subscription: { recordKind: 'universe', recordId: 'u-1' },
      receivedAt: '2026-05-18T11:57:00Z', // 3 min ago
    };
    expect(isLiveSubscription(item, NOW)).toBe(true);
  });

  it('returns false for a subscription row received outside the live window', () => {
    const item = {
      subscription: { recordKind: 'universe', recordId: 'u-1' },
      receivedAt: '2026-05-18T11:50:00Z', // 10 min ago
    };
    expect(isLiveSubscription(item, NOW)).toBe(false);
  });

  it('returns false for a one-shot share (no subscription field) even if recent', () => {
    const item = { subscription: null, receivedAt: '2026-05-18T11:59:30Z' };
    expect(isLiveSubscription(item, NOW)).toBe(false);
  });

  it('returns false when receivedAt is missing or unparseable', () => {
    const subscription = { recordKind: 'universe', recordId: 'u-1' };
    expect(isLiveSubscription({ subscription }, NOW)).toBe(false);
    expect(isLiveSubscription({ subscription, receivedAt: '' }, NOW)).toBe(false);
    expect(isLiveSubscription({ subscription, receivedAt: 'not-a-date' }, NOW)).toBe(false);
  });

  it('returns false for null / non-object inputs without throwing', () => {
    expect(isLiveSubscription(null, NOW)).toBe(false);
    expect(isLiveSubscription(undefined, NOW)).toBe(false);
  });
});
