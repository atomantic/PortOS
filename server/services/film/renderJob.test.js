import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { compositeFilmStill, renderFilmCodeFrames } from './codeRender.js';
import { requireBlenderFilmTool, runBlenderDriver } from './driver.js';
import { encodeBlenderShot } from './encode.js';
import { __resetBlenderJobsForTests, createBlenderJob } from './jobs.js';
import { writeBlenderManifest } from './manifest.js';
import { runBlenderShotRender } from './renderJob.js';
import { blenderCompositedHandlesDir, blenderFramesDir, blenderLayerFramesDir, blenderRenderFile } from './renderIndex.js';

vi.mock('./driver.js', async (load) => ({
  ...await load(),
  requireBlenderFilmTool: vi.fn(),
  runBlenderDriver: vi.fn(),
}));
vi.mock('./encode.js', () => ({
  encodeBlenderPoster: vi.fn(async () => {}),
  encodeBlenderSheet: vi.fn(),
  encodeBlenderShot: vi.fn(async ({ output }) => writeFile(output, 'encoded shot')),
}));
vi.mock('./codeRender.js', () => ({
  compositeFilmStill: vi.fn(),
  renderFilmCodeFrames: vi.fn(),
}));

const fps = 24;
const quality = 'final';
const shotId = 'shot-a';
const frame24 = 'frame_000024.png';
const frame25 = 'frame_000025.png';
let owner;
let settings;
let durationSec;
let shot;

const frames = () => blenderFramesDir(owner, shotId, quality);
const renderMeta = async () => JSON.parse(await readFile(blenderRenderFile(owner, shotId, quality), 'utf8'));
const saveManifest = () => writeBlenderManifest(owner, {
  fps, syncedAt: '2026-01-01T00:00:00.000Z', shots: [shot],
  options: [{ key: 'bloom', type: 'boolean', default: false }],
});
const writeSource = (name, content) => writeFile(join(owner.workspaceDir, 'src', name), content);

beforeEach(async () => {
  vi.resetAllMocks();
  const workspaceDir = await mkdtemp(join(tmpdir(), 'portos-render-job-'));
  settings = { fps };
  durationSec = 3;
  shot = { id: shotId, start: 1, end: 26 / fps, deps: ['film.py'] };
  owner = {
    kind: 'standalone-test', id: basename(workspaceDir), workspaceDir,
    readRecord: async () => ({ settings }),
    timeline: async () => ({ durationSec }),
    song: async () => null,
    emit: vi.fn(),
  };
  await mkdir(join(workspaceDir, 'src'));
  await writeSource('film.py', '# sample film');
  await writeSource('support.py', '# imported by the driver');
  await saveManifest();
  requireBlenderFilmTool.mockResolvedValue({ version: '4.0-fixture' });
});

afterEach(async () => {
  __resetBlenderJobsForTests();
  if (owner) await rm(owner.workspaceDir, { recursive: true, force: true });
});

function render(options = {}) {
  const entry = createBlenderJob(owner, { kind: 'render', shotId, quality });
  return runBlenderShotRender(entry, { owner, shotId, quality, ...options });
}

async function leaveInterruptedFrame() {
  runBlenderDriver.mockImplementationOnce(async ({ job }) => {
    expect(job.resume).toBe(false);
    await writeFile(join(frames(), frame24), 'retained first frame');
    return { ok: false, canceled: true, events: { done: { imports: ['support.py'] } } };
  });
  await expect(render()).rejects.toMatchObject({ canceled: true });
  expect(encodeBlenderShot).not.toHaveBeenCalled();
  const partial = await renderMeta();
  expect(partial).toMatchObject({ complete: false, imports: { 'support.py': expect.any(String) } });
  return partial;
}

it('reuses finished partial frames and keeps imports from callbacks the resumed driver skipped', async () => {
  const partial = await leaveInterruptedFrame();
  runBlenderDriver.mockImplementationOnce(async ({ job }) => {
    expect(job.resume).toBe(true);
    expect(await readFile(join(frames(), frame24), 'utf8')).toBe('retained first frame');
    await writeFile(join(frames(), frame25), 'new second frame');
    return { ok: true, events: { done: { imports: [] } } };
  });

  await render();

  expect(encodeBlenderShot).toHaveBeenCalledOnce();
  expect(await renderMeta()).toMatchObject({ complete: true, imports: partial.imports, srcHash: partial.srcHash });
});

it.each([
  ['declared source', () => writeSource('film.py', '# changed film')],
  ['import outside declared dependencies', () => writeSource('support.py', '# changed imported support')],
  ['render settings', () => { settings.finalSamples = 16; }],
  ['film options', () => { settings.options = { bloom: true }; }],
  ['song context', () => { durationSec = 4; }],
  ['forced render', null, { force: true }],
])('clears interrupted frames before rendering with changed %s', async (_reason, change, request) => {
  await leaveInterruptedFrame();
  await change?.();
  runBlenderDriver.mockImplementationOnce(async ({ job }) => {
    expect(job.resume).toBe(false);
    expect(await readdir(frames())).toEqual([]);
    await writeFile(join(frames(), frame24), 'new first frame');
    await writeFile(join(frames(), frame25), 'new second frame');
    return { ok: true, events: {} };
  });

  await render(request);

  expect(await readFile(join(frames(), frame24), 'utf8')).toBe('new first frame');
  expect(await renderMeta()).toMatchObject({ complete: true });
});

it('reuses the main and overlapping handle frames when shrinking handles and rebuilds their composites', async () => {
  const layer = { entry: 'overlay.js', place: 'over', blend: 'add' };
  shot = { ...shot, renderer: 'code', entry: 'plate.js', layers: [layer], handles: { in: 2 / fps, out: 2 / fps } };
  await writeSource('plate.js', 'export const plate = true;');
  await writeSource('overlay.js', 'export const overlay = true;');
  await saveManifest();
  renderFilmCodeFrames.mockImplementation(async ({ entry, frames: requested, reuseExisting }) => {
    for (const frame of requested) {
      await writeFile(frame.file, entry, { flag: reuseExisting ? 'wx' : 'w' }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
    }
  });
  compositeFilmStill.mockImplementation(async (plate, [overlay], output) => {
    await writeFile(output, `${await readFile(plate, 'utf8')} + ${await readFile(overlay.file, 'utf8')}`);
  });
  await render();

  const layerDir = blenderLayerFramesDir(owner, shotId, quality, 0);
  const handleDir = blenderCompositedHandlesDir(owner, shotId, quality);
  const overlap = 'handle_in_000023.png';
  expect((await readdir(handleDir)).sort()).toEqual(['handle_in_000022.png', overlap, 'handle_out_000026.png', 'handle_out_000027.png']);
  await writeFile(join(frames(), frame24), 'retained main plate');
  await writeFile(join(layerDir, overlap), 'retained overlay');
  shot.handles = { in: 1 / fps, out: 0 };
  await saveManifest();
  compositeFilmStill.mockClear();

  await render();

  const remaining = [frame24, frame25, overlap];
  expect((await readdir(frames())).sort()).toEqual(remaining);
  expect((await readdir(layerDir)).sort()).toEqual(remaining);
  expect(await readdir(handleDir)).toEqual([overlap]);
  expect(await readFile(join(frames(), frame24), 'utf8')).toBe('retained main plate');
  expect(await readFile(join(handleDir, overlap), 'utf8')).toBe('plate.js + retained overlay');
  expect(compositeFilmStill).toHaveBeenCalledWith(
    join(frames(), overlap), [{ file: join(layerDir, overlap), place: 'over', blend: 'add' }], join(handleDir, overlap),
  );
  expect(await renderMeta()).toMatchObject({ complete: true, handles: shot.handles });
});
