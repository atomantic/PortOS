import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the I/O boundaries; keep catalogTypes real (pure snippet transform) so
// buildPortraitPrompt exercises the actual physicalDescription fallback chain.
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
}));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(),
}));
vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: vi.fn(() => ({ cleanC2PA: true, denoise: false })),
}));
vi.mock('../catalogDB.js', () => ({
  getIngredient: vi.fn(),
  listMediaForIngredient: vi.fn(),
}));

import { buildPortraitPrompt, enqueueFirstPassPortraits, enqueueFirstPassSceneFrames } from './firstPassGen.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { getIngredient, listMediaForIngredient } from '../catalogDB.js';

let jobSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  jobSeq = 0;
  enqueueJob.mockImplementation(() => ({ jobId: `job-${++jobSeq}`, position: 1, status: 'queued' }));
  // Default: local mode configured, ingredients have no portrait.
  getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: { pythonPath: '/py' } } });
  listMediaForIngredient.mockResolvedValue([]);
});

describe('buildPortraitPrompt', () => {
  it('joins name + the physicalDescription snippet for a character', () => {
    const prompt = buildPortraitPrompt({
      id: 'c1', type: 'character', name: 'Vale',
      payload: { physicalDescription: 'a tall noir detective in a trench coat', description: 'ignored' },
    });
    expect(prompt).toBe('Vale — a tall noir detective in a trench coat');
  });

  it('falls back to description for non-character types', () => {
    const prompt = buildPortraitPrompt({
      id: 'p1', type: 'place', name: 'The Pier', payload: { description: 'a fog-soaked dock at night' },
    });
    expect(prompt).toBe('The Pier — a fog-soaked dock at night');
  });

  it('uses the name alone when there is no descriptive payload', () => {
    expect(buildPortraitPrompt({ id: 'x', type: 'object', name: 'Brass Key', payload: {} })).toBe('Brass Key');
  });

  it('returns "" for a null / nameless+descriptionless ingredient', () => {
    expect(buildPortraitPrompt(null)).toBe('');
    expect(buildPortraitPrompt({ id: 'x', type: 'object', name: '   ', payload: {} })).toBe('');
  });
});

describe('enqueueFirstPassPortraits', () => {
  it('enqueues a portrait-tagged job per member lacking a portrait', async () => {
    getIngredient.mockImplementation(async (id) => ({
      id, type: 'character', name: `Name-${id}`, payload: { physicalDescription: `desc ${id}` },
    }));
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }, { ingredientId: 'b' }]);
    expect(out.mode).toBe('local');
    expect(out.enqueued).toEqual([
      { ingredientId: 'a', jobId: 'job-1' },
      { ingredientId: 'b', jobId: 'job-2' },
    ]);
    expect(out.skipped).toEqual([]);
    // Each job carries the catalogAttach tag the durable hook keys off, with an
    // explicit portrait kind and the local pythonPath/cleaners folded in.
    const firstJob = enqueueJob.mock.calls[0][0];
    expect(firstJob.kind).toBe('image');
    expect(firstJob.params.catalogAttach).toEqual({ ingredientId: 'a', kind: 'portrait' });
    expect(firstJob.params.prompt).toBe('Name-a — desc a');
    expect(firstJob.params.pythonPath).toBe('/py');
    expect(firstJob.params.cleanC2PA).toBe(true);
  });

  it('skips a member that already has a portrait (idempotent re-run)', async () => {
    getIngredient.mockImplementation(async (id) => ({ id, type: 'character', name: id, payload: { physicalDescription: 'd' } }));
    listMediaForIngredient.mockImplementation(async (id) =>
      id === 'a' ? [{ kind: 'portrait', mediaKey: 'a.png' }] : []);
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }, { ingredientId: 'b' }]);
    expect(out.enqueued).toEqual([{ ingredientId: 'b', jobId: 'job-1' }]);
    expect(out.skipped).toEqual([{ ingredientId: 'a', reason: 'has-portrait' }]);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('skips a gone ingredient and one with no usable prompt', async () => {
    getIngredient.mockImplementation(async (id) => {
      if (id === 'gone') return null;
      if (id === 'blank') return { id, type: 'object', name: '   ', payload: {} };
      return { id, type: 'character', name: id, payload: { physicalDescription: 'd' } };
    });
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'gone' }, { ingredientId: 'blank' }, { ingredientId: 'ok' }]);
    expect(out.enqueued).toEqual([{ ingredientId: 'ok', jobId: 'job-1' }]);
    expect(out.skipped).toEqual([
      { ingredientId: 'gone', reason: 'gone' },
      { ingredientId: 'blank', reason: 'no-prompt' },
    ]);
  });

  it('enqueues codex-mode jobs only when codex is enabled', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'codex', codex: { enabled: true, codexPath: '/cx', model: 'gpt-image' } } });
    getIngredient.mockResolvedValue({ id: 'a', type: 'character', name: 'A', payload: { physicalDescription: 'd' } });
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }]);
    expect(out.mode).toBe('codex');
    expect(out.enqueued).toHaveLength(1);
    expect(enqueueJob.mock.calls[0][0].params.mode).toBe('codex');
    expect(enqueueJob.mock.calls[0][0].params.codexPath).toBe('/cx');
  });

  it('skips gracefully when codex is the mode but disabled', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'codex', codex: { enabled: false } } });
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }]);
    expect(out).toEqual({ mode: 'codex', enqueued: [], skipped: [], reason: 'codex-disabled' });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(getIngredient).not.toHaveBeenCalled();
  });

  it('skips gracefully when local mode has no pythonPath (default model would fail unseen)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'local', local: {} } });
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }]);
    expect(out).toEqual({ mode: 'local', enqueued: [], skipped: [], reason: 'local-not-configured' });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(getIngredient).not.toHaveBeenCalled();
  });

  it('skips gracefully for external mode (not queue-backed)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    const out = await enqueueFirstPassPortraits([{ ingredientId: 'a' }]);
    expect(out).toEqual({ mode: 'external', enqueued: [], skipped: [], reason: 'mode-unsupported' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns an empty summary for no members (never reads settings)', async () => {
    const out = await enqueueFirstPassPortraits([]);
    expect(out).toEqual({ mode: null, enqueued: [], skipped: [] });
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('ignores members without an ingredientId', async () => {
    getIngredient.mockResolvedValue({ id: 'a', type: 'character', name: 'A', payload: { physicalDescription: 'd' } });
    const out = await enqueueFirstPassPortraits([{ foo: 'bar' }, null, { ingredientId: 'a' }]);
    expect(out.enqueued).toEqual([{ ingredientId: 'a', jobId: 'job-1' }]);
  });
});

describe('enqueueFirstPassSceneFrames (#1867)', () => {
  const scene = (over = {}) => ({
    sceneId: 's1', order: 0, intent: 'x', prompt: 'a cat walks into a noir alley',
    durationSeconds: 4, status: 'pending', ...over,
  });

  it('enqueues a creativeDirector-tagged job per scene lacking a reference frame', async () => {
    const project = { id: 'cd-1', treatment: { scenes: [scene({ sceneId: 's1' }), scene({ sceneId: 's2' })] } };
    const out = await enqueueFirstPassSceneFrames(project);
    expect(out.mode).toBe('local');
    expect(out.enqueued).toEqual([
      { sceneId: 's1', jobId: 'job-1' },
      { sceneId: 's2', jobId: 'job-2' },
    ]);
    expect(out.skipped).toEqual([]);
    const firstJob = enqueueJob.mock.calls[0][0];
    expect(firstJob.kind).toBe('image');
    expect(firstJob.params.creativeDirector).toEqual({ projectId: 'cd-1', sceneId: 's1' });
    expect(firstJob.params.prompt).toBe('a cat walks into a noir alley');
    expect(firstJob.params.pythonPath).toBe('/py');
  });

  it('skips a scene that already has a reference frame (idempotent re-run)', async () => {
    const project = {
      id: 'cd-1',
      treatment: { scenes: [scene({ sceneId: 's1', sourceImageFile: 'existing.png' }), scene({ sceneId: 's2' })] },
    };
    const out = await enqueueFirstPassSceneFrames(project);
    expect(out.enqueued).toEqual([{ sceneId: 's2', jobId: 'job-1' }]);
    expect(out.skipped).toEqual([{ sceneId: 's1', reason: 'has-reference' }]);
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('skips a scene with a blank prompt', async () => {
    const project = { id: 'cd-1', treatment: { scenes: [scene({ sceneId: 's1', prompt: '   ' })] } };
    const out = await enqueueFirstPassSceneFrames(project);
    expect(out.enqueued).toEqual([]);
    expect(out.skipped).toEqual([{ sceneId: 's1', reason: 'no-prompt' }]);
  });

  it('skips gracefully for external mode (not queue-backed)', async () => {
    getSettings.mockResolvedValue({ imageGen: { mode: 'external' } });
    const project = { id: 'cd-1', treatment: { scenes: [scene()] } };
    const out = await enqueueFirstPassSceneFrames(project);
    expect(out).toEqual({ mode: 'external', enqueued: [], skipped: [], reason: 'mode-unsupported' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('returns an empty summary for no treatment / no scenes (never reads settings)', async () => {
    expect(await enqueueFirstPassSceneFrames({ id: 'cd-1', treatment: null })).toEqual({ mode: null, enqueued: [], skipped: [] });
    expect(await enqueueFirstPassSceneFrames({ id: 'cd-1', treatment: { scenes: [] } })).toEqual({ mode: null, enqueued: [], skipped: [] });
    expect(getSettings).not.toHaveBeenCalled();
  });
});
