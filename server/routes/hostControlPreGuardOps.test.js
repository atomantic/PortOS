import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-ops-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted router still runs behind the real gates for a
// local operator and a delegated agent session. Effects are doubled at their service.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  mcpTool: vi.fn(async () => ({ content: [{ type: 'text', text: '{}' }] })),
  createAgent: vi.fn(async (data) => ({ id: 'example-agent', ...data })),
  healthCheck: vi.fn(async () => ({ healthy: true })),
  backfill: vi.fn(async () => 0),
  setSubscription: vi.fn(async (family, enabled) => ({ applied: true, family, enabled })),
  saveSettings: vi.fn(async (update) => update({})),
  updateBrainMeta: vi.fn(async (data) => ({ ...data })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: effects.saveSettings,
}));
vi.mock('../services/agent/agentContextMcp.js', () => ({
  getAgentContextManifest: vi.fn(async () => ({
    enabled: true, configurationValid: true, profile: 'minimal', scopes: [], actions: {}, tools: [],
  })),
  callAgentContextTool: effects.mcpTool,
}));
vi.mock('../services/agent/agentPersonalities.js', () => ({ createAgent: effects.createAgent }));
vi.mock('../services/history.js', () => ({ logAction: vi.fn(async () => {}) }));
vi.mock('../services/cos/cosHealthMonitor.js', () => ({ runHealthCheck: effects.healthCheck }));
vi.mock('../services/taskLearning.js', () => ({ backfillFromHistory: effects.backfill }));
vi.mock('../services/reviewQueue.js', () => ({ __resetAlertsCache: vi.fn() }));
vi.mock('../services/subscriptions.js', () => ({
  setSubscriptionEnabled: effects.setSubscription,
  getSubscriptionOverview: vi.fn(async () => ({ subscriptions: [] })),
}));
vi.mock('../services/brain.js', () => ({
  loadMeta: vi.fn(async () => ({ defaultProvider: 'example-cli', defaultModel: 'example-model' })),
  updateMeta: effects.updateBrainMeta,
}));
vi.mock('../services/provider/providers.js', () => ({
  getProviderById: vi.fn(async (id) => ({ id, type: 'api', models: [] })),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  setCodexParallelLimit: vi.fn(), syncParallelLimits: vi.fn(), CODEX_PARALLEL_MIN: 1, CODEX_PARALLEL_MAX: 8, CODEX_PARALLEL_DEFAULT: 2,
}));
// Service graphs the mounted routers import; their handlers are not reached.
vi.mock('../services/agent/agentPersonalityGenerator.js', () => ({}));
vi.mock('../services/cos/cosClaimSelection.js', () => ({}));
vi.mock('../services/instanceFeatures.js', () => ({}));
vi.mock('../services/dockerContainment.js', () => ({}));
vi.mock('../services/aiAssignments.js', () => ({}));
vi.mock('../services/cos/cos.js', () => ({}));
vi.mock('../services/cos/cosReports.js', () => ({}));
vi.mock('../services/claudeChangelog.js', () => ({}));
vi.mock('../services/cos/cosAgentLifecycle.js', () => ({}));
vi.mock('../services/cos/cosAgentArchive.js', () => ({}));
vi.mock('../services/cos/cosAgentIndex.js', () => ({}));
vi.mock('../services/cos/cosAgentFeedback.js', () => ({}));
vi.mock('../services/agent/agentOrchestrator.js', () => ({}));
vi.mock('../services/weeklyDigest.js', () => ({}));
vi.mock('../services/cos/cosState.js', () => ({}));
vi.mock('../services/userActionScheduleLog.js', () => ({}));
vi.mock('../services/maintenanceRun.js', () => ({}));
vi.mock('../services/usage.js', () => ({}));
vi.mock('../services/claudeCodeUsage.js', () => ({}));
vi.mock('../services/claudeCodeTranscriptUsage.js', () => ({}));
vi.mock('../services/nativeUsageHistory.js', () => ({}));
vi.mock('../services/provider/providerUsage.js', () => ({}));
vi.mock('../services/peerUsage.js', () => ({}));
vi.mock('../services/usageFleetBilling.js', () => ({}));
vi.mock('../services/subscriptionCosts.js', () => ({}));
vi.mock('../services/credentialInventory.js', () => ({}));
vi.mock('../services/eidoverse.js', () => ({}));
vi.mock('../services/eidoverseHost.js', () => ({}));

const mounts = [
  ['/api/agent-context', (await import('./agentContextMcp.js')).default],
  ['/api/agents/personalities', (await import('./agentPersonalities.js')).default],
  ['/api/cos', (await import('./cosAgentRoutes.js')).default],
  ['/api/cos', (await import('./cosReportRoutes.js')).default],
  ['/api/cos', (await import('./cosLearningRoutes.js')).default],
  ['/api/cos', (await import('./cosScheduleRoutes.js')).default],
  ['/api/usage', (await import('./usage.js')).default],
  ['/api/settings', (await import('./settings.js')).default],
  ['/api/brain', (await import('./brainSettings.js')).default],
];

// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', '/api/agent-context/mcp', {
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brain_capture', arguments: {} },
  }, effects.mcpTool, 200],
  ['post', '/api/agents/personalities', {
    userId: 'example-user', name: 'Example Bot', personality: { style: 'casual' },
  }, effects.createAgent, 201],
  ['post', '/api/cos/health/check', {}, effects.healthCheck, 200],
  ['post', '/api/cos/learning/backfill', {}, effects.backfill, 200],
  ['put', '/api/usage/subscriptions/enabled', { family: 'claude', enabled: true }, effects.setSubscription, 200],
  ['put', '/api/settings', { hideFirstRunCard: true }, effects.saveSettings, 200],
  ['put', '/api/brain/settings', { defaultModel: 'example-other-model' }, effects.updateBrainMeta, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('ops routers behind the default-deny gate (#16114)', () => {
  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({
      auth, mounts, workflows,
      // The MCP transport requires this Accept header; the other routes ignore it.
      headers: { Accept: 'application/json, text/event-stream' },
      // The agent-context router admits loopback sockets only.
      localPath: (path) => path.startsWith('/api/agent-context/'),
    });
    expect(effects.mcpTool).toHaveBeenLastCalledWith('brain_capture', {}, expect.anything(), expect.anything());
    expect(effects.setSubscription).toHaveBeenLastCalledWith('claude', true);
    expect(effects.updateBrainMeta).toHaveBeenLastCalledWith({ defaultModel: 'example-other-model' });
  });
});
