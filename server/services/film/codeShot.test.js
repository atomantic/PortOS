/** Code shots and code layers render beside Blender shots, and a code-only film needs no Blender. */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { createFakeBlender } from '../musicVideo/blender/__blenderFixture.js';
import { renderFilmCodeFrames } from './codeRender.js';
import { describeNeedsBlender } from './describeRun.js';
import { __resetBlenderJobsForTests, listBlenderJobs } from './jobs.js';
import { enqueueBlenderRenders } from './queue.js';
import { blenderFramesDir } from './renderIndex.js';
import { scaffoldBlenderWorkspace } from './sources.js';
import { getBlenderState } from './state.js';
import { startBlenderSync } from './sync.js';
import { startBlenderCut } from './cuts.js';

function ROOT() { return lazyTempDataRoot('film-code-shot-'); }
const runtime = vi.hoisted(() => ({ blender: null, ffmpeg: [], opened: [] }));
vi.mock('../../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => runtime.blender.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => runtime.blender.resolveBlenderTool(...args),
}));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(), findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'), bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    runtime.ffmpeg.push(args);
    writeFileSync(args.at(-1), 'video');
    return { ok: true };
  }),
}));
vi.mock('../htmlComposition/browser.js', () => ({
  openComposition: async (stage, options) => {
    runtime.opened.push({ stage, options });
    return {
      close: async () => {},
      evaluate: async (expression) => {
        const text = String(expression);
        if (text.includes('portosFilm.ready')) return true;
        const spec = JSON.parse(text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')));
        const pixels = Buffer.alloc(spec.width * spec.height * 4);
        pixels[0] = spec.frame & 255;
        const alpha = spec.alpha ? 128 : 255;
        for (let index = 3; index < pixels.length; index += 4) pixels[index] = alpha;
        return pixels.toString('base64');
      },
    };
  },
}));

afterAll(() => { __resetBlenderJobsForTests(); cleanupTempDataRoots(); });
beforeEach(() => {
  __resetBlenderJobsForTests(); cleanupTempDataRoots();
  runtime.blender = createFakeBlender();
  runtime.ffmpeg = [];
  runtime.opened = [];
});

const SETTINGS = { width: 320, height: 180, fps: 12, previewScale: 1, previewSamples: 1, finalSamples: 1, concurrency: 1 };

function createOwner(durationSec, { cutEffects = null } = {}) {
  let record = normalizeBlenderRecord({ settings: SETTINGS });
  return {
    kind: 'standalone-test', id: 'example-film', workspaceDir: join(ROOT(), 'standalone', 'example-film'),
    timeline: async () => ({
      durationSec, fps: record.settings.fps,
      ...(cutEffects ? { cutEffects: () => cutEffects } : {}),
    }),
    song: async () => null,
    readRecord: async () => record,
    writeRecord: async (change) => { record = { ...record, ...change(record) }; return record; },
    emit: () => {},
  };
}

const settled = (owner, ids) => vi.waitFor(() => {
  const jobs = listBlenderJobs(owner).filter((job) => ids.includes(job.id));
  expect(jobs.map((job) => `${job.status}:${job.error || ''}`)).toEqual(ids.map(() => 'done:'));
}, { timeout: 20_000, interval: 20 });

const frameBytes = (owner, shotId, quality) => {
  const directory = blenderFramesDir(owner, shotId, quality);
  return Object.fromEntries(readdirSync(directory).sort().map((name) => [name, readFileSync(join(directory, name))]));
};

const mixedManifest = () => ({
  title: 'Mixed Film',
  shots: [
    { id: 's010', start: 0, end: 0.5, deps: ['film.py'] },
    { id: 's020', start: 0.5, end: 1, renderer: 'code', entry: 'code/s020.js', deps: ['film.py'] },
    { id: 's030', start: 1, end: 1.5, deps: ['film.py'], handles: { out: 1 / 12 }, layers: [
      { entry: 'code/under.js', place: 'under', blend: 'multiply' },
      { entry: 'code/fx.js', place: 'over', blend: 'screen' },
    ] },
    { id: 's040', start: 1.5, end: 2, deps: ['film.py'], handles: { in: 1 / 12 } },
  ],
});

// One frame on each side of the cut between the layered shot and the shot after it.
const LAYER_DISSOLVE = [{
  style: 'dissolve', index: 2, cutFrame: 18, startFrame: 17, endFrame: 19, needOutFrames: 1, needInFrames: 1,
}];

function writeCode(owner) {
  const src = join(owner.workspaceDir, 'src', 'code');
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 's020.js'), 'export function render() {}\n');
  writeFileSync(join(src, 'dot.js'), 'export function dot() {}\n');
  writeFileSync(join(src, 'under.js'), 'export function render() {}\n');
  writeFileSync(join(src, 'fx.js'), "import { dot } from './dot.js';\nexport function render() { dot(); }\n");
}

describe('describeNeedsBlender', () => {
  const starter = fileURLToPath(new URL('./py/starter', import.meta.url));
  const workspaceFor = (src) => {
    const root = mkdtempSync(join(tmpdir(), 'portos-code-film-'));
    symlinkSync(src, join(root, 'src'));
    return root;
  };

  it('follows the starter into bpy and ignores a film that only imports the standard library', async () => {
    const starterRoot = workspaceFor(starter);
    try {
      expect(await describeNeedsBlender({ workspaceDir: starterRoot })).toBe(true);
    } finally {
      rmSync(starterRoot, { recursive: true, force: true });
    }
    const src = mkdtempSync(join(tmpdir(), 'portos-code-film-src-'));
    const root = workspaceFor(src);
    try {
      writeFileSync(join(src, 'film.py'), '# import bpy\nimport math\ndef describe(ctx):\n    return {"shots": []}\n');
      expect(await describeNeedsBlender({ workspaceDir: root })).toBe(false);
      writeFileSync(join(src, 'film.py'), 'note = "import bpy"\nimport math\n');
      expect(await describeNeedsBlender({ workspaceDir: root })).toBe(false);
      writeFileSync(join(src, 'film.py'), 'import math\ndef ready():\n    if True:\n        import bpy\n');
      expect(await describeNeedsBlender({ workspaceDir: root })).toBe(true);
      mkdirSync(join(src, 'shots'));
      writeFileSync(join(src, 'film.py'), 'import shots.hero\n');
      writeFileSync(join(src, 'shots', 'hero.py'), 'import bpy\n');
      expect(await describeNeedsBlender({ workspaceDir: root })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });
});

it('does not stage a code module through a symlinked directory', async () => {
  const owner = createOwner(1);
  const outside = mkdtempSync(join(tmpdir(), 'portos-code-outside-'));
  try {
    mkdirSync(join(owner.workspaceDir, 'src'), { recursive: true });
    writeFileSync(join(outside, 's010.js'), 'export function render() {}\n');
    symlinkSync(outside, join(owner.workspaceDir, 'src', 'code'));
    const frame = join(owner.workspaceDir, 'renders', 'frame.png');
    mkdirSync(join(owner.workspaceDir, 'renders'), { recursive: true });
    await expect(renderFilmCodeFrames({
      owner, jobId: 'symlink', entry: 'code/s010.js', song: null, width: 2, height: 2,
      paths: ['code/s010.js'], frames: [{ frame: 0, t: 0, localT: 0, file: frame }],
    })).rejects.toThrow(/leaves the film source/);
    expect(runtime.opened).toEqual([]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

it('renders a Blender shot, a code shot and a code layer, then marks only the edited layer stale', async () => {
  const owner = createOwner(2, { cutEffects: LAYER_DISSOLVE });
  runtime.blender.control.manifest = mixedManifest();
  runtime.blender.control.imports = ['film.py'];
  runtime.blender.control.imageFrames = true;
  await scaffoldBlenderWorkspace(owner);
  writeCode(owner);
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  const synced = await getBlenderState(owner);
  expect(synced.manifest.shots.map((shot) => shot.renderer || 'blender')).toEqual(['blender', 'code', 'blender', 'blender']);
  expect(synced.manifest.shots[1]).toMatchObject({ entry: 'code/s020.js' });
  expect(synced.manifest.shots[2].layers).toEqual([
    { entry: 'code/under.js', place: 'under', blend: 'multiply' },
    { entry: 'code/fx.js', place: 'over', blend: 'screen' },
  ]);

  for (const quality of ['still', 'preview', 'final']) {
    const request = quality === 'still'
      ? { quality, shotIds: ['s010', 's020', 's030'], times: [0.25, 0.75, 1.25] }
      : { quality };
    await settled(owner, (await enqueueBlenderRenders(owner, request)).jobs.map((job) => job.id));
  }
  const rendered = await getBlenderState(owner);
  for (const shotId of ['s010', 's020', 's030']) {
    expect(rendered.renders[shotId].stills, shotId).toHaveLength(1);
    expect(rendered.renders[shotId].preview.complete, shotId).toBe(true);
    expect(rendered.renders[shotId].final.complete, shotId).toBe(true);
    expect(rendered.renders[shotId].preview.stale, shotId).toBe(false);
  }
  await settled(owner, [(await startBlenderCut(owner, { quality: 'preview' })).job.id]);
  expect((await getBlenderState(owner)).cuts[0]).toMatchObject({ missing: [], stale: [] });
  const cutGraph = runtime.ffmpeg.find((args) => args.some((arg) => String(arg).includes(join('s030', 'preview', 'handles', 'handle_out_%06d.png'))));
  expect(cutGraph).toBeTruthy();

  const layeredStill = join(owner.workspaceDir, 'renders', 's030', 'stills', 't000001250.png');
  const stillOnce = readFileSync(layeredStill);
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s030'], times: [1.25] })).jobs.map((job) => job.id));
  expect(readFileSync(layeredStill).equals(stillOnce)).toBe(true);
  const codeStill = join(owner.workspaceDir, 'renders', 's020', 'stills', 't000000750.png');
  const codeOnce = readFileSync(codeStill);
  writeFileSync(codeStill, 'stale-pixels');
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s020'], times: [0.75] })).jobs.map((job) => job.id));
  expect(readFileSync(codeStill).equals(codeOnce)).toBe(true);

  const renders = runtime.blender.control.jobs.filter((job) => job.mode === 'render');
  expect(renders.some((job) => job.shots.some((shot) => shot.id === 's020'))).toBe(false);
  expect(renders.some((job) => job.shots.some((shot) => shot.id === 's030'))).toBe(true);
  const layered = runtime.ffmpeg.find((args) => args.some((arg) => String(arg).includes('blend=all_mode=screen')));
  const graph = layered?.find((arg) => String(arg).includes('blend=all_mode=screen'));
  expect(String(graph)).toContain('[in1][in0]overlay=format=auto:shortest=1');
  expect(String(graph)).toContain('blend=all_mode=screen:shortest=1');
  expect(String(graph)).toContain('alphaextract');
  expect(String(graph)).toContain('alphamerge');
  expect(layered?.some((arg) => String(arg).includes(join('layers', '0')))).toBe(true);
  expect(layered?.some((arg) => String(arg).includes(join('layers', '1')))).toBe(true);
  for (const quality of ['preview', 'final']) {
    const handle = join(owner.workspaceDir, 'renders', 's030', quality, 'handles', 'handle_out_000018.png');
    expect(statSync(handle).size, quality).toBeGreaterThan(0);
  }
  expect(runtime.opened.length).toBeGreaterThan(0);
  expect(runtime.opened.every((call) => call.options.ownedBrowser === true && call.options.isolation === 'legacy' && call.options.mediaMode === 'code-only')).toBe(true);

  const jobsBeforeSheet = runtime.blender.control.jobs.length;
  const openedBeforeSheet = runtime.opened.length;
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'sheet', shotIds: ['s030'], sheet: { every: 6, columns: 2 } })).jobs.map((job) => job.id));
  expect(runtime.blender.control.jobs).toHaveLength(jobsBeforeSheet);
  expect(runtime.opened.length).toBeGreaterThan(openedBeforeSheet);
  expect((await getBlenderState(owner)).renders.s030.sheets[0]).toMatchObject({ fromPreview: true, stale: false, tiles: 1 });

  const first = frameBytes(owner, 's020', 'preview');
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s020'], force: true })).jobs.map((job) => job.id));
  const second = frameBytes(owner, 's020', 'preview');
  expect(second).toEqual(first);

  const names = Object.keys(second).sort();
  const kept = names[0];
  const dropped = names.at(-1);
  const renderFile = join(owner.workspaceDir, 'renders', 's020', 'preview', 'render.json');
  const meta = JSON.parse(readFileSync(renderFile, 'utf8'));
  meta.complete = false;
  writeFileSync(renderFile, JSON.stringify(meta));
  rmSync(join(blenderFramesDir(owner, 's020', 'preview'), dropped));
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s020'] })).jobs.map((job) => job.id));
  const resumed = frameBytes(owner, 's020', 'preview');
  expect(resumed[kept].equals(second[kept])).toBe(true);
  expect(resumed[dropped].equals(second[dropped])).toBe(true);

  writeFileSync(join(owner.workspaceDir, 'src', 'code', 'dot.js'), 'export function dot() { return 2; }\n');
  const stale = await getBlenderState(owner);
  expect(stale.renders.s010.preview.stale).toBe(false);
  expect(stale.renders.s010.final.stale).toBe(false);
  expect(stale.renders.s010.stills[0].stale).toBe(false);
  expect(stale.renders.s020.preview.stale).toBe(false);
  expect(stale.renders.s020.final.stale).toBe(false);
  expect(stale.renders.s030.preview.stale).toBe(true);
  expect(stale.renders.s030.preview.staleReasons).toContain('source');
  expect(stale.renders.s030.final.stale).toBe(true);
  expect(stale.renders.s030.stills[0].stale).toBe(true);
});

it('syncs and renders a code-only film with Blender unconfigured', async () => {
  const owner = createOwner(1.5);
  runtime.blender.control.executionMode = 'contained';
  runtime.blender.control.ready = false;
  const src = join(owner.workspaceDir, 'src');
  mkdirSync(join(src, 'code'), { recursive: true });
  writeFileSync(join(src, 'film.py'), [
    'def describe(ctx):',
    '    return {"title": "Code Film", "shots": [',
    '        {"id": "s010", "start": 0.0, "end": 1.5, "renderer": "code", "entry": "code/s010.js", "deps": ["film.py"]},',
    '    ]}',
  ].join('\n'));
  writeFileSync(join(src, 'code', 's010.js'), 'export function render() {}\n');
  await expect(startBlenderSync(owner)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL' });
  expect(listBlenderJobs(owner)).toEqual([]);
  runtime.blender.control.executionMode = 'trusted-local';
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  expect(runtime.blender.control.jobs).toEqual([]);
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'sheet', shotIds: ['s010'], sheet: { every: 6, columns: 2 } })).jobs.map((job) => job.id));
  expect(runtime.blender.control.jobs).toEqual([]);
  expect(runtime.opened.length).toBeGreaterThan(0);
  const state = await getBlenderState(owner);
  expect(state.renders.s010.sheets[0]).toMatchObject({ fromPreview: false, stale: false });
  expect(state.tool.ready).toBe(false);
  expect(state.manifest.shots[0]).toMatchObject({ renderer: 'code', entry: 'code/s010.js' });
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s010'], times: [0.5] })).jobs.map((job) => job.id));
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s010'] })).jobs.map((job) => job.id));
  await settled(owner, [(await startBlenderCut(owner, { quality: 'preview' })).job.id]);
  const rendered = await getBlenderState(owner);
  expect(rendered.renders.s010.stills).toHaveLength(1);
  expect(rendered.renders.s010.preview.complete).toBe(true);
  expect(rendered.cuts[0]).toMatchObject({ missing: [], stale: [] });
  expect(runtime.blender.control.jobs).toEqual([]);
});
