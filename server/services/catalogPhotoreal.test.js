import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-photoreal-') });
});
const db = vi.hoisted(() => ({ getIngredient: vi.fn(), listMediaForIngredient: vi.fn(), detachMedia: vi.fn() }));
const upload = vi.hoisted(() => vi.fn());
const maintenanceRun = vi.hoisted(() => vi.fn());
const copyScene = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  copyScene.mockImplementation(actual.copyFile);
  return { ...actual, copyFile: copyScene };
});
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: { run: maintenanceRun } }));
vi.mock('./catalogDB.js', () => db);
vi.mock('./catalogMedia.js', () => ({ uploadIngredientMediaFile: upload }));

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { catalogEvents } = await import('./catalogEvents.js');
afterAll(cleanupTempDataRoots);
const { getPhotorealStatus, openPhotorealBlend, startPhotorealRender, __setPhotorealDepsForTests } = await import('./catalogPhotoreal.js');
const { PATHS } = await import('../lib/fileUtils.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const scene = {
  parts: [{ id: 'floor', type: 'box', size: [30, 0.1, 14] }],
  shots: [
    { id: 'wide', label: 'Wide', position: [0, 4, 14], target: [0, 1, 0], plate: 'plate-old.png' },
    { id: 'booth', label: 'Booth', position: [5, 2, 5], target: [0, 1, 0] },
  ],
};
let seq = 0;
const place = (greybox = scene) => ({ id: `plc-${seq}`, type: 'place', name: 'Example Rink', payload: { greybox } });

// A worker that writes what the PortOS script would, then hands the directory over.
const fakeWorker = (outputs) => vi.fn(async ({ files, workspaceRoot, onOutput }) => {
  const dir = join(workspaceRoot, `run-${seq}`);
  await mkdir(dir, { recursive: true });
  const listed = [];
  for (const [path, content] of Object.entries(outputs)) {
    await writeFile(join(dir, path), content);
    listed.push({ path, bytes: Buffer.byteLength(content) });
  }
  fakeWorker.lastFiles = files;
  await onOutput(dir, listed);
  return { status: 'completed' };
});

const frames = [];
const sceneFrames = [];
catalogEvents.on('photoreal', (frame) => frames.push(frame));
catalogEvents.on('photoreal-scene', (frame) => sceneFrames.push(frame));
const finished = (id) => vi.waitFor(() => {
  const last = frames.filter((f) => f.ingredientId === id).at(-1);
  if (!last || last.job.state === 'running') throw new Error('still running');
  return last.job;
});

beforeEach(() => {
  vi.clearAllMocks();
  seq += 1;
  frames.length = 0;
  sceneFrames.length = 0;
  maintenanceRun.mockImplementation((_kind, _label, work) => work());
  upload.mockImplementation(async ({ role }) => ({ mediaKey: `new-${role.split(':')[1]}.png`, kind: 'reference', role }));
  db.listMediaForIngredient.mockResolvedValue([
    { mediaKey: 'plate-old.png', kind: 'reference', role: 'photoreal:wide' },
    { mediaKey: 'stale-booth.png', kind: 'reference', role: 'photoreal:booth' },
    { mediaKey: 'capture.png', kind: 'reference', role: 'greybox-shot:booth' },
  ]);
});

describe('startPhotorealRender', () => {
  // Metal cannot compile inside the sandbox, so GPU auto-selection would crash a contained job (#14939).
  it('forces the CPU for a contained Cycles job and refuses contained EEVEE before Blender starts', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    const worker = fakeWorker({
      'report.json': JSON.stringify({ version: '5.2.3', engine: 'CYCLES', device: 'CPU', backend: 'CPU', samples: 8, parts: 1, shots: [{ shotId: 'wide', seconds: 1 }] }),
      'blockout.blend': 'BLENDER-v503',
      'shot-wide.png': PNG,
    });
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', executionMode: 'contained', worker }), lastCheckedVersion: async () => '5.2.3' });

    await expect(startPhotorealRender(record.id, { shotIds: ['wide'], engine: 'eevee', samples: 8 }))
      .rejects.toMatchObject({ status: 409, code: 'PHOTOREAL_CONTAINED_NO_GPU' });
    expect(worker).not.toHaveBeenCalled();

    await startPhotorealRender(record.id, { shotIds: ['wide'], engine: 'cycles', samples: 8 });
    await expect(finished(record.id)).resolves.toMatchObject({ state: 'done', report: { device: 'CPU' } });
    expect(JSON.parse(fakeWorker.lastFiles.find((f) => f.path === 'greybox-blender.json').content)).toMatchObject({ engine: 'CYCLES', useGpu: false });
  });

  it('renders the saved greybox in Blender, attaches each camera, keeps plates and the .blend', async () => {
    const record = place();
    record.payload.photoreal = { materials: [], lights: [{ id: 'panel', type: 'area', position: [0, 6, 0], watts: 600 }], atmosphere: { haze: 0.2 }, textures: { 'wood-floor': 'oak_planks' } };
    db.getIngredient.mockResolvedValue(record);
    const worker = fakeWorker({
      'report.json': JSON.stringify({ version: '5.2.3', engine: 'CYCLES', device: 'GPU', backend: 'METAL', samples: 64, parts: 1, shots: [{ shotId: 'wide', seconds: 12.5 }] }),
      'blockout.blend': 'BLENDER-v503',
      'shot-wide.png': PNG,
      'shot-booth.png': PNG,
    });
    const texture = { id: 'oak_planks', sizeM: 2.4, maps: { color: 'textures/oak_planks/color.jpg' } };
    const stageTextures = vi.fn(async () => ({ files: [{ path: texture.maps.color, content: Buffer.from('jpg') }], job: { 'wood-floor': texture }, missing: [] }));
    __setPhotorealDepsForTests({
      resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }),
      lastCheckedVersion: async () => '5.2.3',
      stageTextures,
    });

    const job = await startPhotorealRender(record.id, { shotIds: ['wide', 'booth'], engine: 'cycles', samples: 64 });
    expect(job).toMatchObject({ state: 'running', engine: 'cycles', samples: 64, shotIds: ['wide', 'booth'] });
    await expect(finished(record.id)).resolves.toMatchObject({ state: 'done', report: { device: 'GPU' } });

    // The scene goes in as data beside PortOS's own script; argv never runs caller code.
    const data = JSON.parse(fakeWorker.lastFiles.find((f) => f.path === 'greybox-blender.json').content);
    expect(data).toMatchObject({ engine: 'CYCLES', useGpu: true, samples: 64, longEdge: 1920, shotIds: ['wide', 'booth'],
      look: { lights: [{ id: 'panel', size: 0.25 }], atmosphere: { haze: 0.2, sun: false } }, textures: { 'wood-floor': texture } });
    // The look's downloaded textures are staged beside the script for Blender to read.
    expect(stageTextures).toHaveBeenCalledWith({ 'wood-floor': 'oak_planks' });
    expect(fakeWorker.lastFiles.map((f) => f.path)).toContain('textures/oak_planks/color.jpg');
    expect(worker.mock.calls[0][0].tool.argv('entry.py')).toEqual(expect.arrayContaining(['--background', '--disable-autoexec', '--python', 'entry.py']));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ role: 'photoreal:wide', mimeType: 'image/png', dataBase64: PNG.toString('base64'),
      caption: expect.stringContaining('Cycles, 64 samples, 12.5s') }));
    // The stale booth render is replaced; the wide render stays because it is that camera's plate.
    expect(db.detachMedia.mock.calls).toEqual([[record.id, 'stale-booth.png', 'reference']]);
    await expect(getPhotorealStatus(record.id)).resolves.toMatchObject({
      blendUrl: `/api/catalog/ingredients/${record.id}/photoreal/blend`, blenderVersion: '5.2.3', job: { state: 'done' },
      files: { blend: join(PATHS.data, 'photoreal-blends', `${record.id}.blend`), renders: PATHS.images },
    });
  });

  it('refuses unusable greyboxes, unknown cameras and a second render before touching Blender', async () => {
    const resolveTool = vi.fn();
    __setPhotorealDepsForTests({ resolveTool });
    db.getIngredient.mockResolvedValue(place({ ...scene, source: 'glb' }));
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' })).rejects.toMatchObject({ code: 'GREYBOX_NOT_RENDERABLE' });
    db.getIngredient.mockResolvedValue(place());
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['missing'], engine: 'eevee' })).rejects.toMatchObject({ code: 'GREYBOX_SHOT_UNKNOWN' });
    expect(resolveTool).not.toHaveBeenCalled();

    let release;
    resolveTool.mockResolvedValue({ executable: '/opt/blender', version: '5.2.3', worker: () => new Promise((resolve) => { release = resolve; }) });
    await startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' });
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' })).rejects.toMatchObject({ status: 409, code: 'PHOTOREAL_BUSY' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release({ status: 'terminated', reason: 'time' });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'failed', error: 'Blender was stopped by the wall-time limit.' });
    expect(upload).not.toHaveBeenCalled();
  });

  // Catches two requests passing the busy check while their tool lookup overlaps.
  it('starts only one worker when render requests overlap during tool resolution', async () => {
    db.getIngredient.mockResolvedValue(place());
    let resolveTool;
    let releaseWorker;
    const toolReady = new Promise((resolve) => { resolveTool = resolve; });
    const lookup = vi.fn(() => toolReady);
    const worker = vi.fn(() => new Promise((resolve) => { releaseWorker = resolve; }));
    __setPhotorealDepsForTests({ resolveTool: lookup });
    const attempts = Promise.allSettled([
      startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' }),
      startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' }),
    ]);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(2));
    resolveTool({ executable: '/opt/blender', version: '5.2.3', worker });
    const results = await attempts;
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1].reason).toMatchObject({ status: 409, code: 'PHOTOREAL_BUSY' });
    expect(worker).toHaveBeenCalledTimes(1);
    releaseWorker({ status: 'killed', reason: 'test complete' });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'failed' });
  });

  it('allows another render after tool resolution fails', async () => {
    db.getIngredient.mockResolvedValue(place());
    const worker = vi.fn(async () => ({ status: 'killed', reason: 'test complete' }));
    const resolveTool = vi.fn().mockRejectedValueOnce(new Error('tool unavailable'))
      .mockResolvedValue({ executable: '/opt/blender', version: '5.2.3', worker });
    __setPhotorealDepsForTests({ resolveTool });
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' })).rejects.toThrow('tool unavailable');
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' })).resolves.toMatchObject({ state: 'running' });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'failed' });
    expect(worker).toHaveBeenCalledTimes(1);
  });

  // Catches a fly-through that renders stills, drops a frame, or never reaches Media History.
  it('flies one camera through the chosen cameras in order and saves the MP4 to Media History', async () => {
    db.getIngredient.mockResolvedValue(place());
    const pngFrames = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`frame-${String(i + 1).padStart(4, '0')}.png`, PNG]));
    const runFfmpeg = vi.fn(async () => ({ ok: true }));
    const saveVideo = vi.fn(async () => ({ id: 'upload-abc123', filename: 'upload-abc123.mp4' }));
    __setPhotorealDepsForTests({
      resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker: fakeWorker({
        'report.json': JSON.stringify({ version: '5.2.3', device: 'GPU', backend: 'METAL', frames: 48, fps: 24 }), 'blockout.blend': 'BLENDER', ...pngFrames,
      }) }),
      findFfmpeg: async () => '/usr/bin/ffmpeg', runFfmpeg, saveVideo,
    });
    await startPhotorealRender(`plc-${seq}`, { shotIds: ['booth', 'wide'], engine: 'eevee', flythroughSeconds: 2 });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'done', flythroughSeconds: 2, video: { id: 'upload-abc123' } });

    const data = JSON.parse(fakeWorker.lastFiles.find((f) => f.path === 'greybox-blender.json').content);
    expect(data).toMatchObject({ shotIds: ['booth', 'wide'], flythrough: { fps: 24, frames: 48 } });
    expect(runFfmpeg.mock.calls[0][0].args).toEqual(expect.arrayContaining(['-framerate', '24', '-frames:v', '48', '-c:v', 'libx264']));
    expect(saveVideo).toHaveBeenCalledWith(expect.stringContaining('flythrough.mp4'), 'Example Rink fly-through (Booth → Wide).mp4');
    // A fly-through leaves the cameras' stills alone.
    expect(upload).not.toHaveBeenCalled();
    expect(db.detachMedia).not.toHaveBeenCalled();
  });

  it('refuses a fly-through with one camera or no ffmpeg before touching Blender', async () => {
    const resolveTool = vi.fn();
    __setPhotorealDepsForTests({ resolveTool, findFfmpeg: async () => null });
    db.getIngredient.mockResolvedValue(place());
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee', flythroughSeconds: 4 })).rejects.toMatchObject({ code: 'PHOTOREAL_FLYTHROUGH_SHOTS' });
    await expect(startPhotorealRender(`plc-${seq}`, { shotIds: ['wide', 'booth'], engine: 'eevee', flythroughSeconds: 4 })).rejects.toMatchObject({ status: 503, code: 'FFMPEG_MISSING' });
    expect(resolveTool).not.toHaveBeenCalled();
  });

  it('fails the job when Blender skips a camera or writes a non-PNG', async () => {
    db.getIngredient.mockResolvedValue(place());
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker: fakeWorker({
      'report.json': '{"shots":[]}', 'blockout.blend': 'BLENDER', 'shot-wide.png': 'not a png',
    }) }) });
    await startPhotorealRender(`plc-${seq}`, { shotIds: ['wide'], engine: 'eevee' });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'failed', error: expect.stringContaining('not a PNG') });
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('openPhotorealBlend', () => {
  it('opens an existing scene in the checked Blender with scripts off', async () => {
    const launch = vi.fn(async () => {});
    const worker = vi.fn();
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });
    const id = `plc-open-${seq}`;
    await mkdir(join(PATHS.data, 'photoreal-blends'), { recursive: true });
    const path = join(PATHS.data, 'photoreal-blends', `${id}.blend`);
    await writeFile(path, 'BLENDER');
    await expect(openPhotorealBlend(id)).resolves.toEqual({ opened: true, blenderVersion: '5.2.3', blendUrl: `/api/catalog/ingredients/${id}/photoreal/blend` });
    expect(launch).toHaveBeenCalledWith('/opt/blender', ['--disable-autoexec', path]);
    expect(worker).not.toHaveBeenCalled();

    launch.mockRejectedValueOnce(new Error('spawn EACCES'));
    await expect(openPhotorealBlend(id)).rejects.toMatchObject({ code: 'PHOTOREAL_OPEN_FAILED', message: expect.stringContaining('EACCES') });
  });

  it('builds a missing scene without rendering, even when the greybox has no cameras', async () => {
    const record = place({ ...scene, shots: [] });
    db.getIngredient.mockResolvedValue(record);
    const worker = fakeWorker({ 'report.json': '{"sceneOnly":true}', 'blockout.blend': 'BLENDER' });
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', executionMode: 'contained', worker }), launch });
    const path = join(PATHS.data, 'photoreal-blends', `${record.id}.blend`);

    await expect(openPhotorealBlend(record.id)).resolves.toMatchObject({ opened: true, blendUrl: `/api/catalog/ingredients/${record.id}/photoreal/blend` });
    expect(JSON.parse(fakeWorker.lastFiles.find((file) => file.path === 'greybox-blender.json').content))
      .toMatchObject({ sceneOnly: true, engine: 'CYCLES', useGpu: false, shotIds: [] });
    expect(await readFile(path, 'utf8')).toBe('BLENDER');
    expect(launch).toHaveBeenCalledWith('/opt/blender', ['--disable-autoexec', path]);
    expect(sceneFrames).toEqual([{ ingredientId: record.id }, { ingredientId: record.id }]);
    expect(upload).not.toHaveBeenCalled();
    expect(db.detachMedia).not.toHaveBeenCalled();
  });

  it('shares a scene build and refuses an overlapping render for the same place', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const writeScene = fakeWorker({ 'report.json': '{"sceneOnly":true}', 'blockout.blend': 'BLENDER' });
    const worker = vi.fn(async (args) => { await gate; return writeScene(args); });
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });
    const first = openPhotorealBlend(record.id);
    const second = openPhotorealBlend(record.id);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    await expect(getPhotorealStatus(record.id)).resolves.toMatchObject({ sceneBuilding: true, blendUrl: null });
    expect(sceneFrames).toEqual([{ ingredientId: record.id }]);
    await expect(startPhotorealRender(record.id, { shotIds: ['wide'], engine: 'cycles' })).rejects.toMatchObject({ code: 'PHOTOREAL_BUSY' });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    await expect(getPhotorealStatus(record.id)).resolves.toMatchObject({ sceneBuilding: false, blendUrl: `/api/catalog/ingredients/${record.id}/photoreal/blend` });
    expect(sceneFrames).toEqual([{ ingredientId: record.id }, { ingredientId: record.id }]);
    expect(worker).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('does not start a scene build while the first render is running', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    let release;
    const worker = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });
    await startPhotorealRender(record.id, { shotIds: ['wide'], engine: 'cycles' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(openPhotorealBlend(record.id)).rejects.toMatchObject({ code: 'PHOTOREAL_BUSY' });
    expect(worker).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
    release({ status: 'terminated', reason: 'time' });
    await finished(record.id);
  });

  it('does not replace a scene that appears while the build is running', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const writeScene = fakeWorker({ 'report.json': '{"sceneOnly":true}', 'blockout.blend': 'GENERATED' });
    const worker = vi.fn(async (args) => { await gate; return writeScene(args); });
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });
    const opening = openPhotorealBlend(record.id);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledOnce());
    const path = join(PATHS.data, 'photoreal-blends', `${record.id}.blend`);
    await mkdir(join(PATHS.data, 'photoreal-blends'), { recursive: true });
    await writeFile(path, 'EXISTING');
    release();
    await opening;
    expect(await readFile(path, 'utf8')).toBe('EXISTING');
    expect(launch).toHaveBeenCalledWith('/opt/blender', ['--disable-autoexec', path]);
  });

  it('keeps a scene private while copying and waits for the build before opening', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    let releaseCopy;
    let copying;
    const copyStarted = new Promise((resolve) => { copying = resolve; });
    const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
    copyScene.mockImplementationOnce(async (_source, target) => {
      await writeFile(target, 'PARTIAL');
      copying();
      await copyGate;
      await writeFile(target, 'GENERATED');
    });
    const worker = fakeWorker({ 'report.json': '{"sceneOnly":true}', 'blockout.blend': 'GENERATED' });
    const launch = vi.fn(async () => {});
    const resolveTool = vi.fn(async () => ({ executable: '/opt/blender', version: '5.2.3', worker }));
    __setPhotorealDepsForTests({ resolveTool, launch, lastCheckedVersion: async () => '5.2.3' });
    const first = openPhotorealBlend(record.id);
    let second;
    try {
      await copyStarted;
      expect((await getPhotorealStatus(record.id)).blendUrl).toBeNull();
      const path = join(PATHS.data, 'photoreal-blends', `${record.id}.blend`);
      await writeFile(path, 'EXISTING');
      second = openPhotorealBlend(record.id);
      await vi.waitFor(() => expect(resolveTool).toHaveBeenCalledTimes(2));
      expect(launch).not.toHaveBeenCalled();
    } finally {
      releaseCopy();
    }
    await Promise.all([first, second]);
    expect(await readFile(join(PATHS.data, 'photoreal-blends', `${record.id}.blend`), 'utf8')).toBe('EXISTING');
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('reports a failed build without launching Blender and allows a retry', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    const writeScene = fakeWorker({ 'report.json': '{"sceneOnly":true}', 'blockout.blend': 'BLENDER' });
    const worker = vi.fn().mockResolvedValueOnce({ status: 'terminated', reason: 'time' }).mockImplementation(writeScene);
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });

    await expect(openPhotorealBlend(record.id)).rejects.toMatchObject({ code: 'PHOTOREAL_BUILD_FAILED', message: expect.stringContaining('wall-time limit') });
    expect(launch).not.toHaveBeenCalled();
    await expect(getPhotorealStatus(record.id)).resolves.toMatchObject({ sceneBuilding: false });
    await expect(openPhotorealBlend(record.id)).resolves.toMatchObject({ opened: true });
    expect(worker).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('does not publish or open output without a scene-only report', async () => {
    const record = place();
    db.getIngredient.mockResolvedValue(record);
    const worker = fakeWorker({ 'report.json': '{"shots":[]}', 'blockout.blend': 'BLENDER' });
    const launch = vi.fn(async () => {});
    __setPhotorealDepsForTests({ resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }), launch });
    await expect(openPhotorealBlend(record.id)).rejects.toMatchObject({ code: 'PHOTOREAL_BUILD_FAILED', message: expect.stringContaining('scene-only') });
    expect(launch).not.toHaveBeenCalled();
    expect((await getPhotorealStatus(record.id)).blendUrl).toBeNull();
  });

  it('refuses unsafe ids and unsupported greyboxes before building', async () => {
    const worker = vi.fn();
    const launch = vi.fn();
    const resolveTool = vi.fn(async () => ({ executable: '/opt/blender', version: '5.2.3', worker }));
    __setPhotorealDepsForTests({ resolveTool, launch });
    await expect(openPhotorealBlend('../unsafe')).rejects.toMatchObject({ code: 'PHOTOREAL_BAD_ID' });
    expect(resolveTool).not.toHaveBeenCalled();

    const record = place({ ...scene, source: 'glb' });
    db.getIngredient.mockResolvedValue(record);
    await expect(openPhotorealBlend(record.id)).rejects.toMatchObject({ code: 'GREYBOX_NOT_RENDERABLE' });
    expect(worker).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});
