import { describe, it, expect } from 'vitest';
import { authorizeRemoteVideoTombstone, TOMBSTONE_FUTURE_SKEW_MS } from './videoTombstoneAuthorization.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const OWNER = { id: 'rec-owner', instanceId: 'peer-o', enabled: true, syncSecret: 's'.repeat(40) };
const ROW = { id: 'v1', filename: 'v1.mp4', originInstanceId: 'peer-o' };
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const check = (deletedAt, extra = {}) => authorizeRemoteVideoTombstone({
  peer: OWNER, tombstone: { key: 'v1', deletedAt }, localRow: ROW, hostedIndex: {}, via: 'snapshot', nowMs: NOW, ...extra,
});

describe('authorizeRemoteVideoTombstone deletedAt bounds', () => {
  it('accepts clock skew up to the limit and refuses anything later', () => {
    expect(check(at(4 * 60 * 1000)).allowed).toBe(true);
    expect(check(at(TOMBSTONE_FUTURE_SKEW_MS)).allowed).toBe(true);
    expect(check(at(TOMBSTONE_FUTURE_SKEW_MS + 1000))).toEqual({ allowed: false, reason: 'future-or-invalid-deletedAt' });
  });

  it('refuses an unparseable deletedAt', () => {
    expect(check('not a time')).toEqual({ allowed: false, reason: 'future-or-invalid-deletedAt' });
    expect(check(undefined).allowed).toBe(false);
  });
});
