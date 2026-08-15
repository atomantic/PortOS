import { beforeEach, describe, expect, it, vi } from 'vitest';

// Proves models.js dispatches create/render purely through the adapter registry
// (adapters.js) — registering an additional target needs no `if (targetId === …)`
// branch in models.js. Deliberately mocks `./adapters.js` directly (not
// `./trellis2.js`, as models.test.js does) with a target that shares no code with
// TRELLIS.2, so a passing test here can't be explained by TRELLIS.2-specific
// wiring (#3080).

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  rm: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { imageTo3d: '/mock/data/image-to-3d' },
  resolveGalleryImage: vi.fn((filename) => `/mock/data/images/${filename}`),
  ensureDir: vi.fn(() => Promise.resolve()),
}));

vi.mock('./targets.js', () => ({
  DEFAULT_IMAGE_TO_3D_TARGET: 'trellis2',
  detectHostCapabilities: vi.fn(() => ({ appleSilicon: true, unifiedMemoryGb: 128, cuda: false })),
  resolveTarget: vi.fn((id) => ({
    targetId: id, target: { id, label: id }, available: true, reason: null,
  })),
}));

vi.mock('../../lib/hfToken.js', () => ({
  hfChildEnv: vi.fn(async () => ({ HF_TOKEN: 'hf_test' })),
}));

// models.js also claims the machine-wide heavy-accelerator lock before
// rendering (see heavyJobClaim.js). Mock it the same way models.test.js does —
// this suite mocks fileUtils.js down to `imageTo3d` alone, and the real
// heavyJobClaim.js needs PATHS.data at import time.
vi.mock('../../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, holder: {}, release: vi.fn(() => Promise.resolve()) })),
}));

vi.mock('./db.js', () => ({
  listModels: vi.fn(),
  getModel: vi.fn(),
  createModel: vi.fn(),
  mutateModel: vi.fn(),
  deleteModel: vi.fn(),
  recoverInterruptedModels: vi.fn(),
}));

const fakeIsInstalled = vi.fn(() => true);
const fakeRun = vi.fn(() => ({
  promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
  kill: vi.fn(),
}));

vi.mock('./adapters.js', () => ({
  getTargetAdapter: vi.fn((id) => (id === 'second-target' ? { isInstalled: fakeIsInstalled, run: fakeRun } : null)),
}));

import { hfChildEnv } from '../../lib/hfToken.js';
import * as store from './db.js';
import { createModel } from './models.js';

describe('models.js target dispatch is adapter-registry-driven (#3080)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeIsInstalled.mockReturnValue(true);
    fakeRun.mockReturnValue({
      promise: Promise.resolve({ assetPath: '/mock/data/image-to-3d/x/model.glb' }),
      kill: vi.fn(),
    });
    store.getModel.mockResolvedValue(null);
  });

  it('renders through a newly-registered adapter with no target-specific branch in models.js', async () => {
    let current = { id: 'image3d-2', target: 'second-target', status: 'draft', runs: [] };
    store.createModel.mockImplementation(async () => current);
    store.mutateModel.mockImplementation(async (_id, mutate) => {
      const next = mutate(current);
      if (next) current = next;
      return current;
    });

    const started = await createModel({ name: 'Second', filename: 'shot.png', target: 'second-target' });
    expect(started.status).toBe('generating');

    await vi.waitFor(() => expect(fakeRun).toHaveBeenCalled());
    expect(fakeIsInstalled).toHaveBeenCalled();
    // #3080: env/credential resolution is adapter-owned (`resolveEnv`) — a
    // target that declares no `resolveEnv` must never trigger the Hugging Face
    // token lookup or receive an env it never asked for.
    expect(hfChildEnv).not.toHaveBeenCalled();
    expect(fakeRun).toHaveBeenCalledWith(expect.objectContaining({ env: undefined }));
  });

  it('501s a target the adapter registry has no adapter for', async () => {
    await expect(createModel({ name: 'Unregistered', filename: 'shot.png', target: 'unregistered' }))
      .rejects.toMatchObject({ status: 501, code: 'TARGET_NO_RUNNER' });
    expect(store.createModel).not.toHaveBeenCalled();
  });
});
