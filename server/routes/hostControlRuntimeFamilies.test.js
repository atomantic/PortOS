import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-runtime-authority-') }));
afterAll(cleanupTempDataRoots);

// Browser, harness and local-runtime writes are plain writes under the
// default-deny gate (#16018, #8798); the principal matrix lives in
// services/authGate.test.js. Real routes and schemas run with every
// runtime/store boundary doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
  readSettingsStrict: vi.fn(async () => ({ settings: {} })),
  updateSettingsWith: vi.fn(async update => update({})),
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
vi.mock('../services/provider/providerReadiness.js', () => ({
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

import browserRoutes from './browser.js';
import harnessRoutes from './harnesses.js';
import localLlmRoutes from './localLlm.js';
import { updateConfig, launchBrowser } from '../services/browserService.js';
import { streamHarnessAction } from '../services/harnessActionStream.js';
import { listHarnesses } from '../services/harnesses.js';
import { installBackend, getStatus, listModels, installModel } from '../services/localLlm.js';
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js';
import { updateSettingsWith } from '../services/settings.js';
import { runLocalLlmTest } from '../services/localLlmPlayground.js';
import { runCapabilityTest } from '../services/modelCapabilityTests.js';
import { getMeasuredFits } from '../services/localModelAssessmentStore.js';

const mounts = [
  ['/api/browser', browserRoutes],
  ['/api/harnesses', harnessRoutes],
  ['/api/local-llm', localLlmRoutes],
];

const writes = [
  ['post', '/api/local-llm/capability-tests/run', { backend: 'ollama', modelId: 'example-model', testId: 'sandbox-repair' }, runCapabilityTest],
  ['put', '/api/browser/config', { chromePath: '/opt/example/bin/chrome', headless: true }, updateConfig],
  ['post', '/api/browser/launch', {}, launchBrowser],
  ['post', '/api/harnesses/action?runtime=codex&action=uninstall', {}, streamHarnessAction],
  ['post', '/api/local-llm/install-backend', { backend: 'ollama' }, installBackend],
  ['post', '/api/local-llm/assessments/agent-benchmark', { backend: 'ollama', modelId: 'example-model' }, runOpenCodeAgentBenchmark],
  ['put', '/api/local-llm/jev/policy', { scopeAdherenceEnabled: false }, updateSettingsWith],
];

describe('operator authority for browser, harness and local-runtime management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.enabled = false;
    installBackend.mockResolvedValue({ success: true });
    runOpenCodeAgentBenchmark.mockResolvedValue({ completed: true });
    runCapabilityTest.mockResolvedValue({ passed: true });
    getStatus.mockResolvedValue({ available: true });
    listModels.mockResolvedValue([]);
    getMeasuredFits.mockResolvedValue({});
    installModel.mockResolvedValue({ success: true });
    runLocalLlmTest.mockResolvedValue({ text: 'example answer' });
  });

  it('refuses a remote caller before a runtime install', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/local-llm/install-backend', { backend: 'ollama' }, installBackend]);
  });

  it('preserves local and delegated-agent runtime management and inference', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ...writes.map(([method, path, body, effect]) => [method, path, body, effect, 200]),
      ['post', '/api/local-llm/install', { backend: 'ollama', modelId: 'example-model' }, installModel, 200],
      ['post', '/api/local-llm/test/stream', { backend: 'ollama', modelId: 'example-model', prompt: 'Example' }, runLocalLlmTest, 200],
    ] });
  });

  it('keeps remote status and catalog reads open', async () => {
    const app = await hostControlApp('192.0.2.10', mounts);
    for (const path of ['/api/browser/config', '/api/harnesses', '/api/local-llm/status', '/api/local-llm/catalog?backend=ollama']) {
      expect((await callRoute(app, ['get', path])).status, path).toBe(200);
    }
    expect(listHarnesses).toHaveBeenCalledExactlyOnceWith({ fresh: false });
  });

  it('requires host control for a forced harness refresh', async () => {
    const path = '/api/harnesses?fresh=1';
    await expectRemoteRefusal(mounts, ['get', path, undefined, listHarnesses]);
    const app = await hostControlApp('127.0.0.1', mounts);
    expect((await callRoute(app, ['get', path])).status).toBe(200);
    expect(listHarnesses).toHaveBeenCalledExactlyOnceWith({ fresh: true });
  });
});
