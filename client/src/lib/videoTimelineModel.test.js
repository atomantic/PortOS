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
  clampTrim,
  fitFadePatch,
  segmentVolumeAt,
  projectSummary,
  canvasAspectRatio,
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
describe('clampTrim', () => {
  const segment = { inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0 };

  it('clamps out to the source duration', () => {
    expect(clampTrim(segment, { outSec: 99 }, 5, 24)).toMatchObject({ outSec: 5 });
  });

  it('keeps at least one frame between in and out, matching the server guard', () => {
    // 24fps → 1/24s minimum, not the old hardcoded 0.04.
    expect(clampTrim(segment, { inSec: 4 }, 4, 24).outSec - clampTrim(segment, { inSec: 4 }, 4, 24).inSec)
      .toBeCloseTo(1 / 24);
  });

  it('shrinks fades that no longer fit the tightened trim', () => {
    const faded = { inSec: 0, outSec: 4, fadeInSec: 1, fadeOutSec: 1 };
    const patched = clampTrim(faded, { outSec: 1 }, 4, 24);
    expect(patched.fadeInSec + patched.fadeOutSec).toBeCloseTo(1);
  });
});

describe('fitFadePatch', () => {
  it('leaves a fitting fade pair untouched', () => {
    expect(fitFadePatch({ fadeInSec: 0.5, fadeOutSec: 0.5 }, { fadeInSec: 1 }, 4)).toEqual({ fadeInSec: 1 });
  });

  it('scales an over-long pair down proportionally rather than dropping one', () => {
    const patched = fitFadePatch({ fadeInSec: 1, fadeOutSec: 3 }, { fadeInSec: 1 }, 2);
    expect(patched.fadeInSec).toBeCloseTo(0.5);
    expect(patched.fadeOutSec).toBeCloseTo(1.5);
  });

  it('zeroes both fades when the duration collapses', () => {
    const patched = fitFadePatch({ fadeInSec: 1, fadeOutSec: 1 }, { durationSec: 0 }, 0);
    expect(patched).toMatchObject({ fadeInSec: 0, fadeOutSec: 0 });
  });
});

describe('segmentVolumeAt — preview must audition what the export mixes', () => {
  const seg = { type: 'clip', clipId: 'c', inSec: 0, outSec: 4, volume: 0.5, fadeInSec: 1, fadeOutSec: 0 };

  it('multiplies the project clip volume by the segment volume, exactly as the export chain does', () => {
    // Export builds `volume=${clipVolume * seg.volume}` ahead of the afade.
    expect(segmentVolumeAt(seg, 0.4, 2)).toBeCloseTo(0.2);
  });

  it('applies the segment fade on top of that product', () => {
    expect(segmentVolumeAt(seg, 1, 0.5)).toBeCloseTo(0.25);
    expect(segmentVolumeAt(seg, 1, 1)).toBeCloseTo(0.5);
  });

  it('defaults a missing clipVolume/volume to unity', () => {
    expect(segmentVolumeAt({ type: 'clip', inSec: 0, outSec: 2 }, null, 1)).toBe(1);
  });

  it('caps at 1 — a >1x multiplier cannot be honoured by a media element', () => {
    expect(segmentVolumeAt({ type: 'clip', inSec: 0, outSec: 2, volume: 4 }, 2, 1)).toBe(1);
  });

  it('is silent for a still — it carries no audio track', () => {
    expect(segmentVolumeAt({ type: 'still', durationSec: 3 }, 1, 1)).toBe(0);
  });
});

describe('projectSummary — the index must count the lane, not the mirror', () => {
  const thumbFor = (id) => (id === 'c1' ? 'c1.jpg' : null);

  it('counts stills, which the derived clips mirror deliberately omits', () => {
    const summary = projectSummary({
      segments: [
        { type: 'clip', clipId: 'c1', inSec: 0, outSec: 2 },
        { type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3 },
      ],
      // A layered project's mirror carries only its clip segments; reading it
      // here would under-report the timeline the editor actually plays.
      clips: [{ clipId: 'c1', inSec: 0, outSec: 2 }],
    }, thumbFor);

    expect(summary).toMatchObject({ blockCount: 2, totalSec: 5 });
  });

  it('does not report a stills-only project as empty', () => {
    const summary = projectSummary({
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 4 }],
      clips: [],
    }, thumbFor);

    expect(summary).toMatchObject({ blockCount: 1, totalSec: 4, firstThumb: '/data/images/plate.png' });
  });

  it('falls back to clips for a v1 project, where the mirror IS the lane', () => {
    expect(projectSummary({ clips: [{ clipId: 'c1', inSec: 1, outSec: 4 }] }, thumbFor))
      .toMatchObject({ blockCount: 1, totalSec: 3, firstThumb: '/data/video-thumbnails/c1.jpg' });
  });

  it('takes the first block\'s thumbnail, still or clip', () => {
    expect(projectSummary({
      segments: [
        { type: 'still', assetKind: 'images', assetFile: 'first.png', durationSec: 1 },
        { type: 'clip', clipId: 'c1', inSec: 0, outSec: 1 },
      ],
    }, thumbFor).firstThumb).toBe('/data/images/first.png');
  });

  it('reports an empty project as empty rather than throwing', () => {
    expect(projectSummary({}, thumbFor)).toEqual({ totalSec: 0, blockCount: 0, firstThumb: null });
  });
});

describe('overlayOpacityAt — clamped to the timeline length like the export', () => {
  const overlay = { startSec: 4, durationSec: 6, opacity: 1, fadeInSec: 0, fadeOutSec: 2 };

  it('pulls the fade-out earlier when the overlay outruns the video lane', () => {
    // The export clamps the overlay's end to the timeline length, so its
    // 2s fade-out lands at 6s–8s, not 8s–10s.
    expect(overlayOpacityAt(overlay, 7, 8)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(overlay, 8, 8)).toBe(0);
  });

  it('uses the configured window when the overlay fits', () => {
    expect(overlayOpacityAt(overlay, 7, 30)).toBe(1);
    expect(overlayOpacityAt(overlay, 9, 30)).toBeCloseTo(0.5);
  });

  it('is fully transparent once the limit cuts the window to nothing', () => {
    expect(overlayOpacityAt(overlay, 4, 4)).toBe(0);
  });
});

describe('canvasAspectRatio — the preview must match the export canvas', () => {
  const dims = { c1: { width: 1080, height: 1920 }, c2: { width: 1920, height: 1080 } };
  const dimsFor = (id) => dims[id];

  it('takes the FIRST clip segment, mirroring resolveTimeline', () => {
    expect(canvasAspectRatio([
      { type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec: 2 },
      { type: 'clip', clipId: 'c1' },
      { type: 'clip', clipId: 'c2' },
    ], dimsFor)).toBeCloseTo(1080 / 1920);
  });

  it('falls back to the server default for a stills-only project', () => {
    expect(canvasAspectRatio([{ type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec: 2 }], dimsFor))
      .toBeCloseTo(1280 / 720);
  });

  it('skips a clip whose dimensions are unknown rather than dividing by zero', () => {
    expect(canvasAspectRatio([{ type: 'clip', clipId: 'gone' }, { type: 'clip', clipId: 'c2' }], dimsFor))
      .toBeCloseTo(1920 / 1080);
  });
});

describe('overlay fade parity when the timeline clamps the window', () => {
  // 5s timeline, overlay starting at 4.5s with a 3s body and a 2s fade-out:
  // the window is cut to 0.5s, so the 2s fade cannot run as authored. Preview
  // and export must compress it identically or the render pops off on the
  // last frame while the editor showed it already gone.
  const overlay = { startSec: 4.5, durationSec: 3, opacity: 1, fadeInSec: 0, fadeOutSec: 2 };

  it('compresses the fade into the visible window, reaching zero exactly at the end', () => {
    expect(overlayOpacityAt(overlay, 4.5, 5)).toBe(1);
    expect(overlayOpacityAt(overlay, 4.75, 5)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(overlay, 5, 5)).toBe(0);
  });

  it('leaves an unclamped overlay on its authored ramp', () => {
    // Window [4.5, 7.5]; the 2s ramp therefore runs 5.5s → 7.5s.
    expect(overlayOpacityAt(overlay, 5.5, 30)).toBe(1);
    expect(overlayOpacityAt(overlay, 6.5, 30)).toBeCloseTo(0.5);
    expect(overlayOpacityAt(overlay, 7.5, 30)).toBe(0);
  });
});
