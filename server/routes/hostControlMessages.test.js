import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-messages-authority-') }));
afterAll(cleanupTempDataRoots);

// Messages browser launch and Gmail API enable open tabs in the signed-in managed
// browser (#11433). Both are plain writes under the default-deny gate (#16018),
// whose principal matrix lives in services/authGate.test.js. This suite keeps the
// router's authorized workflow.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => ({ peers: [] })) }));

const account = { id: '00000000-0000-4000-8000-000000000001', type: 'outlook', name: 'Example Mail' };
const effects = vi.hoisted(() => ({
  getAccount: vi.fn(),
  launchProvider: vi.fn(async () => ({ success: true })),
  navigateToUrl: vi.fn(async () => true),
}));
vi.mock('../services/messageAccounts.js', async (importOriginal) => ({
  ...await importOriginal(), getAccount: effects.getAccount,
}));
vi.mock('../services/messagePlaywrightSync.js', async (importOriginal) => ({
  ...await importOriginal(), launchProvider: effects.launchProvider,
}));
vi.mock('../services/browserService.js', async (importOriginal) => ({
  ...await importOriginal(), navigateToUrl: effects.navigateToUrl,
}));
vi.mock('../services/googleAuth.js', async (importOriginal) => ({
  ...await importOriginal(),
  getCredentials: vi.fn(async () => ({ clientId: '123456-example.apps.googleusercontent.com' })),
}));
const mounts = [['/api/messages', (await import('./messages.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  effects.getAccount.mockImplementation(async () => account);
});

describe('Messages router behind the default-deny gate (#16114)', () => {
  it('still launches the provider and opens the Gmail API page for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `/api/messages/launch/${account.id}`, {}, effects.launchProvider, 200],
      ['post', '/api/messages/gmail/enable-api', {}, effects.navigateToUrl, 200],
    ] });
    expect(effects.launchProvider).toHaveBeenLastCalledWith('outlook');
    expect(effects.navigateToUrl).toHaveBeenLastCalledWith(expect.stringContaining('gmail.googleapis.com'));
  });
});
