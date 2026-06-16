import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useConfirmDelete } from './useConfirmDelete';

describe('useConfirmDelete', () => {
  it('starts with nothing armed', () => {
    const { result } = renderHook(() => useConfirmDelete());
    expect(result.current.confirmingId).toBe(null);
    expect(result.current.isConfirming('a')).toBe(false);
  });

  it('arms a single row and reports it via isConfirming', () => {
    const { result } = renderHook(() => useConfirmDelete());

    act(() => result.current.requestDelete('row-1'));

    expect(result.current.confirmingId).toBe('row-1');
    expect(result.current.isConfirming('row-1')).toBe(true);
    expect(result.current.isConfirming('row-2')).toBe(false);
  });

  it('arms only one row at a time — opening a second closes the first', () => {
    const { result } = renderHook(() => useConfirmDelete());

    act(() => result.current.requestDelete('row-1'));
    act(() => result.current.requestDelete('row-2'));

    expect(result.current.isConfirming('row-1')).toBe(false);
    expect(result.current.isConfirming('row-2')).toBe(true);
  });

  it('cancelDelete disarms', () => {
    const { result } = renderHook(() => useConfirmDelete());

    act(() => result.current.requestDelete('row-1'));
    act(() => result.current.cancelDelete());

    expect(result.current.confirmingId).toBe(null);
    expect(result.current.isConfirming('row-1')).toBe(false);
  });

  it('confirmDelete disarms then runs the delete fn and returns its result', async () => {
    const { result } = renderHook(() => useConfirmDelete());
    const fn = vi.fn().mockResolvedValue('deleted');

    act(() => result.current.requestDelete('row-1'));

    let returned;
    await act(async () => {
      returned = await result.current.confirmDelete(fn);
    });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(returned).toBe('deleted');
    expect(result.current.confirmingId).toBe(null);
  });

  it('treats a falsy-but-valid id (0) as armed, and null as nothing armed', () => {
    const { result } = renderHook(() => useConfirmDelete());

    act(() => result.current.requestDelete(0));
    expect(result.current.isConfirming(0)).toBe(true);

    act(() => result.current.cancelDelete());
    // After cancel, an id of null must not read as armed.
    expect(result.current.isConfirming(null)).toBe(false);
  });
});
