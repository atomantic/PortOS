import { describe, it, expect } from 'vitest';
import { buildUniverseSectionRenderTag } from './universeRunTag.js';

describe('buildUniverseSectionRenderTag', () => {
  const universe = { id: 'uni-1', name: 'Aether' };
  const entry = { id: 'chr-7', name: 'Vesper' };

  it('builds the canon entryRef tag from universe + entry identity', () => {
    expect(buildUniverseSectionRenderTag(universe, 'characters', entry)).toEqual({
      universeId: 'uni-1',
      universeName: 'Aether',
      entryRef: { kind: 'canon', kindKey: 'characters', id: 'chr-7' },
      label: 'Vesper',
      category: 'characters',
    });
  });

  it('falls back the label to the kindKey when the entry has no name', () => {
    const tag = buildUniverseSectionRenderTag(universe, 'places', { id: 'plc-2' });
    expect(tag.label).toBe('places');
    expect(tag.entryRef).toEqual({ kind: 'canon', kindKey: 'places', id: 'plc-2' });
  });

  it('returns null when identity is not yet resolvable', () => {
    expect(buildUniverseSectionRenderTag(null, 'characters', entry)).toBeNull();
    expect(buildUniverseSectionRenderTag({ id: 'uni-1' }, 'characters', entry)).toBeNull(); // no name
    expect(buildUniverseSectionRenderTag(universe, 'characters', { name: 'x' })).toBeNull(); // no id
    expect(buildUniverseSectionRenderTag(universe, '', entry)).toBeNull(); // no kindKey
  });
});
