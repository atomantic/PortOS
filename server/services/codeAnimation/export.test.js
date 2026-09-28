import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import vm from 'vm';

const state = vi.hoisted(() => ({ dataRoot: null, job: null, html: '' }));

vi.mock('../../lib/paths.js', async () => {
  const actual = await vi.importActual('../../lib/paths.js');
  return { ...actual, PATHS: new Proxy(actual.PATHS, { get: (target, prop) => (prop === 'data' ? state.dataRoot : target[prop]) }) };
});
vi.mock('./jobStore.js', () => ({
  isCodeAnimationJobId: (id) => /^[0-9a-f-]{36}$/.test(id),
  getCodeAnimationJobRecord: async () => state.job,
  readCodeAnimationHtml: async () => state.html,
}));

const { startCodeAnimationExport } = await import('./export.js');

const JOB_ID = '11111111-2222-4333-8444-555555555555';

// Stage an export of `pageScript` and run the staged document's scripts, in
// order, in a minimal browser-like realm.
async function runPage(pageScript, { song = null } = {}) {
  state.html = `<html><head></head><body><script>${pageScript}</script></body></html>`;
  await startCodeAnimationExport(JOB_ID, { enqueueJob: async () => ({ jobId: 'm' }), beatGrid: async () => song });
  const staged = await readFile(join(state.dataRoot, 'code-animation-exports', JOB_ID, 'index.html'), 'utf8');
  const scripts = [...staged.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const listeners = {};
  const canvas = { width: 1920, height: 1080, setAttribute: vi.fn() };
  const ctx = {
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => {},
    addEventListener: (type, fn) => { listeners[type] = fn; },
    document: {
      querySelectorAll: () => [canvas],
      createElement: () => ({}),
      head: { appendChild: vi.fn() },
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const script of scripts) vm.runInContext(script, ctx);
  listeners.load?.();
  return { ctx, canvas };
}

describe('export shim', () => {
  beforeEach(async () => {
    state.dataRoot = await mkdtemp(join(tmpdir(), 'code-animation-shim-'));
    state.job = { id: JOB_ID, status: 'completed', frame: { width: 1920, height: 1080, fps: 30, durationSeconds: 20 }, audioUrl: '/data/music/a.mp3' };
  });
  afterEach(async () => {
    await rm(state.dataRoot, { recursive: true, force: true });
  });

  it('stops the page clock and exposes renderFrame as a clamped composition seek', async () => {
    const { ctx, canvas } = await runPage(`
      window.drawn = [];
      window.ticks = 0;
      window.ANIMATION_META = { duration: 180, fps: 30, width: 1920, height: 1080 };
      window.renderFrame = (t) => { window.drawn.push(t); };
      requestAnimationFrame(() => { window.ticks += 1; });
    `, { song: { bpm: 120, beats: [0.5], downbeats: [], hits: [] } });
    expect(ctx.ticks).toBe(0);
    expect(canvas.setAttribute).toHaveBeenCalledWith('data-portos-film', '');
    expect(ctx.ANIMATION_SONG.bpm).toBe(120);
    const composition = ctx.portosComposition;
    expect(composition).toMatchObject({ durationSec: 120, fps: 30, width: 1920, height: 1080 });
    await composition.seek(2.5);
    expect(ctx.drawn).toEqual([2.5]);
  });

  it('names the reason when the animation has no renderFrame', async () => {
    const { ctx } = await runPage('window.ANIMATION_META = { duration: 5, fps: 30, width: 1920, height: 1080 };');
    expect(() => ctx.portosComposition).toThrow(/does not define window\.renderFrame\(t\).*Record \(real-time\)/);
  });
});

describe('startCodeAnimationExport', () => {
  let enqueueJob;
  beforeEach(async () => {
    state.dataRoot = await mkdtemp(join(tmpdir(), 'code-animation-export-'));
    state.html = '<!DOCTYPE html><html><head><title>x</title></head><body><script>window.renderFrame=()=>{}</script></body></html>';
    state.job = { id: JOB_ID, status: 'completed', frame: { width: 1920, height: 1080, fps: 30, durationSeconds: 20 }, audioUrl: '/data/music/Song%20A.mp3' };
    enqueueJob = vi.fn(async () => ({ jobId: 'media-1', position: 1, status: 'queued' }));
  });
  afterEach(async () => {
    await rm(state.dataRoot, { recursive: true, force: true });
  });

  it('stages the HTML with the shim ahead of page scripts and queues a composition render with the library track', async () => {
    const beatGrid = vi.fn(async () => ({ bpm: 100, beats: [0.6], downbeats: [0.6], hits: [] }));
    const result = await startCodeAnimationExport(JOB_ID, { enqueueJob, beatGrid });
    expect(result).toMatchObject({ jobId: 'media-1', notes: [] });
    expect(beatGrid).toHaveBeenCalledWith('Song A.mp3');
    expect(enqueueJob).toHaveBeenCalledWith({ kind: 'html-composition',
      params: { directory: `code-animation-exports/${JOB_ID}`, musicTrack: 'Song A.mp3' } });
    const staged = await readFile(join(state.dataRoot, 'code-animation-exports', JOB_ID, 'index.html'), 'utf8');
    expect(staged.indexOf('portosComposition')).toBeLessThan(staged.indexOf('window.renderFrame=()=>{}'));
    expect(staged).toContain('"bpm":100');
  });

  it('exports uploaded-audio and over-long films with explanatory notes', async () => {
    state.job = { ...state.job, audioUrl: '/api/uploads/take.wav', frame: { ...state.job.frame, durationSeconds: 180 } };
    const result = await startCodeAnimationExport(JOB_ID, { enqueueJob, beatGrid: vi.fn() });
    expect(result.notes).toHaveLength(2);
    expect(enqueueJob.mock.calls[0][0].params).toEqual({ directory: `code-animation-exports/${JOB_ID}` });
  });

  it('refuses frame sizes the composition renderer cannot encode and unfinished jobs', async () => {
    state.job = { ...state.job, frame: { ...state.job.frame, width: 1440, height: 1080 } };
    await expect(startCodeAnimationExport(JOB_ID, { enqueueJob })).rejects.toMatchObject({ code: 'EXPORT_SIZE_UNSUPPORTED' });
    state.job = { ...state.job, status: 'running' };
    await expect(startCodeAnimationExport(JOB_ID, { enqueueJob })).rejects.toMatchObject({ code: 'NOT_COMPLETED' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
