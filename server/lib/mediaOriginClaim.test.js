import { describe, it, expect } from 'vitest';
import { earliestHolderOrigin, ORIGIN_CLAIM_SKEW_MS } from './mediaOriginClaim.js';

const T = 1_700_000_000_000;
const DAY = 86_400_000;
const peer = (peerId, mtimeMs, mayDelete = true) => ({ peerId, mtimeMs, mayDelete });

describe('earliestHolderOrigin', () => {
  it('names this machine when its file is strictly the earliest', () => {
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [peer('a', T + DAY), peer('b', T + 2 * DAY)] })).toBe('me');
  });

  it('names a peer that wrote its bytes first, only when it may delete media here', () => {
    const holders = [peer('a', T - DAY), peer('b', T + DAY)];
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders })).toBe('a');
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [peer('a', T - DAY, false), peer('b', T + DAY)] })).toBeNull();
  });

  it('fails closed on a tie, a gap within clock skew, no holder, or an unusable time', () => {
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [peer('a', T)] })).toBeNull();
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [peer('a', T + ORIGIN_CLAIM_SKEW_MS)] })).toBeNull();
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [] })).toBeNull();
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: T, holders: [peer('a', T + DAY), peer('b', undefined)] })).toBeNull();
    expect(earliestHolderOrigin({ localId: 'me', localMtimeMs: 0, holders: [peer('a', T + DAY)] })).toBeNull();
  });
});
