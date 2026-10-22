import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Real Calendar router, MCP services and provider picker behind production
// middleware. Persistence and the CLI sink are doubled; no real calendar,
// database, provider or instance data is used.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-calendar-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
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
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({ calendarSync: { providerId: fixture.provider.id, model: 'example-model' } })),
}));
vi.mock('../services/providers.js', () => ({
  getAllProviders: vi.fn(async () => ({ providers: {
    'claude-code': { id: 'claude-code', type: 'cli', command: 'claude', enabled: true },
    [fixture.provider.id]: fixture.provider,
  } })),
}));
vi.mock('../lib/cliProviderRun.js', async (importOriginal) => ({
  ...await importOriginal(),
  runCliProviderPrompt: vi.fn(async ({ prompt }) => {
    const discovery = prompt.includes('gcal_list_calendars');
    const [, timeMin, timeMax] = discovery ? [] : prompt.match(/date range (\d{4}-[\w:.-]+Z) to (\d{4}-[\w:.-]+Z)/);
    return {
      text: JSON.stringify(discovery
        ? [{ id: fixture.calendarId, name: fixture.marker }]
        : { calendars: [{ calendarId: fixture.calendarId, events: [], complete: true, nextPageToken: null, timeMin, timeMax }] }),
      exitCode: 0, partial: false,
    };
  }),
}));
vi.mock('../services/calendarAccounts.js', async (importOriginal) => ({
  ...await importOriginal(),
  getAccount: vi.fn(async () => fixture.account),
  updateSyncStatus: vi.fn(async () => ({})),
  updateSubcalendars: vi.fn(async (_id, subcalendars) => {
    fixture.account = { ...fixture.account, subcalendars };
    return fixture.account;
  }),
}));
vi.mock('../services/calendarSync.js', async (importOriginal) => ({
  ...await importOriginal(),
  mutateCache: vi.fn(async (_id, mutate) => mutate({ events: [] }, fixture.account)),
  purgeDisabledSubcalendars: vi.fn(async () => {}),
  logCalendarTouchpoints: vi.fn(async () => {}),
  recordCalendarActivity: vi.fn(async () => {}),
}));
vi.mock('../services/calendarGoogleApiSync.js', () => ({
  apiSyncAccount: vi.fn(async () => ({ status: 'success' })),
  apiDiscoverCalendars: vi.fn(async () => ({ calendars: [] })),
}));
vi.mock('../services/dailyReview.js', () => ({}));
vi.mock('../services/googleAuth.js', () => ({}));
vi.mock('../services/googleOAuthAutoConfig.js', () => ({
  startAutoConfig: vi.fn(async () => ({ status: 'opened' })),
  captureCredentials: vi.fn(async () => ({ status: 'captured' })),
  runAutomatedSetup: vi.fn(async () => ({ status: 'configured' })),
}));
vi.mock('../services/messageTokenExtractor.js', () => ({
  getToken: vi.fn(async () => ({ token: 'example-token', fresh: true, decoded: {} })), getTokenStatus: vi.fn(), clearTokenCache: vi.fn(),
}));
// Outlook generic sync: token capture in the signed-in tab, then the Graph fetch.
// null is its "no token" answer, which syncAccount reports as skipped.
vi.mock('../services/calendarApiSync.js', async (importOriginal) => ({
  ...await importOriginal(), syncOutlookCalendarApi: vi.fn(async () => null),
}));

import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import { getAllProviders } from '../services/providers.js';
import { runCliProviderPrompt } from '../lib/cliProviderRun.js';
import { getAccount, updateSyncStatus, updateSubcalendars } from '../services/calendarAccounts.js';
import { mutateCache } from '../services/calendarSync.js';
import { apiSyncAccount, apiDiscoverCalendars } from '../services/calendarGoogleApiSync.js';
import { startAutoConfig, captureCredentials, runAutomatedSetup } from '../services/googleOAuthAutoConfig.js';
import { getToken } from '../services/messageTokenExtractor.js';
import { syncOutlookCalendarApi } from '../services/calendarApiSync.js';
import calendarRoutes from './calendar.js';

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/calendar', calendarRoutes);
  app.use(errorMiddleware);
  return app;
};
const post = (app, action, headers = {}, variant = false) => {
  const path = `/api/calendar/sync/${fixture.id}/${action}`;
  const pending = request(app).post(variant ? path.toUpperCase() + '/' : path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send({});
};
const expectNoEffects = () => {
  for (const effect of [getAccount, getAllProviders, runCliProviderPrompt, updateSyncStatus, updateSubcalendars, mutateCache]) {
    expect(effect).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
  fixture.account = {
    id: fixture.id, name: 'Example Account', type: 'google-calendar', enabled: true,
    subcalendars: [{ calendarId: fixture.calendarId, name: fixture.marker, enabled: true, dormant: false }],
  };
});

describe('Calendar MCP operator authority (#11051)', () => {
  it('refuses remote and proxied calls, including Express URL variants, before account, provider or CLI effects', async () => {
    for (const action of ['google', 'discover']) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        for (const variant of [false, true]) {
          const response = await post(appFor(address), action, headers, variant);
          expect([response.status, response.body.code], action).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
      }
    }
    expectNoEffects();
  });

  it('keeps password authentication and scoped-peer limits, and refuses Basic as operator authority', async () => {
    auth.enabled = true;
    for (const action of ['google', 'discover']) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await post(appFor(), action, headers);
        expect([response.status, response.body.code], action).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('preserves genuine local, human-session and delegated-agent execution with the configured CLI', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const action of ['google', 'discover']) {
        runCliProviderPrompt.mockClear();
        const response = await post(appFor(address), action, headers);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        expect(response.body.status).toBe('success');
        expect(runCliProviderPrompt).toHaveBeenCalledTimes(1);
        const call = runCliProviderPrompt.mock.calls[0][0];
        expect(call).toEqual(expect.objectContaining({ provider: fixture.provider, model: 'example-model', extraArgs: [] }));
        if (action === 'google') expect(call.prompt).toContain(fixture.marker);
      }
    }
  });

  it('allows remote reference-data edits, push ingestion and direct API operations without a CLI', async () => {
    const app = appFor();
    const edited = await request(app).put(`/api/calendar/accounts/${fixture.id}/subcalendars`).send({
      subcalendars: [{ calendarId: fixture.calendarId, name: fixture.marker, enabled: true }],
    });
    expect(edited.status).toBe(200);
    const read = await request(app).get(`/api/calendar/accounts/${fixture.id}/subcalendars`);
    expect(read.body[0].name).toBe(fixture.marker);
    const pushed = await request(app).post(`/api/calendar/sync/${fixture.id}/push`).send({
      calendarId: fixture.calendarId, calendarName: fixture.marker, events: [],
    });
    expect(pushed.status).toBe(200);
    expect(mutateCache).toHaveBeenCalledTimes(1);
    for (const action of ['api', 'discover-api']) expect((await post(app, action)).status).toBe(200);
    expect(apiSyncAccount).toHaveBeenCalledWith(fixture.id, undefined);
    expect(apiDiscoverCalendars).toHaveBeenCalledWith(fixture.id);

    // The stored marker remains data: neither MCP entry point may consume it
    // when this same remote caller tries to start the agent.
    getAccount.mockClear();
    getAllProviders.mockClear();
    for (const action of ['google', 'discover']) expect((await post(app, action)).status).toBe(403);
    expect(getAccount).not.toHaveBeenCalled();
    expect(getAllProviders).not.toHaveBeenCalled();
    expect(runCliProviderPrompt).not.toHaveBeenCalled();
  });
});

describe('Calendar host-browser automation operator authority (#12952)', () => {
  const browserActions = [
    ['/api/calendar/google/auto-configure/start', startAutoConfig],
    ['/api/calendar/google/auto-configure/capture', captureCredentials],
    ['/api/calendar/google/auto-configure/run', runAutomatedSetup],
    ['/api/calendar/debug/test-token', getToken],
  ];

  it('refuses a remote password-free caller, direct or proxied, before the host browser is driven', async () => {
    for (const [path, effect] of browserActions) {
      for (const [address, headers] of [['192.0.2.10', {}], ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }]]) {
        const pending = request(appFor(address)).post(path);
        for (const [name, value] of Object.entries(headers)) pending.set(name, value);
        const response = await pending.send({});
        expect([response.status, response.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      expect(effect, path).not.toHaveBeenCalled();
    }
  });

  it('keeps local, operator-session and delegated-agent callers able to run it', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const [path] of browserActions) {
        const pending = request(appFor(address)).post(path);
        for (const [name, value] of Object.entries(headers)) pending.set(name, value);
        const response = await pending.send({});
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
      }
    }
    for (const [path, effect] of browserActions) expect(effect, path).toHaveBeenCalledTimes(3);
  });
});

describe('Calendar generic sync operator authority (#13055)', () => {
  // An Outlook account's generic sync captures a bearer token from the
  // operator's signed-in browser tab on a cache miss, so the route is gated
  // whole; its /api, /push and /discover-api siblings stay open (above).
  const path = `/api/calendar/sync/${fixture.id}`;
  const sync = (app, headers = {}, target = path) => {
    const pending = request(app).post(target);
    for (const [name, value] of Object.entries(headers)) pending.set(name, value);
    return pending.send({});
  };
  const expectNotSynced = () => {
    for (const effect of [getAccount, syncOutlookCalendarApi, getToken]) expect(effect).not.toHaveBeenCalled();
  };
  beforeEach(() => {
    fixture.account = { ...fixture.account, type: 'outlook-calendar' };
  });

  it('refuses remote, spoofed-proxy and URL-variant callers before the account is read', async () => {
    for (const [address, headers] of [
      ['192.0.2.10', {}],
      ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
      ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
    ]) {
      for (const target of [path, path.toUpperCase() + '/']) {
        const response = await sync(appFor(address), headers, target);
        expect([response.status, response.body.code], target).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNotSynced();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const [headers, status, code] of [
      [{}, 401, 'AUTH_REQUIRED'],
      [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      [{
        [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
        [PEER_INSTANCE_HEADER]: 'example-instance',
      }, 403, 'PEER_SCOPE_FORBIDDEN'],
    ]) {
      const response = await sync(appFor(), headers);
      expect([response.status, response.body.code]).toEqual([status, code]);
    }
    expectNotSynced();
  });

  it('keeps local, operator-session and delegated-agent callers able to sync', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Cookie: `portos_auth=${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      const response = await sync(appFor(address), headers);
      expect([response.status, response.body.status], JSON.stringify(response.body)).toEqual([200, 'skipped']);
    }
    expect(syncOutlookCalendarApi).toHaveBeenCalledTimes(3);
    expect(syncOutlookCalendarApi).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: fixture.id, type: 'outlook-calendar' }), expect.anything(), undefined, {},
    );
  });
});
