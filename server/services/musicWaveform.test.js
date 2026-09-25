import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const musicDir = await mkdtemp(join(tmpdir(), 'waveform-music-'));

vi.mock('./tracks/index.js', () => ({
  getTrack: vi.fn(),
  updateTrack: vi.fn(async (id, patch) => ({ id, ...patch })),
  appendActiveTake: vi.fn(async (id, take, patch) => ({ id, ...take, ...patch })),
}));

vi.mock('./promptRunner.js', async () => ({
  ...(await vi.importActual('./promptRunner.js')),
  resolveProviderAndModel: vi.fn(),
  runPromptThroughProvider: vi.fn(),
}));

// No ffmpeg in tests — the render keeps the deterministic WAV output.
vi.mock('../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn().mockResolvedValue(null),
  runFfmpegProcess: vi.fn(),
}));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, music: musicDir } };
});

const tracks = await import('./tracks/index.js');
const promptRunner = await import('./promptRunner.js');
const { drawWaveSketch, drawWaveSketchForTrack, renderWaveSketchToTrack } = await import('./musicWaveform.js');
const { normalizeWaveSketch } = await import('../lib/waveSketch.js');

const drawnSketch = () => ({
  version: 1,
  title: 'Glass Tide',
  durationSec: 2,
  shapes: { glass: [0, 0.8, 1, 0.3, 0, -0.5, -1, -0.2] },
  voices: [{ name: 'lead', shape: 'glass', notes: [{ t: 0, d: 1, pitch: 'A4' }, { t: 1, d: 1, pitch: 'E5' }] }],
});

const baseTrack = (extra = {}) => ({ id: 'track-1', title: 'Untitled music draft', prompt: 'saved prompt', renders: [], ...extra });

afterAll(async () => { await rm(musicDir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.clearAllMocks();
  promptRunner.resolveProviderAndModel.mockResolvedValue({ provider: { id: 'prov-1', type: 'api' }, selectedModel: 'model-x' });
});

describe('drawWaveSketch', () => {
  it('asks for a drawing and returns the normalized sketch', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(drawnSketch()), model: 'model-x' });

    const result = await drawWaveSketch({ description: 'glassy tidal ambient', lyrics: '[verse]\nsalt', durationSec: 12, providerId: 'prov-1' });

    const args = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(args).toMatchObject({ source: 'music-waveform', model: 'model-x' });
    expect(args.prompt).toContain('glassy tidal ambient');
    expect(args.prompt).toContain('about 12 seconds');
    expect(args.prompt).not.toContain('CURRENT SKETCH');
    // The runner's schema is "normalizes to something playable".
    expect(args.responseSchema(drawnSketch())).toBe(true);
    expect(args.responseSchema({ voices: [] })).toBe(false);
    expect(result.sketch.voices[0].notes[0]).toMatchObject({ hz: 440, pitch: 'A4' });
    expect(result.llm).toEqual({ provider: 'prov-1', model: 'model-x' });
  });

  it('sends the current drawing back when revising', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(drawnSketch()) });
    await drawWaveSketch({ description: 'x', guidance: 'punchier kick', current: drawnSketch() });
    const { prompt } = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(prompt).toContain('CURRENT SKETCH');
    expect(prompt).toContain('"glass"');
    expect(prompt).toContain('punchier kick');
  });

  it('502s when the reply has nothing playable', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: 'I drew you a lovely picture!' });
    await expect(drawWaveSketch({ description: 'x' })).rejects.toMatchObject({ status: 502, code: 'WAVEFORM_BAD_RESPONSE' });
  });
});

describe('drawWaveSketchForTrack', () => {
  it('persists the drawing and its description on the track', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(drawnSketch()), model: 'model-x' });

    const result = await drawWaveSketchForTrack({ trackId: 'track-1', description: 'glassy tidal ambient', revise: true });

    // No stored drawing yet, so "revise" still draws fresh.
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).not.toContain('CURRENT SKETCH');
    expect(tracks.updateTrack).toHaveBeenCalledWith('track-1', {
      waveSketch: normalizeWaveSketch(drawnSketch()), waveSketchPrompt: 'glassy tidal ambient',
    });
    expect(result.sketch).toEqual(normalizeWaveSketch(drawnSketch()));
    expect(result.track).toMatchObject({ id: 'track-1', waveSketchPrompt: 'glassy tidal ambient' });
  });

  it('revises the STORED drawing, and only when asked', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: normalizeWaveSketch(drawnSketch()) }));
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: JSON.stringify(drawnSketch()) });

    await drawWaveSketchForTrack({ trackId: 'track-1', description: 'x', revise: true });
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).toContain('CURRENT SKETCH');
    await drawWaveSketchForTrack({ trackId: 'track-1', description: 'x' });
    expect(promptRunner.runPromptThroughProvider.mock.calls[1][0].prompt).not.toContain('CURRENT SKETCH');
  });

  it('404s on a missing track without calling the provider', async () => {
    tracks.getTrack.mockResolvedValue(null);
    await expect(drawWaveSketchForTrack({ trackId: 'gone', description: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });
});

describe('renderWaveSketchToTrack', () => {
  it('renders the stored drawing into the music library as the active waveform take', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: normalizeWaveSketch(drawnSketch()), waveSketchPrompt: 'drawn from this' }));

    const result = await renderWaveSketchToTrack({ trackId: 'track-1', prompt: 'glassy', title: 'Glass Tide' });

    expect(result.filename).toMatch(/^music-.+\.wav$/);
    expect(await readdir(musicDir)).toContain(result.filename);
    // 2s of 16-bit mono at 44.1 kHz behind a 44-byte header.
    expect((await readFile(join(musicDir, result.filename))).length).toBe(44 + 2 * 44100 * 2);
    expect(tracks.appendActiveTake).toHaveBeenCalledWith('track-1', {
      audioFilename: result.filename, prompt: 'glassy', engine: 'waveform', durationSec: 2,
    }, { title: 'Glass Tide' });
    expect(result.track).toMatchObject({ engine: 'waveform', title: 'Glass Tide' });
  });

  it('defaults the take prompt to the description the drawing came from', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: normalizeWaveSketch(drawnSketch()), waveSketchPrompt: 'drawn from this' }));
    await renderWaveSketchToTrack({ trackId: 'track-1' });
    expect(tracks.appendActiveTake.mock.calls[0][1]).toMatchObject({ prompt: 'drawn from this' });
  });

  it('400s when the track has no drawing and 404s on a missing track', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: null }));
    await expect(renderWaveSketchToTrack({ trackId: 'track-1' }))
      .rejects.toMatchObject({ status: 400, code: 'WAVEFORM_EMPTY' });
    tracks.getTrack.mockResolvedValue(null);
    await expect(renderWaveSketchToTrack({ trackId: 'gone' }))
      .rejects.toMatchObject({ status: 404 });
    expect(tracks.appendActiveTake).not.toHaveBeenCalled();
  });
});
