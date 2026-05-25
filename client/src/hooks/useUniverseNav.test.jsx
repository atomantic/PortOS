import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUniverseNav, universesBasePath } from './useUniverseNav';

// Pair the hook with `useLocation` so each test can read back the URL the
// `goToWorld(id)` call produced — the contract here is URL transitions, so
// that's what we assert on. Mirrors the `usePreviewRoute.test.jsx` pattern.
const renderUniverseNav = (initial = '/universes') => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({
    goToWorld: useUniverseNav(),
    location: useLocation(),
  }), { wrapper });
};

describe('universesBasePath', () => {
  it('strips a trailing /:universeId from the root mount', () => {
    expect(universesBasePath('/universes/u-123')).toBe('/universes');
  });

  it('strips deeper trailing paths', () => {
    expect(universesBasePath('/universes/u-123/extra/path')).toBe('/universes');
  });

  it('returns the input unchanged when /universes is the leaf with no id', () => {
    expect(universesBasePath('/universes')).toBe('/universes');
  });

  it('tolerates null / empty input without throwing', () => {
    expect(universesBasePath(null)).toBe('');
    expect(universesBasePath('')).toBe('');
  });
});

describe('useUniverseNav', () => {
  it('navigates to /universes/:id when called with an id', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('u-42'));

    expect(result.current.location.pathname).toBe('/universes/u-42');
  });

  it('navigates back to the basePath when called with null', () => {
    const { result } = renderUniverseNav('/universes/u-42');

    act(() => result.current.goToWorld(null));

    expect(result.current.location.pathname).toBe('/universes');
  });

  it('preserves location.search across the transition', () => {
    const { result } = renderUniverseNav('/universes?tab=cast&bucket=heroes');

    act(() => result.current.goToWorld('u-42'));

    expect(result.current.location.pathname).toBe('/universes/u-42');
    expect(result.current.location.search).toBe('?tab=cast&bucket=heroes');
  });

  it('preserves location.search when clearing back to the index', () => {
    const { result } = renderUniverseNav('/universes/u-42?series=s1');

    act(() => result.current.goToWorld(null));

    expect(result.current.location.pathname).toBe('/universes');
    expect(result.current.location.search).toBe('?series=s1');
  });

  it('URI-encodes ids containing reserved characters', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('id with spaces & ?#'));

    // Spaces / `&` / `?` / `#` would otherwise smear into the path or split
    // off as query / hash — verify they all land inside the encoded segment.
    expect(result.current.location.pathname).toBe('/universes/id%20with%20spaces%20%26%20%3F%23');
  });

  it('URI-encodes ids containing forward slashes (path-segment smear guard)', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('a/b'));

    expect(result.current.location.pathname).toBe('/universes/a%2Fb');
  });

  it('swaps id-for-id when already on a world', () => {
    const { result } = renderUniverseNav('/universes/u-old');

    act(() => result.current.goToWorld('u-new'));

    expect(result.current.location.pathname).toBe('/universes/u-new');
  });
});
