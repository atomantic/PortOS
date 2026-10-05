/**
 * Rig and retarget records against a backup cut (#9982). Each run publishes a
 * verified GLB+report pair into its own directory, which is never replaced, and
 * only then does the image-to-3D row come to name it. A cut copies files before
 * it dumps rows, so the row commit takes the lease: a cut either follows the
 * commit, with the pair already on disk to copy, or precedes it, and the dumped
 * row is still `rigging` / `retargeting`. The worker run itself stays outside.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../imageTo3d/db.js', () => ({ getModel: vi.fn(), mutateModel: vi.fn() }));
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));

const store = await import('../imageTo3d/db.js');
const { rigImageTo3dModel } = await import('./autoSkin.js');
const { retargetImageTo3dModel } = await import('./retarget.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const MODEL_ID = 'image3d-example';

const rigResult = {
  rigId: 'rig-example',
  assetPath: `/data/image-to-3d/${MODEL_ID}/rig/rig-example/character.rigged.glb`,
  sha256: 'a'.repeat(64),
  bytes: 1234,
  summary: { boneCount: 24 },
};
const retargetResult = {
  retargetId: 'retarget-example',
  rigId: 'rig-example',
  clip: 'Walk',
  assetPath: `/data/image-to-3d/${MODEL_ID}/retarget/retarget-example/character.animated.glb`,
  sha256: 'b'.repeat(64),
  bytes: 2345,
  summary: { clip: 'Walk' },
};

let current;
/** Pauses only the commit that first names a published pair; the in-flight marker write is never held. */
let hold;
function installStore(field) {
  store.getModel.mockImplementation(async () => current);
  store.mutateModel.mockImplementation(async (_id, mutate) => {
    const next = mutate(current);
    if (field(next)?.sha256) await hold?.();
    if (next) current = next;
    return current;
  });
}

const rigging = () => rigImageTo3dModel(MODEL_ID, {}, { run: async () => rigResult, now: () => '2026-01-01T00:00:00.000Z' });
const retargeting = () => retargetImageTo3dModel(MODEL_ID, { clip: 'walk.glb' }, {
  run: async () => retargetResult,
  resolveClip: () => '/mock/clips/walk.glb',
  now: () => '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  hold = null;
  current = {
    id: MODEL_ID,
    status: 'ready',
    assetPath: `/data/image-to-3d/${MODEL_ID}/model.glb`,
    rig: { status: 'ready', rigId: 'rig-example', skeletonHint: 'mixamo' },
  };
});

describe.each([
  ['rig', rigging, (record) => record?.rig],
  ['retarget', retargeting, (record) => record?.retarget],
])('%s record and a backup cut', (_name, start, field) => {
  beforeEach(() => installStore(field));

  it('drains a cut behind the commit that first names the published pair', async () => {
    let reachedRow;
    const reached = new Promise((resolve) => { reachedRow = resolve; });
    let finishRow;
    const rowDone = new Promise((resolve) => { finishRow = resolve; });
    hold = async () => { reachedRow(); await rowDone; };

    const pending = start();
    await reached;
    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
    try {
      await settle();
      expect(cutReady, 'cut acquired while the ready row was committing').toBe(false);
      finishRow();
      (await cut)();
    } finally {
      finishRow();
    }
    await pending;
    expect(field(current).status).toBe('ready');
  });

  it('keeps the ready row out of a cut, so the dump still shows the in-flight state', async () => {
    const release = await acquireBackupSnapshotCut();
    let settled = false;
    const pending = start().then((value) => { settled = true; return value; });
    try {
      await settle();
      expect(settled).toBe(false);
      expect(field(current).status).toMatch(/^(rigging|retargeting)$/);
      expect(field(current).sha256).toBeUndefined();
    } finally {
      release();
    }
    await pending;
    expect(field(current)).toMatchObject({ status: 'ready', sha256: expect.stringMatching(/^[ab]{64}$/) });
  });
});
