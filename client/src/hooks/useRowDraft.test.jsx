import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useRowDraft from './useRowDraft';

describe('useRowDraft', () => {
  it('draftFor returns the persisted column value when no draft is set', () => {
    const row = { name: 'amber', hex: '#f59e0b', role: 'jacket' };
    const { result } = renderHook(() => useRowDraft(row, vi.fn()));
    expect(result.current.draftFor('name')).toBe('amber');
    expect(result.current.draftFor('hex')).toBe('#f59e0b');
    expect(result.current.draftFor('role')).toBe('jacket');
  });

  it('draftFor coerces a missing/null persisted column to "" so the input stays controlled', () => {
    const row = { name: 'amber', hex: null };
    const { result } = renderHook(() => useRowDraft(row, vi.fn()));
    expect(result.current.draftFor('hex')).toBe('');
    expect(result.current.draftFor('absent')).toBe('');
  });

  it('setDraft buffers the value locally without calling onChange', () => {
    const row = { name: 'amber' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => result.current.setDraft('name', 'crimson'));
    expect(result.current.draftFor('name')).toBe('crimson');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commit fires onChange with the merged row when the draft differs from persisted', () => {
    const row = { name: 'amber', hex: '#f59e0b' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => result.current.setDraft('name', 'crimson'));
    act(() => result.current.commit('name'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ name: 'crimson', hex: '#f59e0b' });
  });

  it('commit is a no-op when no draft for that column exists', () => {
    const row = { name: 'amber' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => result.current.commit('name'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('commit clears the draft without firing onChange when value equals persisted', () => {
    const row = { name: 'amber' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => result.current.setDraft('name', 'amber'));
    act(() => result.current.commit('name'));
    expect(onChange).not.toHaveBeenCalled();
    // After commit, draftFor falls back to the persisted value.
    expect(result.current.draftFor('name')).toBe('amber');
  });

  it('commit treats null/undefined persisted as "" so an empty draft against an absent column is a no-op', () => {
    const row = { name: 'amber' }; // hex absent
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => result.current.setDraft('hex', ''));
    act(() => result.current.commit('hex'));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ride-along: committing column B while column A still has a pending draft ships both in one onChange', () => {
    const row = { name: 'amber', hex: '#f59e0b' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => {
      result.current.setDraft('name', 'crimson');
      result.current.setDraft('hex', '#dc2626');
    });
    act(() => result.current.commit('hex'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ name: 'crimson', hex: '#dc2626' });
  });

  it('commit clears only the committed column from drafts; sibling drafts remain pending', () => {
    const row = { name: 'amber', hex: '#f59e0b' };
    const onChange = vi.fn();
    const { result } = renderHook(() => useRowDraft(row, onChange));
    act(() => {
      result.current.setDraft('name', 'crimson');
      result.current.setDraft('hex', '#dc2626');
    });
    act(() => result.current.commit('name'));
    // name's draft cleared (falls back to whatever the parent re-renders
    // with — in this test the `row` prop is stable, so persisted wins).
    expect(result.current.draftFor('name')).toBe('amber');
    // hex's draft still pending.
    expect(result.current.draftFor('hex')).toBe('#dc2626');
  });
});
