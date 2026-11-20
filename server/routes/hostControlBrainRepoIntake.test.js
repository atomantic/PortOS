import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Session minting writes auth-sessions.json; keep it out of the real data/ tree.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-brain-repo-intake-') }));
afterAll(cleanupTempDataRoots);

// Automatic repository intake (#11037). Link create and capture are gated by the
// default-deny write policy (#16018); the refusal and principal matrix live in
// services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js, and the data-only
// autoClone:false path in services/brain.test.js. The real Brain router and
// service run here; storage (in memory), the clone and the post-clone intake
// queue are doubled, so the workflow watches the agent dispatch at its end.
const auth = vi.hoisted(() => ({ enabled: false }));
const store = vi.hoisted(() => ({ links: new Map() }));
const clone = vi.hoisted(() => ({ cloneRepo: vi.fn(), runRepoIntake: vi.fn(async () => ({})) }));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [] })),
  getInstanceId: vi.fn(async () => 'example-instance'),
  ensureInstanceId: vi.fn(async () => 'example-instance'),
  UNKNOWN_INSTANCE_ID: 'unknown',
}));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => {}) }));
vi.mock('../services/repoCloner.js', async () => ({
  isDerivedClonePath: (await vi.importActual('../services/repoCloner.js')).isDerivedClonePath,
  cloneRepo: clone.cloneRepo,
  pullRepo: vi.fn(),
  reapStaleCloneStaging: vi.fn(async () => 0),
}));
vi.mock('../services/repoIntake.js', () => ({
  runRepoIntake: clone.runRepoIntake,
  queueMalwareScan: vi.fn(),
  restudyRepoLink: vi.fn(),
}));
vi.mock('../services/malwareScanReports.js', () => ({ getScanReport: vi.fn() }));
vi.mock('../lib/openFolder.js', () => ({ openFolderInSystemExplorer: vi.fn() }));
vi.mock('../services/brainStorage.js', async (importOriginal) => ({
  ...await importOriginal(),
  // No duplicate-URL hit, so each principal's create clones afresh.
  getLinkByUrl: vi.fn(async () => null),
  getLinkById: vi.fn(async (id) => store.links.get(id) ?? null),
  createLink: vi.fn(async (data) => {
    const link = { id: `link-${store.links.size + 1}`, ...data };
    store.links.set(link.id, link);
    return link;
  }),
  updateLink: vi.fn(async (id, patch) => {
    if (!store.links.has(id)) return null;
    const link = { ...store.links.get(id), ...patch };
    store.links.set(id, link);
    return link;
  }),
  updateLinkWith: vi.fn(async (id, mutate) => {
    if (!store.links.has(id)) return null;
    const patch = await mutate({ ...store.links.get(id) });
    if (!patch) return null;
    const link = { ...store.links.get(id), ...patch };
    store.links.set(id, link);
    return link;
  }),
}));

const mounts = [['/api/brain', (await import('./brain.js')).default]];
const REPO_URL = 'https://github.com/example-org/example-repo';
const intake = { malwareScan: true, learn: true, providerId: 'example-cli', model: 'example-model', effort: 'high' };

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  store.links.clear();
  clone.cloneRepo.mockResolvedValue({ localPath: '/repos/example-org/example-repo' });
});

describe('Brain router behind the default-deny gate (#16114)', () => {
  it('still clones and queues repository intake for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/brain/links', { url: REPO_URL, repoIntake: intake }, clone.runRepoIntake, 201],
    ] });
    expect(clone.cloneRepo).toHaveBeenCalledTimes(2);
    // The provider/model/effort pins ride along on the persisted record.
    expect(clone.runRepoIntake.mock.calls[0][1]).toEqual(expect.objectContaining(intake));
  });
});
