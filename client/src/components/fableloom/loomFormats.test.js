// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { LOOM_FORMATS as SERVER_FORMAT_IDS } from '../../../../server/lib/fableLoomFormats.js';
import {
  LOOM_FORMATS, episodesNeedingReformat, isTeleplayFormat, loomFormatHint, loomFormatLabel, sceneNeedsReformat,
} from './loomFormats.js';

describe('loomFormats', () => {
  it('offers exactly the ids the server accepts, in their declared order', () => {
    expect(LOOM_FORMATS.map((f) => f.id)).toEqual(SERVER_FORMAT_IDS);
  });

  it('labels and hints every id, and never falls through to a blank', () => {
    for (const { id } of LOOM_FORMATS) {
      expect(loomFormatLabel(id)).toBeTruthy();
      expect(loomFormatHint(id)).toBeTruthy();
    }
    // An unknown id degrades to the default rather than rendering empty chrome.
    expect(loomFormatLabel('haiku')).toBe(LOOM_FORMATS[0].label);
    expect(isTeleplayFormat('haiku')).toBe(false);
    expect(isTeleplayFormat('teleplay')).toBe(true);
  });
});

describe('reformat pending helpers', () => {
  const loom = {
    episodes: [
      { id: 'ep-1', nodes: [{ prose: 'Written.', format: 'prose' }, { prose: 'Also written.' }] },
      { id: 'ep-2', nodes: [{ prose: 'Converted.', format: 'teleplay' }] },
      { id: 'ep-3', nodes: [{ title: 'Placeholder', prose: '   ' }] },
    ],
  };

  it('counts only scenes with prose that is not already in the target format', () => {
    // A title-only placeholder has no beat to preserve, so it is never sent —
    // the model would invent one and it would land as if authored.
    expect(sceneNeedsReformat({ prose: '   ' }, 'teleplay')).toBe(false);
    expect(sceneNeedsReformat({ prose: 'Written.' }, 'teleplay')).toBe(true);
    expect(sceneNeedsReformat({ prose: 'Written.', format: 'teleplay' }, 'teleplay')).toBe(false);
    expect(sceneNeedsReformat(undefined, 'teleplay')).toBe(false);
  });

  it('lists only the episodes a rewrite still has work in', () => {
    expect(episodesNeedingReformat(loom, 'teleplay').map((e) => [e.episode.id, e.sceneCount]))
      .toEqual([['ep-1', 2]]);
    expect(episodesNeedingReformat(loom, 'prose').map((e) => [e.episode.id, e.sceneCount]))
      .toEqual([['ep-1', 1], ['ep-2', 1]]);
    expect(episodesNeedingReformat(undefined, 'prose')).toEqual([]);
  });
});
