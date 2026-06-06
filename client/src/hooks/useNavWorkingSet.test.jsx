import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useNavWorkingSet } from './useNavWorkingSet.js';
import { RECENT_KEY, PINNED_KEY } from '../utils/navWorkingSet.js';

// Minimal resolver: label is the last path segment, icon is a sentinel.
const ICON = () => null;
const resolveNavEntry = (path) => ({ path, label: path.replace('/', '') || 'home', icon: ICON });

function wrapper({ children }) {
  return <MemoryRouter initialEntries={['/start']}>{children}</MemoryRouter>;
}

describe('useNavWorkingSet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('records the initial route to localStorage (even though it is excluded from the displayed recent list)', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    // The current page is recorded to storage...
    expect(JSON.parse(localStorage.getItem(RECENT_KEY))).toEqual(['/start']);
    // ...but excluded from the displayed list because it's the current page.
    expect(result.current.recent).toEqual([]);
  });

  it('pin() persists to localStorage and exposes resolved rows', () => {
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.pin('/brain/inbox'));
    expect(result.current.isPinned('/brain/inbox')).toBe(true);
    expect(result.current.pinned).toEqual([
      { path: '/brain/inbox', label: 'brain/inbox', icon: ICON },
    ]);
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual(['/brain/inbox']);
  });

  it('unpin() removes a pin', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/a', '/b']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    act(() => result.current.unpin('/a'));
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/b']);
  });

  it('excludes pinned and the current path from recent', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['/start', '/x', '/y']));
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/x']));
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    // current path is /start (excluded), /x is pinned (excluded) -> only /y
    expect(result.current.recent.map((r) => r.path)).toEqual(['/y']);
  });

  it('drops paths the resolver cannot resolve', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/known']));
    const partialResolver = (path) => (path === '/known' ? { path, label: 'known', icon: ICON } : null);
    const { result } = renderHook(() => useNavWorkingSet(partialResolver), { wrapper });
    act(() => result.current.pin('/unknown'));
    // /unknown is stored but unresolvable -> not displayed
    expect(result.current.pinned.map((r) => r.path)).toEqual(['/known']);
  });

  it('tolerates corrupt recent storage', () => {
    localStorage.setItem(RECENT_KEY, 'not-json{');
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    expect(result.current.recent).toEqual([]);
  });

  it('tolerates corrupt pinned storage', () => {
    localStorage.setItem(PINNED_KEY, '{bad');
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    expect(result.current.pinned).toEqual([]);
  });

  it('does not throw when localStorage.getItem throws (private mode)', () => {
    const spy = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    expect(() => renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper })).not.toThrow();
    spy.mockRestore();
  });

  it('does not throw when localStorage.setItem throws (quota)', () => {
    const spy = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper });
    expect(() => act(() => result.current.pin('/brain/inbox'))).not.toThrow();
    // in-memory state still updates despite the write failing
    expect(result.current.isPinned('/brain/inbox')).toBe(true);
    spy.mockRestore();
  });

  it('records a subsequent navigation into recent and storage', () => {
    let nav;
    function GrabNav() {
      nav = useNavigate();
      return null;
    }
    const navWrapper = ({ children }) => (
      <MemoryRouter initialEntries={['/start']}>
        <GrabNav />
        {children}
      </MemoryRouter>
    );
    const { result } = renderHook(() => useNavWorkingSet(resolveNavEntry), { wrapper: navWrapper });
    act(() => nav('/second'));
    // /second is now current (excluded from display), /start moved to recent
    expect(JSON.parse(localStorage.getItem(RECENT_KEY))).toEqual(['/second', '/start']);
    expect(result.current.recent.map((r) => r.path)).toEqual(['/start']);
  });
});
