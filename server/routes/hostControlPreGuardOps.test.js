import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-ops-') }));
afterAll(cleanupTempDataRoots);

// Agent-context MCP tool calls, social persona creation, CoS resets and the
// PM2 health sweep, plus the per-request splits that arm or retarget work
// (enabling a subscription family, Docker containment and agent-context
// settings, the Brain digest provider) require operator authority (#13055).
// Real routers behind the real gates; every effect is doubled at its service.
const auth = vi.hoisted(() => ({ enabled: false }));
const storedBrain = vi.hoisted(() => ({ defaultProvider: 'example-cli', defaultModel: 'example-model', scheduledReviewsEnabled: false }));
const effects = vi.hoisted(() => ({
  mcpTool: vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] })),
  createAgent: vi.fn(async (data) => ({ id: 'example-agent', ...data })),
  clearCooldown: vi.fn(async () => ({ cooldownUntil: null })),
  healthCheck: vi.fn(async () => ({ healthy: true })),
  backfill: vi.fn(async () => 0),
  resetLearning: vi.fn(async (taskType) => ({ reset: true, taskType })),
  resetSchedule: vi.fn(async () => ({ success: true })),
  setSubscription: vi.fn(async (family, enabled) => ({ applied: true, family, enabled })),
  updateFeature: vi.fn(async (id, enabled) => ({ features: [{ id, enabled }] })),
  reconcileDocker: vi.fn(async () => ({})),
  saveSettings: vi.fn(async (update) => update({})),
  updateAssignment: vi.fn(async (id) => ({ id })),
  updateBrainMeta: vi.fn(async (data) => ({ ...data })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: effects.saveSettings,
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/agentContextMcp.js', () => ({
  getAgentContextManifest: vi.fn(async () => ({
    enabled: true, configurationValid: true, profile: 'minimal', scopes: [], actions: {}, tools: [],
  })),
  callAgentContextTool: effects.mcpTool,
}));
vi.mock('../services/agentPersonalities.js', () => ({ createAgent: effects.createAgent }));
vi.mock('../services/agentPersonalityGenerator.js', () => ({}));
vi.mock('../services/history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('../services/appActivity.js', () => ({ clearAppCooldown: effects.clearCooldown }));
vi.mock('../services/cosHealthMonitor.js', () => ({ runHealthCheck: effects.healthCheck }));
vi.mock('../services/taskLearning.js', () => ({
  backfillFromHistory: effects.backfill, resetTaskTypeLearning: effects.resetLearning,
}));
vi.mock('../services/reviewQueue.js', () => ({ __resetAlertsCache: vi.fn() }));
vi.mock('../services/taskSchedule.js', () => ({ resetExecutionHistory: effects.resetSchedule }));
vi.mock('../services/subscriptions.js', () => ({
  setSubscriptionEnabled: effects.setSubscription,
  getSubscriptionOverview: vi.fn(async () => ({ subscriptions: [] })),
}));
vi.mock('../services/instanceFeatures.js', () => ({ updateInstanceFeature: effects.updateFeature }));
vi.mock('../services/dockerContainment.js', () => ({ reconcileDockerContainment: effects.reconcileDocker }));
vi.mock('../services/aiAssignments.js', () => ({ updateAiAssignment: effects.updateAssignment }));
vi.mock('../services/brain.js', () => ({
  loadMeta: vi.fn(async () => ({ ...storedBrain })),
  updateMeta: effects.updateBrainMeta,
}));
vi.mock('../services/providers.js', () => ({
  getProviderById: vi.fn(async (id) => ({ id, type: 'api', models: [] })),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  setCodexParallelLimit: vi.fn(), CODEX_PARALLEL_MIN: 1, CODEX_PARALLEL_MAX: 8, CODEX_PARALLEL_DEFAULT: 2,
}));
// Unrelated service graphs the mounted routers import; their handlers are not reached.
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/cosReports.js', () => ({}));
vi.mock('../services/claudeChangelog.js', () => ({}));
vi.mock('../services/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cosAgentArchive.js', () => ({}));
vi.mock('../services/cosAgentIndex.js', () => ({}));
vi.mock('../services/cosAgentFeedback.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/weeklyDigest.js', () => ({}));
vi.mock('../services/cosState.js', () => ({}));
vi.mock('../services/userActionScheduleLog.js', () => ({}));
vi.mock('../services/maintenanceRun.js', () => ({}));
vi.mock('../services/usage.js', () => ({}));
vi.mock('../services/claudeCodeUsage.js', () => ({}));
vi.mock('../services/claudeCodeTranscriptUsage.js', () => ({}));
vi.mock('../services/providerUsage.js', () => ({}));
vi.mock('../services/peerUsage.js', () => ({}));
vi.mock('../services/usageFleetBilling.js', () => ({}));
vi.mock('../services/subscriptionCosts.js', () => ({}));
vi.mock('../services/credentialInventory.js', () => ({}));
vi.mock('../services/eidoverse.js', () => ({}));
vi.mock('../services/eidoverseHost.js', () => ({}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
import agentContextRoutes from './agentContextMcp.js';
import agentPersonalitiesRoutes from './agentPersonalities.js';
import cosAgentRoutes from './cosAgentRoutes.js';
import cosReportRoutes from './cosReportRoutes.js';
import cosLearningRoutes from './cosLearningRoutes.js';
import cosScheduleRoutes from './cosScheduleRoutes.js';
import usageRoutes from './usage.js';
import settingsRoutes from './settings.js';
import brainSettingsRoutes from './brainSettings.js';

const REMOTE = '192.0.2.10';
const brainPut = (body) => ['put', '/api/brain/settings', body, effects.updateBrainMeta, 200];
// [method, path, gated body, effect, success status, open twin]. A row with an
// open twin is gated per request (body gate or handler) and the twin is the
// same route with a body that stays open; the others are gated whole.
const operations = [
  ['post', '/api/agent-context/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_capture', arguments: {} },
  }, effects.mcpTool, 200],
  ['post', '/api/agents/personalities', {
    userId: 'example-user', name: 'Example Bot', personality: { style: 'casual' },
  }, effects.createAgent, 201],
  ['post', '/api/cos/app-activity/example-app/clear-cooldown', {}, effects.clearCooldown, 200],
  ['post', '/api/cos/health/check', {}, effects.healthCheck, 200],
  ['post', '/api/cos/learning/backfill', {}, effects.backfill, 200],
  ['post', '/api/cos/learning/reset/task:example', {}, effects.resetLearning, 200],
  ['post', '/api/cos/schedule/reset', { taskType: 'example-task' }, effects.resetSchedule, 200],
  ['put', '/api/usage/subscriptions/enabled', { family: 'claude', enabled: true }, effects.setSubscription, 200,
    ['put', '/api/usage/subscriptions/enabled', { family: 'claude', enabled: false }]],
  // Disabling also tears containment down through the docker CLI.
  ['put', '/api/settings/features/docker-containment', { enabled: false }, effects.updateFeature, 200,
    ['put', '/api/settings/features/post', { enabled: false }]],
  ['put', '/api/settings', { agentContext: { enabled: true } }, effects.saveSettings, 200,
    ['put', '/api/settings', { hideFirstRunCard: true }]],
  ['put', '/api/settings/ai-assignments/brain.default', { providerId: 'example-cli', model: 'example-model' }, effects.updateAssignment, 200,
    ['put', '/api/settings/ai-assignments/settings.creativeDirector.treatment', { providerId: 'example-cli', model: 'example-model' }]],
  [...brainPut({ scheduledReviewsEnabled: true }), ['put', '/api/brain/settings', { confidenceThreshold: 0.7, dailyDigestTime: '07:00' }]],
  [...brainPut({ defaultProvider: 'example-other' }), ['put', '/api/brain/settings', { defaultProvider: 'example-cli', defaultModel: 'example-model' }]],
  [...brainPut({ defaultModel: 'example-other-model' }), ['put', '/api/brain/settings', { defaultModel: 'example-model' }]],
];
const isWholeRoute = (operation) => operation[5] === undefined;
// The agent-context router admits loopback sockets only, so its operator and
// agent sessions arrive locally; a password still makes the session the grant.
const callerAddress = ([, path], address) => (path.startsWith('/api/agent-context/') ? '127.0.0.1' : address);

const appFor = (address = REMOTE) => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/agent-context', agentContextRoutes);
  app.use('/api/agents/personalities', agentPersonalitiesRoutes);
  app.use('/api/cos', cosAgentRoutes, cosReportRoutes, cosLearningRoutes, cosScheduleRoutes);
  app.use('/api/usage', usageRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/brain', brainSettingsRoutes);
  app.use(errorMiddleware);
  return app;
};
// The MCP transport requires this Accept header; the other routes ignore it.
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path).set('Accept', 'application/json, text/event-stream');
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

describe('pre-guard audit operations and policy splits require operator authority (#13055)', () => {
  it('refuses remote password-free callers, spoofed-proxy and case variants before any effect', async () => {
    for (const operation of operations) {
      const targets = isWholeRoute(operation) ? [operation[1], operation[1].toUpperCase() + '/'] : [operation[1]];
      for (const [address, headers] of [
        [REMOTE, {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: REMOTE }],
        [REMOTE, { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        for (const target of targets) {
          const response = await call(appFor(address), [operation[0], target, operation[2]], headers);
          expect([response.status, response.body.code], `${target} ${JSON.stringify(operation[2])}`)
            .toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
        }
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
        const response = await call(appFor(callerAddress(operation, REMOTE)), operation, headers);
        expect([response.status, response.body.code], `${operation[1]} ${JSON.stringify(operation[2])}`)
          .toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, REMOTE, { Authorization: `Bearer ${operator.token}` }],
      [true, REMOTE, { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const previousCalls = operation[3].mock.calls.length;
        const response = await call(appFor(callerAddress(operation, address)), operation, headers);
        expect(response.status, `${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
        expect(operation[3]).toHaveBeenCalledTimes(previousCalls + 1);
      }
    }
    expect(effects.mcpTool).toHaveBeenLastCalledWith('brain_capture', {}, expect.anything(), expect.anything());
    expect(effects.resetLearning).toHaveBeenLastCalledWith('task:example');
    expect(effects.setSubscription).toHaveBeenLastCalledWith('claude', true);
    expect(effects.reconcileDocker).toHaveBeenLastCalledWith({ enabled: false, reason: 'feature-toggle' });
    expect(effects.updateBrainMeta).toHaveBeenLastCalledWith({ defaultModel: 'example-other-model' });
  });

  it('leaves the open body of each split route to a remote password-free caller', async () => {
    for (const operation of operations.filter((row) => !isWholeRoute(row))) {
      const previousCalls = operation[3].mock.calls.length;
      const response = await call(appFor(), operation[5]);
      expect(response.status, `${operation[5][1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
      expect(operation[3]).toHaveBeenCalledTimes(previousCalls + 1);
    }
    expect(effects.setSubscription).toHaveBeenCalledWith('claude', false);
    expect(effects.updateFeature).toHaveBeenCalledWith('post', false);
    expect(effects.reconcileDocker).not.toHaveBeenCalled();
    expect(effects.updateBrainMeta).toHaveBeenCalledWith({ defaultProvider: 'example-cli', defaultModel: 'example-model' });
  });
});
