import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import useUniverseTabs from './useUniverseTabs';

// The contract here is URL transitions, so pair the hook with `useLocation`
// and assert on the query string each call produces (mirrors
// useUniverseNav.test.jsx).
const renderTabs = (initial, categories) => {
  const wrapper = ({ children }) => (
    <MemoryRouter initialEntries={[initial]}>{children}</MemoryRouter>
  );
  return renderHook(({ cats }) => ({
    tabs: useUniverseTabs(cats),
    location: useLocation(),
  }), { wrapper, initialProps: { cats: categories } });
};

const CATEGORIES = {
  heroes: { kind: 'characters', variations: [] },
  cities: { kind: 'places', variations: [] },
  factions: { kind: 'other', variations: [] },
};

describe('useUniverseTabs', () => {
  it('defaults to the bible tab with no bucket', () => {
    const { result } = renderTabs('/universes/u-1', CATEGORIES);

    expect(result.current.tabs.activeTab).toBe('bible');
    expect(result.current.tabs.activeBucket).toBe('');
  });

  it('reads the tab + bucket out of the query string', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&bucket=heroes', CATEGORIES);

    expect(result.current.tabs.activeTab).toBe('cast');
    expect(result.current.tabs.activeBucket).toBe('heroes');
  });

  it('groups buckets by kind and flags the Other bin', () => {
    const { result } = renderTabs('/universes/u-1', CATEGORIES);

    expect(result.current.tabs.bucketsByKind.characters).toEqual(['heroes']);
    expect(result.current.tabs.bucketsByKind.other).toEqual(['factions']);
    expect(result.current.tabs.hasOtherBuckets).toBe(true);
  });

  it('drops ?tab= when switching back to bible and preserves unrelated params', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&series=s-1', CATEGORIES);

    act(() => result.current.tabs.setTab('bible'));

    expect(result.current.location.search).toBe('?series=s-1');
  });

  it('clears the bucket on a tab transition but preserves it on the same tab', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&bucket=heroes', CATEGORIES);

    act(() => result.current.tabs.setTab('cast'));
    expect(result.current.tabs.activeBucket).toBe('heroes');

    act(() => result.current.tabs.setTab('places'));
    expect(result.current.tabs.activeBucket).toBe('');
  });

  it('honors an explicit null bucket as a clear on the same tab', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&bucket=heroes', CATEGORIES);

    act(() => result.current.tabs.setTab('cast', { bucket: null }));

    expect(result.current.tabs.activeBucket).toBe('');
  });

  it('setBucket sets then clears the bucket param', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast', CATEGORIES);

    act(() => result.current.tabs.setBucket('heroes'));
    expect(result.current.tabs.activeBucket).toBe('heroes');

    act(() => result.current.tabs.setBucket(''));
    expect(result.current.location.search).toBe('?tab=cast');
  });

  it('strips an unknown ?tab= from the URL instead of silently falling back', () => {
    const { result } = renderTabs('/universes/u-1?tab=bogus', CATEGORIES);

    expect(result.current.tabs.activeTab).toBe('bible');
    expect(result.current.location.search).toBe('');
  });

  it('strips ?tab=other when there are no Other buckets', () => {
    const { result } = renderTabs('/universes/u-1?tab=other', {
      heroes: { kind: 'characters', variations: [] },
    });

    expect(result.current.tabs.activeTab).toBe('bible');
    expect(result.current.location.search).toBe('');
  });

  it('strips a ?bucket= that does not exist under the active tab', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&bucket=cities', CATEGORIES);

    expect(result.current.location.search).toBe('?tab=cast');
    expect(result.current.tabs.activeBucket).toBe('');
  });

  it('keeps the canon pseudo-bucket on a trunk tab', () => {
    const { result } = renderTabs('/universes/u-1?tab=cast&bucket=canon', CATEGORIES);

    expect(result.current.tabs.activeBucket).toBe('canon');
  });
});
