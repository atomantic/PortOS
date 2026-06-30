import { describe, it, expect, vi, beforeEach } from 'vitest';

// Isolate the module's I/O boundaries so the pure builders + resolvers can be
// unit-tested without ffmpeg, the DB, or the filesystem.
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  probeVideoDuration: vi.fn(async () => 30),
}));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(), saveHistory: vi.fn(async () => {}) }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), updateProject: vi.fn(async () => ({})) }));

import { existsSync } from 'fs';
import {
  beatSnapClips,
  buildMusicVideoFfmpegArgs,
  resolveSceneClips,
  resolveMasterAudioPath,
  renderMusicVideo,
} from './render.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { loadHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject } from './projects.js';

const clip = (over = {}) => ({ videoPath: '/v/a.mp4', width: 768, height: 512, fps: 24, duration: 2, inSec: 0, outSec: 2, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
});

describe('buildMusicVideoFfmpegArgs', () => {
  it('concats video-only and maps one external audio bed', () => {
    const { args } = buildMusicVideoFfmpegArgs([clip({ videoPath: '/v/a.mp4' }), clip({ videoPath: '/v/b.mp4' })], '/music/track.wav', '/out.mp4', { audioDurationSec: 30 });
    const fc = args[args.indexOf('-filter_complex') + 1];
    // Video-only concat (a=0), no per-clip audio stubs.
    expect(fc).toContain('concat=n=2:v=1:a=0[outv]');
    expect(fc).not.toContain('anullsrc');
    expect(fc).not.toContain('atrim');
    expect(fc).not.toMatch(/\[a\d+\]/);
    // The track is the last input, mapped as the sole output audio (index 2).
    expect(args.slice(-3, -1)).not.toContain('anullsrc');
    expect(args).toContain('/music/track.wav');
    const maps = args.reduce((acc, a, i) => (a === '-map' ? [...acc, args[i + 1]] : acc), []);
    expect(maps).toEqual(['[outv]', '2:a']);
    expect(args).toContain('-shortest');
  });

  it('totalDuration is the min of video and audio length', () => {
    const r1 = buildMusicVideoFfmpegArgs([clip({ duration: 2, outSec: 2 }), clip({ duration: 2, outSec: 2 })], '/a.wav', '/o.mp4', { audioDurationSec: 30 });
    expect(r1.totalDuration).toBe(4); // video (4) < audio (30)
    const r2 = buildMusicVideoFfmpegArgs([clip({ duration: 20, outSec: 20 })], '/a.wav', '/o.mp4', { audioDurationSec: 10 });
    expect(r2.totalDuration).toBe(10); // audio (10) < video (20)
  });

  it('throws on empty clips', () => {
    expect(() => buildMusicVideoFfmpegArgs([], '/a.wav', '/o.mp4')).toThrow(/empty clips/);
  });
});

describe('beatSnapClips', () => {
  it('returns clips unchanged when there is no beat grid', () => {
    const out = beatSnapClips([clip({ duration: 2, outSec: 2 })], null);
    expect(out[0].outSec).toBe(2);
  });

  it('trims a cut back to a nearby beat (snap earlier, never extend)', () => {
    // clip natural end = 2.0; a beat at 1.95 is within tolerance → trim to 1.95.
    const out = beatSnapClips([clip({ duration: 2, outSec: 2 })], [0, 1.95, 4], { toleranceSec: 0.12 });
    expect(out[0].outSec).toBeCloseTo(1.95, 5);
    expect(out[0].duration).toBeCloseTo(1.95, 5);
  });

  it('does not extend a clip to a beat past its natural end', () => {
    // nearest beat (2.1) is AFTER the 2.0 natural end → no snap (can't grow a clip).
    const out = beatSnapClips([clip({ duration: 2, outSec: 2 })], [0, 2.1], { toleranceSec: 0.2 });
    expect(out[0].outSec).toBe(2);
  });

  it('ignores a beat outside the tolerance window', () => {
    const out = beatSnapClips([clip({ duration: 2, outSec: 2 })], [0, 1.5], { toleranceSec: 0.12 });
    expect(out[0].outSec).toBe(2);
  });

  it('never trims below the minimum clip length', () => {
    const out = beatSnapClips([clip({ duration: 0.5, outSec: 0.5 })], [0.45], { toleranceSec: 0.12, minClipSec: 0.4 });
    // snapping to 0.45 would leave 0.45 ≥ min, so it IS allowed here:
    expect(out[0].outSec).toBeCloseTo(0.45, 5);
    // but a beat that would shorten below min is rejected:
    const out2 = beatSnapClips([clip({ duration: 0.5, outSec: 0.5 })], [0.3], { toleranceSec: 0.3, minClipSec: 0.4 });
    expect(out2[0].outSec).toBe(0.5);
  });

  it('advances the running cursor by the snapped (not natural) duration', () => {
    // clip0 trims 2.0→1.95; clip1 natural end is then 1.95+2=3.95, beat at 3.9 → 1.95.
    const out = beatSnapClips([clip({ duration: 2, outSec: 2 }), clip({ duration: 2, outSec: 2 })], [1.95, 3.9], { toleranceSec: 0.12 });
    expect(out[0].outSec).toBeCloseTo(1.95, 5);
    expect(out[1].outSec).toBeCloseTo(1.95, 5); // 3.9 - 1.95
  });

  // #1854 — a director-arranged scene's saved startSec/endSec is honored
  // exactly, bypassing live re-derivation from the beat grid.
  describe('with a persisted scene arrangement', () => {
    it('honors a beatAligned scene\'s saved duration instead of the live grid', () => {
      const scenes = [{ sceneId: 's1', startSec: 10, endSec: 11.2, beatAligned: true }];
      // Without the override, the nearest beat (1.95) would trim the clip to 1.95s.
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], [1.95], { toleranceSec: 0.12, scenes });
      expect(out[0].outSec).toBeCloseTo(1.2, 5); // 11.2 - 10
      expect(out[0].duration).toBeCloseTo(1.2, 5);
    });

    it('clamps a persisted duration to the clip\'s own rendered length', () => {
      const scenes = [{ sceneId: 's1', startSec: 0, endSec: 100, beatAligned: true }];
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], null, { scenes });
      expect(out[0].outSec).toBe(2);
    });

    it('clamps a persisted duration to minClipSec', () => {
      const scenes = [{ sceneId: 's1', startSec: 0, endSec: 0.05, beatAligned: true }];
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], null, { scenes, minClipSec: 0.4 });
      expect(out[0].outSec).toBeCloseTo(0.4, 5);
    });

    it('falls back to live beat-snapping for a scene without beatAligned set', () => {
      const scenes = [{ sceneId: 's1', startSec: 10, endSec: 11.2, beatAligned: false }];
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], [1.95], { toleranceSec: 0.12, scenes });
      expect(out[0].outSec).toBeCloseTo(1.95, 5);
    });

    it('falls back to live beat-snapping when startSec/endSec are missing', () => {
      const scenes = [{ sceneId: 's1', beatAligned: true, startSec: null, endSec: null }];
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], [1.95], { toleranceSec: 0.12, scenes });
      expect(out[0].outSec).toBeCloseTo(1.95, 5);
    });

    it('advances the running cursor by the honored duration for later clips', () => {
      const scenes = [{ sceneId: 's1', startSec: 0, endSec: 1, beatAligned: true }];
      // clip0 honored at 1.0s exactly; clip1 (no scene match) natural end = 1+2=3, beat at 2.95 → 2.95-1=1.95.
      const out = beatSnapClips(
        [clip({ sceneId: 's1', duration: 2, outSec: 2 }), clip({ sceneId: 's2', duration: 2, outSec: 2 })],
        [2.95],
        { toleranceSec: 0.12, scenes },
      );
      expect(out[0].outSec).toBeCloseTo(1, 5);
      expect(out[1].outSec).toBeCloseTo(1.95, 5);
    });

    it('returns clips unchanged with no beat grid and no matching scenes', () => {
      const out = beatSnapClips([clip({ sceneId: 's1', duration: 2, outSec: 2 })], null, { scenes: [] });
      expect(out[0].outSec).toBe(2);
    });
  });
});

describe('resolveSceneClips', () => {
  it('resolves scenes with a clip, in order, skipping those without one', async () => {
    loadHistory.mockResolvedValue([
      { id: 'h1', filename: 'a.mp4', width: 768, height: 512, fps: 24, numFrames: 48 },
      { id: 'h2', filename: 'b.mp4', width: 768, height: 512, fps: 24, numFrames: 24 },
    ]);
    const project = { scenes: [
      { sceneId: 's2', order: 1, videoHistoryId: 'h2' },
      { sceneId: 's1', order: 0, videoHistoryId: 'h1' },
      { sceneId: 's3', order: 2, videoHistoryId: null }, // no clip yet → skipped
    ] };
    const clips = await resolveSceneClips(project);
    expect(clips.map((c) => c.sceneId)).toEqual(['s1', 's2']); // sorted by order
    expect(clips[0].duration).toBe(2); // 48/24
  });

  it('throws NO_SCENE_CLIPS when no scene has a clip', async () => {
    loadHistory.mockResolvedValue([]);
    await expect(resolveSceneClips({ scenes: [{ sceneId: 's1', order: 0, videoHistoryId: null }] }))
      .rejects.toMatchObject({ status: 400, code: 'NO_SCENE_CLIPS' });
  });

  it('throws MISSING_CLIPS when a clip id is not in history', async () => {
    loadHistory.mockResolvedValue([]); // h1 absent
    await expect(resolveSceneClips({ scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }] }))
      .rejects.toMatchObject({ status: 404, code: 'MISSING_CLIPS' });
  });

  it('throws MISSING_CLIPS when the clip file is gone', async () => {
    loadHistory.mockResolvedValue([{ id: 'h1', filename: 'a.mp4', width: 768, height: 512, fps: 24, numFrames: 48 }]);
    existsSync.mockReturnValue(false);
    await expect(resolveSceneClips({ scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }] }))
      .rejects.toMatchObject({ status: 404, code: 'MISSING_CLIPS' });
  });

  it('throws MISSING_CLIPS for a dimensionless history entry instead of an opaque ffmpeg failure', async () => {
    // A clip lacking width/height would render `scale=undefined:undefined`; treat
    // it as a missing clip so the caller gets the clean 4xx (mirrors the duration guard).
    loadHistory.mockResolvedValue([{ id: 'h1', filename: 'a.mp4', fps: 24, numFrames: 48 }]); // no width/height
    await expect(resolveSceneClips({ scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }] }))
      .rejects.toMatchObject({ status: 404, code: 'MISSING_CLIPS' });
  });
});

describe('renderMusicVideo mutex (#1760 re-entrancy guard)', () => {
  it('409s a second concurrent render for the same project', async () => {
    getProject.mockResolvedValue({ id: 'p1', name: 'P', trackId: 't1', status: 'ready', scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }] });
    loadHistory.mockResolvedValue([{ id: 'h1', filename: 'a.mp4', width: 768, height: 512, fps: 24, numFrames: 48 }]);
    getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
    // The first call hangs in prep (findFfmpeg never resolves) so its synchronously
    // reserved PENDING slot stays claimed across the await window.
    findFfmpeg.mockReturnValue(new Promise(() => {}));
    const first = renderMusicVideo('p1'); // do NOT await — hangs after claiming PENDING
    first.catch(() => {}); // it never settles; suppress any rejection noise
    await new Promise((r) => setTimeout(r, 0)); // let the first call claim PENDING

    await expect(renderMusicVideo('p1')).rejects.toMatchObject({ status: 409, code: 'RENDER_IN_PROGRESS' });
    findFfmpeg.mockResolvedValue('/usr/bin/ffmpeg'); // restore for any later test
  });

  it('releases the slot when prep throws (no stale 409 on retry)', async () => {
    // Audio resolves (track present) so prep reaches the clip check and throws there.
    getProject.mockResolvedValue({ id: 'p2', name: 'P', status: 'ready', trackId: 't1', scenes: [] });
    getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
    findFfmpeg.mockResolvedValue('/usr/bin/ffmpeg');
    loadHistory.mockResolvedValue([]);
    await expect(renderMusicVideo('p2')).rejects.toMatchObject({ code: 'NO_SCENE_CLIPS' });
    // The slot was released on the prep failure, so a retry reaches resolution
    // again (same throw, NOT a 409 from a stuck slot).
    await expect(renderMusicVideo('p2')).rejects.toMatchObject({ code: 'NO_SCENE_CLIPS' });
  });
});

describe('resolveMasterAudioPath', () => {
  it('resolves a linked track to its audio file', async () => {
    getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
    const p = await resolveMasterAudioPath({ trackId: 't1' });
    expect(p).toMatch(/song\.wav$/);
  });

  it('resolves an uploaded audio filename', async () => {
    const p = await resolveMasterAudioPath({ uploadedAudioFilename: 'upload.mp3' });
    expect(p).toMatch(/upload\.mp3$/);
  });

  it('400s when the project has no audio', async () => {
    await expect(resolveMasterAudioPath({})).rejects.toMatchObject({ status: 400, code: 'NO_AUDIO' });
  });

  it('404s when the linked track is missing', async () => {
    getTrack.mockResolvedValue(null);
    await expect(resolveMasterAudioPath({ trackId: 't1' })).rejects.toMatchObject({ status: 404 });
  });

  it('404s when the audio file is gone', async () => {
    getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
    existsSync.mockReturnValue(false);
    await expect(resolveMasterAudioPath({ trackId: 't1' })).rejects.toMatchObject({ status: 404, code: 'AUDIO_MISSING' });
  });
});
