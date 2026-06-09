import { describe, it, expect } from 'vitest';
import { diffSeq, directionalCounts, describeDirectional } from './syncCounts.js';

describe('diffSeq', () => {
  it('subtracts numeric seqs', () => {
    expect(diffSeq(54, 10)).toBe(44);
  });

  it('subtracts numeric-string (BIGSERIAL) seqs', () => {
    expect(diffSeq('81', '5')).toBe(76);
  });

  it('clamps a negative difference to 0 (peer ahead of our reported max)', () => {
    expect(diffSeq(5, 10)).toBe(0);
  });

  it('returns 0 when equal', () => {
    expect(diffSeq(42, 42)).toBe(0);
  });

  it('stays exact past Number.MAX_SAFE_INTEGER', () => {
    const big = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    const lo = '9007199254740990';
    expect(diffSeq(big, lo)).toBe(3);
  });

  it('caps a delta beyond MAX_SAFE_INTEGER instead of returning a lossy value', () => {
    // ahead is 2^53 + 100 over behind=0 → delta exceeds the safe range.
    const huge = (BigInt(Number.MAX_SAFE_INTEGER) + 100n).toString();
    expect(diffSeq(huge, '0')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('returns null when either side is absent', () => {
    expect(diffSeq(undefined, 5)).toBeNull();
    expect(diffSeq(5, null)).toBeNull();
    expect(diffSeq(null, null)).toBeNull();
  });

  it('returns null for non-numeric strings rather than collapsing to 0', () => {
    expect(diffSeq('abc', 5)).toBeNull();
    expect(diffSeq(5, '')).toBeNull();
  });

  it('rejects negative numeric inputs as invalid', () => {
    expect(diffSeq(-1, 0)).toBeNull();
  });
});

describe('directionalCounts', () => {
  it('computes both directions from seqs', () => {
    expect(directionalCounts({ localMax: 100, peerMax: 54, ourCursor: 54, peerCursorForUs: 88 }))
      .toEqual({ toPull: 0, toPush: 12 });
  });

  it('treats an absent ourCursor as 0 pulled (pull defaults, not unknown)', () => {
    expect(directionalCounts({ localMax: 10, peerMax: 54, ourCursor: undefined, peerCursorForUs: 10 }))
      .toEqual({ toPull: 54, toPush: 0 });
  });

  it('treats an absent peerCursorForUs as unknown push (null, not 0)', () => {
    expect(directionalCounts({ localMax: 100, peerMax: 54, ourCursor: 54, peerCursorForUs: undefined }))
      .toEqual({ toPull: 0, toPush: null });
  });

  it('treats an absent peerMax as unknown pull (null)', () => {
    expect(directionalCounts({ localMax: 100, peerMax: undefined, ourCursor: 0, peerCursorForUs: 100 }))
      .toEqual({ toPull: null, toPush: 0 });
  });
});

describe('describeDirectional', () => {
  it('reports "in sync" when both directions are known-zero', () => {
    expect(describeDirectional({ toPull: 0, toPush: 0 })).toEqual({ state: 'synced', text: 'in sync' });
  });

  it('reports both pending directions in plain language', () => {
    expect(describeDirectional({ toPull: 3, toPush: 12 }))
      .toEqual({ state: 'behind', text: '3 to pull · 12 to push' });
  });

  it('reports a single direction when the other is zero', () => {
    expect(describeDirectional({ toPull: 0, toPush: 7 }))
      .toEqual({ state: 'behind', text: '7 to push' });
    expect(describeDirectional({ toPull: 5, toPush: 0 }))
      .toEqual({ state: 'behind', text: '5 to pull' });
  });

  it('does not claim "in sync" when push is unknown but pull is zero', () => {
    expect(describeDirectional({ toPull: 0, toPush: null }))
      .toEqual({ state: 'pending', text: 'checking…' });
  });

  it('reports the known direction even when the other is unknown', () => {
    expect(describeDirectional({ toPull: 9, toPush: null }))
      .toEqual({ state: 'behind', text: '9 to pull' });
  });

  it('shows "checking…" when both directions are unknown', () => {
    expect(describeDirectional({ toPull: null, toPush: null }))
      .toEqual({ state: 'pending', text: 'checking…' });
  });
});
