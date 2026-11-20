import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { useNavWorkingSet as useRawWorkingSet, useResolvedNavWorkingSet } from './useNavWorkingSet.js';
import { RECENT_KEY, PINNED_KEY } from '../utils/navWorkingSet.js';

const useNavWorkingSet = resolve => {
  const workingSet = useRawWorkingSet();
  const { pathname } = useLocation();
  return { ...workingSet, ...useResolvedNavWorkingSet(workingSet, resolve, pathname) };
};

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

  // A page that MOVED is the reason a pin used to vanish on an app update: the
  // stored path stopped matching anything and the row silently rendered nothing.
  // Layout's resolver now falls back through the manifest's `previousPaths`, so
  // the hook sees the CURRENT entry for a legacy stored path.
  const movedResolver = (path) => {
    const current = path === '/city' ? '/openworld'
      : path.startsWith('/city/') ? `/openworld${path.slice('/city'.length)}`
        : path;
    return { path: current, label: current.replace('/', ''), icon: ICON };
  };

  it('renders a pin whose page has moved under its current path', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/city', '/city/settings']));
    const { result } = renderHook(() => useNavWorkingSet(movedResolver), { wrapper });

    expect(result.current.pinned.map((row) => row.path)).toEqual(['/openworld', '/openworld/settings']);
    expect(result.current.isPinned('/openworld')).toBe(true);
  });

  it('folds the moved path back into storage so unpin() matches the rendered row', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/city']));
    const { result } = renderHook(() => useNavWorkingSet(movedResolver), { wrapper });
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual(['/openworld']);

    act(() => result.current.unpin('/openworld'));
    expect(result.current.pinned).toEqual([]);
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual([]);
  });

  it('collapses a moved path onto its already-current twin instead of duplicating', () => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/city', '/openworld']));
    const { result } = renderHook(() => useNavWorkingSet(movedResolver), { wrapper });
    expect(result.current.pinned.map((row) => row.path)).toEqual(['/openworld']);
  });

  it('leaves a pin the resolver cannot place alone rather than dropping it', () => {
    // The dynamic app/series/universe rows load async, so "unresolvable" is a
    // normal transient state during boot — rewriting or pruning storage on that
    // miss would lose the pin for good.
    localStorage.setItem(PINNED_KEY, JSON.stringify(['/apps/not-loaded-yet']));
    const { result } = renderHook(() => useNavWorkingSet(() => null), { wrapper });

    expect(result.current.pinned).toEqual([]);
    expect(JSON.parse(localStorage.getItem(PINNED_KEY))).toEqual(['/apps/not-loaded-yet']);
  });

  it('migrates recent destinations too', () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['/start', '/city/settings']));
    const { result } = renderHook(() => useNavWorkingSet(movedResolver), { wrapper });
    expect(result.current.recent.map((row) => row.path)).toEqual(['/openworld/settings']);
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
