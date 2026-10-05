/**
 * Image-to-3D records against a backup cut (#9982). The runner writes
 * `model.glb` in place while the row still says `generating`, so only the commit
 * that marks the mesh ready takes the lease; an AR export replaces `model.usdz`
 * and stamps the row in one workflow. A cut copies files before it dumps rows,
 * so it must never land between a file write and the row that names it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeFile } = vi.hoisted(() => ({ writeFile: vi.fn(() => Promise.resolve()) }));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { imageTo3d: '/mock/data/image-to-3d' },
  resolveGalleryImage: vi.fn((filename) => `/mock/data/images/${filename}`),
  ensureDir: vi.fn(() => Promise.resolve()),
  rmGuarded: vi.fn(() => Promise.resolve()),
  writeFileGuarded: writeFile,
}));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
vi.mock('./targets.js', () => ({
  DEFAULT_IMAGE_TO_3D_TARGET: 'trellis2',
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  resolveTarget: vi.fn(() => ({ targetId: 'trellis2', target: { id: 'trellis2', label: 'TRELLIS.2' }, available: true, reason: null })),
  renderOptionSupportFor: vi.fn(() => null),
}));
vi.mock('./trellis2.js', () => ({
  isTrellis2Installed: vi.fn(() => true),
  runTrellis2Generate: vi.fn(() => ({ promise: Promise.resolve({}), kill: vi.fn() })),
}));
vi.mock('../hfToken.js', () => ({ hfChildEnv: vi.fn(async () => ({})) }));
vi.mock('./sourceKeying.js', () => ({ prepareSourceImage: vi.fn(async () => null) }));
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, holder: {}, release: vi.fn(async () => {}) })),
}));
vi.mock('../localMemory.js', async (importOriginal) => ({
  ...(await importOriginal()),
  prepareLocalMemory: vi.fn(async () => ({ unloaded: [], availableGb: 64, totalGb: 64, budgetGb: 64, blockers: [] })),
}));
vi.mock('./db.js', () => ({
  listModels: vi.fn(),
  listGeneratingModelSummaries: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  mutateModel: vi.fn(),
  deleteModel: vi.fn(),
  recoverInterruptedModels: vi.fn(),
}));

const store = await import('./db.js');
const { startGeneration, saveModelUsdz } = await import('./models.js');
const { drainActivityNotesForTests } = await import('../systemActivityNotify.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const usdzBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
const readyRecord = () => ({
  id: 'image3d-example',
  name: 'Beacon',
  target: 'trellis2',
  sourceImage: { filename: 'example.png' },
  status: 'ready',
  assetPath: '/data/image-to-3d/image3d-example/model.glb',
  generationOperationId: null,
  runs: [],
});

let current;
let beforeRowWrite;
/** `mutateModel` applies its updater to `current`, after an optional test-held pause. */
function installStore() {
  store.getModel.mockImplementation(async () => current);
  store.mutateModel.mockImplementation(async (_id, mutate) => {
    await beforeRowWrite?.();
    const next = mutate(current);
    if (next) current = next;
    return current;
  });
}

function holdRow() {
  let reached;
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  beforeRowWrite = async () => { reached(); await released; };
  return { reached: reachedPromise, release };
}

beforeEach(() => {
  drainActivityNotesForTests();
  vi.clearAllMocks();
  current = readyRecord();
  beforeRowWrite = null;
  installStore();
});

describe('image-to-3D AR export and a backup cut', () => {
  it('drains a cut behind an export that wrote the file but has not stamped its row', async () => {
    const row = holdRow();
    const saving = saveModelUsdz('image3d-example', usdzBytes);
    await row.reached;
    expect(writeFile).toHaveBeenCalledOnce();

    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
    try {
      await settle();
      expect(cutReady, 'cut acquired between model.usdz and its row').toBe(false);
      row.release();
      (await cut)();
    } finally {
      row.release();
    }
    const saved = await saving;
    expect(saved.usdzPath).toBe('/data/image-to-3d/image3d-example/model.usdz');
  });

  it('writes nothing while a cut is held, then exports once it closes', async () => {
    const release = await acquireBackupSnapshotCut();
    let settled = false;
    const saving = saveModelUsdz('image3d-example', usdzBytes).then((value) => { settled = true; return value; });
    try {
      await settle();
      expect(settled).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
    } finally {
      release();
    }
    expect((await saving).usdzPath).toBe('/data/image-to-3d/image3d-example/model.usdz');
    expect(writeFile).toHaveBeenCalledOnce();
  });
});

describe('image-to-3D render completion and a backup cut', () => {
  it('drains a cut behind the commit that marks a finished render ready', async () => {
    current = { ...readyRecord(), status: 'draft', assetPath: null };
    // The generation start (status flip) and the failure/progress writes are not
    // admitted; hold only the commit that carries `status: 'ready'`.
    let reachedReady;
    const reached = new Promise((resolve) => { reachedReady = resolve; });
    let finishReady;
    const readyDone = new Promise((resolve) => { finishReady = resolve; });
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next?.status === 'ready') { reachedReady(); await readyDone; }
      if (next) current = next;
      return current;
    });

    await startGeneration('image3d-example');
    await reached;
    expect(current.status).toBe('generating');

    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
    try {
      await settle();
      expect(cutReady, 'cut acquired while the ready commit was in flight').toBe(false);
      finishReady();
      (await cut)();
    } finally {
      finishReady();
    }
    await vi.waitFor(() => expect(current.status).toBe('ready'));
  });

  it('keeps the ready commit out of a cut: the dumped row is still generating', async () => {
    current = { ...readyRecord(), status: 'draft', assetPath: null };
    const release = await acquireBackupSnapshotCut();
    try {
      await startGeneration('image3d-example');
      await settle();
      // The render finished, but its commit waits for the cut to close.
      expect(current.status).toBe('generating');
    } finally {
      release();
    }
    await vi.waitFor(() => expect(current.status).toBe('ready'));
  });
});
