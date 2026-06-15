import { describe, it, expect } from 'vitest';
import { buildImporterLink, resolveImporterDeepLink } from './importerDeepLink.js';

describe('buildImporterLink', () => {
  it('returns a bare /importer with no args', () => {
    expect(buildImporterLink()).toBe('/importer');
    expect(buildImporterLink({})).toBe('/importer');
  });

  it('encodes a universeId + seriesId pair (existing records)', () => {
    expect(buildImporterLink({ universeId: 'u1', seriesId: 's1' }))
      .toBe('/importer?universeId=u1&seriesId=s1');
  });

  it('passes a not-yet-created series by name and trims it', () => {
    expect(buildImporterLink({ universeId: 'u1', seriesName: '  Salt Run  ' }))
      .toBe('/importer?universeId=u1&series=Salt+Run');
  });

  it('drops a whitespace-only series name', () => {
    expect(buildImporterLink({ universeId: 'u1', seriesName: '   ' }))
      .toBe('/importer?universeId=u1');
  });
});

describe('resolveImporterDeepLink', () => {
  const universes = [
    { id: 'u1', name: 'Cyberpunk 2099' },
    { id: 'u2', name: 'Salt Run' },
  ];
  const series = [
    { id: 's1', name: 'The Choir Awakens', universeId: 'u1' },
    { id: 's2', name: 'Foundry', universeId: 'u2' },
  ];

  it('resolves a seriesId to its name AND pins its parent universe', () => {
    expect(resolveImporterDeepLink({ seriesId: 's1', universes, series })).toEqual({
      universeName: 'Cyberpunk 2099',
      seriesName: 'The Choir Awakens',
    });
  });

  it('resolves a universeId on its own', () => {
    expect(resolveImporterDeepLink({ universeId: 'u2', universes, series })).toEqual({
      universeName: 'Salt Run',
      seriesName: '',
    });
  });

  it('lets a seriesId override a mismatched universeId so the pair cannot drift', () => {
    // universeId points at u2 (Salt Run) but the series belongs to u1 — the
    // series wins and pins Cyberpunk 2099.
    expect(resolveImporterDeepLink({ universeId: 'u2', seriesId: 's1', universes, series })).toEqual({
      universeName: 'Cyberpunk 2099',
      seriesName: 'The Choir Awakens',
    });
  });

  it('falls back to raw name params when ids do not match a record', () => {
    expect(resolveImporterDeepLink({
      universeId: 'missing', universeName: 'Brand New World', seriesName: 'Brand New Series',
      universes, series,
    })).toEqual({ universeName: 'Brand New World', seriesName: 'Brand New Series' });
  });

  it('returns empty names when nothing resolves', () => {
    expect(resolveImporterDeepLink({ universes, series })).toEqual({ universeName: '', seriesName: '' });
  });
});
