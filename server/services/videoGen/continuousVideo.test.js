import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';

vi.mock('./generateVideo.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./reactor.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./fal.js', () => ({ generateVideo: vi.fn() }));
vi.mock('./frameExtraction.js', () => ({ extractLastFrame: vi.fn(async () => ({ filename: 'frame-still.png' })) }));
vi.mock('./history.js', () => ({ getHistoryItem: vi.fn(async () => ({ clipId: 'reactor-clip-1' })) }));
vi.mock('./stitchVideos.js', () => ({
  stitchVideos: vi.fn(async (videoIds, opts) => ({
    filename: `${opts.id}.mp4`, thumbnail: `${opts.id}-thumb.png`,
  })),
}));

const { generateVideo: localGenerate } = await import('./generateVideo.js');
const { generateVideo: reactorGenerate } = await import('./reactor.js');
const { extractLastFrame } = await import('./frameExtraction.js');
const { getHistoryItem } = await import('./history.js');
const { stitchVideos } = await import('./stitchVideos.js');
const { videoGenEvents } = await import('./events.js');
const { generateContinuousVideoEpisode, composeEpisodeClips } = await import('./continuousVideo.js');

// Two-beat scene: a 20-word opening beat (always 'fresh'), then a second
// 20-word beat that overflows BEAT_MAX_WORDS (35) and becomes a 'continue'
// clip — mirrors the shape scriptVideoCompiler.compileScriptToClips emits.
const WORDS_20 = Array(20).fill('word').join(' ');
const scenes = [{
  sceneId: 'scene-1',
  location: 'loc1',
  lines: [
    { type: 'action', text: WORDS_20 },
    { type: 'action', text: WORDS_20 },
  ],
}];
const bible = {
  styleDescriptor: 'Style: painterly line art.',
  locations: { loc1: { descriptor: 'Location: a rain-slicked alley.' } },
  cast: {},
};

// Auto-resolve `completed` once the mocked generateVideo has been invoked for
// this jobId — matches how the real backends emit their terminal event
// asynchronously after returning a sync jobId descriptor.
const succeedOnce = ({ jobId }) => {
  queueMicrotask(() => videoGenEvents.emit('completed', { generationId: jobId, filename: `${jobId}.mp4` }));
  return Promise.resolve({ jobId });
};
const failOnce = ({ jobId }, error = 'render failed') => {
  queueMicrotask(() => videoGenEvents.emit('failed', { generationId: jobId, error }));
  return Promise.resolve({ jobId });
};
const succeedOn = (mockFn) => mockFn.mockImplementation(succeedOnce);
const failOn = (mockFn, error = 'render failed') => mockFn.mockImplementationOnce((args) => failOnce(args, error));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('composeEpisodeClips', () => {
  it('adds the hard-cut opener and bible references to a continuing clip', () => {
    const clips = composeEpisodeClips({ scenes, bible, framings: [null, 'medium shot'] });
    expect(clips).toHaveLength(2);
    expect(clips[0].cutType).toBe('fresh');
    expect(clips[1].cutType).toBe('continue');
    expect(clips[1].prompt.startsWith('Hard cut to medium shot:')).toBe(true);
    expect(clips[1].references).toEqual([{ kind: 'locations', id: 'loc1' }]);
  });

  it('leaves a continuing clip unmarked when no framing is supplied', () => {
    const clips = composeEpisodeClips({ scenes, bible });
    expect(clips[1].framing).toBeNull();
    expect(clips[1].prompt.startsWith('Hard cut to')).toBe(false);
  });
});

describe('generateContinuousVideoEpisode', () => {
  it('short-circuits on a lint failure without generating any clip', async () => {
    const result = await generateContinuousVideoEpisode({ scenes, bible, framings: [], backend: 'local' });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('lint');
    expect(result.lint.pass).toBe(false);
    expect(localGenerate).not.toHaveBeenCalled();
  });

  it('generates every clip in chain order and stitches the completed clips', async () => {
    succeedOn(localGenerate);
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(true);
    expect(localGenerate).toHaveBeenCalledTimes(2);
    // Second (continuing) clip conditions on the first clip's extracted last frame.
    expect(extractLastFrame).toHaveBeenCalledTimes(1);
    const secondCallArgs = localGenerate.mock.calls[1][0];
    expect(secondCallArgs.sourceImagePath).toContain('frame-still.png');
    expect(stitchVideos).toHaveBeenCalledWith(
      result.clipIds,
      expect.objectContaining({ historyKey: 'chainedFrom' }),
    );
    expect(result.filename).toBe(`${result.jobId}.mp4`);
  });

  it('re-establishes a failed continuation clip fresh instead of aborting the episode', async () => {
    // clip0 (fresh) succeeds; clip1's conditioned attempt fails ONCE; the
    // unconditioned retry that follows succeeds.
    localGenerate.mockImplementationOnce((args) => succeedOnce(args));
    localGenerate.mockImplementationOnce((args) => failOnce(args, 'continuation render failed'));
    localGenerate.mockImplementationOnce((args) => succeedOnce(args));
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(true);
    // clip0 (1 call) + clip1 failed attempt (1 call) + clip1 fresh retry (1 call)
    expect(localGenerate).toHaveBeenCalledTimes(3);
    const retryArgs = localGenerate.mock.calls[2][0];
    expect(retryArgs.sourceImagePath).toBeNull();
    expect(result.clipIds).toHaveLength(2);
  });

  it('aborts the episode when a fresh clip fails outright', async () => {
    failOn(localGenerate, 'backend unavailable');
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'local',
    });
    expect(result.ok).toBe(false);
    expect(result.stage).toBe('generation');
    expect(result.failedClipIndex).toBe(0);
    expect(stitchVideos).not.toHaveBeenCalled();
  });

  it('conditions a reactor continuation clip with continue_from_clip_id instead of a frame still', async () => {
    succeedOn(reactorGenerate);
    const result = await generateContinuousVideoEpisode({
      scenes, bible, framings: [null, 'medium shot'], backend: 'reactor',
    });
    expect(result.ok).toBe(true);
    expect(getHistoryItem).toHaveBeenCalledTimes(1);
    const secondCallArgs = reactorGenerate.mock.calls[1][0];
    expect(secondCallArgs.continueFromClipId).toBe('reactor-clip-1');
    expect(extractLastFrame).not.toHaveBeenCalled();
  });

  it('rejects an unknown backend', async () => {
    await expect(generateContinuousVideoEpisode({ scenes, bible, backend: 'bogus' }))
      .rejects.toThrow(/Unknown continuous-video backend/);
  });
});
