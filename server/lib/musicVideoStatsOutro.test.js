import { describe, expect, it } from 'vitest';
import { STATS_OUTRO_FLOOR_MAX, musicVideoOutroStats, statsOutroDecisions, normalizeStatsOutro, statsOutroRows, statsOutroSeconds } from './musicVideoStatsOutro.js';

describe('cutting room floor outro', () => {
  it('is off unless turned on, and its length stays inside its limits', () => {
    expect(normalizeStatsOutro(null)).toBeNull();
    expect(statsOutroSeconds(null)).toBe(0);
    expect(statsOutroSeconds({ durationSec: 10 })).toBe(0);
    expect(normalizeStatsOutro({ enabled: true })).toEqual({ enabled: true, durationSec: 8 });
    expect(statsOutroSeconds({ enabled: true, durationSec: 99 })).toBe(20);
    expect(statsOutroSeconds({ enabled: true, durationSec: 1 })).toBe(4);
  });

  // The tally is the feature: every count must come from what the project records, each asset counted once.
  it('counts what was made, kept and turned down from the shots, the collection and the marks', () => {
    const project = {
      assetMarks: { 'image:bad.png': 'bad', 'image:kept.png': 'bad', 'image:never-made.png': 'bad' },
      scenes: [
        {
          sceneId: 's1', referenceImageId: 'kept.png', videoHistoryId: 'clip-kept', endImageId: 'end.png',
          transitionIn: 'vhs-glitch', transitionOut: 'channel-change', camera: { move: 'push-in' }, shotMode: 'performance',
          takes: [
            { kind: 'image', assetId: 'kept.png', status: 'candidate' },
            { kind: 'image', assetId: 'rejected.png', status: 'rejected' },
            { kind: 'video', assetId: 'clip-kept', status: 'candidate' },
            { kind: 'video', assetId: 'clip-rejected', status: 'rejected' },
            { kind: 'endImage', assetId: 'end.png', status: 'candidate' },
          ],
        },
        // Restored onto another shot after being rejected here: in the cut, so not a rejection.
        { sceneId: 's2', referenceImageId: 'rejected.png', imageEffect: 'flash-develop', takes: [] },
      ],
    };
    const collectionItems = [
      { kind: 'image', ref: 'kept.png' }, { kind: 'image', ref: 'floor.png' }, { kind: 'image', ref: 'bad.png' },
      { kind: 'video', ref: 'clip-floor' }, { kind: 'video', ref: 'clip-kept' }, { kind: 'audio', ref: 'ignored.mp3' },
    ];
    const stats = musicVideoOutroStats(project, { collectionItems });
    expect(stats).toEqual({
      stills: { made: 5, kept: 3 }, // kept, rejected (now on s2), end, floor, bad
      clips: { made: 3, kept: 1 },
      rejected: 2, // clip-rejected, and bad.png by its mark; kept.png is in the cut and never-made.png was never made
      shots: 2, lipSyncs: 1, transitions: 2, imageEffects: 1, cameraMoves: 1,
      floorImages: ['bad.png', 'floor.png'],
    });
    const rows = statsOutroRows(stats);
    expect(rows).toEqual([
      { label: 'Renders reviewed', value: 8 },
      { label: 'Images generated', value: 5 },
      { label: 'Images used', value: 3, choice: true },
      { label: 'Videos generated', value: 3 },
      { label: 'Videos used', value: 1, choice: true },
      { label: 'Cuts, moves & effects', value: 5, choice: true },
      { label: 'Left on the floor', value: 4, accent: true },
    ]);
    // Every shot dreamed up is a decision, then each still and clip used and each cut, move and effect.
    expect(statsOutroDecisions(stats)).toBe(2 + 3 + 1 + 5);
  });

  it('leaves out the choices never made and spreads the floor over the whole pile', () => {
    const collectionItems = Array.from({ length: 40 }, (_, i) => ({ kind: 'image', ref: `still-${String(i).padStart(2, '0')}.png` }));
    const stats = musicVideoOutroStats({ scenes: [{ sceneId: 's' }] }, { collectionItems });
    expect(stats.floorImages).toHaveLength(STATS_OUTRO_FLOOR_MAX);
    expect(stats.floorImages[0]).toBe('still-00.png');
    expect(stats.floorImages.at(-1) > 'still-35.png').toBe(true);
    expect(statsOutroRows(stats).map((row) => row.label)).toEqual(['Renders reviewed', 'Images generated', 'Images used', 'Videos generated', 'Videos used', 'Left on the floor']);
  });
});
