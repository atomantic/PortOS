import { describe, expect, it } from 'vitest';
import { parseSceneFilter, sceneAttention, sceneMatchesFilter } from './musicVideoSceneAttention.js';

const ready = { sceneId: 's', order: 0, referenceImageId: 'f.png', videoHistoryId: 'v1', startSec: 0, endSec: 4, takes: [] };

describe('sceneAttention', () => {
  it('is empty for a shot with its frame and clip', () => {
    expect(sceneAttention(ready)).toEqual([]);
  });

  it('flags missing frame and clip, but not a clip in a footage-optional mode', () => {
    expect(sceneAttention({ sceneId: 's' })).toEqual(['missing-frame', 'missing-clip']);
    expect(sceneAttention({ sceneId: 's', referenceImageId: 'f.png' }, { footageOptional: true })).toEqual([]);
  });

  it('flags a still or card with no span only in a layered composition', () => {
    const still = { ...ready, visualLayer: 'still', startSec: null, endSec: null };
    expect(sceneAttention(still, { layered: true })).toEqual(['no-span']);
    expect(sceneAttention(still, { layered: false })).toEqual([]);
    expect(sceneAttention({ sceneId: 's', visualLayer: 'card', startSec: 1, endSec: 3 }, { layered: true })).toEqual([]);
  });

  it('never asks a code shot for a frame or clip (#10297)', () => {
    expect(sceneAttention({ sceneId: 's', visualLayer: 'code', startSec: 1, endSec: 3 }, { layered: true })).toEqual([]);
    expect(sceneAttention({ sceneId: 's', visualLayer: 'code' }, { layered: true })).toEqual(['no-span']);
  });

  it('flags a non-looping beat-aligned shot longer than its measured clip', () => {
    const shot = { ...ready, loop: false, beatAligned: true, endSec: 10 };
    expect(sceneAttention(shot, { clipSec: 5 })).toEqual(['under-covered']);
    expect(sceneAttention(shot, { clipSec: 9.9 })).toEqual([]);
    expect(sceneAttention(shot)).toEqual([]);
    expect(sceneAttention({ ...shot, loop: true }, { clipSec: 5 })).toEqual([]);
  });

  it('flags a blocked performance, pending candidates, failures and an unverified plate', () => {
    const performance = { ...ready, shotMode: 'performance' };
    expect(sceneAttention(performance, { lipSyncBackend: 'local' })).toContain('perf-blocked');
    expect(sceneAttention({ ...ready, takes: [{ takeId: 't1', kind: 'image', assetId: 'g.png', status: 'candidate' }] })).toEqual(['candidates-pending']);
    expect(sceneAttention(ready, { failed: { video: { s: true } } })).toEqual(['last-failure']);
    const withIntent = { ...ready, direction: { actionContract: { purpose: 'Singer turns toward the door' } },
      takes: [{ takeId: 't1', kind: 'image', assetId: 'f.png', status: 'selected' }] };
    expect(sceneAttention(withIntent)).toContain('plate-unverified');
  });
});

describe('scene filters', () => {
  it('parses unknown values as all and splits missing from other attention', () => {
    expect(parseSceneFilter('nope')).toBe('all');
    expect(parseSceneFilter('missing')).toBe('missing');
    expect(sceneMatchesFilter(['last-failure'], 'attention')).toBe(true);
    expect(sceneMatchesFilter(['last-failure'], 'missing')).toBe(false);
    expect(sceneMatchesFilter(['missing-clip'], 'missing')).toBe(true);
    expect(sceneMatchesFilter([], 'attention')).toBe(false);
    expect(sceneMatchesFilter([], 'all')).toBe(true);
  });
});
