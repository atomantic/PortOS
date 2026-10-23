import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-privacy-authority-') }));
afterAll(cleanupTempDataRoots);

// Privacy broker scans, opt-out and verification passes, arming the broker
// recheck (route body or the `privacy` settings slice), broker consent grants,
// YouTube scrapes and the setup check in the managed browser, and Google Calendar goal blocks need
// operator authority (#13055). Real routers behind the real gates; the first
// service boundary is doubled so no browser, mail, DB or Google call runs.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  scan: vi.fn(async () => ({ scanned: 0 })),
  optOut: vi.fn(async () => ({ submitted: 0 })),
  verify: vi.fn(async () => ({ verified: 0 })),
  updateSettings: vi.fn(async (mutate) => mutate({})),
  restartRecheck: vi.fn(async () => {}),
  recordConsent: vi.fn(async (grant) => ({ id: 'example-grant', ...grant })),
  youtubeSync: vi.fn(async () => ({ ok: true })),
  youtubeSetupCheck: vi.fn(async () => ({ ok: true })),
  playlistSync: vi.fn(async () => ({ ok: true })),
  scheduleGoal: vi.fn(async () => ({ scheduled: 0 })),
  rescheduleGoal: vi.fn(async () => ({ scheduled: 0 })),
  settingsWrite: vi.fn((req, res) => res.json({ saved: Object.keys(req.body) })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: effects.updateSettings,
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/privacyScan.js', () => ({ runScanPass: effects.scan }));
vi.mock('../services/privacyOptOut.js', () => ({ runOptOutPass: effects.optOut, runVerificationPass: effects.verify }));
vi.mock('../services/privacyRecheckScheduler.js', () => ({
  restartPrivacyRecheckScheduler: effects.restartRecheck,
  getPrivacyRecheckStatus: vi.fn(async () => ({ enabled: false })),
}));
vi.mock('../services/privacySubjects.js', () => ({ recordConsent: effects.recordConsent }));
vi.mock('../services/privacyVault.js', () => ({}));
vi.mock('../services/privacyOrgs.js', () => ({}));
vi.mock('../services/privacyBrokers.js', () => ({}));
vi.mock('../services/privacyChanges.js', () => ({}));
vi.mock('../services/youtubeSync.js', () => ({ runSync: effects.youtubeSync, checkSetup: effects.youtubeSetupCheck }));
vi.mock('../services/youtubePlaylists.js', () => ({ syncYoutubePlaylists: effects.playlistSync }));
vi.mock('../services/goalCalendarScheduler.js', () => ({
  scheduleTimeBlocks: effects.scheduleGoal, rescheduleTimeBlocks: effects.rescheduleGoal,
}));
vi.mock('../services/identity.js', () => ({}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import privacyRoutes from './privacy.js';
import youtubeRoutes from './youtube.js';
import identityRoutes from './identity.js';

const subjectId = '22222222-2222-4222-8222-222222222222';
const consents = `/api/privacy/subjects/${subjectId}/consents`;
const schedule = '/api/privacy/optout/schedule';
// [method, path, body, effect, status]; the last six rows are body gates.
const operations = [
  ['post', '/api/privacy/scan', {}, effects.scan, 200],
  ['post', '/api/privacy/optout', {}, effects.optOut, 200],
  ['post', '/api/privacy/optout/verify', {}, effects.verify, 200],
  ['post', '/api/youtube/sync', {}, effects.youtubeSync, 200],
  ['post', '/api/youtube/playlists/sync', {}, effects.playlistSync, 200],
  // Opens or reuses a YouTube tab in the signed-in browser and reads it (#13097).
  ['get', '/api/youtube/setup-check', undefined, effects.youtubeSetupCheck, 200],
  ['post', '/api/digital-twin/identity/goals/example-goal/schedule', {}, effects.scheduleGoal, 200],
  ['post', '/api/digital-twin/identity/goals/example-goal/reschedule', {}, effects.rescheduleGoal, 200],
  ['put', schedule, { enabled: true }, effects.restartRecheck, 200],
  ['put', schedule, { autoApproveOptOutEmails: true }, effects.restartRecheck, 200],
  ['put', schedule, { autoSubmitWebForms: true }, effects.restartRecheck, 200],
  ['put', schedule, { cronExpression: '0 3 * * 1' }, effects.restartRecheck, 200],
  ['post', consents, { scope: 'broker_scan', method: 'verbal' }, effects.recordConsent, 201],
  ['post', consents, { scope: 'broker_optout', method: 'verbal' }, effects.recordConsent, 201],
  ['put', '/api/settings', { privacy: { recheck: { enabled: true } } }, effects.settingsWrite, 200],
];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/youtube', youtubeRoutes);
  app.use('/api/digital-twin/identity', identityRoutes);
  // Stand-in for the settings store: the body gate, not the store, is under test.
  app.put('/api/settings', effects.settingsWrite);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('privacy broker, YouTube and goal calendar operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any effect', async () => {
    for (const [method, path, body] of operations) {
      for (const [address, headers, target] of [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
        ['192.0.2.10', {}, path.toUpperCase() + '/'],
      ]) {
        const response = await call(appFor(address), [method, target, body], headers);
        expect([response.status, response.body.code], `${target} ${JSON.stringify(body)}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], `${operation[1]} ${JSON.stringify(operation[2])}`).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const [, path, body, effect, status] = operation;
        const before = effect.mock.calls.length;
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(status);
        expect(effect, `${path} ${JSON.stringify(body)}`).toHaveBeenCalledTimes(before + 1);
      }
    }
    expect(effects.rescheduleGoal).toHaveBeenLastCalledWith('example-goal');
    expect(effects.recordConsent).toHaveBeenLastCalledWith(expect.objectContaining({ subjectId, scope: 'broker_optout' }));
  });

  it('leaves disarming the recheck and a local-vault consent open to a remote caller', async () => {
    const disarm = await call(appFor(), ['put', schedule, { enabled: false, autoApproveOptOutEmails: false, autoSubmitWebForms: false }]);
    expect(disarm.status, JSON.stringify(disarm.body)).toBe(200);
    expect(effects.restartRecheck).toHaveBeenCalledTimes(1);
    const vault = await call(appFor(), ['post', consents, { scope: 'pii_vault', method: 'verbal' }]);
    expect(vault.status, JSON.stringify(vault.body)).toBe(201);
    expect(effects.recordConsent).toHaveBeenCalledWith(expect.objectContaining({ subjectId, scope: 'pii_vault' }));
  });
});
