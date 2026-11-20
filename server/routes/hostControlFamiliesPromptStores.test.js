import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-prompt-stores-authority-') }));
afterAll(cleanupTempDataRoots);

// Instruction-store writes (prompts, mind recipes, personas, tools, twin settings)
// are plain writes under the default-deny gate (#16018), whose principal matrix lives
// in services/authGate.test.js; server/test/guards/modules/hostControlCoverage.test.js pins every mounted one.
// This suite keeps the twin-settings router's authorized workflow and what it persists.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', async (original) => ({
  ...await original(), getSettings: vi.fn(async () => ({})),
}));
const twin = vi.hoisted(() => ({ current: {}, loadMeta: vi.fn(), updateSettings: vi.fn() }));
vi.mock('../services/digital-twin.js', () => twin);
const mounts = [['/api/digital-twin', (await import('./digital-twin/settings.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  twin.current = { autoInjectToCoS: true, includePrivacyContext: false, activePersonaId: null, maxContextTokens: 4000 };
  twin.loadMeta.mockImplementation(async () => ({ settings: { ...twin.current } }));
  twin.updateSettings.mockImplementation(async data => Object.assign(twin.current, data));
});

describe('twin instruction settings behind the default-deny gate (#16114)', () => {
  it('still updates the settings for a local operator and a delegated agent session', async () => {
    const form = { autoInjectToCoS: false, includePrivacyContext: true, maxContextTokens: 5000 };
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['put', '/api/digital-twin/settings', form, twin.updateSettings, 200],
    ] });
    expect(twin.current).toMatchObject(form);
  });
});
