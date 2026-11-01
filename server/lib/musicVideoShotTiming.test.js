import { describe, it, expect } from 'vitest';
import {
  falSceneTake, falTakeRequestFields, performanceCapability, planPerformanceWindow, planShotSplit, shotSplitLimit,
  SOURCE_AUDIO_LIPSYNC, PERFORMANCE_WINDOW_MARGIN_SEC,
} from './musicVideoShotTiming.js';

// The split planner is an algorithm with a real input matrix (#8977): which
// boundary wins, how many pieces, and exact coverage are each ambiguous when
// seen only through the scene-split route, which asserts the record outcome.

const coverage = (pieces) => pieces.map((p) => [p.startSec, p.endSec]);
const expectContiguous = (pieces, startSec, endSec, maxSec) => {
  expect(pieces[0].startSec).toBe(startSec);
  expect(pieces.at(-1).endSec).toBe(endSec);
  for (let i = 1; i < pieces.length; i += 1) expect(pieces[i].startSec).toBe(pieces[i - 1].endSec);
  for (const p of pieces) expect(p.endSec - p.startSec).toBeLessThanOrEqual(maxSec + 1e-6);
};

describe('planShotSplit', () => {
  it('cuts in the pause between two sung lines rather than at the even midpoint', () => {
    const lyricCues = [
      { text: 'first line', startSec: 40, endSec: 47 },
      { text: 'second line', startSec: 49, endSec: 58 },
    ];
    const plan = planShotSplit({ startSec: 40, endSec: 60, maxSec: 14.75, lyricCues });
    expect(plan.ok).toBe(true);
    expect(coverage(plan.pieces)).toEqual([[40, 48], [48, 60]]);
    expect(plan.pieces.map((p) => p.cut)).toEqual(['pause', null]);
  });

  it('never cuts inside a sung line on a lyric/phrase boundary; falls to a beat, then an even cut', () => {
    // One long line covers the whole reachable cut range — only a beat may land inside it.
    const lyricCues = [{ text: 'held note', startSec: 0, endSec: 20 }];
    const phrases = [{ startSec: 9, endSec: 11, intent: 'turn' }];
    const onBeat = planShotSplit({ startSec: 0, endSec: 20, maxSec: 10.5, lyricCues, phrases, beats: [9.5, 10.2] });
    expect(coverage(onBeat.pieces)).toEqual([[0, 10.2], [10.2, 20]]);
    expect(onBeat.pieces[0].cut).toBe('beat');
    const even = planShotSplit({ startSec: 0, endSec: 20, maxSec: 10.5, lyricCues, phrases });
    expect(coverage(even.pieces)).toEqual([[0, 10], [10, 20]]);
    expect(even.pieces[0].cut).toBe('even');
  });

  it('uses the fewest pieces, each within the limit, covering the span exactly', () => {
    const plan = planShotSplit({ startSec: 12.5, endSec: 43.7, maxSec: 10 });
    expect(plan.pieces).toHaveLength(4);
    expectContiguous(plan.pieces, 12.5, 43.7, 10);
    // A phrase boundary out of reach of a feasible cut is ignored rather than
    // leaving a remainder too long for the pieces left.
    const reach = planShotSplit({ startSec: 0, endSec: 29, maxSec: 10, phrases: [{ startSec: 2, endSec: 3 }] });
    expect(reach.pieces).toHaveLength(3);
    expectContiguous(reach.pieces, 0, 29, 10);
  });

  it('adds at most one piece to keep every cut out of a sung line', () => {
    // Two pieces would have to cut inside the 9–21 line; three cut at 8.5 and 21.5.
    const lyricCues = [
      { text: 'a', startSec: 0, endSec: 8 },
      { text: 'b', startSec: 9, endSec: 21 },
      { text: 'c', startSec: 22, endSec: 28 },
    ];
    const clean = planShotSplit({ startSec: 0, endSec: 28, maxSec: 14.75, lyricCues });
    expect(coverage(clean.pieces)).toEqual([[0, 8.5], [8.5, 21.5], [21.5, 28]]);
    // A single 20s line cannot be cleanly cut even with an extra piece: keep the fewest.
    const held = planShotSplit({ startSec: 0, endSec: 20, maxSec: 14.75, lyricCues: [{ text: 'held', startSec: 0, endSec: 20 }] });
    expect(held.pieces).toHaveLength(2);
  });

  it('refuses an untimed shot and one that already fits the limit (boundary inclusive)', () => {
    expect(planShotSplit({ startSec: null, endSec: 30, maxSec: 10 })).toMatchObject({ ok: false, code: 'MUSIC_VIDEO_SPLIT_UNTIMED' });
    expect(planShotSplit({ startSec: 5, endSec: 15, maxSec: 10 })).toMatchObject({ ok: false, code: 'MUSIC_VIDEO_SPLIT_NOT_NEEDED' });
    expect(planShotSplit({ startSec: 5, endSec: 15.01, maxSec: 10 }).pieces).toHaveLength(2);
    // Just past an exact multiple still needs the extra piece; float noise at it does not.
    expect(planShotSplit({ startSec: 0, endSec: 20.000004, maxSec: 10 }).pieces).toHaveLength(3);
    expect(32.2 - 2.2).toBeGreaterThan(30);
    expect(planShotSplit({ startSec: 2.2, endSec: 32.2, maxSec: 10 }).pieces).toHaveLength(3);
  });
});

describe('shotSplitLimit', () => {
  it('bounds a performance by the lip-sync window and a Grok footage cutaway by its longest clip', () => {
    const fal = SOURCE_AUDIO_LIPSYNC.fal;
    expect(shotSplitLimit({ shotMode: 'performance' }, 'fal')).toBeCloseTo(fal.maxAudioSec - PERFORMANCE_WINDOW_MARGIN_SEC, 6);
    expect(shotSplitLimit({ shotMode: 'cutaway' }, 'grok')).toBe(15);
    // Blocked outright (not split) or unbounded lanes have no limit.
    expect(shotSplitLimit({ shotMode: 'performance' }, 'grok')).toBeNull();
    expect(shotSplitLimit({ shotMode: 'cutaway' }, 'fal')).toBeNull();
    expect(shotSplitLimit({ shotMode: 'cutaway', visualLayer: 'still' }, 'grok')).toBeNull();
  });
});

// Local LTX lip-sync (the song slice is the a2v audio): no provider minimum to
// pad to, and a shorter per-take ceiling than fal's.
describe('local LTX lip-sync lane', () => {
  it('plans the shot itself as the window, for lip-sync and music-driven scenes alike', () => {
    for (const performanceStyle of [null, 'music']) {
      const capability = performanceCapability('local', { scene: { shotMode: 'performance', performanceStyle } });
      expect(capability).toMatchObject({ provider: 'local', modelId: null, style: performanceStyle === 'music' ? 'music' : 'lipsync' });
      expect(planPerformanceWindow({ startSec: 2, endSec: 4.5, songDurationSec: 60, capability }))
        .toMatchObject({ ok: true, windowStartSec: 2, windowEndSec: 4.5, editInSec: 0 });
    }
    expect(planPerformanceWindow({ startSec: 0, endSec: 25, songDurationSec: 60, capability: performanceCapability('local') }))
      .toMatchObject({ ok: false, code: 'MUSIC_VIDEO_PERFORMANCE_TOO_LONG' });
    expect(shotSplitLimit({ shotMode: 'performance' }, 'local')).toBeCloseTo(20 - PERFORMANCE_WINDOW_MARGIN_SEC, 6);
  });
});

// Whole sung line: the take hears the full line while the edit still frames
// the shot. Catches a window that drops the line's start or end, counts a cue
// that only touches the shot, or overruns the per-take limit.
describe('whole sung line windows', () => {
  const capability = performanceCapability('fal');
  const cues = [
    { text: 'before', startSec: 30, endSec: 39.2 },
    { text: 'the line', startSec: 39.2, endSec: 45.6 },
    { text: 'after', startSec: 45.6, endSec: 50 },
  ];

  it('covers every lyric line the shot overlaps and keeps the shot as the edit', () => {
    expect(planPerformanceWindow({ startSec: 40.5, endSec: 42.8, songDurationSec: 60, capability, lineCues: cues })).toMatchObject({
      ok: true, windowStartSec: 39.2, windowEndSec: 45.6, windowSec: 6.4, editInSec: 1.3, editOutSec: 3.6,
      lineStartSec: 39.2, lineEndSec: 45.6, lineTooLong: false,
    });
  });

  it('pads a line shorter than the provider minimum around the line, and keeps the shot window for an over-long line', () => {
    const short = [{ text: 'hey', startSec: 10, endSec: 12 }];
    expect(planPerformanceWindow({ startSec: 10.5, endSec: 11, songDurationSec: 60, capability, lineCues: short }))
      .toMatchObject({ ok: true, windowStartSec: 8.475, windowEndSec: 13.525, lineStartSec: 10, lineEndSec: 12, editInSec: 2.025 });
    const long = [{ text: 'a very long line', startSec: 0, endSec: 40 }];
    expect(planPerformanceWindow({ startSec: 10, endSec: 16, songDurationSec: 60, capability, lineCues: long }))
      .toMatchObject({ ok: true, windowStartSec: 10, windowEndSec: 16, editInSec: 0, lineTooLong: true });
  });

  it('prices the whole-line take', () => {
    const scene = { shotMode: 'performance', startSec: 40.5, endSec: 42.8 };
    expect(falSceneTake({ scene, songDurationSec: 60, lineCues: cues })).toMatchObject({ seconds: 6.4, costUsd: 1.024 });
  });
});

// Each failure variant is a distinct admission regression: evidence, word
// gap, provider minimum, or timebase mismatch must never resubmit a prefix.
describe('music-driven performance takes', () => {
  // The drummer case: a 3.735s shot of the song whose motion the audio drives.
  const drummer = { shotMode: 'performance', performanceStyle: 'music', startSec: 212.718, endSec: 216.453 };

  it('render on H3 Max reference by default, the song window padded to exactly its shortest billed clip', () => {
    const take = falSceneTake({ scene: drummer, videoSettings: {}, songDurationSec: 240 });
    expect(take).toMatchObject({ performance: true, music: true, modelId: 'minimax/h3-max/reference-to-video', seconds: 5, resolution: '768P', costUsd: 0.4 });
    // A music-driven take names its model, so a shot card can pick another.
    expect(falTakeRequestFields(take)).toEqual({ falModelId: 'minimax/h3-max/reference-to-video', falResolution: '768P' });
    // The same shot as lip-sync pads to the route's 5s minimum plus its margin.
    expect(falSceneTake({ scene: { ...drummer, performanceStyle: null }, songDurationSec: 240 }).seconds).toBeCloseTo(5.05, 6);
    expect(shotSplitLimit(drummer, 'fal')).toBeCloseTo(15 - PERFORMANCE_WINDOW_MARGIN_SEC, 6);
  });

  it('follow the project pin (model and resolution) and fall back to the default for an uncurated pin', () => {
    // An audio-to-video model hears the shot itself, with no padding.
    const pinned = falSceneTake({ scene: drummer, videoSettings: { falMusicModelId: 'fal-ai/bytedance/omnihuman/v1.5', falMusicResolution: '720p' }, songDurationSec: 240 });
    expect(pinned).toMatchObject({ modelId: 'fal-ai/bytedance/omnihuman/v1.5', seconds: 3.735, resolution: '720p', costUsd: 0.5976 });
    const seedance = falSceneTake({ scene: drummer, videoSettings: { falMusicModelId: 'bytedance/seedance-2.5/reference-to-video' }, songDurationSec: 240 });
    expect(seedance).toMatchObject({ seconds: 4, resolution: '720p', costUsd: 1.892 });
    // A pin this install no longer curates (fal LTX-2.3, removed) falls back to the default.
    expect(falSceneTake({ scene: drummer, videoSettings: { falMusicModelId: 'fal-ai/ltx-2.3-22b/audio-to-video' }, songDurationSec: 240 }).modelId)
      .toBe('minimax/h3-max/reference-to-video');
  });
});

describe('fal model per shot', () => {
  it('uses the end-frame upgrade only on shots with an end frame, and only a model that takes one', () => {
    const KLING = 'fal-ai/kling-video/v3/pro/image-to-video';
    const shot = { sceneId: 's', startSec: 0, endSec: 2 };
    const videoSettings = { falEndFrameModelId: KLING };
    expect(falSceneTake({ scene: shot, videoSettings })).toMatchObject({ modelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video', seconds: 6, costUsd: 0.27 });
    expect(falSceneTake({ scene: { ...shot, endImageId: 'sketch.png' }, videoSettings })).toMatchObject({ modelId: KLING, seconds: 3, costUsd: 0.42 });
    expect(falSceneTake({ scene: { ...shot, endImageId: 'sketch.png' }, videoSettings: { falEndFrameModelId: 'fal-ai/veo3.1/fast/image-to-video' } }).modelId)
      .toBe('fal-ai/minimax/hailuo-02/standard/image-to-video');
  });
});

describe('accepted-prefix repair planning', () => {
  const scene = { shotMode: 'performance', sceneId: 'example', videoHistoryId: 'clip', startSec: 10, endSec: 24,
    takes: [{ kind: 'video', assetId: 'clip', shotInstruction: { shotMode: 'performance',
      songInterval: { startSec: 10, endSec: 24 }, audio: { songDurationSec: 30 }, audioWindow: { startSec: 8 },
      edit: { inSec: 2, outSec: 16 }, cues: [{ startSec: 2, endSec: 16, words: [
        { startSec: 2, endSec: 5.8 }, { startSec: 6.2, endSec: 16 },
      ] }] } }] };
  const temporal = { status: 'verified', takeId: 'clip', analyzer: { id: 'synthetic' }, spans: [
    { startSec: 2, endSec: 6, status: 'verified', offsetSec: 0.01, confidence: 0.95 },
    { startSec: 6, endSec: 16, status: 'verified', offsetSec: 0.3, confidence: 0.95 },
  ] };
  it('maps excerpt evidence and clip-relative words to the exact source suffix and reference frame', async () => {
    const { planPerformanceRepair } = await import('./musicVideoShotTiming.js');
    expect(planPerformanceRepair({ scene, temporal, excerptStartSec: 8, backend: 'fal' }))
      .toMatchObject({ ok: true, boundarySec: 14, endSec: 24, suffixSec: 10, referenceClipSec: 6, costUsd: 1.6 });
  });
  it('plans a take whose edit points were moved onto padded clip audio (#11210) in clip time', async () => {
    const { planPerformanceRepair } = await import('./musicVideoShotTiming.js');
    const aligned = structuredClone(scene);
    Object.assign(aligned.takes[0].shotInstruction, { edit: { inSec: 2.42, outSec: 16.42 }, alignment: { offsetSec: 0.42 } });
    expect(planPerformanceRepair({ scene: aligned, temporal, excerptStartSec: 8, backend: 'fal' }))
      .toMatchObject({ ok: true, boundarySec: 14, referenceClipSec: 6.42 });
  });
  it('rejects inconclusive/partial evidence, unsafe word gaps, short suffixes and unsupported routes', async () => {
    const { planPerformanceRepair } = await import('./musicVideoShotTiming.js');
    const plan = (overrides = {}) => planPerformanceRepair({ scene, temporal, excerptStartSec: 8, backend: 'fal', ...overrides });
    expect(plan({ temporal: { ...temporal, status: 'unverified' } }).ok).toBe(false);
    expect(plan({ temporal: { ...temporal, spans: [{ ...temporal.spans[0], confidence: null }, temporal.spans[1]] } }).ok).toBe(false);
    expect(plan({ excerptStartSec: 8.1 }).ok).toBe(false);
    expect(plan({ backend: 'grok' }).ok).toBe(false);
    const unsafe = structuredClone(scene);
    unsafe.takes[0].shotInstruction.cues[0].words[0].endSec = 6.3;
    expect(plan({ scene: unsafe }).ok).toBe(false);
    const short = structuredClone(scene);
    short.takes[0].shotInstruction.cues[0].words = [{ startSec: 2, endSec: 12 }, { startSec: 12.2, endSec: 16 }];
    expect(plan({ scene: short }).ok).toBe(false);
  });
});

// A cold-open shot with Clip sound on is the one take that asks for model
// sound; a request that drops the flag would hand that shot a silent clip.
describe('cold-open clip sound', () => {
  const kling = { falModelId: 'fal-ai/kling-video/v3/pro/image-to-video', falDuration: 5 };

  it('asks for sound and prices it only on a cold-open shot playing its clip sound', () => {
    const coldOpen = { preMusic: { durationSec: 4, clipVolume: 1 } };
    const take = falSceneTake({ scene: coldOpen, videoSettings: kling });
    expect(take).toMatchObject({ generateAudio: true, costUsd: 1.05 });
    expect(falTakeRequestFields(take)).toMatchObject({ falGenerateAudio: true });

    for (const scene of [{ preMusic: { durationSec: 4 } }, { startSec: 0, endSec: 5 }]) {
      const silent = falSceneTake({ scene, videoSettings: kling });
      expect(silent).toMatchObject({ generateAudio: false, costUsd: 0.7 });
      expect(falTakeRequestFields(silent)).not.toHaveProperty('falGenerateAudio');
    }
  });
});
