import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-moltworld-authority-'),
}));
afterAll(cleanupTempDataRoots);

// Moltworld world actions, queue and WebSocket controls are plain writes under the
// default-deny gate (#16018), whose principal matrix lives in services/authGate.test.js.
// This suite keeps one authorized workflow per router.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
const effects = vi.hoisted(() => ({
  getAccountWithCredentials: vi.fn(async () => ({ status: 'active', platform: 'moltworld', credentials: { apiKey: 'example-key' } })),
  recordActivity: vi.fn(), joinWorld: vi.fn(async () => ({})), connect: vi.fn(), getStatus: vi.fn(() => ({})),
}));
vi.mock('../services/platformAccounts.js', () => effects);
vi.mock('../services/agentPersonalities.js', () => ({ getAgentById: vi.fn() }));
vi.mock('../services/agentActivity.js', () => ({ logActivity: vi.fn() }));
vi.mock('../integrations/moltworld/index.js', () => ({ createMoltworldClient: () => effects }));
vi.mock('../services/moltworldWs.js', () => effects);
vi.mock('../services/moltworldQueue.js', () => effects);

const base = '/api/agents/tools/moltworld';
const mounts = [
  [`${base}/ws`, (await import('./moltworldWs.js')).default],
  [base, (await import('./moltworldTools.js')).default],
];

beforeEach(() => { vi.clearAllMocks(); auth.enabled = false; });

describe('Moltworld routers behind the default-deny gate (#16114)', () => {
  it('still joins the world and connects the socket for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `${base}/join`, { accountId: 'example-account' }, effects.joinWorld, 200],
      ['post', `${base}/ws/connect`, { accountId: 'example-account' }, effects.connect, 200],
    ] });
  });
});
