import { mkdtemp, readdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const musicDir = await mkdtemp(join(tmpdir(), 'waveform-music-'));

vi.mock('./tracks/index.js', () => ({
  getTrack: vi.fn(),
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
const { drawWaveSketch, renderWaveSketchToTrack } = await import('./musicWaveform.js');

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

describe('renderWaveSketchToTrack', () => {
  it('renders the drawing into the music library as the active waveform take', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());

    const result = await renderWaveSketchToTrack({ trackId: 'track-1', sketch: drawnSketch(), prompt: 'glassy', title: 'Glass Tide' });

    expect(result.filename).toMatch(/^music-.+\.wav$/);
    expect(await readdir(musicDir)).toContain(result.filename);
    // 2s of 16-bit mono at 44.1 kHz behind a 44-byte header.
    expect((await readFile(join(musicDir, result.filename))).length).toBe(44 + 2 * 44100 * 2);
    expect(tracks.appendActiveTake).toHaveBeenCalledWith('track-1', {
      audioFilename: result.filename, prompt: 'glassy', engine: 'waveform', durationSec: 2,
    }, { title: 'Glass Tide' });
    expect(result.track).toMatchObject({ engine: 'waveform', title: 'Glass Tide' });
  });

  it('400s on an empty drawing and 404s on a missing track', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());
    await expect(renderWaveSketchToTrack({ trackId: 'track-1', sketch: { voices: [] } }))
      .rejects.toMatchObject({ status: 400, code: 'WAVEFORM_EMPTY' });
    tracks.getTrack.mockResolvedValue(null);
    await expect(renderWaveSketchToTrack({ trackId: 'gone', sketch: drawnSketch() }))
      .rejects.toMatchObject({ status: 404 });
    expect(tracks.appendActiveTake).not.toHaveBeenCalled();
  });
});
