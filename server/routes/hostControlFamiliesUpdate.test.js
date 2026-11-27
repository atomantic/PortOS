import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'path';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-families-update-') }));
afterAll(cleanupTempDataRoots);

// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; this keeps one refusal before the self-update
// effect and the authorized workflow of the brain-link and ask routers.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));

const updateChecker = vi.hoisted(() => ({
  getRemoteInfo: vi.fn(),
}));
vi.mock('../services/updateChecker.js', () => updateChecker);

const selfUpdate = vi.hoisted(() => ({
  startPortosSelfUpdate: vi.fn(),
}));
vi.mock('../services/portosSelfUpdate.js', () => selfUpdate);

const nodeRuntime = vi.hoisted(() => ({
  getNodeRuntimeStatus: vi.fn(),
  startNodeUpdate: vi.fn(),
  startPm2Update: vi.fn(),
  repairStartup: vi.fn(),
}));
vi.mock('../services/nodeRuntime.js', () => nodeRuntime);

const brainService = vi.hoisted(() => ({
  getLinkById: vi.fn(),
}));
vi.mock('../services/brainStorage.js', async (importOriginal) => ({ ...await importOriginal(), ...brainService }));

const repoCloner = vi.hoisted(() => ({
  pullRepo: vi.fn(),
}));
vi.mock('../services/repoCloner.js', async () => ({
  ...repoCloner,
  isDerivedClonePath: (await vi.importActual('../services/repoCloner.js')).isDerivedClonePath,
}));

const askPromote = vi.hoisted(() => ({
  promoteTurnById: vi.fn(),
}));
vi.mock('../services/askPromote.js', () => askPromote);

const askConversations = vi.hoisted(() => ({
  ID_RE: /^[a-z0-9-]+$/,
  VALID_MODES: ['ask'],
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn(),
  deleteConversation: vi.fn(),
  setPromoted: vi.fn(),
}));
vi.mock('../services/askConversations.js', () => askConversations);
vi.mock('../services/askService.js', () => ({
  runAsk: vi.fn(),
  VALID_MODES: askConversations.VALID_MODES,
}));

const { PATHS } = await import('../lib/fileUtils.js');
import updateRoutes from './update.js';
import brainLinksRoutes from './brainLinks.js';
import askRoutes from './ask.js';

const mounts = [
  ['/api/update', updateRoutes],
  ['/api/brain', brainLinksRoutes],
  ['/api/ask', askRoutes],
];

describe('host-control gate on update, brain-link and ask promote writes (#8742, #16114)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.enabled = false;
    brainService.getLinkById.mockResolvedValue({
      id: 'link-1', isRepo: true, url: 'https://github.com/example-owner/example-repo',
      localPath: join(PATHS.repos, 'example-owner', 'example-repo'), cloneStatus: 'idle',
    });
    repoCloner.pullRepo.mockResolvedValue({ updated: true });
    askConversations.getConversation.mockResolvedValue({ id: 'conv-1' });
    askConversations.setPromoted.mockResolvedValue({ id: 'conv-1', promoted: true });
    askPromote.promoteTurnById.mockResolvedValue({ target: 'task', taskId: 'task-1' });
  });

  it('refuses a remote caller before the self-update runs', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/update/execute', {}, selfUpdate.startPortosSelfUpdate]);
  });

  it('keeps the pull, the turn promote and the flag-only conversation promote working for local and agent callers', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/brain/links/link-1/pull', {}, repoCloner.pullRepo, 200],
      ['post', '/api/ask/conv-1/turns/turn-1/promote', { target: 'task' }, askPromote.promoteTurnById, 200],
      ['post', '/api/ask/conv-1/promote', {}, askConversations.setPromoted, 200],
    ] });
    // The conversation-level promote is a flag write, not a turn promotion.
    expect(askPromote.promoteTurnById).toHaveBeenCalledTimes(2);
  });
});
