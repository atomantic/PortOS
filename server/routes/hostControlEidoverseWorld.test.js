import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-eidoverse-world-authority-') }));
afterAll(cleanupTempDataRoots);

// Eidoverse augment and say act in the private world as the owner-granted CoS
// identity (#13055). Both are plain writes under the default-deny gate (#16018),
// whose principal matrix lives in services/authGate.test.js. This suite keeps the
// router's authorized workflow; the world service is doubled so no connection opens.
const auth = vi.hoisted(() => ({ enabled: false }));
const world = vi.hoisted(() => ({
  augment: vi.fn(async () => ({ success: true, applied: 1 })),
  say: vi.fn(async () => ({ success: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [] })),
}));
vi.mock('../services/eidoverseWorld.js', () => ({
  augmentEidoverseWorld: world.augment,
  sayInEidoverseWorld: world.say,
  getEidoverseWorldStatus: vi.fn(async () => ({ installed: true })),
}));
vi.mock('../services/eidoverseFoundationLedger.js', () => ({}));
vi.mock('../services/eidoverseControllerRuntime.js', () => ({}));
vi.mock('../services/eidoverseControllerRegistry.js', () => ({}));
const mounts = [['/api/eidoverse/world', (await import('./eidoverseWorldRoutes.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Eidoverse world router behind the default-deny gate (#16114)', () => {
  it('still augments and speaks for a local operator and a delegated agent session', async () => {
    const operations = [{ verb: 'grant', args: { id: 'example-visitor', role: 'owner' } }];
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/eidoverse/world/augment', { operations }, world.augment, 200],
      ['post', '/api/eidoverse/world/say', { text: 'Example message' }, world.say, 200],
    ] });
    expect(world.augment).toHaveBeenLastCalledWith(operations);
    expect(world.say).toHaveBeenLastCalledWith('Example message');
  });
});
