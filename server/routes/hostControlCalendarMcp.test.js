import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Calendar MCP sync (#11051), host-browser automation (#12952) and generic sync
// (#13055) are gated by the default-deny write policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// The real Calendar router, MCP service and provider picker run here, so the
// workflow proves the sync still reaches the configured CLI. Persistence and the
// CLI sink are doubled; no real calendar, database, provider or instance data is used.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-calendar-authority-') }));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
const fixture = vi.hoisted(() => ({
  id: '00000000-0000-4000-8000-000000000001',
  calendarId: 'example-calendar',
  marker: 'EXAMPLE_UNTRUSTED_SUBCALENDAR_TEXT',
  account: null,
  provider: {
    id: 'example-codex', name: 'Example Codex', type: 'cli', enabled: true,
    command: 'codex', args: [], models: ['example-model'], defaultModel: 'example-model',
  },
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({ calendarSync: { providerId: fixture.provider.id, model: 'example-model' } })),
}));
vi.mock('../services/provider/providers.js', () => ({
  getAllProviders: vi.fn(async () => ({ providers: {
    'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', enabled: true },
    [fixture.provider.id]: fixture.provider,
  } })),
}));
vi.mock('../lib/cliProviderRun.js', async (importOriginal) => ({
  ...await importOriginal(),
  runCliProviderPrompt: vi.fn(async ({ prompt }) => {
    const [, timeMin, timeMax] = prompt.match(/date range (\d{4}-[\w:.-]+Z) to (\d{4}-[\w:.-]+Z)/);
    return {
      text: JSON.stringify({ calendars: [{ calendarId: fixture.calendarId, events: [], complete: true, nextPageToken: null, timeMin, timeMax }] }),
      exitCode: 0, partial: false,
    };
  }),
}));
vi.mock('../services/calendarAccounts.js', async (importOriginal) => ({
  ...await importOriginal(),
  getAccount: vi.fn(async () => fixture.account),
  updateSyncStatus: vi.fn(async () => ({})),
}));
vi.mock('../services/calendarSync.js', async (importOriginal) => ({
  ...await importOriginal(),
  mutateCache: vi.fn(async (_id, mutate) => mutate({ events: [] }, fixture.account)),
  purgeDisabledSubcalendars: vi.fn(async () => {}),
}));
// Service graphs the router imports; their handlers are not reached.
vi.mock('../services/calendarGoogleApiSync.js', () => ({}));
vi.mock('../services/dailyReview.js', () => ({}));
vi.mock('../services/googleAuth.js', () => ({}));
vi.mock('../services/googleOAuthAutoConfig.js', () => ({}));
vi.mock('../services/messageTokenExtractor.js', () => ({}));

const { runCliProviderPrompt } = await import('../lib/cliProviderRun.js');
const mounts = [['/api/calendar', (await import('./calendar.js')).default]];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  fixture.account = {
    id: fixture.id, name: 'Example Account', type: 'google-calendar', enabled: true,
    subcalendars: [{ calendarId: fixture.calendarId, name: fixture.marker, enabled: true, dormant: false }],
  };
});

describe('Calendar router behind the default-deny gate (#16114)', () => {
  it('still runs the MCP sync with the configured CLI for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `/api/calendar/sync/${fixture.id}/google`, {}, runCliProviderPrompt, 200],
    ] });
    const [call] = runCliProviderPrompt.mock.lastCall;
    expect(call).toEqual(expect.objectContaining({ provider: fixture.provider, model: 'example-model', extraArgs: [] }));
    expect(call.prompt).toContain(fixture.marker);
  });
});
