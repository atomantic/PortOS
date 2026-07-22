import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoots = [];
const makeTmp = async (prefix) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
};
const musicDir = await makeTmp('chiptune-music-');

vi.mock('./tracks/index.js', () => ({
  getTrack: vi.fn(),
  updateTrack: vi.fn(),
  buildRenderAppend: vi.fn((track, input) => {
    const render = { id: 'render-test', ...input, createdAt: '2026-01-01T00:00:00.000Z' };
    return { render, renders: [...(track?.renders || []), render] };
  }),
}));

vi.mock('../lib/promptRunner.js', () => ({
  resolveProviderAndModel: vi.fn(),
  assertProvider: vi.fn(),
  runPromptThroughProvider: vi.fn(),
}));

vi.mock('./apps.js', () => ({
  getAppById: vi.fn(),
}));

// No ffmpeg in tests — the render path keeps the deterministic WAV output.
vi.mock('../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn().mockResolvedValue(null),
  runFfmpegProcess: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, music: musicDir } };
});

const tracks = await import('./tracks/index.js');
const promptRunner = await import('../lib/promptRunner.js');
const apps = await import('./apps.js');
const { generateChiptuneScore, renderChiptuneTrack, publishChiptuneTrack, buildChiptunePrompt } = await import('./chiptune.js');

const validScore = () => ({
  version: 1,
  bpm: 120,
  stepsPerBeat: 4,
  beatsPerBar: 4,
  channels: [{ id: 'pulse1', wave: 'square', duty: 0.5, gain: 0.5 }],
  patterns: { A: { bars: 1, notes: { pulse1: [{ step: 0, pitch: 'C5', len: 4 }] } } },
  order: ['A'],
});

const baseTrack = (extra = {}) => ({
  id: 'track-1', title: 'Farm Theme', renders: [], chiptuneScore: null, chiptunePrompt: '', ...extra,
});

afterAll(async () => {
  await Promise.all(tmpRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  vi.clearAllMocks();
  promptRunner.resolveProviderAndModel.mockResolvedValue({
    provider: { id: 'prov-1', type: 'api' }, selectedModel: 'model-x',
  });
  tracks.updateTrack.mockImplementation(async (id, patch) => ({ ...baseTrack(), ...patch }));
});

describe('generateChiptuneScore', () => {
  it('runs the provider with the score schema and persists the validated score', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());
    promptRunner.runPromptThroughProvider.mockResolvedValue({
      text: JSON.stringify(validScore()), provider: { id: 'prov-1' }, model: 'model-x',
    });

    const result = await generateChiptuneScore({ trackId: 'track-1', prompt: 'upbeat farm theme', providerId: 'prov-1', model: 'model-x' });

    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: { id: 'prov-1', type: 'api' },
      source: 'chiptune-score',
      model: 'model-x',
      responseSchema: expect.anything(),
    }));
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', {
      chiptuneScore: expect.objectContaining({ bpm: 120 }),
      chiptunePrompt: 'upbeat farm theme',
    });
    expect(result.providerId).toBe('prov-1');
    expect(result.model).toBe('model-x');
  });

  it('iterates on an existing score by default and starts fresh when asked', async () => {
    const existing = validScore();
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: existing }));
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(validScore()), provider: { id: 'prov-1' }, model: null });

    await generateChiptuneScore({ trackId: 'track-1', prompt: 'faster' });
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).toContain('CURRENT SCORE');

    await generateChiptuneScore({ trackId: 'track-1', prompt: 'faster', fresh: true });
    expect(promptRunner.runPromptThroughProvider.mock.calls[1][0].prompt).not.toContain('CURRENT SCORE');
  });

  it('rejects a response that fails schema validation after the runner', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify({ version: 1 }), provider: { id: 'prov-1' } });
    await expect(generateChiptuneScore({ trackId: 'track-1', prompt: 'x' }))
      .rejects.toMatchObject({ code: 'CHIPTUNE_BAD_RESPONSE' });
    expect(tracks.updateTrack).not.toHaveBeenCalled();
  });

  it('404s on an unknown track', async () => {
    tracks.getTrack.mockResolvedValue(null);
    await expect(generateChiptuneScore({ trackId: 'nope', prompt: 'x' }))
      .rejects.toMatchObject({ status: 404 });
  });
});

describe('buildChiptunePrompt', () => {
  it('embeds the request and, when iterating, the current score JSON', () => {
    const fresh = buildChiptunePrompt({ prompt: 'spooky cave theme', currentScore: null });
    expect(fresh).toContain('spooky cave theme');
    expect(fresh).not.toContain('CURRENT SCORE');
    const iterate = buildChiptunePrompt({ prompt: 'more drums', currentScore: validScore() });
    expect(iterate).toContain('CURRENT SCORE');
    expect(iterate).toContain('"order":["A"]');
  });
});

describe('renderChiptuneTrack', () => {
  it('400s when the track has no score', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());
    await expect(renderChiptuneTrack({ trackId: 'track-1' }))
      .rejects.toMatchObject({ code: 'CHIPTUNE_NO_SCORE' });
  });

  it('renders a WAV into the music library and appends a chiptune render', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore(), chiptunePrompt: 'farm loop' }));

    const result = await renderChiptuneTrack({ trackId: 'track-1' });

    expect(result.filename).toMatch(/^music-.+\.wav$/);
    const files = await readdir(musicDir);
    expect(files).toContain(result.filename);
    expect(result.durationSec).toBe(2); // 16 steps · 0.125s = 2s
    expect(tracks.buildRenderAppend).toHaveBeenCalledWith(expect.objectContaining({ id: 'track-1' }), {
      audioFilename: result.filename,
      prompt: 'farm loop',
      engine: 'chiptune',
      durationSec: result.durationSec,
    });
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', expect.objectContaining({
      audioFilename: result.filename,
      engine: 'chiptune',
      modelId: '',
    }));
  });
});

describe('publishChiptuneTrack', () => {
  it('404s when the app is unknown or has no repoPath', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore() }));
    apps.getAppById.mockResolvedValue(null);
    await expect(publishChiptuneTrack({ trackId: 'track-1', appId: 'nope' }))
      .rejects.toMatchObject({ code: 'CHIPTUNE_APP_NOT_FOUND' });
    apps.getAppById.mockResolvedValue({ id: 'app-1', name: 'Game', repoPath: '' });
    await expect(publishChiptuneTrack({ trackId: 'track-1', appId: 'app-1' }))
      .rejects.toMatchObject({ code: 'CHIPTUNE_APP_NOT_FOUND' });
  });

  it('rejects traversal and absolute subdirs before touching the filesystem', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore() }));
    const repo = await makeTmp('chiptune-repo-');
    apps.getAppById.mockResolvedValue({ id: 'app-1', name: 'Game', repoPath: repo });
    for (const subdir of ['../outside', 'a/../../b', '/etc', 'a\\..\\b']) {
      await expect(publishChiptuneTrack({ trackId: 'track-1', appId: 'app-1', subdir }))
        .rejects.toMatchObject({ code: 'CHIPTUNE_BAD_SUBDIR' });
    }
  });

  it('400s when the repo path does not exist on disk', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore() }));
    apps.getAppById.mockResolvedValue({ id: 'app-1', name: 'Game', repoPath: '/nonexistent/path/for/test' });
    await expect(publishChiptuneTrack({ trackId: 'track-1', appId: 'app-1' }))
      .rejects.toMatchObject({ code: 'CHIPTUNE_APP_REPO_MISSING' });
  });

  it('writes the audio + score JSON under the default subdir with a slugged name', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore() }));
    const repo = await makeTmp('chiptune-repo-');
    apps.getAppById.mockResolvedValue({ id: 'app-1', name: 'Game', repoPath: repo });

    const result = await publishChiptuneTrack({ trackId: 'track-1', appId: 'app-1' });

    expect(result.files).toEqual(['game/assets/music/farm-theme.wav', 'game/assets/music/farm-theme.score.json']);
    expect(result.format).toBe('wav'); // ffmpeg mocked away → WAV fallback
    const published = JSON.parse(await readFile(join(repo, 'game/assets/music/farm-theme.score.json'), 'utf8'));
    expect(published.bpm).toBe(120);
    const audio = await readFile(join(repo, 'game/assets/music/farm-theme.wav'));
    expect(audio.toString('ascii', 0, 4)).toBe('RIFF');
  });

  it('honors a custom subdir and slug', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ chiptuneScore: validScore() }));
    const repo = await makeTmp('chiptune-repo-');
    apps.getAppById.mockResolvedValue({ id: 'app-1', name: 'Game', repoPath: repo });

    const result = await publishChiptuneTrack({ trackId: 'track-1', appId: 'app-1', subdir: 'assets/bgm', slug: 'Overworld Theme!' });
    expect(result.files[0]).toBe('assets/bgm/overworld-theme.wav');
  });
});
