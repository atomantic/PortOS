import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import useDrawerTab from './useDrawerTab';

// MemoryRouter so `useSearchParams` resolves; `useLocation` lets the assertions
// read back the resulting URL — the deep-link contract this hook defines.
const renderWithRouter = (args, initial = '/x') => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({
    pair: useDrawerTab(...args),
    location: useLocation(),
  }), { wrapper });
};

const IDS = ['general', 'ports', 'jira'];

describe('useDrawerTab', () => {
  it('returns the default tab when the param is absent', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS]);
    expect(result.current.pair[0]).toBe('general');
  });

  it('reads the active tab from the URL param', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS], '/x?tab=jira');
    expect(result.current.pair[0]).toBe('jira');
  });

  it('falls back to the default for a stale/invalid param', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS], '/x?tab=nope');
    expect(result.current.pair[0]).toBe('general');
  });

  it('accepts any value when no tabIds allow-list is given', () => {
    const { result } = renderWithRouter(['tab', 'general'], '/x?tab=anything');
    expect(result.current.pair[0]).toBe('anything');
  });

  it('writes the param when switching to a non-default tab', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS]);
    act(() => result.current.pair[1]('ports'));
    expect(result.current.pair[0]).toBe('ports');
    expect(result.current.location.search).toBe('?tab=ports');
  });

  it('drops the param when switching back to the default tab', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS], '/x?tab=jira');
    act(() => result.current.pair[1]('general'));
    expect(result.current.pair[0]).toBe('general');
    expect(result.current.location.search).toBe('');
  });

  it('preserves unrelated query params when writing the tab', () => {
    const { result } = renderWithRouter(['tab', 'general', IDS], '/x?settings=1');
    act(() => result.current.pair[1]('jira'));
    expect(result.current.location.search).toContain('settings=1');
    expect(result.current.location.search).toContain('tab=jira');
  });

  it('lets two drawers on one page use distinct param names', () => {
    const { result } = renderWithRouter(['imgTab', 'backend', ['backend', 'local']], '/x?tab=jira');
    // The other drawer's `tab` param must not leak into this one.
    expect(result.current.pair[0]).toBe('backend');
    act(() => result.current.pair[1]('local'));
    expect(result.current.location.search).toContain('tab=jira');
    expect(result.current.location.search).toContain('imgTab=local');
  });
});
