import { describe, it, expect } from 'vitest';
import {
  parseTempo, clampTempo, stripTempId, localId, buildRoundPatch, TEMPO_MIN, TEMPO_MAX,
} from './roundDraft.js';

describe('roundDraft tempo', () => {
  it('parseTempo returns null for empty or non-numeric input', () => {
    expect(parseTempo('')).toBeNull();
    expect(parseTempo(null)).toBeNull();
    expect(parseTempo('abc')).toBeNull();
  });

  it('clampTempo floors to the band without touching a mid-keystroke parse', () => {
    expect(parseTempo('6')).toBe(6);
    expect(clampTempo(6)).toBe(TEMPO_MIN);
    expect(clampTempo(400)).toBe(TEMPO_MAX);
    expect(clampTempo(null)).toBeNull();
  });
});

describe('roundDraft ids', () => {
  it('stripTempId blanks a -new-N id and keeps a stable one', () => {
    expect(stripTempId({ id: 'sec-new-0', title: 'Verse' })).toEqual({ id: '', title: 'Verse' });
    expect(stripTempId({ id: 'lead' })).toEqual({ id: 'lead' });
  });

  it('buildRoundPatch blanks nested temp layerIds on reference segments', () => {
    const tempLayer = localId('layer');
    const patch = buildRoundPatch({
      title: 'Song',
      sections: [{ id: 'sec-new-1' }],
      layers: [{ id: tempLayer }],
      scoreParts: [],
      recordings: [],
      references: [{
        id: 'ref-1',
        segments: [{ layerId: tempLayer }, { layerId: 'lead' }],
      }],
    });
    expect(patch.sections[0].id).toBe('');
    expect(patch.layers[0].id).toBe('');
    expect(patch.references[0].segments).toEqual([
      { layerId: '' },
      { layerId: 'lead' },
    ]);
  });
});
// @vitest-environment node
