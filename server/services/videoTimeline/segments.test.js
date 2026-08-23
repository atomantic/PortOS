import { describe, it, expect } from 'vitest';
import {
  TIMELINE_SCHEMA_VERSION,
  normalizeProject,
  validateSegments,
  validateOverlays,
  validateAudio,
  deriveLegacyClips,
  resolveAsset,
  assetPathFor,
  fitFades,
  segmentDuration,
  laneDuration,
} from './segments.js';

const CLIP_A = '11111111-1111-4111-8111-111111111111';
const CLIP_B = '22222222-2222-4222-8222-222222222222';

describe('normalizeProject — v1 → v2 upgrade', () => {
  it('promotes a legacy clips array to clip segments and stamps the schema version', () => {
    const v1 = {
      id: 'p1',
      name: 'Example Project',
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }, { clipId: CLIP_B, inSec: 1, outSec: 2.5 }],
    };

    const v2 = normalizeProject(v1);

    expect(v2.schemaVersion).toBe(TIMELINE_SCHEMA_VERSION);
    expect(v2.segments).toEqual([
      { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
      { type: 'clip', clipId: CLIP_B, inSec: 1, outSec: 2.5, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
    ]);
    expect(v2.overlays).toEqual([]);
    expect(v2.audio).toEqual({ clipVolume: 1, tracks: [] });
    // The mirror stays so a rolled-back v1 build still renders the video lane.
    expect(v2.clips).toEqual(v1.clips);
  });

  it('is idempotent — normalizing a v2 project changes nothing', () => {
    const once = normalizeProject({ id: 'p1', clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }] });
    expect(normalizeProject(once)).toEqual(once);
  });

  it('takes a diverged clips mirror as a rolled-back v1 build\'s edit, not a stale copy', () => {
    // v2 rebuilds the mirror on every write, so a mirror that disagrees with
    // the lane can only have been written by a v1 build after a rollback —
    // and that edit is newer than the lane it had no way to touch.
    const v2 = normalizeProject({
      id: 'p1',
      schemaVersion: 2,
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, fadeInSec: 0.5, volume: 0.3 }],
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }, { clipId: CLIP_B, inSec: 0, outSec: 9 }],
    });

    expect(v2.segments.map((s) => s.clipId)).toEqual([CLIP_A, CLIP_B]);
    // Effects the v1 build couldn't see ride across from the matching segment.
    expect(v2.segments[0]).toMatchObject({ fadeInSec: 0.5, volume: 0.3 });
    // A clip the v1 build added carries neutral defaults.
    expect(v2.segments[1]).toMatchObject({ clipId: CLIP_B, fadeInSec: 0, fadeOutSec: 0, volume: 1 });
  });

  it('keeps the lane when it holds stills — a v1 mirror cannot represent them', () => {
    const v2 = normalizeProject({
      id: 'p1',
      schemaVersion: 2,
      segments: [
        { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2 },
        { type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3 },
      ],
      // Honouring this would delete a still the old build never saw.
      clips: [{ clipId: CLIP_B, inSec: 0, outSec: 9 }],
    });

    expect(v2.segments).toHaveLength(2);
    expect(v2.segments[1]).toMatchObject({ type: 'still', assetFile: 'plate.png' });
    expect(v2.clips).toEqual([{ clipId: CLIP_A, inSec: 0, outSec: 2 }]);
  });

  it('leaves a matching mirror alone — no divergence, no reconciliation', () => {
    const v2 = normalizeProject({
      id: 'p1',
      schemaVersion: 2,
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, fadeInSec: 0.5, fadeOutSec: 0, volume: 0.3 }],
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }],
    });
    expect(v2.segments[0]).toMatchObject({ fadeInSec: 0.5, volume: 0.3 });
  });

  it('drops corrupt entries instead of throwing — this runs on every read', () => {
    const project = normalizeProject({
      id: 'p1',
      clips: 'not-an-array',
      segments: [
        null,
        { type: 'clip', clipId: CLIP_A, inSec: 3, outSec: 1 }, // inverted trim
        { type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec: 0 }, // zero hold
        { type: 'clip', clipId: CLIP_B, inSec: 0, outSec: 2 },
      ],
      overlays: 'nope',
      audio: [],
    });

    expect(project.segments).toHaveLength(1);
    expect(project.segments[0].clipId).toBe(CLIP_B);
    expect(project.overlays).toEqual([]);
    expect(project.audio).toEqual({ clipVolume: 1, tracks: [] });
  });

  it('carries stills, overlays and audio through unchanged', () => {
    const v2 = normalizeProject({
      id: 'p1',
      segments: [{ type: 'still', assetKind: 'images', assetFile: 'plate.png', durationSec: 3, fadeInSec: 0.5, fadeOutSec: 0.5 }],
      overlays: [{ assetKind: 'images', assetFile: 'logo.png', startSec: 1, durationSec: 2, x: 0.1, y: 0.2, width: 0.3, opacity: 0.8 }],
      audio: { clipVolume: 0.5, tracks: [{ assetKind: 'music', assetFile: 'bed.mp3', startSec: 0, durationSec: 5, volume: 0.4 }] },
    });

    expect(v2.segments[0]).toMatchObject({ type: 'still', assetFile: 'plate.png', durationSec: 3 });
    expect(v2.overlays[0]).toMatchObject({ type: 'image', assetFile: 'logo.png', opacity: 0.8 });
    expect(v2.audio.tracks[0]).toMatchObject({ assetFile: 'bed.mp3', volume: 0.4 });
    // Stills contribute no clip mirror — a v1 build has no way to render one.
    expect(v2.clips).toEqual([]);
  });
});

describe('validateSegments', () => {
  it('accepts a v1-shaped entry with no type and treats it as a clip', () => {
    expect(validateSegments([{ clipId: CLIP_A, inSec: 0, outSec: 2 }])[0]).toMatchObject({ type: 'clip', clipId: CLIP_A });
  });

  it('rejects an inverted trim', () => {
    expect(() => validateSegments([{ type: 'clip', clipId: CLIP_A, inSec: 2, outSec: 1 }]))
      .toThrow(/inSec\/outSec invalid/);
  });

  it('rejects an unknown segment type', () => {
    expect(() => validateSegments([{ type: 'caption', text: 'hi' }])).toThrow(/unknown segment type/);
  });

  it('rejects a fade pair that outlasts its own segment', () => {
    expect(() => validateSegments([{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, fadeInSec: 1.5, fadeOutSec: 1.5 }]))
      .toThrow(/exceeds its duration/);
  });

  it('rejects a still whose assetFile escapes its asset root', () => {
    expect(() => validateSegments([{ type: 'still', assetKind: 'images', assetFile: '../../etc/passwd', durationSec: 2 }]))
      .toThrow(/plain filename/);
  });

  it('rejects an assetKind outside the allowlist', () => {
    expect(() => validateSegments([{ type: 'still', assetKind: 'videos', assetFile: 'a.png', durationSec: 2 }]))
      .toThrow(/assetKind must be one of/);
  });

  it('clamps volume into range', () => {
    expect(validateSegments([{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, volume: 99 }])[0].volume).toBe(4);
    expect(validateSegments([{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2, volume: -1 }])[0].volume).toBe(0);
  });
});

describe('validateOverlays / validateAudio', () => {
  it('fills geometry defaults and clamps opacity', () => {
    const [ov] = validateOverlays([{ assetKind: 'images', assetFile: 'logo.png', startSec: 1, durationSec: 2, opacity: 5 }]);
    expect(ov).toMatchObject({ type: 'image', x: 0, y: 0, width: 0.25, opacity: 1 });
  });

  it('rejects an audio track pointing at the image gallery', () => {
    expect(() => validateAudio({ tracks: [{ assetKind: 'images', assetFile: 'a.png', startSec: 0, durationSec: 2 }] }))
      .toThrow(/assetKind must be one of/);
  });

  it('treats a null audio lane as the neutral default rather than an error', () => {
    expect(validateAudio(null)).toEqual({ clipVolume: 1, tracks: [] });
  });

  it('rejects a non-array tracks value', () => {
    expect(() => validateAudio({ tracks: 'bed.mp3' })).toThrow(/must be an array/);
  });
});

describe('resolveAsset', () => {
  it('refuses a traversal filename', () => {
    expect(resolveAsset('images', '../secrets.png', { requireExists: false })).toBeNull();
    expect(resolveAsset('images', 'nested/logo.png', { requireExists: false })).toBeNull();
  });

  it('refuses a kind outside the caller allowlist even when it is a known root', () => {
    expect(resolveAsset('music', 'bed.mp3', { allowedKinds: ['images'], requireExists: false })).toBeNull();
  });

  it('resolves a plain basename under its asset root', () => {
    const resolved = resolveAsset('images', 'logo.png', { requireExists: false });
    expect(resolved).toMatch(/data[/\\]images[/\\]logo\.png$/);
  });
});

describe('duration helpers', () => {
  it('measures a still by its hold and a clip by its trim', () => {
    expect(segmentDuration({ type: 'still', durationSec: 3 })).toBe(3);
    expect(segmentDuration({ type: 'clip', inSec: 1, outSec: 4 })).toBe(3);
  });

  it('sums the lane', () => {
    expect(laneDuration([
      { type: 'clip', inSec: 0, outSec: 2 },
      { type: 'still', durationSec: 3 },
    ])).toBe(5);
  });
});

describe('deriveLegacyClips', () => {
  it('keeps only clip segments, in lane order', () => {
    expect(deriveLegacyClips([
      { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 2 },
      { type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec: 1 },
      { type: 'clip', clipId: CLIP_B, inSec: 1, outSec: 3 },
    ])).toEqual([
      { clipId: CLIP_A, inSec: 0, outSec: 2 },
      { clipId: CLIP_B, inSec: 1, outSec: 3 },
    ]);
  });
});

describe('assetPathFor — a valid gallery basename must stay usable', () => {
  it('accepts a filename containing a `..` substring, which the gallery permits', () => {
    // `safeUnder` rejects any `..` substring, which would make this real
    // gallery file unselectable in the timeline.
    expect(assetPathFor('images', 'my..render.png')).toMatch(/data[/\\]images[/\\]my\.\.render\.png$/);
    expect(() => validateSegments([{ type: 'still', assetKind: 'images', assetFile: 'my..render.png', durationSec: 2 }]))
      .not.toThrow();
  });

  it('still refuses a traversal segment, a separator and the bare dots', () => {
    expect(assetPathFor('images', '../secrets.png')).toBeNull();
    expect(assetPathFor('images', 'nested/logo.png')).toBeNull();
    expect(assetPathFor('images', '..')).toBeNull();
    expect(assetPathFor('images', '.')).toBeNull();
    expect(assetPathFor('images', 'a\\b.png')).toBeNull();
  });

  it('refuses an unknown kind', () => {
    expect(assetPathFor('videos', 'clip.mp4')).toBeNull();
  });
});

describe('fitFades', () => {
  it('leaves a fitting pair alone', () => {
    expect(fitFades(1, 1, 4)).toEqual({ fadeInSec: 1, fadeOutSec: 1 });
  });

  it('scales an over-long pair proportionally rather than dropping one', () => {
    expect(fitFades(1, 3, 2)).toEqual({ fadeInSec: 0.5, fadeOutSec: 1.5 });
  });

  it('collapses to zero when the duration does', () => {
    expect(fitFades(1, 1, 0)).toEqual({ fadeInSec: 0, fadeOutSec: 0 });
  });
});

describe('reconcileLegacyMirror — a legacy trim must not strand an over-long fade', () => {
  it('refits fades carried onto a clip the v1 build shortened', () => {
    const v2 = normalizeProject({
      id: 'p1',
      schemaVersion: 2,
      segments: [{ type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 10, fadeInSec: 5, fadeOutSec: 5, volume: 0.5 }],
      // The v1 editor cut this to 2s; the old 5s+5s fade pair no longer fits.
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }],
    });

    const [seg] = v2.segments;
    expect(seg.outSec - seg.inSec).toBe(2);
    expect(seg.fadeInSec + seg.fadeOutSec).toBeLessThanOrEqual(2);
    expect(seg.volume).toBe(0.5);
    // The refitted result must survive the persist-time validator, or the
    // layered editor could never save this project again.
    expect(() => validateSegments(v2.segments)).not.toThrow();
  });
});

describe('asset extension gate', () => {
  it('refuses an image sidecar that lives in the same directory as the gallery', () => {
    // data/images also holds *.metadata.json; without this it is an acceptable
    // still that only fails at render as a bare `ffmpeg exit 1`.
    expect(() => validateSegments([{ type: 'still', assetKind: 'images', assetFile: 'shot.metadata.json', durationSec: 2 }]))
      .toThrow(/assetFile must be one of/);
  });

  it('refuses an image where an audio track is expected, and vice versa', () => {
    expect(() => validateAudio({ tracks: [{ assetKind: 'music', assetFile: 'cover.png', startSec: 0, durationSec: 2 }] }))
      .toThrow(/assetFile must be one of/);
    expect(() => validateOverlays([{ assetKind: 'images', assetFile: 'bed.mp3', startSec: 0, durationSec: 2 }]))
      .toThrow(/assetFile must be one of/);
  });

  it('accepts the formats each lane actually renders, case-insensitively', () => {
    expect(() => validateSegments([{ type: 'still', assetKind: 'images', assetFile: 'PLATE.PNG', durationSec: 2 }])).not.toThrow();
    expect(() => validateOverlays([{ assetKind: 'images', assetFile: 'logo.webp', startSec: 0, durationSec: 2 }])).not.toThrow();
    expect(() => validateAudio({ tracks: [{ assetKind: 'audio', assetFile: 'vo.wav', startSec: 0, durationSec: 2 }] })).not.toThrow();
  });
});
