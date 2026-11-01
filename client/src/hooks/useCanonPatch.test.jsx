import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useState } from 'react';

const patchUniverseCanonEntry = vi.fn();
vi.mock('../services/apiUniverseBuilder', () => ({
  patchUniverseCanonEntry: (...args) => patchUniverseCanonEntry(...args),
}));
const toastError = vi.fn();
vi.mock('../components/ui/Toast', () => ({ default: { error: (...a) => toastError(...a) } }));

import { useCanonPatch } from './useCanonPatch.js';
import useMounted from './useMounted';

const KIND = { key: 'characters', singular: 'character' };
const BASE = {
  id: 'u1',
  characters: [
    { id: 'c1', name: 'Alice', physicalDescription: 'Original' },
    { id: 'c2', name: 'Bob' },
  ],
};
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const setup = () => renderHook(() => {
  const [universe, apply] = useState(BASE);
  const mountedRef = useMounted();
  return { universe, apply, ...useCanonPatch({ universe, apply, mountedRef }) };
});

beforeEach(() => {
  patchUniverseCanonEntry.mockReset();
  toastError.mockReset();
});

describe('useCanonPatch write ownership', () => {
  it('keeps newer optimistic edits and references through field-only acknowledgements', async () => {
    const first = deferred();
    const second = deferred();
    patchUniverseCanonEntry.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = setup();
    let a;
    let b;
    // Same-frame calls must compose without waiting for React to render.
    act(() => {
      a = result.current.patchEntry(KIND, 'c1', { physicalDescription: ' First ' });
      b = result.current.patchEntry(KIND, 'c2', { name: 'Robert' });
    });
    await act(async () => {});
    expect(result.current.universe.characters[1].name).toBe('Robert');
    expect(result.current.universe.characters[0].physicalDescription).toBe(' First ');
    expect(patchUniverseCanonEntry).toHaveBeenNthCalledWith(1, 'u1', 'character', 'c1', { physicalDescription: ' First ' }, { silent: true });

    // Another writer adds a reference while the inline save is pending.
    act(() => result.current.apply(previous => ({ ...previous, updatedAt: '2026-01-01T00:00:02.000Z', characters: previous.characters.map(entry => entry.id === 'c1' ? { ...entry, imageRefs: ['new.png'] } : entry) })));
    await act(async () => {
      first.resolve({ universe: { updatedAt: '2026-01-01T00:00:01.000Z' }, entry: { id: 'c1', name: 'Alice', physicalDescription: 'First', imageRefs: [] } });
      await a;
    });
    expect(result.current.universe.characters[0]).toMatchObject({ physicalDescription: 'First', imageRefs: ['new.png'] });
    expect(result.current.universe.characters[1].name).toBe('Robert');
    expect(result.current.universe.updatedAt).toBe('2026-01-01T00:00:02.000Z');
    expect(patchUniverseCanonEntry).toHaveBeenLastCalledWith('u1', 'character', 'c2', { name: 'Robert' }, { silent: true });
    await act(async () => { second.resolve({ universe: { updatedAt: '2026-01-01T00:00:03.000Z' }, entry: { id: 'c2', name: 'Robert' } }); await b; });
    expect(result.current.universe.updatedAt).toBe('2026-01-01T00:00:03.000Z');
  });

  it('does not restore a previous value when the same field is edited again before its save completes', async () => {
    const first = deferred();
    patchUniverseCanonEntry.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ entry: { id: 'c1', physicalDescription: 'Newest' } });
    const { result } = setup();
    let a;
    let b;
    act(() => { a = result.current.patchEntry(KIND, 'c1', { physicalDescription: 'Earlier' }); });
    act(() => { b = result.current.patchEntry(KIND, 'c1', { physicalDescription: 'Newest' }); });
    await act(async () => { first.resolve({ entry: { id: 'c1', physicalDescription: 'Earlier' } }); await a; });
    expect(result.current.universe.characters[0].physicalDescription).toBe('Newest');
    await act(async () => { await b; });
    expect(result.current.universe.characters[0].physicalDescription).toBe('Newest');
  });

  it('ignores an old visit acknowledgement after navigating away and back to the same universe', async () => {
    const first = deferred();
    patchUniverseCanonEntry.mockReturnValue(first.promise);
    const { result } = setup();
    let pending;
    act(() => { pending = result.current.patchEntry(KIND, 'c1', { name: 'Old visit' }); });
    act(() => { result.current.apply({ id: 'u2', characters: [] }); });
    act(() => { result.current.apply({ ...BASE, characters: [{ id: 'c1', name: 'Current visit' }] }); });
    await act(async () => { first.resolve({ entry: { id: 'c1', name: 'Old visit' } }); await pending; });
    expect(result.current.universe.characters[0].name).toBe('Current visit');
  });

  it('finishes accepted writes after unmount without publishing their results', async () => {
    const first = deferred();
    const apply = vi.fn();
    patchUniverseCanonEntry.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ entry: { id: 'c2', name: 'Robert' } });
    const { result, unmount } = renderHook(() => useCanonPatch({ universe: BASE, apply, mountedRef: useMounted() }));
    let a;
    let b;
    act(() => { a = result.current.patchEntry(KIND, 'c1', { name: 'Alicia' }); b = result.current.patchEntry(KIND, 'c2', { name: 'Robert' }); });
    unmount();
    await act(async () => { first.resolve({ entry: { id: 'c1', name: 'Alicia' } }); await a; await b; });
    expect(patchUniverseCanonEntry).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2); // optimistic updates only
  });

  it('reports a failed write and still saves the next edit', async () => {
    patchUniverseCanonEntry.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ entry: { id: 'c2', name: 'Robert' } });
    const { result } = setup();
    await act(async () => {
      const a = result.current.patchEntry(KIND, 'c1', { name: 'Alicia' });
      const b = result.current.patchEntry(KIND, 'c2', { name: 'Robert' });
      await a;
      await b;
    });
    expect(toastError).toHaveBeenCalledWith('Save failed: offline');
    expect(patchUniverseCanonEntry).toHaveBeenLastCalledWith('u1', 'character', 'c2', { name: 'Robert' }, { silent: true });
    expect(result.current.universe.characters[1].name).toBe('Robert');
  });
});
