import { describe, it, expect } from 'vitest';
import {
  assetUrl,
  segmentDuration,
  timelineDuration,
  findSegmentAt,
  fadeMultiplier,
  overlayOpacityAt,
  audioTrackStateAt,
  stripKey,
  withKeys,
  timelinePatch,
} from './videoTimelineModel';

const clip = (inSec, outSec) => ({ type: 'clip', clipId: 'c', inSec, outSec });
const still = (durationSec) => ({ type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec });

describe('assetUrl', () => {
  it('maps each allowlisted kind to its served directory', () => {
    expect(assetUrl('images', 'plate.png')).toBe('/data/images/plate.png');
    expect(assetUrl('music', 'bed.mp3')).toBe('/data/music/bed.mp3');
    expect(assetUrl('video-thumbnails', 'thumb.jpg')).toBe('/data/video-thumbnails/thumb.jpg');
  });

  it('encodes the filename so a space or hash cannot break the URL', () => {
    expect(assetUrl('images', 'my plate #2.png')).toBe('/data/images/my%20plate%20%232.png');
  });

  it('returns null for an unknown kind or an empty filename', () => {
    expect(assetUrl('videos', 'x.mp4')).toBeNull();
    expect(assetUrl('images', '')).toBeNull();
  });
});

describe('segmentDuration / timelineDuration', () => {
  it('measures a still by its hold and a clip by its trim', () => {
    expect(segmentDuration(still(3))).toBe(3);
    expect(segmentDuration(clip(1, 4))).toBe(3);
  });

  it('never goes negative on an inverted trim', () => {
    expect(segmentDuration(clip(4, 1))).toBe(0);
  });

  it('sums a heterogeneous lane', () => {
    expect(timelineDuration([clip(0, 2), still(3), clip(1, 2)])).toBe(6);
  });
});

describe('findSegmentAt', () => {
  const lane = [clip(0, 2), still(3), clip(5, 6)];

  it('maps project time into the right segment', () => {
    expect(findSegmentAt(lane, 0.5)).toEqual({ index: 0, within: 0.5, startAtProj: 0 });
    expect(findSegmentAt(lane, 3)).toEqual({ index: 1, within: 1, startAtProj: 2 });
    expect(findSegmentAt(lane, 5.5)).toEqual({ index: 2, within: 0.5, startAtProj: 5 });
  });

  it('falls through an exact seam to the NEXT segment', () => {
    expect(findSegmentAt(lane, 2).index).toBe(1);
    expect(findSegmentAt(lane, 5).index).toBe(2);
  });

  it('clamps past the end to the last segment', () => {
    expect(findSegmentAt(lane, 99).index).toBe(2);
  });
});

describe('fadeMultiplier', () => {
  it('is 1 with no fades', () => {
    expect(fadeMultiplier(0, 0, 4, 2)).toBe(1);
  });

  it('ramps linearly in and out, matching ffmpeg\'s default tri curve', () => {
    expect(fadeMultiplier(1, 0, 4, 0)).toBe(0);
    expect(fadeMultiplier(1, 0, 4, 0.5)).toBeCloseTo(0.5);
    expect(fadeMultiplier(1, 0, 4, 1)).toBe(1);
    expect(fadeMultiplier(0, 2, 4, 3)).toBeCloseTo(0.5);
    expect(fadeMultiplier(0, 2, 4, 4)).toBe(0);
  });

  it('multiplies where an overlapping pair leaves no full-opacity window', () => {
    // 3s of fade across a 2s segment — the probe-clamped case.
    expect(fadeMultiplier(1.5, 1.5, 2, 1)).toBeCloseTo(1 / 1.5 * (1 / 1.5));
  });

  it('returns 1 rather than dividing by a zero duration', () => {
    expect(fadeMultiplier(1, 1, 0, 0)).toBe(1);
  });
});

describe('overlayOpacityAt', () => {
  const overlay = { startSec: 2, durationSec: 4, opacity: 0.5, fadeInSec: 1, fadeOutSec: 1 };

  it('is fully transparent outside its window', () => {
    expect(overlayOpacityAt(overlay, 1.9)).toBe(0);
    expect(overlayOpacityAt(overlay, 6.1)).toBe(0);
  });

  it('scales its configured opacity by the alpha ramp', () => {
    expect(overlayOpacityAt(overlay, 2)).toBe(0);
    expect(overlayOpacityAt(overlay, 2.5)).toBeCloseTo(0.25);
    expect(overlayOpacityAt(overlay, 4)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(overlay, 5.5)).toBeCloseTo(0.25);
  });

  it('defaults a missing opacity to fully opaque', () => {
    expect(overlayOpacityAt({ startSec: 0, durationSec: 2 }, 1)).toBe(1);
  });
});

describe('audioTrackStateAt', () => {
  const track = { startSec: 2, offsetSec: 30, durationSec: 4, volume: 0.8, fadeInSec: 1, fadeOutSec: 0 };

  it('is silent and inactive before its start', () => {
    expect(audioTrackStateAt(track, 0)).toMatchObject({ active: false, volume: 0 });
  });

  it('seeks the source at offset + elapsed, not at project time', () => {
    expect(audioTrackStateAt(track, 3).sourceTime).toBe(31);
  });

  it('applies the fade ramp to the configured volume', () => {
    expect(audioTrackStateAt(track, 2.5).volume).toBeCloseTo(0.4);
    expect(audioTrackStateAt(track, 4).volume).toBeCloseTo(0.8);
  });

  it('goes inactive at the exact end so it cannot double up with the next placement', () => {
    expect(audioTrackStateAt(track, 6).active).toBe(false);
  });
});

describe('save helpers', () => {
  it('strips the client-only _key', () => {
    expect(stripKey({ _key: 'k', clipId: 'c', inSec: 0 })).toEqual({ clipId: 'c', inSec: 0 });
  });

  it('gives every loaded lane entry a distinct key', () => {
    const keyed = withKeys([still(1), still(1)], 'seg');
    expect(keyed[0]._key).not.toBe(keyed[1]._key);
    expect(keyed[0]).toMatchObject({ type: 'still', durationSec: 1 });
  });

  it('builds a PATCH body with every lane present and no keys', () => {
    const patch = timelinePatch({
      segments: [{ ...clip(0, 2), _key: 'a' }],
      overlays: [{ assetKind: 'images', assetFile: 'l.png', startSec: 0, durationSec: 1, _key: 'b' }],
      audio: { clipVolume: 0.5, tracks: [{ assetKind: 'music', assetFile: 'b.mp3', startSec: 0, durationSec: 2, _key: 'c' }] },
    });

    expect(JSON.stringify(patch)).not.toContain('_key');
    expect(patch.segments).toHaveLength(1);
    expect(patch.overlays).toHaveLength(1);
    expect(patch.audio).toMatchObject({ clipVolume: 0.5 });
  });

  it('sends every lane even when empty, so clearing one actually persists', () => {
    expect(timelinePatch({})).toEqual({ segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] } });
  });
});
