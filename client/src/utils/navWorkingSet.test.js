// @vitest-environment node

import { describe, it, expect } from 'vitest';
import {
  RECENT_KEY, PINNED_KEY, RECENT_CAP,
  recordVisit, togglePin, isPinned, resolveRecentNavEntries, migrateLegacyNavPath,
} from './navWorkingSet.js';

describe('navWorkingSet — constants', () => {
  it('exposes stable localStorage keys and a cap of 5', () => {
    expect(RECENT_KEY).toBe('portos-nav-recent');
    expect(PINNED_KEY).toBe('portos-nav-pinned');
    expect(RECENT_CAP).toBe(5);
  });
});

describe('recordVisit', () => {
  it('prepends a new path most-recent-first', () => {
    expect(recordVisit('/b', ['/a'])).toEqual(['/b', '/a']);
  });

  it('dedups — moves an existing path to the front without duplicating', () => {
    expect(recordVisit('/a', ['/b', '/a', '/c'])).toEqual(['/a', '/b', '/c']);
  });

  it('caps the list at RECENT_CAP entries', () => {
    const result = recordVisit('/new', ['/1', '/2', '/3', '/4', '/5']);
    expect(result).toEqual(['/new', '/1', '/2', '/3', '/4']);
    expect(result).toHaveLength(RECENT_CAP);
    expect(result).not.toContain('/5'); // oldest entry dropped past the cap
  });

  it('ignores falsy / non-string paths (returns the list unchanged)', () => {
    expect(recordVisit('', ['/a'])).toEqual(['/a']);
    expect(recordVisit(null, ['/a'])).toEqual(['/a']);
    expect(recordVisit(undefined, ['/a'])).toEqual(['/a']);
    expect(recordVisit(42, ['/a'])).toEqual(['/a']);
    expect(recordVisit('javascript:alert(1)', ['/a'])).toEqual(['/a']);
    expect(recordVisit('//example.com', ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(recordVisit('/a', null)).toEqual(['/a']);
    expect(recordVisit('/a', undefined)).toEqual(['/a']);
  });
});

describe('resolveRecentNavEntries', () => {
  const commands = [
    { id: 'nav.dashboard', path: '/', label: 'Dashboard' },
    { id: 'nav.apps', path: '/apps', label: 'Apps' },
    { id: 'nav.pipeline', path: '/pipeline', label: 'Pipeline' },
    { id: 'nav.pipeline.series', path: '/pipeline/series', label: 'Series' },
  ];

  it('resolves exact paths and preserves deep-link destinations via the longest base route', () => {
    expect(resolveRecentNavEntries(['/apps/example', '/pipeline/series/series-1', '/'], commands))
      .toEqual([
        { ...commands[1], path: '/apps/example' },
        { ...commands[3], path: '/pipeline/series/series-1' },
        commands[0],
      ]);
  });

  it('resolves a stored path whose page has moved to where it lives now', () => {
    const moved = [...commands, { id: 'nav.openworld', path: '/openworld', label: 'OpenWorld', previousPaths: ['/city'] }];
    expect(resolveRecentNavEntries(['/city/settings'], moved))
      .toEqual([{ ...moved[4], path: '/openworld/settings' }]);
  });

  it('skips the current, stale, duplicate, and unsafe paths while honoring the limit', () => {
    expect(resolveRecentNavEntries(
      ['/apps', '/missing', '/apps/example', '/apps/example', '//example.com'],
      commands,
      { currentPath: '/apps', limit: 1 },
    )).toEqual([{ ...commands[1], path: '/apps/example' }]);
  });
});

describe('migrateLegacyNavPath', () => {
  // Shaped like the real manifest: `previousPaths` is declared on the entry that
  // moved (server/lib/navManifest.js) and ships whole in the palette payload.
  const commands = [
    { id: 'nav.eidoverse', path: '/eidoverse', label: 'Eidoverse', previousPaths: ['/openworld', '/city'], preservePreviousPathSuffix: false },
    { id: 'nav.sprites', path: '/sprites', label: 'Sprites', previousPaths: ['/media/sprites', '/media/sprites/:id'] },
    { id: 'nav.universes', path: '/universes', label: 'Universes', previousPaths: ['/media/universe-builder', '/universe-builder'] },
    { id: 'nav.cityscape', path: '/cityscape', label: 'Cityscape' },
  ];

  it('maps a moved page onto its current path', () => {
    expect(migrateLegacyNavPath('/city', commands)).toBe('/eidoverse');
    expect(migrateLegacyNavPath('/media/sprites', commands)).toBe('/sprites');
  });

  it('carries the trailing path across, including a subtree the manifest never spells out', () => {
    // Record-detail moves retain the selection. Retired OpenWorld subroutes do
    // not exist in Eidoverse, so its manifest explicitly collapses the suffix.
    expect(migrateLegacyNavPath('/media/sprites/s-1', commands)).toBe('/sprites/s-1');
    expect(migrateLegacyNavPath('/city/apps/portos', commands)).toBe('/eidoverse');
    expect(migrateLegacyNavPath('/openworld/region/example', commands)).toBe('/eidoverse');
  });

  it('is segment-anchored, so a sibling route that merely shares a prefix is untouched', () => {
    expect(migrateLegacyNavPath('/cityscape', commands)).toBe('/cityscape');
  });

  it('prefers the longest matching previous path', () => {
    expect(migrateLegacyNavPath('/media/universe-builder/u-1', commands)).toBe('/universes/u-1');
    expect(migrateLegacyNavPath('/universe-builder/u-1', commands)).toBe('/universes/u-1');
  });

  it('returns a current path, an unknown path, and a non-path unchanged', () => {
    expect(migrateLegacyNavPath('/eidoverse', commands)).toBe('/eidoverse');
    expect(migrateLegacyNavPath('/whatever', commands)).toBe('/whatever');
    expect(migrateLegacyNavPath('//example.com', commands)).toBe('//example.com');
    expect(migrateLegacyNavPath(null, commands)).toBe(null);
  });

  it('tolerates an absent or malformed manifest', () => {
    expect(migrateLegacyNavPath('/city', undefined)).toBe('/city');
    expect(migrateLegacyNavPath('/city', [null, { path: '/x', previousPaths: 'nope' }])).toBe('/city');
  });
});

describe('togglePin / isPinned', () => {
  it('adds a path when absent', () => {
    expect(togglePin('/a', [])).toEqual(['/a']);
  });

  it('removes a path when present', () => {
    expect(togglePin('/a', ['/a', '/b'])).toEqual(['/b']);
  });

  it('ignores falsy paths', () => {
    expect(togglePin('', ['/a'])).toEqual(['/a']);
    expect(togglePin(null, ['/a'])).toEqual(['/a']);
  });

  it('tolerates a non-array current list', () => {
    expect(togglePin('/a', null)).toEqual(['/a']);
  });

  it('isPinned reports membership', () => {
    expect(isPinned('/a', ['/a', '/b'])).toBe(true);
    expect(isPinned('/c', ['/a', '/b'])).toBe(false);
    expect(isPinned('/a', null)).toBe(false);
  });
});
