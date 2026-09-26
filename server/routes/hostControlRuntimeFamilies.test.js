import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { EventEmitter } from 'node:events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

// Real routes, schemas and authorization, with every runtime/store boundary
// doubled: no package, process, provider, peer or live-state effects.
const auth = vi.hoisted(() => ({
  isAuthEnabled: vi.fn(),
  verifyPassword: vi.fn(async () => true),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
}));
vi.mock('../services/auth.js', () => auth);
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  readSettingsStrict: vi.fn(async () => ({ settings: {} })),
  updateSettingsWith: vi.fn(async update => update({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true,
    syncSecret: 'example-pair-secret-for-tests-only-123456',
  }] })),
}));
vi.mock('../services/browserService.js', () => ({
  updateConfig: vi.fn(async body => body),
  launchBrowser: vi.fn(async () => ({ running: true })),
  getConfig: vi.fn(async () => ({})),
}));
vi.mock('../services/browserStatus.js', () => ({ getBrowserStatusSnapshot: vi.fn() }));
vi.mock('../services/harnessActionStream.js', () => ({
  streamHarnessAction: vi.fn(async (_req, res) => res.json({ success: true })),
}));
vi.mock('../services/harnesses.js', () => ({
  listHarnesses: vi.fn(async () => []), refreshHarnessModels: vi.fn(),
}));
vi.mock('../services/modelObservation.js', () => ({
  observeModelMutations: () => (_req, _res, next) => next(),
  observeModelResource: (_key, read) => ({ read }),
}));
vi.mock('../services/llamaServerManager.js', () => ({
  getLlamaServerStatus: vi.fn(),
  getLlamaServerUpdateStatus: vi.fn(),
  startLlamaServer: vi.fn(),
  stopLlamaServer: vi.fn(),
  installLlamaServer: vi.fn(),
  upgradeLlamaServer: vi.fn(),
}));
vi.mock('../services/mtplxServerManager.js', () => ({
  MTPLX_APP: 'example-runtime',
  getMtplxServerStatus: vi.fn(),
  startMtplxServer: vi.fn(),
  stopMtplxServer: vi.fn(),
  installMtplx: vi.fn(),
}));
vi.mock('../services/slotstreamServerManager.js', () => ({
  SLOTSTREAM_APP: 'example-runtime',
  getSlotstreamServerStatus: vi.fn(),
  startSlotstreamServer: vi.fn(),
  stopSlotstreamServer: vi.fn(),
  installSlotstream: vi.fn(),
}));
vi.mock('../services/slotstreamModelManager.js', () => ({
  cancelSlotstreamModelDownload: vi.fn(),
  downloadSlotstreamModel: vi.fn(),
  previewSlotstreamDownload: vi.fn(),
}));
vi.mock('../services/mtplxModelManager.js', () => ({
  searchMtplxCatalog: vi.fn(),
  pullMtplxModel: vi.fn(),
  previewMtplxPull: vi.fn(),
  removeMtplxModel: vi.fn(),
}));
vi.mock('../services/pm2.js', () => ({
  saveProcessList: vi.fn(),
}));
vi.mock('../services/specDecodeModels.js', () => ({
  getSpecDecodePresetStatus: vi.fn(),
  downloadSpecDecodeModel: vi.fn(),
  previewSpecDecodeDownload: vi.fn(),
  cancelSpecDecodeModelDownload: vi.fn(),
  removeSpecDecodeModel: vi.fn(),
}));
vi.mock('../services/providerReadiness.js', () => ({
  resetProviderReadinessCache: vi.fn(),
}));
vi.mock('../services/huggingFaceCatalog.js', () => ({
  searchHuggingFaceModels: vi.fn(),
  enrichCatalogWithVariants: vi.fn(),
  applyMeasuredFit: vi.fn(),
}));
vi.mock('../services/localModelAssessmentStore.js', () => ({
  getMeasuredFits: vi.fn(),
}));
vi.mock('../services/localLlm.js', () => ({
  getStatus: vi.fn(),
  listModels: vi.fn(),
  listVisionModels: vi.fn(),
  listToolUseModels: vi.fn(),
  installModel: vi.fn(),
  previewInstallModel: vi.fn(),
  deleteModel: vi.fn(),
  switchBackend: vi.fn(),
  migrateBackend: vi.fn(),
  installBackend: vi.fn(),
  upgradeBackend: vi.fn(),
  controlOllamaServer: vi.fn(),
  describeInstallProgress: vi.fn(),
}));
vi.mock('../services/modelAbuseGuard.js', () => ({
  getModelAbuseGuardStatus: vi.fn(),
  installModelAbuseGuard: vi.fn(),
  cancelModelAbuseGuardInstall: vi.fn(),
}));
vi.mock('../services/jev.js', () => ({
  cancelJevInstall: vi.fn(),
  decide: vi.fn(),
  getJevStatus: vi.fn(),
  installJev: vi.fn(),
  stopJevSidecar: vi.fn(),
}));
vi.mock('../services/jevRouter.js', () => ({
  readJevDecisionStats: vi.fn(),
}));
vi.mock('../services/localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));
vi.mock('../services/localModelAssessments.js', () => ({
  getAssessmentReport: vi.fn(),
  runAssessment: vi.fn(),
  deleteAssessment: vi.fn(),
}));
vi.mock('../services/localModelAssessmentSweep.js', () => ({
  startSweep: vi.fn(),
  getSweepStatus: vi.fn(),
  cancelSweep: vi.fn(),
}));
vi.mock('../services/localModelAgentBenchmark.js', () => ({
  runOpenCodeAgentBenchmark: vi.fn(),
}));
vi.mock('../services/modelCapabilityTests.js', () => ({
  getCapabilityTestReport: vi.fn(),
  getCapabilityTestResult: vi.fn(),
  runCapabilityTest: vi.fn(),
}));
vi.mock('../services/modelCapabilityTestStore.js', () => ({
  deleteResult: vi.fn(),
}));
vi.mock('../services/audioModels.js', () => ({
  listUserModels: vi.fn(),
}));
vi.mock('../services/localPersistentMindSetup.js', () => ({
  describeLocalPersistentMindSetup: vi.fn(),
  applyLocalPersistentMindSetup: vi.fn(),
}));
vi.mock('../services/pipeline/musicGen.js', () => ({
  ENGINES: {},
}));
vi.mock('../services/ollamaManager.js', () => ({
  getLastLoadedModelsError: vi.fn(),
  getLoadedModels: vi.fn(),
  unloadModel: vi.fn(),
}));
vi.mock('../services/lmStudioManager.js', () => ({
  controlLmStudioServer: vi.fn(),
  getLastLoadedModelsError: vi.fn(),
  getLoadedModels: vi.fn(),
}));

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import browserRoutes from './browser.js';
import harnessRoutes from './harnesses.js';
import localLlmRoutes from './localLlm.js';
import { updateConfig, launchBrowser } from '../services/browserService.js';
import { streamHarnessAction } from '../services/harnessActionStream.js';
import { installBackend, getStatus, listModels, installModel } from '../services/localLlm.js';
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js';
import { updateSettingsWith } from '../services/settings.js';
import { runLocalLlmTest } from '../services/localLlmPlayground.js';
import { runCapabilityTest } from '../services/modelCapabilityTests.js';
import { getMeasuredFits } from '../services/localModelAssessmentStore.js';

const buildApp = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlBodyGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/browser', browserRoutes);
  app.use('/api/harnesses', harnessRoutes);
  app.use('/api/local-llm', localLlmRoutes);
  app.use(errorMiddleware);
  return app;
};

const writes = [
  ['post', '/api/local-llm/capability-tests/run', { backend: 'ollama', modelId: 'example-model', testId: 'sandbox-repair' }, runCapabilityTest],
  ['put', '/api/browser/config', { chromePath: '/opt/example/bin/chrome', headless: true }, updateConfig],
  ['post', '/api/browser/launch', {}, launchBrowser],
  ['post', '/api/harnesses/action?runtime=codex&action=uninstall', {}, streamHarnessAction],
  ['post', '/api/local-llm/install-backend', { backend: 'ollama' }, installBackend],
  ['post', '/api/local-llm/assessments/agent-benchmark', { backend: 'ollama', modelId: 'example-model' }, runOpenCodeAgentBenchmark],
  ['put', '/api/local-llm/jev/policy', { scopeAdherenceEnabled: false }, updateSettingsWith],
];

const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [key, value] of Object.entries(headers)) pending.set(key, value);
  return pending.send(body);
};

describe('operator authority for browser, harness and local-runtime management (#8798)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.isAuthEnabled.mockResolvedValue(false);
    installBackend.mockResolvedValue({ success: true });
    runOpenCodeAgentBenchmark.mockResolvedValue({ completed: true });
    runCapabilityTest.mockResolvedValue({ passed: true });
    getStatus.mockResolvedValue({ available: true });
    listModels.mockResolvedValue([]);
    getMeasuredFits.mockResolvedValue({});
    installModel.mockResolvedValue({ success: true });
    runLocalLlmTest.mockResolvedValue({ text: 'example answer' });
  });

  it('refuses direct and Vite-proxied remote mutations before any side effect', async () => {
    for (const write of writes) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const res = await call(buildApp(address), write, headers);
        expect([res.status, res.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
      expect(write[3]).not.toHaveBeenCalled();
    }
  });

  it('retains direct/local-proxy access without a password and remote operator-session access with one', async () => {
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      auth.isAuthEnabled.mockResolvedValue(enabled);
      for (const write of writes) expect((await call(buildApp(address), write, headers)).status).toBe(200);
    }
    for (const write of writes) expect(write[3]).toHaveBeenCalledTimes(3);
  });

  it('does not let anonymous, Basic or scoped peer credentials acquire runtime authority', async () => {
    auth.isAuthEnabled.mockResolvedValue(true);
    for (const write of writes) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_INSTANCE_HEADER]: 'example-instance',
          [PEER_AUTH_HEADER]: derivePeerAuthToken('example-pair-secret-for-tests-only-123456', 'example-instance'),
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const res = await call(buildApp(), write, headers);
        expect([res.status, res.body.code]).toEqual([status, code]);
      }
      expect(write[3]).not.toHaveBeenCalled();
    }
  });

  it('preserves remote status/catalog reads, model downloads and configured-model inference', async () => {
    const app = buildApp();
    for (const path of ['/api/browser/config', '/api/harnesses', '/api/local-llm/status', '/api/local-llm/catalog?backend=ollama']) {
      expect((await request(app).get(path)).status).toBe(200);
    }
    expect((await call(app, ['post', '/api/local-llm/install', { backend: 'ollama', modelId: 'example-model' }])).status).toBe(200);
    expect((await call(app, ['post', '/api/local-llm/test', { backend: 'ollama', modelId: 'example-model', prompt: 'Example' }])).status).toBe(200);
    expect((await call(app, ['post', '/api/local-llm/capability-tests/run', { backend: 'ollama', modelId: 'example-model', testId: 'story-outline' }])).status).toBe(200);
    expect(runCapabilityTest).toHaveBeenCalledTimes(1);
    expect(installModel).toHaveBeenCalledTimes(1);
    expect(runLocalLlmTest).toHaveBeenCalledTimes(1);
  });
});
