import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const { makePathsProxy, lazyTempDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-photoreal-') });
});
const db = vi.hoisted(() => ({ getIngredient: vi.fn(), listMediaForIngredient: vi.fn(), detachMedia: vi.fn() }));
const upload = vi.hoisted(() => vi.fn());
const maintenanceRun = vi.hoisted(() => vi.fn());
vi.mock('../lib/maintenanceAdmission.js', () => ({ maintenance: { run: maintenanceRun } }));
vi.mock('./catalogDB.js', () => db);
vi.mock('./catalogMedia.js', () => ({ uploadIngredientMediaFile: upload }));

const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
const { catalogEvents } = await import('./catalogEvents.js');
afterAll(cleanupTempDataRoots);
const { getPhotorealStatus, startPhotorealRender, __setPhotorealDepsForTests } = await import('./catalogPhotoreal.js');

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
catalogEvents.on('photoreal', (frame) => frames.push(frame));
const finished = (id) => vi.waitFor(() => {
  const last = frames.filter((f) => f.ingredientId === id).at(-1);
  if (!last || last.job.state === 'running') throw new Error('still running');
  return last.job;
});

beforeEach(() => {
  vi.clearAllMocks();
  seq += 1;
  frames.length = 0;
  maintenanceRun.mockImplementation((_kind, _label, work) => work());
  upload.mockImplementation(async ({ role }) => ({ mediaKey: `new-${role.split(':')[1]}.png`, kind: 'reference', role }));
  db.listMediaForIngredient.mockResolvedValue([
    { mediaKey: 'plate-old.png', kind: 'reference', role: 'photoreal:wide' },
    { mediaKey: 'stale-booth.png', kind: 'reference', role: 'photoreal:booth' },
    { mediaKey: 'capture.png', kind: 'reference', role: 'greybox-shot:booth' },
  ]);
});

describe('startPhotorealRender', () => {
  it('renders the saved greybox in Blender, attaches each camera, keeps plates and the .blend', async () => {
    const record = place();
    record.payload.photoreal = { materials: [], lights: [{ id: 'panel', type: 'area', position: [0, 6, 0], watts: 600 }], atmosphere: { haze: 0.2 } };
    db.getIngredient.mockResolvedValue(record);
    const worker = fakeWorker({
      'report.json': JSON.stringify({ version: '5.2.3', engine: 'CYCLES', device: 'GPU', backend: 'METAL', samples: 64, parts: 1, shots: [{ shotId: 'wide', seconds: 12.5 }] }),
      'blockout.blend': 'BLENDER-v503',
      'shot-wide.png': PNG,
      'shot-booth.png': PNG,
    });
    __setPhotorealDepsForTests({
      resolveTool: async () => ({ executable: '/opt/blender', version: '5.2.3', worker }),
      lastCheckedVersion: async () => '5.2.3',
    });

    const job = await startPhotorealRender(record.id, { shotIds: ['wide', 'booth'], engine: 'cycles', samples: 64 });
    expect(job).toMatchObject({ state: 'running', engine: 'cycles', samples: 64, shotIds: ['wide', 'booth'] });
    await expect(finished(record.id)).resolves.toMatchObject({ state: 'done', report: { device: 'GPU' } });

    // The scene goes in as data beside PortOS's own script; argv never runs caller code.
    const data = JSON.parse(fakeWorker.lastFiles.find((f) => f.path === 'greybox-blender.json').content);
    expect(data).toMatchObject({ engine: 'CYCLES', samples: 64, longEdge: 1920, shotIds: ['wide', 'booth'],
      look: { lights: [{ id: 'panel', size: 0.25 }], atmosphere: { haze: 0.2, sun: false } } });
    expect(worker.mock.calls[0][0].tool.argv('entry.py')).toEqual(expect.arrayContaining(['--background', '--disable-autoexec', '--python', 'entry.py']));
    expect(upload).toHaveBeenCalledWith(expect.objectContaining({ role: 'photoreal:wide', mimeType: 'image/png', dataBase64: PNG.toString('base64'),
      caption: expect.stringContaining('Cycles, 64 samples, 12.5s') }));
    // The stale booth render is replaced; the wide render stays because it is that camera's plate.
    expect(db.detachMedia.mock.calls).toEqual([[record.id, 'stale-booth.png', 'reference']]);
    await expect(getPhotorealStatus(record.id)).resolves.toMatchObject({
      blendUrl: `/api/catalog/ingredients/${record.id}/photoreal/blend`, blenderVersion: '5.2.3', job: { state: 'done' },
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
    release({ status: 'killed', reason: 'wall clock' });
    await expect(finished(`plc-${seq}`)).resolves.toMatchObject({ state: 'failed', error: expect.stringContaining('wall clock') });
    expect(upload).not.toHaveBeenCalled();
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
