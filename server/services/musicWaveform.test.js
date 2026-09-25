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
const { PAINTED_CANVAS_LIMITS } = await import('../lib/paintedCanvas.js');

// The passage window a prompt asks for ("passage 2 of 3: t=30s to t=60s").
const windowOf = (prompt) => {
  const m = prompt.match(/passage (\d+) of (\d+): t=([\d.]+)s to t=([\d.]+)s/);
  return { index: Number(m[1]) - 1, count: Number(m[2]), start: Number(m[3]), end: Number(m[4]) };
};

// A reply painting one tonal and one noise stroke inside the asked-for window.
const paintReply = (prompt, extra = {}) => {
  const { index, start, end } = windowOf(prompt);
  const mid = (start + end) / 2;
  return {
    title: 'Glass Tide',
    strokes: [
      { name: `line${index + 1}`, overtones: [0.4], path: [{ t: start, hz: 220, a: 0.5 }, { t: mid, hz: 330, a: 0.6, overtones: [0.1, 0.5] }] },
      // Rings on past the passage end, into the next one.
      { name: `air${index + 1}`, width: 1200, pan: -0.4, path: [{ t: mid, hz: 5000, a: 0.2 }, { t: end + 1, hz: 4000, a: 0 }] },
      // Starts outside the window — discarded.
      { name: 'stray', path: [{ t: end + 0.5, hz: 440, a: 0.5 }, { t: end + 2, hz: 440, a: 0.5 }] },
    ],
    ...extra,
  };
};
const replyWith = (extra) => async ({ prompt }) => ({ text: JSON.stringify(paintReply(prompt, extra)), model: 'model-x' });

const baseTrack = (extra = {}) => ({ id: 'track-1', title: 'Untitled music draft', prompt: 'saved prompt', renders: [], ...extra });

const v1Sketch = () => normalizeWaveSketch({
  version: 1,
  durationSec: 2,
  shapes: { glass: [0, 0.8, 1, 0.3, 0, -0.5, -1, -0.2] },
  voices: [{ name: 'lead', shape: 'glass', notes: [{ t: 0, d: 1, pitch: 'A4' }, { t: 1, d: 1, pitch: 'E5' }] }],
});

afterAll(async () => { await rm(musicDir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.clearAllMocks();
  promptRunner.resolveProviderAndModel.mockResolvedValue({ provider: { id: 'prov-1', type: 'api' }, selectedModel: 'model-x' });
  promptRunner.runPromptThroughProvider.mockImplementation(replyWith());
});

describe('drawWaveSketch', () => {
  it('paints a short piece in one passage and returns the normalized v2 canvas', async () => {
    const result = await drawWaveSketch({ description: 'glassy tidal ambient', lyrics: 'salt on the glass', durationSec: 12, providerId: 'prov-1' });

    expect(promptRunner.runPromptThroughProvider).toHaveBeenCalledTimes(1);
    const args = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    expect(args).toMatchObject({ source: 'music-waveform', model: 'model-x' });
    expect(args.prompt).toContain('glassy tidal ambient');
    expect(args.prompt).toContain('salt on the glass');
    expect(args.prompt).toContain('passage 1 of 1: t=0s to t=12s');
    expect(args.prompt).not.toContain('CURRENT PAINTING');
    expect(args.screenshots).toBeUndefined();
    // The runner's schema is "paints at least one stroke inside the passage".
    expect(args.responseSchema(paintReply(args.prompt))).toBe(true);
    expect(args.responseSchema({ strokes: [{ path: [{ t: 20, hz: 440, a: 1 }, { t: 21, hz: 440, a: 1 }] }] })).toBe(false);

    expect(result.sketch).toMatchObject({ version: 2, title: 'Glass Tide', durationSec: 12, sections: [{ start: 0, end: 12 }] });
    expect(result.sketch.strokes.map((s) => s.name)).toEqual(['line1', 'air1']);
    expect(normalizeWaveSketch(result.sketch)).toEqual(result.sketch);
    expect(result.llm).toEqual({ provider: 'prov-1', model: 'model-x' });
  });

  it('describes only the canvas physics and limits — no arrangement, instruments, or vocal ban', async () => {
    await drawWaveSketch({ description: 'EXAMPLE BRIEF', lyrics: 'EXAMPLE TEXT', durationSec: 20 });
    const { prompt } = promptRunner.runPromptThroughProvider.mock.calls[0][0];
    const withoutInputs = prompt.replace('EXAMPLE BRIEF', '').replace('EXAMPLE TEXT', '');
    expect(withoutInputs).not.toMatch(/\b(melod\w*|bass\w*|drums?|percuss\w*|vocals?|voices?|sing\w*|sung|lead|pads?|chords?|harmon\w*|instruments?|compos\w*|verses?|chorus|arrang\w*|reverb|groove|genre)\b/i);
    // The numeric limits come from PAINTED_CANVAS_LIMITS.
    const L = PAINTED_CANVAS_LIMITS;
    for (const limit of [`${L.HZ_MIN} Hz`, `${L.HZ_MAX} Hz`, `up to ${L.OVERTONES_MAX} levels`, `at most ${L.KEYFRAMES_PER_STROKE_MAX}`, `${L.WIDTH_MIN_HZ}-${L.WIDTH_MAX_HZ} Hz`]) {
      expect(prompt).toContain(limit);
    }
    expect(prompt).toContain(`at most ${L.STROKES_MAX} strokes, ${L.KEYFRAMES_MAX} keyframes in total, and ${L.WORK_MAX_PARTIAL_SEC} units of render work`);
  });

  it('paints a long piece passage by passage, sharing the tempo grid and a summary of its neighbours', async () => {
    promptRunner.runPromptThroughProvider.mockImplementation(async ({ prompt }) => {
      const { index } = windowOf(prompt);
      return { text: JSON.stringify(paintReply(prompt, index === 0 ? { bpm: 100, beatsPerBar: 4 } : { bpm: 60, title: 'Ignored' })) };
    });

    const result = await drawWaveSketch({ description: 'x', durationSec: 70 });

    const prompts = promptRunner.runPromptThroughProvider.mock.calls.map(([args]) => args.prompt);
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('No tempo grid is set');
    // Once the first passage sets 100 BPM (a 2.4s bar), later boundaries land on bar lines.
    expect(result.sketch.sections).toEqual([{ start: 0, end: 23.333 }, { start: 23.333, end: 45.6 }, { start: 45.6, end: 70 }]);
    expect(prompts[1]).toContain('Tempo grid: 100 BPM, 4 beats per bar');
    expect(prompts[1]).toContain('passage 2 of 3: t=23.333s to t=45.6s');
    expect(prompts[1]).toMatch(/Passage 1 \(t 0-23\.333s\), 2 strokes:\n- line1: t 0-11\.67s, 220-330 Hz, peak a 0\.6, overtones/);
    expect(prompts[1]).toContain('- air1: sounding at t=23.333s');
    expect(prompts[2]).toMatch(/Passage 1 \(t 0-23\.333s\): 2 strokes, 220-5000 Hz/);
    expect(result.sketch).toMatchObject({ title: 'Glass Tide', bpm: 100, beatsPerBar: 4 });
    expect(result.sketch.strokes.map((s) => s.name)).toEqual(['line1', 'air1', 'line2', 'air2', 'line3', 'air3']);
    expect(result.passages).toBe(3);
  });

  it('repaints each passage of a v2 painting with its current strokes; a v1 drawing paints fresh', async () => {
    const { sketch: current } = await drawWaveSketch({ description: 'x', durationSec: 40 });
    vi.clearAllMocks();
    promptRunner.resolveProviderAndModel.mockResolvedValue({ provider: { id: 'prov-1', type: 'api' }, selectedModel: 'model-x' });
    promptRunner.runPromptThroughProvider.mockImplementation(replyWith({ title: 'New name' }));

    const revised = await drawWaveSketch({ description: 'x', guidance: 'brighter air', current });
    const prompts = promptRunner.runPromptThroughProvider.mock.calls.map(([args]) => args.prompt);
    expect(prompts).toHaveLength(current.sections.length);
    expect(prompts[0]).toContain('CURRENT PAINTING OF THIS PASSAGE');
    expect(prompts[0]).toContain('"name":"line1"');
    expect(prompts[0]).toContain('brighter air');
    expect(revised.sketch).toMatchObject({ durationSec: 40, sections: current.sections, title: current.title });

    promptRunner.runPromptThroughProvider.mockClear();
    await drawWaveSketch({ description: 'x', current: v1Sketch() });
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).not.toContain('CURRENT PAINTING');
  });

  it('with review, shows the model a spectrogram of each passage and repaints it once', async () => {
    const seen = [];
    promptRunner.runPromptThroughProvider.mockImplementation(async (args) => {
      if (args.screenshots) seen.push({ png: (await readFile(args.screenshots[0])).subarray(1, 4).toString(), prompt: args.prompt });
      return { text: JSON.stringify(paintReply(args.prompt)) };
    });
    const result = await drawWaveSketch({ description: 'x', durationSec: 10, review: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].png).toBe('PNG');
    expect(seen[0].prompt).toContain('ATTACHED IMAGE: a spectrogram of this passage');
    expect(seen[0].prompt).toContain('CURRENT PAINTING OF THIS PASSAGE');
    expect(result.reviewed).toBe(1);
  });

  it('keeps the painting when the provider cannot take the review image', async () => {
    promptRunner.runPromptThroughProvider.mockImplementation(async (args) => {
      if (args.screenshots) throw Object.assign(new Error('cannot receive image attachments'), { code: 'VISION_PROVIDER_UNSUPPORTED' });
      return { text: JSON.stringify(paintReply(args.prompt)) };
    });
    const result = await drawWaveSketch({ description: 'x', durationSec: 10, review: true });
    expect(result.reviewed).toBe(0);
    expect(result.sketch.strokes).toHaveLength(2);
  });

  it('502s when a passage has nothing playable', async () => {
    promptRunner.runPromptThroughProvider.mockResolvedValue({ text: 'I painted you a lovely picture!' });
    await expect(drawWaveSketch({ description: 'x' })).rejects.toMatchObject({ status: 502, code: 'WAVEFORM_BAD_RESPONSE' });
  });
});

describe('drawWaveSketchForTrack', () => {
  it('persists the painting and its description on the track', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack());

    const result = await drawWaveSketchForTrack({ trackId: 'track-1', description: 'glassy tidal ambient', durationSec: 8, revise: true });

    // No stored painting yet, so "revise" still paints fresh.
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).not.toContain('CURRENT PAINTING');
    const [, patch] = tracks.updateTrack.mock.calls[0];
    expect(patch.waveSketchPrompt).toBe('glassy tidal ambient');
    expect(patch.waveSketch).toMatchObject({ version: 2, durationSec: 8 });
    expect(result.sketch).toEqual(patch.waveSketch);
    expect(result.track).toMatchObject({ id: 'track-1', waveSketchPrompt: 'glassy tidal ambient' });
  });

  it('revises the STORED painting, and only when asked', async () => {
    const { sketch } = await drawWaveSketch({ description: 'x', durationSec: 8 });
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: sketch }));
    promptRunner.runPromptThroughProvider.mockClear();

    await drawWaveSketchForTrack({ trackId: 'track-1', description: 'x', revise: true });
    expect(promptRunner.runPromptThroughProvider.mock.calls[0][0].prompt).toContain('CURRENT PAINTING');
    await drawWaveSketchForTrack({ trackId: 'track-1', description: 'x' });
    expect(promptRunner.runPromptThroughProvider.mock.calls[1][0].prompt).not.toContain('CURRENT PAINTING');
  });

  it('404s on a missing track without calling the provider', async () => {
    tracks.getTrack.mockResolvedValue(null);
    await expect(drawWaveSketchForTrack({ trackId: 'gone', description: 'x' })).rejects.toMatchObject({ status: 404 });
    expect(promptRunner.runPromptThroughProvider).not.toHaveBeenCalled();
  });
});

describe('renderWaveSketchToTrack', () => {
  it('renders a stored painting into the music library as a stereo waveform take', async () => {
    const { sketch } = await drawWaveSketch({ description: 'x', durationSec: 2 });
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: sketch, waveSketchPrompt: 'painted from this' }));

    const result = await renderWaveSketchToTrack({ trackId: 'track-1', prompt: 'glassy', title: 'Glass Tide' });

    expect(result.filename).toMatch(/^music-.+\.wav$/);
    expect(await readdir(musicDir)).toContain(result.filename);
    const wav = await readFile(join(musicDir, result.filename));
    // 2s of 16-bit stereo at 44.1 kHz behind a 44-byte header.
    expect(wav.readUInt16LE(22)).toBe(2);
    expect(wav.length).toBe(44 + 2 * 44100 * 2 * 2);
    expect(tracks.appendActiveTake).toHaveBeenCalledWith('track-1', {
      audioFilename: result.filename, prompt: 'glassy', engine: 'waveform', durationSec: 2,
    }, { title: 'Glass Tide' });
    expect(result.track).toMatchObject({ engine: 'waveform', title: 'Glass Tide' });
  });

  it('still renders a stored v1 drawing as mono, defaulting the take prompt to its description', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: v1Sketch(), waveSketchPrompt: 'drawn from this' }));
    const result = await renderWaveSketchToTrack({ trackId: 'track-1' });
    const wav = await readFile(join(musicDir, result.filename));
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.length).toBe(44 + 2 * 44100 * 2);
    expect(tracks.appendActiveTake.mock.calls[0][1]).toMatchObject({ prompt: 'drawn from this' });
  });

  it('400s when the track has no painting and 404s on a missing track', async () => {
    tracks.getTrack.mockResolvedValue(baseTrack({ waveSketch: null }));
    await expect(renderWaveSketchToTrack({ trackId: 'track-1' }))
      .rejects.toMatchObject({ status: 400, code: 'WAVEFORM_EMPTY' });
    tracks.getTrack.mockResolvedValue(null);
    await expect(renderWaveSketchToTrack({ trackId: 'gone' }))
      .rejects.toMatchObject({ status: 404 });
    expect(tracks.appendActiveTake).not.toHaveBeenCalled();
  });
});
