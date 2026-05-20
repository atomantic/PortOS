import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUniverseNav, universeBuilderBasePath } from './useUniverseNav';

// Pair the hook with `useLocation` so each test can read back the URL the
// `goToWorld(id)` call produced — the contract here is URL transitions, so
// that's what we assert on. Mirrors the `usePreviewRoute.test.jsx` pattern.
const renderUniverseNav = (initial = '/universe-builder') => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(() => ({
    goToWorld: useUniverseNav(),
    location: useLocation(),
  }), { wrapper });
};

describe('universeBuilderBasePath', () => {
  it('strips a trailing /:universeId from the root mount', () => {
    expect(universeBuilderBasePath('/universe-builder/u-123')).toBe('/universe-builder');
  });

  it('strips deeper trailing paths', () => {
    expect(universeBuilderBasePath('/universe-builder/u-123/extra/path')).toBe('/universe-builder');
  });

  it('preserves a prefixed mount (e.g. /media/universe-builder)', () => {
    expect(universeBuilderBasePath('/media/universe-builder/u-123')).toBe('/media/universe-builder');
  });

  it('returns the input unchanged when /universe-builder is the leaf with no id', () => {
    expect(universeBuilderBasePath('/universe-builder')).toBe('/universe-builder');
  });

  it('tolerates null / empty input without throwing', () => {
    expect(universeBuilderBasePath(null)).toBe('');
    expect(universeBuilderBasePath('')).toBe('');
  });
});

describe('useUniverseNav', () => {
  it('navigates to /universe-builder/:id when called with an id', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('u-42'));

    expect(result.current.location.pathname).toBe('/universe-builder/u-42');
  });

  it('navigates back to the basePath when called with null', () => {
    const { result } = renderUniverseNav('/universe-builder/u-42');

    act(() => result.current.goToWorld(null));

    expect(result.current.location.pathname).toBe('/universe-builder');
  });

  it('preserves location.search across the transition', () => {
    const { result } = renderUniverseNav('/universe-builder?tab=cast&bucket=heroes');

    act(() => result.current.goToWorld('u-42'));

    expect(result.current.location.pathname).toBe('/universe-builder/u-42');
    expect(result.current.location.search).toBe('?tab=cast&bucket=heroes');
  });

  it('preserves location.search when clearing back to the index', () => {
    const { result } = renderUniverseNav('/universe-builder/u-42?series=s1');

    act(() => result.current.goToWorld(null));

    expect(result.current.location.pathname).toBe('/universe-builder');
    expect(result.current.location.search).toBe('?series=s1');
  });

  it('URI-encodes ids containing reserved characters', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('id with spaces & ?#'));

    // Spaces / `&` / `?` / `#` would otherwise smear into the path or split
    // off as query / hash — verify they all land inside the encoded segment.
    expect(result.current.location.pathname).toBe('/universe-builder/id%20with%20spaces%20%26%20%3F%23');
  });

  it('URI-encodes ids containing forward slashes (path-segment smear guard)', () => {
    const { result } = renderUniverseNav();

    act(() => result.current.goToWorld('a/b'));

    expect(result.current.location.pathname).toBe('/universe-builder/a%2Fb');
  });

  it('honors a prefixed mount when computing basePath', () => {
    const { result } = renderUniverseNav('/media/universe-builder/u-old');

    act(() => result.current.goToWorld('u-new'));

    expect(result.current.location.pathname).toBe('/media/universe-builder/u-new');
  });

  it('swaps id-for-id when already on a world', () => {
    const { result } = renderUniverseNav('/universe-builder/u-old');

    act(() => result.current.goToWorld('u-new'));

    expect(result.current.location.pathname).toBe('/universe-builder/u-new');
  });
});
