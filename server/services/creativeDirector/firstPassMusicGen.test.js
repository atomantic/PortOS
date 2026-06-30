import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(),
}));
vi.mock('../pipeline/musicGen.js', () => ({
  ENGINES: { musicgen: {}, audioldm2: {}, acestep: {} },
  DEFAULT_ENGINE_ID: 'musicgen',
  isEngineReady: vi.fn(),
}));

import { buildMusicBedPrompt, enqueueFirstPassMusicBed } from './firstPassMusicGen.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { isEngineReady } from '../pipeline/musicGen.js';

let jobSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  jobSeq = 0;
  enqueueJob.mockImplementation(() => ({ jobId: `job-${++jobSeq}`, position: 1, status: 'queued' }));
  isEngineReady.mockReturnValue(true);
});

describe('buildMusicBedPrompt', () => {
  it('joins the project name + treatment logline when present', () => {
    const prompt = buildMusicBedPrompt({
      name: 'Neon Drift', treatment: { logline: 'a noir detective chases a ghost across a rain-soaked city' },
      styleSpec: 'ignored when logline is present',
    });
    expect(prompt).toBe('Neon Drift — a noir detective chases a ghost across a rain-soaked city');
  });

  it('falls back to styleSpec when there is no treatment yet', () => {
    const prompt = buildMusicBedPrompt({ name: 'Neon Drift', styleSpec: 'moody synthwave, slow build' });
    expect(prompt).toBe('Neon Drift — moody synthwave, slow build');
  });

  it('uses the name alone when there is no logline or styleSpec', () => {
    expect(buildMusicBedPrompt({ name: 'Bare Project', styleSpec: '' })).toBe('Bare Project');
  });

  it('returns "" for a null / nameless+detailless project', () => {
    expect(buildMusicBedPrompt(null)).toBe('');
    expect(buildMusicBedPrompt({ name: '   ', styleSpec: '' })).toBe('');
  });

  it('truncates an overlong joined prompt to MUSIC_BED_PROMPT_CHARS', () => {
    const longLogline = 'x'.repeat(500);
    const prompt = buildMusicBedPrompt({ name: 'P', treatment: { logline: longLogline } });
    expect(prompt.length).toBeLessThanOrEqual(402); // 400 + ellipsis
    expect(prompt.endsWith('…')).toBe(true);
  });
});

describe('enqueueFirstPassMusicBed', () => {
  it('enqueues an audio job tagged with the project id', async () => {
    const project = { id: 'proj-1', name: 'Neon Drift', styleSpec: 'synthwave' };
    const out = await enqueueFirstPassMusicBed(project);
    expect(out).toEqual({ mode: 'musicgen', enqueued: true, jobId: 'job-1' });
    const call = enqueueJob.mock.calls[0][0];
    expect(call.kind).toBe('audio');
    expect(call.params.prompt).toBe('Neon Drift — synthwave');
    expect(call.params.engine).toBe('musicgen');
    expect(call.params.creativeDirectorMusicBed).toEqual({ projectId: 'proj-1' });
  });

  it('skips a project that already has a music bed (idempotent re-run)', async () => {
    const project = { id: 'proj-1', name: 'Neon Drift', musicBed: { filename: 'existing.wav' } };
    const out = await enqueueFirstPassMusicBed(project);
    expect(out).toEqual({ mode: 'musicgen', enqueued: false, reason: 'has-music-bed' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips gracefully when no engine is ready', async () => {
    isEngineReady.mockReturnValue(false);
    const project = { id: 'proj-1', name: 'Neon Drift' };
    const out = await enqueueFirstPassMusicBed(project);
    expect(out).toEqual({ mode: 'musicgen', enqueued: false, reason: 'engine-not-ready' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('skips a project with no usable prompt', async () => {
    const project = { id: 'proj-1', name: '   ', styleSpec: '' };
    const out = await enqueueFirstPassMusicBed(project);
    expect(out).toEqual({ mode: 'musicgen', enqueued: false, reason: 'no-prompt' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('reports no-project for a missing / id-less project (never reads engine readiness)', async () => {
    expect(await enqueueFirstPassMusicBed(null)).toEqual({ mode: 'musicgen', enqueued: false, reason: 'no-project' });
    expect(await enqueueFirstPassMusicBed({ name: 'no id' })).toEqual({ mode: 'musicgen', enqueued: false, reason: 'no-project' });
    expect(isEngineReady).not.toHaveBeenCalled();
  });

  it('prefers a ready non-default engine over the default when the default is not provisioned', async () => {
    isEngineReady.mockImplementation((id) => id === 'audioldm2');
    const project = { id: 'proj-1', name: 'Neon Drift', styleSpec: 'synthwave' };
    const out = await enqueueFirstPassMusicBed(project);
    expect(out).toEqual({ mode: 'audioldm2', enqueued: true, jobId: 'job-1' });
    expect(enqueueJob.mock.calls[0][0].params.engine).toBe('audioldm2');
  });

  it('honors an explicit engine override', async () => {
    const project = { id: 'proj-1', name: 'Neon Drift', styleSpec: 'ace-step full song' };
    const out = await enqueueFirstPassMusicBed(project, { engine: 'acestep' });
    expect(out.mode).toBe('acestep');
    expect(enqueueJob.mock.calls[0][0].params.engine).toBe('acestep');
    expect(isEngineReady).toHaveBeenCalledWith('acestep');
  });
});
