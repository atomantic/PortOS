import { describe, it, expect, beforeEach } from 'vitest';
import {
  claimPendingSheetSlot,
  getPendingSheetSlot,
  releasePendingSheetSlot,
  clearPendingSheetSlot,
  clearPendingSheetSlotsForUniverse,
  __testing,
} from './universeCharacterSheetSlot.js';

beforeEach(() => __testing.reset());

describe('universeCharacterSheetSlot — claim / get / release', () => {
  it('claim sets the slot; get reads it back', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-1');
  });

  it('claim overwrites the previous jobId for the same (universe, character)', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    claimPendingSheetSlot('u-a', 'char-1', 'job-2');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-2');
  });

  it('releasePendingSheetSlot only deletes when the jobId matches (no-op otherwise)', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    releasePendingSheetSlot('u-a', 'char-1', 'job-other');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-1');
    releasePendingSheetSlot('u-a', 'char-1', 'job-1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBeUndefined();
  });

  it('different (universe, character) pairs are independent', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-a1');
    claimPendingSheetSlot('u-a', 'char-2', 'job-a2');
    claimPendingSheetSlot('u-b', 'char-1', 'job-b1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-a1');
    expect(getPendingSheetSlot('u-a', 'char-2')).toBe('job-a2');
    expect(getPendingSheetSlot('u-b', 'char-1')).toBe('job-b1');
  });
});

describe('universeCharacterSheetSlot — clearPendingSheetSlot (per-character)', () => {
  it('drops the slot unconditionally even if a newer jobId is present', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-2'); // simulate the newest claim
    clearPendingSheetSlot('u-a', 'char-1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBeUndefined();
  });

  it('does not affect slots for other characters in the same universe', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    claimPendingSheetSlot('u-a', 'char-2', 'job-2');
    clearPendingSheetSlot('u-a', 'char-1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBeUndefined();
    expect(getPendingSheetSlot('u-a', 'char-2')).toBe('job-2');
  });

  it('is a no-op when the slot is already empty', () => {
    expect(clearPendingSheetSlot('u-a', 'never-claimed')).toBe(false);
  });

  it('clears every variant for the character (deleting a character should drop both sheet renders)', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-std', 'standard');
    claimPendingSheetSlot('u-a', 'char-1', 'job-bp', 'blueprint');
    clearPendingSheetSlot('u-a', 'char-1');
    expect(getPendingSheetSlot('u-a', 'char-1', 'standard')).toBeUndefined();
    expect(getPendingSheetSlot('u-a', 'char-1', 'blueprint')).toBeUndefined();
  });
});

describe('universeCharacterSheetSlot — variant isolation', () => {
  it('different variants on the same character are independent slots', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-std', 'standard');
    claimPendingSheetSlot('u-a', 'char-1', 'job-bp', 'blueprint');
    expect(getPendingSheetSlot('u-a', 'char-1', 'standard')).toBe('job-std');
    expect(getPendingSheetSlot('u-a', 'char-1', 'blueprint')).toBe('job-bp');
  });

  it('releasing one variant does not touch the other', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-std', 'standard');
    claimPendingSheetSlot('u-a', 'char-1', 'job-bp', 'blueprint');
    releasePendingSheetSlot('u-a', 'char-1', 'job-std', 'standard');
    expect(getPendingSheetSlot('u-a', 'char-1', 'standard')).toBeUndefined();
    expect(getPendingSheetSlot('u-a', 'char-1', 'blueprint')).toBe('job-bp');
  });

  it('variant defaults to standard for back-compat with single-variant callers', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-1');
    expect(getPendingSheetSlot('u-a', 'char-1', 'standard')).toBe('job-1');
    expect(getPendingSheetSlot('u-a', 'char-1', 'blueprint')).toBeUndefined();
  });
});

describe('universeCharacterSheetSlot — clearPendingSheetSlotsForUniverse', () => {
  it('drops every slot whose key is prefixed by the universe id', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-a1');
    claimPendingSheetSlot('u-a', 'char-2', 'job-a2');
    claimPendingSheetSlot('u-b', 'char-1', 'job-b1');
    const cleared = clearPendingSheetSlotsForUniverse('u-a');
    expect(cleared).toBe(2);
    expect(getPendingSheetSlot('u-a', 'char-1')).toBeUndefined();
    expect(getPendingSheetSlot('u-a', 'char-2')).toBeUndefined();
    expect(getPendingSheetSlot('u-b', 'char-1')).toBe('job-b1');
  });

  it('does NOT match a universe id that is a prefix of another (no false-positive on un-anchored substring)', () => {
    // `u-a` is a prefix of `u-ab` as a string, but the key includes the `:`
    // separator so a literal-prefix sweep must not collide. This is what the
    // `${universeId}:` suffix on the prefix is for.
    claimPendingSheetSlot('u-a', 'char-1', 'job-a1');
    claimPendingSheetSlot('u-ab', 'char-1', 'job-ab1');
    clearPendingSheetSlotsForUniverse('u-a');
    expect(getPendingSheetSlot('u-a', 'char-1')).toBeUndefined();
    expect(getPendingSheetSlot('u-ab', 'char-1')).toBe('job-ab1');
    // cleanup the residue so the next test's beforeEach doesn't have to chase it
    clearPendingSheetSlotsForUniverse('u-ab');
  });

  it('returns 0 when no slots match and is a no-op for an unknown universe', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    expect(clearPendingSheetSlotsForUniverse('u-unknown')).toBe(0);
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-1');
  });

  it('returns 0 and is a no-op when called with a falsy universe id', () => {
    claimPendingSheetSlot('u-a', 'char-1', 'job-1');
    expect(clearPendingSheetSlotsForUniverse('')).toBe(0);
    expect(clearPendingSheetSlotsForUniverse(null)).toBe(0);
    expect(clearPendingSheetSlotsForUniverse(undefined)).toBe(0);
    expect(getPendingSheetSlot('u-a', 'char-1')).toBe('job-1');
  });
});
