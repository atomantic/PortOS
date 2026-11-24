import { afterAll, beforeEach, describe, it, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-setup-checks-') }));
afterAll(cleanupTempDataRoots);

// The iMessage and Contacts setup checks open TCC-protected host databases and
// return host paths, so they sit behind the host-control gate like Signal's (#18279).
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  imessageSetup: vi.fn(async () => ({ ok: true })),
  contactsSetup: vi.fn(async () => ({ ok: true })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/imessageSync.js', () => ({ checkSetup: effects.imessageSetup }));
vi.mock('../services/imessageManage.js', () => ({}));
vi.mock('../services/contactsSync.js', () => ({ checkSetup: effects.contactsSetup }));
vi.mock('../services/tribeContacts.js', () => ({}));

const imessageCheck = ['get', '/api/imessage/setup-check', undefined, effects.imessageSetup, 200];
const contactsCheck = ['get', '/api/contacts/setup-check', undefined, effects.contactsSetup, 200];
const mounts = [
  ['/api/imessage', (await import('./imessage.js')).default],
  ['/api/contacts', (await import('./contacts.js')).default],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('iMessage and Contacts setup checks behind the host-control gate (#18279)', () => {
  it.each([[imessageCheck], [contactsCheck]])('refuses the setup check to a remote password-free caller', async (check) => {
    await expectRemoteRefusal(mounts, check);
  });

  it('still runs for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [imessageCheck, contactsCheck] });
  });
});
