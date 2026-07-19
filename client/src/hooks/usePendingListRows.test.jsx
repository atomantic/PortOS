import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePendingListRows from './usePendingListRows';

const WARDROBE_BLANK = () => ({ name: '', description: '' });

describe('usePendingListRows', () => {
  it('merged equals persisted (same reference) when no pending rows exist', () => {
    const persisted = [{ id: 'wd-1', name: 'Casual', description: 'jeans' }];
    const { result } = renderHook(() => usePendingListRows({
      persisted, requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange: vi.fn(),
    }));
    expect(result.current.merged).toBe(persisted);
  });

  it('addRow appends a pending row with idPrefix-prefixed id and blank shape', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted: [], requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.addRow());
    expect(result.current.merged).toHaveLength(1);
    const [row] = result.current.merged;
    expect(row.id.startsWith('wd-')).toBe(true);
    expect(row.name).toBe('');
    expect(row.description).toBe('');
    expect(result.current.isPending(0)).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('updateRow on a pending row with blank required column keeps it pending', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted: [], requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.addRow());
    const pendingId = result.current.merged[0].id;
    act(() => result.current.updateRow(0, { id: pendingId, name: '', description: 'jeans' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.merged[0]).toEqual({ id: pendingId, name: '', description: 'jeans' });
  });

  it('updateRow on a pending row promotes when required column fills (stripIdOnPromote=false keeps id)', () => {
    const persisted = [];
    const onChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ p }) => usePendingListRows({
        persisted: p, requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
      }),
      { initialProps: { p: persisted } },
    );
    act(() => result.current.addRow());
    const pendingId = result.current.merged[0].id;
    act(() => result.current.updateRow(0, { id: pendingId, name: 'Casual', description: '' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ id: pendingId, name: 'Casual', description: '' }]);
    rerender({ p: [{ id: pendingId, name: 'Casual', description: '' }] });
    expect(result.current.merged).toEqual([{ id: pendingId, name: 'Casual', description: '' }]);
    expect(result.current.isPending(0)).toBe(false);
  });

  it('stripIdOnPromote=true drops the id field when promoting', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted: [],
      requiredColumn: 'label',
      idPrefix: 'pending-stats-',
      stripIdOnPromote: true,
      blankRow: () => ({ label: '', value: '' }),
      onChange,
    }));
    act(() => result.current.addRow());
    const pendingId = result.current.merged[0].id;
    expect(pendingId.startsWith('pending-stats-')).toBe(true);
    act(() => result.current.updateRow(0, { id: pendingId, label: 'Height', value: "5'7\"" }));
    expect(onChange).toHaveBeenCalledWith([{ label: 'Height', value: "5'7\"" }]);
  });

  it('updateRow on a persisted row patches it without touching pending', () => {
    const persisted = [{ id: 'wd-1', name: 'Casual', description: 'jeans' }];
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted, requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.updateRow(0, { id: 'wd-1', name: 'Casual', description: 'denim' }));
    expect(onChange).toHaveBeenCalledWith([{ id: 'wd-1', name: 'Casual', description: 'denim' }]);
  });

  it('removeRow drops a pending row without calling onChange', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted: [], requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.addRow());
    act(() => result.current.removeRow(0));
    expect(onChange).not.toHaveBeenCalled();
    expect(result.current.merged).toHaveLength(0);
  });

  it('removeRow drops a persisted row via onChange', () => {
    const persisted = [
      { id: 'wd-1', name: 'Casual', description: '' },
      { id: 'wd-2', name: 'Formal', description: '' },
    ];
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted, requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.removeRow(0));
    expect(onChange).toHaveBeenCalledWith([{ id: 'wd-2', name: 'Formal', description: '' }]);
  });

  it('whitespace-only required column does NOT promote', () => {
    const onChange = vi.fn();
    const { result } = renderHook(() => usePendingListRows({
      persisted: [], requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange,
    }));
    act(() => result.current.addRow());
    const pendingId = result.current.merged[0].id;
    act(() => result.current.updateRow(0, { id: pendingId, name: '   ', description: 'foo' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('isPending partitions merged indices correctly with both persisted and pending rows', () => {
    const persisted = [{ id: 'wd-1', name: 'Casual', description: '' }];
    const { result } = renderHook(() => usePendingListRows({
      persisted, requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange: vi.fn(),
    }));
    act(() => result.current.addRow());
    expect(result.current.merged).toHaveLength(2);
    expect(result.current.isPending(0)).toBe(false);
    expect(result.current.isPending(1)).toBe(true);
  });

  it('addRow still mints a prefixed id without crypto.randomUUID (insecure origin)', () => {
    // jsdom's `crypto` getter is non-writable, so swap randomUUID via spy
    // instead of reassigning `globalThis.crypto`. `uuidv4` (lib/uuid.js) owns
    // the fallback; this only pins that the `<prefix><id>` shape survives it.
    const spy = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(undefined);
    const { result } = renderHook(() => usePendingListRows({
      persisted: [], requiredColumn: 'name', idPrefix: 'wd-', blankRow: WARDROBE_BLANK, onChange: vi.fn(),
    }));
    act(() => result.current.addRow());
    // Assert the real v4 shape, not just "non-empty" — a regression to a
    // non-uuid fallback would otherwise slip through.
    expect(result.current.merged[0].id).toMatch(
      /^wd-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    spy.mockRestore();
  });
});
