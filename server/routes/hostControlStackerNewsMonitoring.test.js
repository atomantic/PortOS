import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-stacker-monitoring-authority-'),
}));
afterAll(cleanupTempDataRoots);
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (original) => ({
  ...await original(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({ settingsEvents: new EventEmitter(), getSettings: async () => ({}) }));
const state = vi.hoisted(() => ({ account: {}, territory: {} }));
const effects = vi.hoisted(() => ({
  createAccount: vi.fn(async data => ({ ...state.account, ...data })),
  updateAccount: vi.fn(async (_id, data) => ({ ...state.account, ...data })),
  createTerritory: vi.fn(async data => ({ ...state.territory, ...data })),
  updateTerritory: vi.fn(async (_id, data) => ({ ...state.territory, ...data })),
  syncAccount: vi.fn(async () => ({ synced: true })),
  verifyConnection: vi.fn(async () => ({ connected: true })),
  getBrowserIdentity: vi.fn(async () => ({ connected: true })),
  reconcileStackerNewsSchedulers: vi.fn(),
  deleteAccount: vi.fn(async () => true), deleteTerritory: vi.fn(async () => state.account.id),
}));
vi.mock('../services/stackerNews.js', () => ({
  ...effects, getAccount: async () => state.account, getTerritory: async () => state.territory,
  listTerritories: async () => state.territory ? [state.territory] : [],
}));
vi.mock('../services/stackerNewsScheduler.js', () => effects);
import routes from './stackerNews.js';
const accountId = '00000000-0000-4000-8000-000000000001';
const territoryId = '00000000-0000-4000-8000-000000000002';
const base = '/api/stacker-news';
const mounts = [[base, routes]];
// The refusal/principal matrix lives in services/authGate.test.js and
// server/test/guards/modules/hostControlCoverage.test.js; every write here is gated by the method default,
// so this keeps one refusal and the authorized workflow of each write.
const workflows = [
  ['post', `${base}/accounts/${accountId}/sync`, {}, effects.syncAccount, 200],
  ['post', `${base}/accounts/${accountId}/browser-identity`, {}, effects.getBrowserIdentity, 200],
  ['post', `${base}/accounts/${accountId}/verify`, {}, effects.verifyConnection, 200],
  ['post', `${base}/accounts`, { label: 'Example account', username: 'example_user', monitoringEnabled: true }, effects.createAccount, 201],
  ['patch', `${base}/accounts/${accountId}`, { monitoringEnabled: true }, effects.updateAccount, 200],
  ['post', `${base}/territories`, { accountId, slug: 'example', monitoringEnabled: true }, effects.createTerritory, 201],
  ['patch', `${base}/territories/${territoryId}`, { monitoringEnabled: true }, effects.updateTerritory, 200],
  ['delete', `${base}/accounts/${accountId}`, {}, effects.deleteAccount, 204],
  ['delete', `${base}/territories/${territoryId}`, {}, effects.deleteTerritory, 204],
];
beforeEach(() => {
  vi.clearAllMocks(); auth.enabled = false;
  state.account = { id: accountId, enabled: true, monitoringEnabled: false };
  state.territory = { id: territoryId, accountId, monitoringEnabled: false };
});

describe('Stacker News browser and monitoring writes behind the default-deny gate (#16114)', () => {
  it('refuses a remote monitoring opt-in before any effect', async () => {
    await expectRemoteRefusal(mounts, ['patch', `${base}/accounts/${accountId}`, { monitoringEnabled: true }, effects.updateAccount]);
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
  });

  it('still runs browser operations, monitoring opt-ins and deletes for a local operator and an agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    // Each opt-in write re-reconciles the schedulers, once per principal.
    expect(effects.reconcileStackerNewsSchedulers).toHaveBeenCalled();
  });
});
