import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useValidTab } from './useValidTab';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
];

const wrapperAt = (path) => {
  function RouteWrapper({ children }) {
    return (
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/page/:tab?" element={children} />
        </Routes>
      </MemoryRouter>
    );
  }
  return RouteWrapper;
};

describe('useValidTab', () => {
  it('returns the tab param when it names a real tab', () => {
    const { result } = renderHook(() => useValidTab(TABS, 'overview'), {
      wrapper: wrapperAt('/page/runs'),
    });
    expect(result.current).toBe('runs');
  });

  it('falls back when the tab param is not a valid id', () => {
    const { result } = renderHook(() => useValidTab(TABS, 'overview'), {
      wrapper: wrapperAt('/page/bogus'),
    });
    expect(result.current).toBe('overview');
  });

  it('falls back when no tab param is present', () => {
    const { result } = renderHook(() => useValidTab(TABS, 'overview'), {
      wrapper: wrapperAt('/page'),
    });
    expect(result.current).toBe('overview');
  });

  it('accepts plain id strings as the tabs list', () => {
    const { result } = renderHook(() => useValidTab(['a', 'b'], 'a'), {
      wrapper: wrapperAt('/page/b'),
    });
    expect(result.current).toBe('b');
  });
});
