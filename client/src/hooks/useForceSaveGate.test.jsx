/**
 * useForceSaveGate — #3717.
 *
 * The gate guards an override that re-admits the exact blocking write the iCloud
 * dataless screen exists to prevent. So the properties worth pinning are the ones
 * that keep it SHUT: it must not arm on a single failure, must not carry across
 * notes, and must close again the moment a save succeeds.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useForceSaveGate } from './useForceSaveGate.js';

describe('useForceSaveGate', () => {
  it('stays disarmed after a single failure', () => {
    const { result } = renderHook(() => useForceSaveGate());

    act(() => result.current.recordFailure('a.md'));

    expect(result.current.isArmed('a.md')).toBe(false);
  });

  it('arms on the second consecutive failure for the same target', () => {
    const { result } = renderHook(() => useForceSaveGate());

    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.recordFailure('a.md'));

    expect(result.current.isArmed('a.md')).toBe(true);
  });

  it('never arms a target the user is not looking at', () => {
    const { result } = renderHook(() => useForceSaveGate());

    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.recordFailure('a.md'));

    expect(result.current.isArmed('b.md')).toBe(false);
    expect(result.current.isArmed(null)).toBe(false);
    expect(result.current.isArmed(undefined)).toBe(false);
  });

  it('restarts the count when the target changes', () => {
    const { result } = renderHook(() => useForceSaveGate());

    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.recordFailure('b.md'));

    // Two failures total, but not two in a row on either note.
    expect(result.current.isArmed('a.md')).toBe(false);
    expect(result.current.isArmed('b.md')).toBe(false);
  });

  it('disarms on reset', () => {
    const { result } = renderHook(() => useForceSaveGate());

    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.reset());

    expect(result.current.isArmed('a.md')).toBe(false);
  });

  it('honors a custom threshold', () => {
    const { result } = renderHook(() => useForceSaveGate(3));

    act(() => result.current.recordFailure('a.md'));
    act(() => result.current.recordFailure('a.md'));
    expect(result.current.isArmed('a.md')).toBe(false);

    act(() => result.current.recordFailure('a.md'));
    expect(result.current.isArmed('a.md')).toBe(true);
  });
});
