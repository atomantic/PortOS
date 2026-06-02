import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// ---------------------------------------------------------------------------
// Module mocks — must be at the top level before any imports.
// ---------------------------------------------------------------------------
vi.mock('../services/apiUniverseBuilder.js', () => ({
  getUniverse: vi.fn(),
}));

let useUniverse;
let getUniverse;

beforeEach(async () => {
  vi.resetModules();
  ({ getUniverse } = await import('../services/apiUniverseBuilder.js'));
  useUniverse = (await import('./useUniverse.js')).default;
  getUniverse.mockReset();
});

const UNIVERSE = { id: 'u1', name: 'Alpha', characters: [{ name: 'A', wardrobes: [{}] }] };

describe('useUniverse', () => {
  it('does not fetch and stays cleared for a falsy id', () => {
    const { result } = renderHook(() => useUniverse(null));
    const [universe, setUniverse, loading, error] = result.current;
    expect(universe).toBeNull();
    expect(typeof setUniverse).toBe('function');
    expect(loading).toBe(false);
    expect(error).toBeNull();
    expect(getUniverse).not.toHaveBeenCalled();
  });

  it('loads the universe and clears loading on success', async () => {
    getUniverse.mockResolvedValue(UNIVERSE);
    const { result } = renderHook(() => useUniverse('u1'));
    // loading flips true synchronously once the effect runs
    await waitFor(() => expect(result.current[0]).toEqual(UNIVERSE));
    expect(getUniverse).toHaveBeenCalledWith('u1');
    expect(result.current[2]).toBe(false); // loading
    expect(result.current[3]).toBeNull(); // error
  });

  it('exposes the rejection reason and nulls the record on failure', async () => {
    const err = new Error('boom');
    getUniverse.mockRejectedValue(err);
    const { result } = renderHook(() => useUniverse('u1'));
    await waitFor(() => expect(result.current[3]).toBe(err));
    expect(result.current[0]).toBeNull();
    expect(result.current[2]).toBe(false); // loading
  });

  it('exposes setUniverse for optimistic post-mutation updates', async () => {
    getUniverse.mockResolvedValue(UNIVERSE);
    const { result } = renderHook(() => useUniverse('u1'));
    await waitFor(() => expect(result.current[0]).toEqual(UNIVERSE));
    const patched = { ...UNIVERSE, name: 'Beta' };
    act(() => { result.current[1](patched); });
    expect(result.current[0]).toEqual(patched);
  });

  it('re-fetches when the id changes', async () => {
    getUniverse.mockResolvedValue(UNIVERSE);
    const { result, rerender } = renderHook(({ id }) => useUniverse(id), {
      initialProps: { id: 'u1' },
    });
    await waitFor(() => expect(result.current[0]).toEqual(UNIVERSE));
    const other = { id: 'u2', name: 'Gamma' };
    getUniverse.mockResolvedValue(other);
    rerender({ id: 'u2' });
    await waitFor(() => expect(result.current[0]).toEqual(other));
    expect(getUniverse).toHaveBeenCalledWith('u2');
  });

  it('treats a null payload as not-found', async () => {
    getUniverse.mockResolvedValue(null);
    const { result } = renderHook(() => useUniverse('u1'));
    await waitFor(() => expect(result.current[2]).toBe(false));
    expect(result.current[0]).toBeNull();
  });
});
