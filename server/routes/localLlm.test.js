import { EventEmitter } from 'node:events';
import { registerModelObservationSocket } from '../services/modelObservation.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import localLlmRoutes from './localLlm.js';
import { decide } from '../services/jev.js';
import { installLaya, scoreLaya } from '../services/layaMlx.js';
import { runLocalLlmTest, compareLocalLlmModels } from '../services/localLlmPlayground.js';
import { listModels, listVisionModels, listToolUseModels, installModel, cancelModelInstall, switchBackend, migrateBackend } from '../services/localLlm.js';
import { enrichCatalogWithVariants, applyMeasuredFit } from '../services/huggingFaceCatalog.js';
import { getMeasuredFits } from '../services/localModelAssessmentStore.js';
import { listEndpointRuntimeModels } from '../services/localRuntimeEndpoints.js';
import { runAssessment } from '../services/localModelAssessments.js';
import { startSweep, getSweepStatus, cancelSweep } from '../services/localModelAssessmentSweep.js';
import { runOpenCodeAgentBenchmark } from '../services/localModelAgentBenchmark.js';
import { getLoadedModels, unloadModel } from '../services/ollamaManager.js';
import { getLoadedModels as getLoadedLmStudioModels, getLastLoadedModelsError as getLmStudioResidencyError } from '../services/lmStudioManager.js';
import { getSettings, readSettingsStrict, updateSettingsWith } from '../services/settings.js';
import { localLlmCompareSchema, localLlmTestSchema } from '../lib/mediaValidation.js';
import { installSplashRuntime, saveSplashContextWindow, startSplashServer, stopSplashServer, uninstallSplashRuntime } from '../services/splashServerManager.js';
import { getMkserveRuntimeStatus, installMkserve, startMkserveServer, stopMkserveServer, uninstallMkserve } from '../services/mkserveRuntimeManager.js';
import { ServerError, errorEvents } from '../lib/errorHandler.js';
import { saveProcessList } from '../services/pm2.js';
import { syncRuntimeProviderModels } from '../services/localRuntimeProviderSync.js';
import { startMtplxServer, stopMtplxServer, waitForMtplxReady } from '../services/mtplxServerManager.js';
import { startSlotstreamServer, stopSlotstreamServer, waitForSlotstreamReady } from '../services/slotstreamServerManager.js';
import { startLlamaServer, stopLlamaServer, waitForLlamaServerReady } from '../services/llamaServerManager.js';
import { pullMtplxModel, removeMtplxModel } from '../services/mtplxModelManager.js';
import { downloadSlotstreamModel } from '../services/slotstreamModelManager.js';

const getModelAbuseGuardStatus = vi.fn(async () => ({ ready: false, modelCached: false, runtimeReady: false }));
const installModelAbuseGuard = vi.fn(async () => ({ ok: true, ready: true }));
const cancelModelAbuseGuardInstall = vi.fn();
const runModelAbuseScan = vi.fn();

// asyncHandler emits to errorEvents on every route failure; with `io` set on
// the app it always fires. Swallow it so a validation-rejection test doesn't
// trip Node's "unhandled 'error' event" — assertions go through the response.
errorEvents.on('error', () => {});

vi.mock('../services/localLlm.js', () => ({
  getStatus: vi.fn(),
  listModels: vi.fn(async () => []),
  listVisionModels: vi.fn(async () => []),
  listToolUseModels: vi.fn(async () => []),
  installModel: vi.fn(),
  cancelModelInstall: vi.fn(),
  previewInstallModel: vi.fn(async () => ({
    kind: 'install', verdict: 'ok', destPath: '/tmp/models', expectedBytes: 0, freeBytes: 1e12, requiredBytes: 0, headroomBytes: 0,
  })),
  describeInstallProgress: vi.fn((p) => p?.status || null),
  deleteModel: vi.fn(),
  switchBackend: vi.fn(),
  migrateBackend: vi.fn(),
  installBackend: vi.fn(),
  upgradeBackend: vi.fn(),
  controlOllamaServer: vi.fn(),
}));

vi.mock('../services/jev.js', async (importOriginal) => ({
  ...await importOriginal(),
  decide: vi.fn(),
}));

vi.mock('../services/layaMlx.js', () => ({
  installLaya: vi.fn(),
  scoreLaya: vi.fn(),
}));

vi.mock('../services/modelAbuseGuard.js', () => ({
  getModelAbuseGuardStatus: (...args) => getModelAbuseGuardStatus(...args),
  installModelAbuseGuard: (...args) => installModelAbuseGuard(...args),
  cancelModelAbuseGuardInstall: (...args) => cancelModelAbuseGuardInstall(...args),
  runModelAbuseScan: (...args) => runModelAbuseScan(...args),
}));

vi.mock('../services/untrustedContent.js', () => ({
  getContributionAssessmentReadiness: vi.fn(async () => ({ ready: false, code: 'untrusted-content-model-required', sources: {} })),
}));

vi.mock('../services/localRuntimeEndpoints.js', () => ({ listEndpointRuntimeModels: vi.fn() }));

vi.mock('../services/localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  compareLocalLlmModels: vi.fn(),
}));

vi.mock('../services/ollamaManager.js', () => ({
  getLastLoadedModelsError: vi.fn(() => null),
  getLoadedModels: vi.fn(async () => []),
  unloadModel: vi.fn(),
  // Reached via providerExecutionReadiness.js's managed-runtime table
  // (issue #8104) whenever an unmocked module transitively imports
  // aiProvider.js — this suite never drives that path, so a no-op stub keeps
  // the module graph loadable.
  ensureProviderReady: vi.fn(async () => ({ success: true })),
  isOllamaProvider: vi.fn(() => false),
}));

vi.mock('../services/lmStudioManager.js', () => ({
  getLastLoadedModelsError: vi.fn(() => null),
  getLoadedModels: vi.fn(async () => []),
}));

// Mock the HF catalog service so /catalog tests don't hit the network. The no-op
// enrichCatalogWithVariants simulates the offline/failed-enrichment case (it leaves
// the catalog's getCatalog overlay untouched), which is exactly when the route's
// raw-id installed overlay must be correct.
vi.mock('../services/huggingFaceCatalog.js', () => ({
  searchHuggingFaceModels: vi.fn(async () => []),
  enrichCatalogWithVariants: vi.fn(async (catalog) => catalog),
  applyMeasuredFit: vi.fn((models) => models),
}));

// Measured assessments are folded into the catalog fit badge. Disk-only in
// production; mocked here so a catalog listing test never touches the store.
vi.mock('../services/localModelAssessmentStore.js', () => ({
  getMeasuredFits: vi.fn(async () => ({})),
}));

vi.mock('../services/localModelAssessments.js', () => ({
  getAssessmentReport: vi.fn(async () => ({ ranked: [], excluded: [] })),
  runAssessment: vi.fn(async () => ({ verdict: 'fits' })),
  deleteAssessment: vi.fn(async () => ({ deleted: true })),
}));

vi.mock('../services/localModelAssessmentSweep.js', () => ({
  startSweep: vi.fn(async () => ({ status: 'running', total: 3, completed: 0 })),
  getSweepStatus: vi.fn(() => ({ status: 'idle', total: 0, completed: 0, results: [] })),
  cancelSweep: vi.fn(() => ({ status: 'cancelled', total: 3, completed: 1, results: [] })),
}));

vi.mock('../services/localModelAgentBenchmark.js', () => ({
  runOpenCodeAgentBenchmark: vi.fn(async ({ backend, modelId, timeoutMs }) => ({
    backend, modelId, timeoutMs, completed: true, taskCharsPerSecond: 100,
  })),
}));

vi.mock('../services/llamaServerManager.js', () => ({
  getLlamaServerStatus: vi.fn(async () => ({ installed: true, running: false })),
  getLlamaServerUpdateStatus: vi.fn(async () => ({
    version: null,
    latestVersion: null,
    updateAvailable: false,
    canUpgrade: false,
    downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
  })),
  startLlamaServer: vi.fn(async () => ({ success: true, pid: 123 })),
  stopLlamaServer: vi.fn(async () => ({ success: true })),
  installLlamaServer: vi.fn(async () => ({ success: true, message: 'installed' })),
  upgradeLlamaServer: vi.fn(async () => ({ success: true, note: 'updated' })),
  waitForLlamaServerReady: vi.fn(),
}));

// The launcher's curated presets (and their weights' on-disk state) ride along
// on the status response so the card can offer a Download button per GGUF.
vi.mock('../services/pm2.js', async (importOriginal) => ({
  ...(await importOriginal()),
  saveProcessList: vi.fn(async () => ({ saved: true })),
}));
vi.mock('../services/localRuntimeProviderSync.js', () => ({ syncRuntimeProviderModels: vi.fn(async () => false) }));
vi.mock('../services/mtplxServerManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getMtplxServerStatus: vi.fn(),
  startMtplxServer: vi.fn(),
  stopMtplxServer: vi.fn(),
  installMtplx: vi.fn(),
  uninstallMtplx: vi.fn(),
  waitForMtplxReady: vi.fn(),
}));
vi.mock('../services/slotstreamServerManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSlotstreamServerStatus: vi.fn(),
  startSlotstreamServer: vi.fn(),
  stopSlotstreamServer: vi.fn(),
  installSlotstream: vi.fn(),
  uninstallSlotstream: vi.fn(),
  waitForSlotstreamReady: vi.fn(),
}));
vi.mock('../services/mtplxModelManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  searchMtplxCatalog: vi.fn(),
  pullMtplxModel: vi.fn(),
  previewMtplxPull: vi.fn(),
  removeMtplxModel: vi.fn(),
}));
vi.mock('../services/slotstreamModelManager.js', async (importOriginal) => ({
  ...(await importOriginal()),
  cancelSlotstreamModelDownload: vi.fn(),
  downloadSlotstreamModel: vi.fn(),
  previewSlotstreamDownload: vi.fn(),
}));
vi.mock('../services/splashRuntimeStatus.js', () => ({
  getSplashRuntimeStatus: vi.fn(async () => ({ supported: true, state: 'stopped', installed: true })),
}));
vi.mock('../services/splashServerManager.js', () => ({
  SPLASH_APP: 'portos-splash',
  installSplashRuntime: vi.fn(),
  saveSplashContextWindow: vi.fn(),
  startSplashServer: vi.fn(),
  stopSplashServer: vi.fn(),
  uninstallSplashRuntime: vi.fn(),
}));
vi.mock('../services/mkserveRuntimeManager.js', () => ({
  MKSERVE_APP: 'portos-mkserve',
  getMkserveRuntimeStatus: vi.fn(async () => ({ supported: true, state: 'stopped', installed: true })),
  installMkserve: vi.fn(),
  startMkserveServer: vi.fn(),
  stopMkserveServer: vi.fn(),
  uninstallMkserve: vi.fn(),
}));

vi.mock('../services/specDecodeModels.js', () => ({
  getSpecDecodePresetStatus: vi.fn(async () => ([{ id: 'test-preset', label: 'Test', specType: 'draft-dspark', model: null, draftModel: null }])),
  downloadSpecDecodeModel: vi.fn(async () => ({ success: true, path: 'models/base.gguf', file: 'base.gguf' })),
  previewSpecDecodeDownload: vi.fn(async () => ({
    kind: 'spec-decode', verdict: 'ok', destPath: 'models/base.gguf', expectedBytes: 6, freeBytes: 1e12, requiredBytes: 6, headroomBytes: 0, alreadyDownloaded: false,
  })),
  cancelSpecDecodeModelDownload: vi.fn(() => true),
  removeSpecDecodeModel: vi.fn(async () => ({ success: true, deleted: true, path: 'models/base.gguf' })),
}));

// /loaded reads getSettings() to honor a user's intentionally-disabled backends,
// so mock it (defaults to no backends disabled; the disabled-case test flips it).
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
  readSettingsStrict: vi.fn(),
  updateSettingsWith: vi.fn(),
  // localPersistentMindSetup → cos → cosTaskStore → codeReview listens on boot.
  settingsEvents: { on: vi.fn(), emit: vi.fn(), setMaxListeners: vi.fn() },
}));

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '3mb' }));
  app.set('io', { emit: vi.fn() });
  app.use('/api/local-llm', localLlmRoutes);
  return app;
}

describe('managed scorer routes', () => {
  const post = (path, body = {}) => request(makeApp()).post(`/api/local-llm/${path}`).send(body);
  const premise = 'A duplicate invoice arrived.';
  const options = ['billing', 'sales'];
  const jevRequest = { premise, hypotheses: options };
  const layaRequest = { premise, instructions: 'Choose a department.', options };

  beforeEach(() => {
    decide.mockReset();
    installLaya.mockReset();
    scoreLaya.mockReset();
  });

  it('accepts a Laya install with HTTP 202', async () => {
    const result = { ok: true, installing: true };
    installLaya.mockResolvedValueOnce(result);
    const res = await post('laya-mlx/install');
    expect(res.status).toBe(202);
    expect(res.body).toEqual(result);
  });

  it.each([
    ['laya-unsupported', 400],
    ['laya-busy', 409],
  ])('returns %s as a Laya install refusal', async (code, status) => {
    installLaya.mockResolvedValueOnce({ ok: false, code });
    const res = await post('laya-mlx/install');
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: expect.any(String), code });
  });

  it.each([
    ['laya-request-invalid', 400],
    ['laya-unsupported', 400],
    ['laya-context-too-long', 400],
    ['laya-disabled', 403],
    ['laya-busy', 409],
    ['laya-not-ready', 503],
    ['laya-response-invalid', 502],
    ['laya-scoring-failed', 502],
  ])('returns %s as a Laya scoring failure', async (code, status) => {
    scoreLaya.mockResolvedValueOnce({ ok: false, code });
    const res = await post('laya-mlx/score', layaRequest);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: expect.any(String), code });
  });

  it.each([
    ['jev-request-invalid', 400],
    ['jev-premise-too-large', 400],
    ['jev-not-installed', 503],
    ['jev-start-failed', 503],
    ['jev-timeout', 504],
    ['jev-response-invalid', 502],
    ['jev-head-revision-mismatch', 502],
  ])('returns %s as a Jev scoring failure', async (code, status) => {
    decide.mockResolvedValueOnce({ ok: false, code });
    const res = await post('jev/score', jevRequest);
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ error: expect.any(String), code });
  });

  it('validates the Jev decision input before calling the scorer', async () => {
    const res = await post('jev/score', { ...jevRequest, hypotheses: [options[0]] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.any(String), code: 'VALIDATION_ERROR' });
    expect(decide).not.toHaveBeenCalled();
  });

  it('returns successful decisions as HTTP 200 with the service payload', async () => {
    const result = { ok: true, choice: 'billing', margin: 0.8, abstained: false };
    decide.mockResolvedValueOnce(result);
    scoreLaya.mockResolvedValueOnce(result);
    const jev = await post('jev/score', { ...jevRequest, minMargin: 0.2 });
    expect(jev.status).toBe(200);
    expect(jev.body).toEqual(result);
    expect(decide).toHaveBeenCalledWith({ premise, options, minMargin: 0.2 });
    const laya = await post('laya-mlx/score', layaRequest);
    expect(laya.status).toBe(200);
    expect(laya.body).toEqual(result);
  });
});

describe('local LLM playground routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /catalog?variants=1 keeps an installed LM Studio recommendation installed (raw-id overlay)', async () => {
    // The route appends LM Studio's quantization to the enrichment installed list,
    // but getCatalog's normalizer can't parse `@quant` — so the overlay must get the
    // RAW ids, or an already-installed model wrongly shows Install. (Enrichment is
    // mocked to a no-op, simulating HF being unreachable.)
    listModels.mockResolvedValue([{ id: 'lmstudio-community/gemma-4-12B-it-GGUF', quantization: 'Q4_K_M' }]);

    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=lmstudio&variants=1');

    expect(res.status).toBe(200);
    expect(enrichCatalogWithVariants).toHaveBeenCalled();
    const entry = res.body.models.find((m) => m.id === 'lmstudio-community/gemma-4-12B-it-GGUF');
    expect(entry).toBeTruthy();
    expect(entry.installed).toBe(true);
  });

  it('GET /catalog skips HF enrichment unless variants=1 (fast local path for the playground)', async () => {
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.models)).toBe(true);
    // The playground only needs catalog metadata — it must not pay for HF probes.
    expect(enrichCatalogWithVariants).not.toHaveBeenCalled();
  });

  it('GET /catalog exposes the managed security classifier separately from chat models', async () => {
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(res.body.securityGuards).toEqual([expect.objectContaining({
      id: 'llama-prompt-guard-2-86m',
      pipelineTag: 'text-classification',
      runtime: 'python-transformers',
    })]);
    expect(res.body.models.some((model) => model.id === 'llama-prompt-guard-2-86m')).toBe(false);
  });

  // Same guarantee for the jev scorer: a descriptor that leaked into `models`
  // would be offered by every provider/model picker that reads the catalog.
  it('GET /catalog exposes the jev decision scorer separately from chat models', async () => {
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(res.body.decisionScorers).toEqual([expect.objectContaining({
      id: 'openjev-qwen3.5-4b-nli',
      pipelineTag: 'text-classification',
      runtime: 'python-transformers',
    })]);
    expect(res.body.models.some((model) => model.id === 'openjev-qwen3.5-4b-nli')).toBe(false);
  });

  it('keeps the Prompt Guard lifecycle out of the general model installer', async () => {
    const status = await request(makeApp()).get('/api/local-llm/security-guard/status');
    expect(status.status).toBe(200);
    expect(getModelAbuseGuardStatus).toHaveBeenCalled();
    // A ready classifier must not mask a contribution assessment with no usable provider/model.
    expect(status.body.contributionAssessment).toEqual(expect.objectContaining({ ready: false, code: 'untrusted-content-model-required' }));

    const install = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(install.status).toBe(200);
    expect(installModelAbuseGuard).toHaveBeenCalledWith({ onEvent: expect.any(Function) });
    expect(installModel).not.toHaveBeenCalled();

    const cancel = await request(makeApp()).post('/api/local-llm/security-guard/install/cancel').send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body).toEqual({ cancelled: true });
    expect(cancelModelAbuseGuardInstall).toHaveBeenCalled();
  });

  it('scans exactly the operator-selected text and reports a flagged verdict without treating it as an error', async () => {
    runModelAbuseScan.mockResolvedValueOnce({ ok: true, safe: false, code: 'flagged', layers: { classifier: 'blocked' }, findings: [] });
    const content = '  Content selected by the owner  ';
    const res = await request(makeApp()).post('/api/local-llm/security-guard/scan').send({ content });
    expect(res.status).toBe(200);
    expect(runModelAbuseScan).toHaveBeenCalledWith({ content });
    expect(res.body).toMatchObject({ safe: false, code: 'flagged' });
    expect(JSON.stringify(res.body)).not.toContain(content);
  });

  it('rejects invalid input and reports an unavailable scan without a safe verdict', async () => {
    const empty = await request(makeApp()).post('/api/local-llm/security-guard/scan').send({ content: '   ' });
    expect(empty.status).toBe(400);
    expect(runModelAbuseScan).not.toHaveBeenCalled();
    const oversized = await request(makeApp()).post('/api/local-llm/security-guard/scan').send({ content: 'x'.repeat(2_000_001) });
    expect(oversized.status).toBe(400);
    expect(runModelAbuseScan).not.toHaveBeenCalled();
    runModelAbuseScan.mockResolvedValueOnce({ ok: false, code: 'security-guard-not-ready' });
    const unavailable = await request(makeApp()).post('/api/local-llm/security-guard/scan').send({ content: 'Example' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ code: 'security-guard-not-ready' });
    expect(unavailable.body.safe).toBeUndefined();
  });

  it('returns actionable Prompt Guard access prerequisites from the install route', async () => {
    installModelAbuseGuard.mockResolvedValueOnce({
      ok: false,
      code: 'security-guard-huggingface-token-required',
    });
    const missingToken = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(missingToken.status).toBe(502);
    expect(missingToken.body).toMatchObject({
      code: 'security-guard-huggingface-token-required',
      error: 'Add a Hugging Face read token before installing Prompt Guard.',
    });

    installModelAbuseGuard.mockResolvedValueOnce({
      ok: false,
      code: 'security-guard-huggingface-access-required',
    });
    const missingAccess = await request(makeApp()).post('/api/local-llm/security-guard/install').send({});
    expect(missingAccess.status).toBe(502);
    expect(missingAccess.body).toMatchObject({
      code: 'security-guard-huggingface-access-required',
      error: 'Hugging Face has not granted Prompt Guard access yet. Submit the usage request on its model card, then retry.',
    });
  });

  it('POST /install forwards force so a redownload can replace on-disk weights', async () => {
    installModel.mockResolvedValue({ success: true, modelId: 'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M' });

    const res = await request(makeApp())
      .post('/api/local-llm/install')
      .send({ backend: 'lmstudio', modelId: 'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M', force: true });

    expect(res.status).toBe(200);
    expect(installModel).toHaveBeenCalledWith(
      'lmstudio',
      'unsloth/Qwen3.8-27B-GGUF@UD-Q4_K_M',
      expect.any(Function),
      { force: true }
    );
  });

  it('answers a canceled install as canceled, not as a 502 failure', async () => {
    installModel.mockResolvedValue({ success: false, canceled: true, code: 'INSTALL_CANCELED', modelId: 'llama3.2' });
    const res = await request(makeApp()).post('/api/local-llm/install').send({ backend: 'ollama', modelId: 'llama3.2' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: false, canceled: true, modelId: 'llama3.2' });
  });

  it('POST /install/cancel stops a running download and 404s when none is running', async () => {
    cancelModelInstall.mockReturnValueOnce({ success: true });
    const ok = await request(makeApp()).post('/api/local-llm/install/cancel').send({ backend: 'ollama', modelId: 'llama3.2' });
    expect(ok.status).toBe(200);
    expect(cancelModelInstall).toHaveBeenCalledWith('ollama', 'llama3.2');

    cancelModelInstall.mockReturnValueOnce({ success: false, code: 'INSTALL_NOT_RUNNING', error: 'No download of llama3.2 is running on ollama' });
    const missing = await request(makeApp()).post('/api/local-llm/install/cancel').send({ backend: 'ollama', modelId: 'llama3.2' });
    expect(missing.status).toBe(404);

    cancelModelInstall.mockReturnValueOnce({ success: false, code: 'INSTALL_NOT_CANCELABLE', error: 'llama3.2 is an Ollama import and can\'t be canceled once started' });
    const held = await request(makeApp()).post('/api/local-llm/install/cancel').send({ backend: 'ollama', modelId: 'llama3.2' });
    expect(held.status).toBe(409);
  });

  it('POST /install without force still pulls as a regular install', async () => {
    installModel.mockResolvedValue({ success: true, modelId: 'llama3.2' });

    const res = await request(makeApp())
      .post('/api/local-llm/install')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(installModel).toHaveBeenCalledWith('ollama', 'llama3.2', expect.any(Function), { force: false });
  });

  it('streams a single local model test with validated defaults', async () => {
    runLocalLlmTest.mockResolvedValue({
      backend: 'ollama',
      modelId: 'llama3.2',
      text: 'hello',
      runId: 'run-1',
      timings: { totalMs: 25, ttftMs: 10, chars: 5, charsPerSecond: 200 },
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.text.trim()).result.text).toBe('hello');
    expect(runLocalLlmTest).toHaveBeenCalledWith({
      backend: 'ollama',
      modelId: 'llama3.2',
      prompt: 'Say hello',
      systemPrompt: '',
      temperature: 0.3,
      maxTokens: 1000,
      timeoutMs: 300000,
      onToken: expect.any(Function),
      // Derived from res — lets a client disconnect tear down the upstream stream.
      signal: expect.any(AbortSignal),
    });
  });

  it('streams tokens then a terminal result frame as NDJSON', async () => {
    runLocalLlmTest.mockImplementation(async ({ onToken }) => {
      onToken('Hel');
      onToken('lo');
      return { backend: 'ollama', modelId: 'llama3.2', text: 'Hello', runId: 'run-1' };
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/x-ndjson/);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'token', delta: 'Hel', kind: 'content' },
      { type: 'token', delta: 'lo', kind: 'content' },
      { type: 'result', result: { backend: 'ollama', modelId: 'llama3.2', text: 'Hello', runId: 'run-1' } },
    ]);
  });

  it('tags reasoning tokens with kind:reasoning so the client can render them separately', async () => {
    runLocalLlmTest.mockImplementation(async ({ onToken }) => {
      onToken('thinking…', 'reasoning');
      onToken('Answer.', 'content');
      return { backend: 'ollama', modelId: 'deepseek-r1', text: 'Answer.', runId: 'run-2' };
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'deepseek-r1', prompt: 'Think then answer' });

    expect(res.status).toBe(200);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'token', delta: 'thinking…', kind: 'reasoning' },
      { type: 'token', delta: 'Answer.', kind: 'content' },
      { type: 'result', result: { backend: 'ollama', modelId: 'deepseek-r1', text: 'Answer.', runId: 'run-2' } },
    ]);
  });

  it('emits exactly one terminal result frame (no extra 500) when the run resolves an in-stream error', async () => {
    // A timed-out/aborted run resolves an { error, text } result rather than
    // throwing — the route must surface it as the single terminal frame.
    runLocalLlmTest.mockResolvedValue({
      backend: 'ollama', modelId: 'llama3.2', error: 'Timed out after 5000ms', text: 'partial',
    });

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200);
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toEqual([
      { type: 'result', result: { backend: 'ollama', modelId: 'llama3.2', error: 'Timed out after 5000ms', text: 'partial' } },
    ]);
  });

  it('converts a pre-stream provider throw into a terminal error result frame (no 500 after headers)', async () => {
    runLocalLlmTest.mockRejectedValue(new Error('Local provider "ollama" is not configured'));

    const res = await request(makeApp())
      .post('/api/local-llm/test/stream')
      .send({ backend: 'ollama', modelId: 'llama3.2', prompt: 'Say hello' });

    expect(res.status).toBe(200); // headers flushed before the throw — never a JSON 500
    const frames = res.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: 'result', result: { error: 'Local provider "ollama" is not configured', text: '' } });
  });

  it('compares models in the requested execution mode', async () => {
    compareLocalLlmModels.mockResolvedValue({
      mode: 'parallel',
      results: [
        { backend: 'ollama', modelId: 'a', text: 'A' },
        { backend: 'lmstudio', modelId: 'b', text: 'B' },
      ],
    });

    const targets = [
      { backend: 'ollama', modelId: 'a' },
      { backend: 'lmstudio', modelId: 'b' },
    ];
    const res = await request(makeApp())
      .post('/api/local-llm/compare')
      .send({ mode: 'parallel', targets, prompt: 'Compare this', options: { maxTokens: 64 } });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(compareLocalLlmModels).toHaveBeenCalledWith({
      mode: 'parallel',
      targets,
      prompt: 'Compare this',
      options: {
        systemPrompt: '',
        temperature: 0.3,
        maxTokens: 64,
        timeoutMs: 300000,
      },
      signal: expect.any(AbortSignal),
    });
  });

  it('accepts an endpoint-runtime target, rejects an unknown backend, and keeps install/delete on the managed pair', async () => {
    compareLocalLlmModels.mockResolvedValue({ mode: 'round-robin', results: [] });
    const ok = await request(makeApp())
      .post('/api/local-llm/compare')
      .send({ prompt: 'p', targets: [{ backend: 'ollama', modelId: 'a' }, { backend: 'llama', modelId: 'dflash' }] });
    expect(ok.status).toBe(200);
    expect(compareLocalLlmModels.mock.calls.at(-1)[0].targets[1]).toEqual({ backend: 'llama', modelId: 'dflash' });

    const unknown = await request(makeApp())
      .post('/api/local-llm/compare')
      .send({ prompt: 'p', targets: [{ backend: 'nope', modelId: 'x' }] });
    expect(unknown.status).toBe(400);

    const install = await request(makeApp()).post('/api/local-llm/install').send({ backend: 'llama', modelId: 'dflash' });
    expect(install.status).toBe(400);
    const del = await request(makeApp()).post('/api/local-llm/delete').send({ backend: 'llama', modelId: 'dflash' });
    expect(del.status).toBe(400);
  });

  it('streams an mtplx test as token frames then a result, and a down daemon is an inline error result', async () => {
    runLocalLlmTest.mockImplementationOnce(async ({ onToken }) => {
      await onToken('Hi', 'content');
      return { backend: 'mtplx', modelId: 'm', text: 'Hi', timings: {} };
    });
    const up = await request(makeApp()).post('/api/local-llm/test/stream').send({ backend: 'mtplx', modelId: 'm', prompt: 'hi' });
    expect(up.status).toBe(200);
    expect(runLocalLlmTest.mock.calls.at(-1)[0]).toMatchObject({ backend: 'mtplx', modelId: 'm', prompt: 'hi' });
    const upFrames = up.text.trim().split('\n').map((l) => JSON.parse(l));
    expect(upFrames.map((f) => f.type)).toEqual(['token', 'result']);

    runLocalLlmTest.mockResolvedValueOnce({ backend: 'mtplx', modelId: 'm', error: 'fetch failed', text: '' });
    const down = await request(makeApp()).post('/api/local-llm/test/stream').send({ backend: 'mtplx', modelId: 'm', prompt: 'hi' });
    expect(down.status).toBe(200);
    expect(JSON.parse(down.text.trim())).toMatchObject({ type: 'result', result: { error: 'fetch failed' } });
  });

  it('lists the runtime models without running a generation', async () => {
    const runtimes = [{ id: 'llama', label: 'llama.cpp', models: [{ id: 'dflash' }], offline: false, error: null }];
    listEndpointRuntimeModels.mockResolvedValue(runtimes);
    const res = await request(makeApp()).get('/api/local-llm/runtime-models');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ runtimes });
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(compareLocalLlmModels).not.toHaveBeenCalled();
  });

  it('rejects empty prompts before running a model', () => {
    const parsed = localLlmTestSchema.safeParse({ backend: 'ollama', modelId: 'llama3.2', prompt: '   ' });

    expect(parsed.success).toBe(false);
  });

  it('limits comparisons to six targets', () => {
    const targets = Array.from({ length: 7 }, (_, i) => ({ backend: 'ollama', modelId: `model-${i}` }));
    const parsed = localLlmCompareSchema.safeParse({ targets, prompt: 'too many' });

    expect(parsed.success).toBe(false);
  });
});

describe('local LLM memory-management routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shares residency samples across socket viewers and fences the unload response', async () => {
    getLoadedModels.mockResolvedValue([{ id: 'example-model' }]);
    getLoadedLmStudioModels.mockResolvedValue([]);
    const first = new EventEmitter();
    const second = new EventEmitter();
    first.connected = second.connected = true;
    registerModelObservationSocket(first);
    registerModelObservationSocket(second);
    first.emit('loaded-models:subscribe');
    second.emit('loaded-models:subscribe');
    try {
      const app = makeApp();
      const [a, b] = await Promise.all([
        request(app).get('/api/local-llm/loaded'),
        request(app).get('/api/local-llm/loaded'),
      ]);
      expect(a.body.ollama).toEqual([{ id: 'example-model' }]);
      expect(b.body).toEqual(a.body);
      expect(getLoadedModels).toHaveBeenCalledTimes(1);
      expect(getLoadedLmStudioModels).toHaveBeenCalledTimes(1);
      unloadModel.mockImplementationOnce(async () => {
        getLoadedModels.mockResolvedValue([]);
        return { unloaded: true, model: 'example-model' };
      });
      await request(app).post('/api/local-llm/unload').send({ backend: 'ollama', modelId: 'example-model' });
      const after = await request(app).get('/api/local-llm/loaded');
      expect(after.body.ollama).toEqual([]);
    } finally {
      first.emit('disconnect');
      second.emit('disconnect');
    }
  });

  it('GET /loaded reports models both local backends currently have resident', async () => {
      // Mirror the real getLoadedModels() field set so the fixture documents the
      // pass-through contract and would catch any future field-stripping.
    const resident = { id: 'llama3.2', name: 'llama3.2', size: 4096, sizeVram: 4096, expiresAt: null };
    const lmStudioResident = { id: 'example/lmstudio', state: 'loaded' };
    getLoadedModels.mockResolvedValue([resident]);
    getLoadedLmStudioModels.mockResolvedValue([lmStudioResident]);

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ollama: [resident], lmstudio: [lmStudioResident], sourceErrors: [], disabled: [] });
    expect(getLoadedModels).toHaveBeenCalledTimes(1);
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
     });

  it('GET /loaded keeps a failed disabled backend in sourceErrors but names it disabled', async () => {
      // "Mark disabled" only silences the availability NAG — it is not evidence the
      // backend holds no memory. So /loaded must still probe a disabled backend AND
      // still surface its failed residency in sourceErrors (the panel's
      // "Free everything" guard keys off that), while separately naming it in
      // `disabled` so the banner can stay quiet about it.
    getSettings.mockResolvedValueOnce({ localLlm: { lmstudio: { disabled: true } } });
    getLmStudioResidencyError.mockReturnValueOnce('LM Studio is unavailable');
    getLoadedLmStudioModels.mockResolvedValue([{ id: 'example/lmstudio', state: 'loaded' }]);

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
       // Residency is honored — the backend is still probed…
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
    expect(res.body.lmstudio).toEqual([{ id: 'example/lmstudio', state: 'loaded' }]);
       // …and its failed probe keeps the "unknown residency" status sourceErrors so
       // "Free everything" can't claim it freed a model it never saw.
    expect(res.body.sourceErrors).toContain('lmstudio');
       // The disabled flag is the signal the panel uses to hold the banner.
    expect(res.body.disabled).toEqual(['lmstudio']);
    expect(getSettings).toHaveBeenCalled();
      });

  it('GET /loaded still reports an enabled backend whose residency probe fails', async () => {
      // An enabled backend that fails its residency probe surfaces in sourceErrors
      // and is NOT in `disabled`, so the panel both shows the nag and keeps its
      // "excluded from Free everything" guard.
    getSettings.mockResolvedValueOnce({});
    getLmStudioResidencyError.mockReturnValueOnce('LM Studio is unavailable');

    const res = await request(makeApp()).get('/api/local-llm/loaded');

    expect(res.status).toBe(200);
    expect(res.body.sourceErrors).toContain('lmstudio');
       // An enabled backend is not in the disabled list.
    expect(res.body.disabled).not.toContain('lmstudio');
    expect(getLoadedLmStudioModels).toHaveBeenCalledWith(true);
      });

  it('POST /unload evicts a resident model and echoes the service result', async () => {
    // Real unloadModel() success shape is { unloaded: true, model } — NOT modelId
    // (ollamaManager.js); the handler spreads it into the response verbatim.
    unloadModel.mockResolvedValue({ unloaded: true, model: 'llama3.2' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, unloaded: true, model: 'llama3.2' });
    expect(unloadModel).toHaveBeenCalledWith('llama3.2');
  });

  it('POST /unload treats an already-evicted model as an idempotent 200 no-op', async () => {
    unloadModel.mockResolvedValue({ unloaded: false, reason: 'not loaded' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, unloaded: false, reason: 'not loaded', modelId: 'llama3.2' });
  });

  it('POST /unload surfaces a genuine unload failure as 502', async () => {
    unloadModel.mockResolvedValue({ unloaded: false, reason: 'Ollama unreachable' });

    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: 'llama3.2' });

    expect(res.status).toBe(502);
    // Standard error envelope (errorHandler): message in `error`, machine code
    // derived from status, the modelId carried in `context` for diagnostics.
    expect(res.body.error).toBe('Ollama unreachable');
    expect(res.body.code).toBe('BAD_GATEWAY');
    expect(res.body.context).toEqual({ modelId: 'llama3.2' });
    expect(unloadModel).toHaveBeenCalledWith('llama3.2');
  });

  it('POST /unload refuses a non-ollama backend before calling the service', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'lmstudio', modelId: 'some-model' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(unloadModel).not.toHaveBeenCalled();
  });

  it('POST /unload rejects a flag-like modelId via Zod validation', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/unload')
      .send({ backend: 'ollama', modelId: '-rf' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(unloadModel).not.toHaveBeenCalled();
  });
});

describe('local LLM capability routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('GET /tool-use-models returns the service list under `models`', async () => {
    listToolUseModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
    ]);

    const res = await request(makeApp()).get('/api/local-llm/tool-use-models');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      models: [
        { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
      ],
    });
    expect(listToolUseModels).toHaveBeenCalledTimes(1);
  });

  it('GET /tool-use-models is a distinct list from /vision-models', async () => {
    // The two endpoints answer different questions; folding tool-use rows into
    // /vision-models would break its "every row is vision-capable" contract,
    // which the LoRA caption picker lists verbatim.
    listVisionModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'qwen2.5-vl:7b', name: 'qwen2.5-vl:7b', vision: true },
    ]);
    listToolUseModels.mockResolvedValueOnce([
      { providerId: 'ollama', backend: 'ollama', id: 'phi4-mini:latest', name: 'phi4-mini:latest', toolUse: true },
    ]);
    const app = makeApp();

    const vision = await request(app).get('/api/local-llm/vision-models');
    const tools = await request(app).get('/api/local-llm/tool-use-models');

    expect(vision.body.models.map((m) => m.id)).toEqual(['qwen2.5-vl:7b']);
    expect(tools.body.models.map((m) => m.id)).toEqual(['phi4-mini:latest']);
  });
});

describe('measured assessments wiring', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('folds measured evidence into the catalog fit badge', async () => {
    getMeasuredFits.mockResolvedValue({ 'example-model:14b': { fit: 'too-large', verdict: 'does-not-fit', stale: false } });
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');

    expect(res.status).toBe(200);
    expect(getMeasuredFits).toHaveBeenCalledWith('ollama');
    // The overlay runs against the SAME backend the listing was built for —
    // an LM Studio measurement must never decorate an Ollama card.
    expect(applyMeasuredFit).toHaveBeenCalledWith(res.body.models, {
      backend: 'ollama',
      measured: { 'example-model:14b': { fit: 'too-large', verdict: 'does-not-fit', stale: false } },
    });
  });

  it('still serves the catalog when the assessments store cannot be read', async () => {
    // A broken measurement file must not take the install picker down with it.
    getMeasuredFits.mockRejectedValue(new Error('disk on fire'));
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama');
    expect(res.status).toBe(200);
    expect(applyMeasuredFit).toHaveBeenCalledWith(expect.anything(), { backend: 'ollama', measured: {} });
  });

  it('forwards assessment progress to the shared localLlm:progress socket event', async () => {
    runAssessment.mockImplementation(async ({ onProgress }) => {
      onProgress({ scope: 'assessment', backend: 'ollama', modelId: 'example-model:14b', event: 'start', sampleIndex: 1, sampleCount: 3 });
      return { verdict: 'fits' };
    });
    const app = makeApp();
    const res = await request(app)
      .post('/api/local-llm/assessments/run')
      .send({ backend: 'ollama', modelId: 'example-model:14b' });

    expect(res.status).toBe(200);
    expect(app.get('io').emit).toHaveBeenCalledWith('localLlm:progress', {
      scope: 'assessment', backend: 'ollama', modelId: 'example-model:14b', event: 'start', sampleIndex: 1, sampleCount: 3,
    });
  });

  it('POST /assessments/run returns 503 when an endpoint runtime is unconfigured', async () => {
    runAssessment.mockRejectedValueOnce(new ServerError('No endpoint is configured for the llama runtime', {
      status: 503,
      code: 'LOCAL_LLM_ENDPOINT_MISSING',
      context: { backend: 'llama' },
    }));

    const res = await request(makeApp())
      .post('/api/local-llm/assessments/run')
      .send({ backend: 'llama', modelId: 'example-model:7b' });

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'LOCAL_LLM_ENDPOINT_MISSING', context: { backend: 'llama' } });
  });

  it('POST /migrate returns 502 when a backend is unavailable', async () => {
    migrateBackend.mockResolvedValueOnce({ success: false, error: 'Source backend is unavailable' });

    const res = await request(makeApp()).post('/api/local-llm/migrate').send({ to: 'ollama' });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: 'Source backend is unavailable', code: 'BAD_GATEWAY' });
  });

  it('runs the explicit OpenCode agent benchmark with a bounded timeout', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/agent-benchmark')
      .send({ backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000 });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000, completed: true,
    });
    expect(runOpenCodeAgentBenchmark).toHaveBeenCalledWith({
      backend: 'ollama', modelId: 'qwen3.8:27b-mlx', timeoutMs: 120000,
    });
  });

  it('rejects an agent benchmark backend outside the configured local targets', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/agent-benchmark')
      .send({ backend: 'vllm', modelId: 'qwen3.8-27b-dflash2' });

    expect(res.status).toBe(400);
    expect(runOpenCodeAgentBenchmark).not.toHaveBeenCalled();
  });

  // The sweep is the overnight path: it must return as soon as the queue exists,
  // because the run outlives the request that started it.
  it('POST /assessments/sweep starts a queue and returns its snapshot', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ scope: 'all' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'running', total: 3 });
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({ scope: 'all' }));
  });

  it('POST /assessments/sweep defaults to the unmeasured scope', async () => {
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep').send({});
    expect(res.status).toBe(200);
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({ scope: 'unmeasured' }));
  });

  it('POST /assessments/sweep rejects an unknown scope rather than silently narrowing it', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ scope: 'everything-please' });

    expect(res.status).toBe(400);
    expect(startSweep).not.toHaveBeenCalled();
  });

  // A refused start has to be visible: a 200 with no queue behind it would leave
  // the page waiting on progress that never comes.
  it('POST /assessments/sweep 409s when the service refuses to start', async () => {
    startSweep.mockResolvedValueOnce({ status: 'running', rejected: 'a sweep is already running' });
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep').send({ scope: 'all' });
    expect(res.status).toBe(409);
  });

  // Only the model list travels: the profile is server-fixed so the gate's count is what runs.
  it('POST /assessments/benchmark queues exactly the picked models on the sweep queue', async () => {
    startSweep.mockResolvedValueOnce({ status: 'running', mode: 'benchmark', total: 2 });
    const models = [{ backend: 'ollama', modelId: 'example-mlx' }, { backend: 'mtplx', modelId: 'example-mtp' }];
    const res = await request(makeApp()).post('/api/local-llm/assessments/benchmark').send({ models, contextTokens: [131072] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'benchmark', total: 2 });
    expect(startSweep).toHaveBeenCalledWith(expect.objectContaining({ models }));
    expect(startSweep.mock.calls[0][0]).not.toHaveProperty('contextTokens');
  });

  it('POST /assessments/benchmark refuses one model, a duplicate pick, or a service refusal', async () => {
    const one = [{ backend: 'ollama', modelId: 'example-mlx' }];
    expect((await request(makeApp()).post('/api/local-llm/assessments/benchmark').send({ models: one })).status).toBe(400);
    expect((await request(makeApp()).post('/api/local-llm/assessments/benchmark').send({ models: [...one, ...one] })).status).toBe(400);
    expect(startSweep).not.toHaveBeenCalled();
    startSweep.mockResolvedValueOnce({ status: 'idle', rejected: 'example-mtp is not installed on mtplx' });
    const refused = await request(makeApp()).post('/api/local-llm/assessments/benchmark')
      .send({ models: [...one, { backend: 'mtplx', modelId: 'example-mtp' }] });
    expect(refused.status).toBe(409);
  });

  it('forwards sweep progress and public queue snapshots to their socket events', async () => {
    startSweep.mockImplementation(async ({ onProgress, onChange }) => {
      onProgress({ scope: 'assessment-sweep', event: 'start', total: 2, completed: 0 });
      onChange({ status: 'running', settled: false, total: 2, completed: 0, results: [], cancelRequested: false });
      return { status: 'running', total: 2, completed: 0 };
    });
    const app = makeApp();
    await request(app).post('/api/local-llm/assessments/sweep').send({ scope: 'unmeasured' });

    expect(app.get('io').emit).toHaveBeenCalledWith('localLlm:progress', {
      scope: 'assessment-sweep', event: 'start', total: 2, completed: 0,
    });
    expect(app.get('io').emit).toHaveBeenCalledWith('localLlm:sweep:changed', {
      status: 'running', settled: false, total: 2, completed: 0, results: [], cancelRequested: false,
    });
  });

  // `tunings` is the ASK, not the grid — the service decides which knob sets a
  // "tuning sweep of this model" means. A client that could post the grid could
  // ask for an arbitrary batch of provider calls.
  // The service's refusals ride the existing rejected → 409 path rather than a
  // second, hand-rolled one in the handler.
  it('POST /assessments/sweep 409s when the service refuses the tuning grid', async () => {
    startSweep.mockResolvedValueOnce({ status: 'idle', rejected: 'mtplx has no tuning knobs PortOS can sweep' });
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'mtplx', modelId: 'example-model', tunings: true });

    expect(res.status).toBe(409);
  });

  // Half a model reference would fall through to the scope and measure every
  // installed model — hours of work nobody asked for.
  it('POST /assessments/sweep rejects a backend with no modelId', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'llama', tunings: true });

    expect(res.status).toBe(400);
    expect(startSweep).not.toHaveBeenCalled();
  });

  // No wire knob shrinks the grid: the consent gate names its count from the
  // report's grid, so a request that could shrink it would run a different
  // number than the user agreed to.
  it('POST /assessments/sweep rejects an attempt to size the grid from the wire', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/assessments/sweep')
      .send({ backend: 'llama', modelId: 'example-model.gguf', tunings: true, maxVariants: 2 });

    expect(res.status).toBe(200);
    expect(startSweep.mock.calls[0][0].maxVariants).toBeUndefined();
  });

  it('POST /assessments/sweep leaves a plain model sweep untuned', async () => {
    await request(makeApp()).post('/api/local-llm/assessments/sweep').send({ scope: 'all' });
    expect(startSweep.mock.calls[0][0].tunings).toBe(false);
  });

  it('GET /assessments/sweep reports the queue without touching a provider', async () => {
    const res = await request(makeApp()).get('/api/local-llm/assessments/sweep');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'idle' });
    expect(getSweepStatus).toHaveBeenCalled();
    expect(startSweep).not.toHaveBeenCalled();
  });

  it('POST /assessments/sweep/cancel stops the queue', async () => {
    const res = await request(makeApp()).post('/api/local-llm/assessments/sweep/cancel');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', completed: 1 });
    expect(cancelSweep).toHaveBeenCalled();
  });
});

describe('llama-server routes', () => {
  it('GET /api/local-llm/llama-server/status returns status with the weight presets', async () => {
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      installed: true,
      running: false,
      presets: [{ id: 'test-preset', label: 'Test', specType: 'draft-dspark', model: null, draftModel: null }],
    });
  });

  it('GET /api/local-llm/llama-server/status keeps Homebrew probes out of lifecycle status', async () => {
    const { getLlamaServerUpdateStatus } = await import('../services/llamaServerManager.js');
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');

    expect(res.status).toBe(200);
    expect(getLlamaServerUpdateStatus).not.toHaveBeenCalled();
    expect(res.body).not.toHaveProperty('updateAvailable');
  });

  it('GET /api/local-llm/llama-server/update-status returns llama.cpp update metadata', async () => {
    const { getLlamaServerUpdateStatus } = await import('../services/llamaServerManager.js');
    getLlamaServerUpdateStatus.mockResolvedValueOnce({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
      downloadUrl: 'https://github.com/ggml-org/llama.cpp/releases',
    });

    const res = await request(makeApp()).get('/api/local-llm/llama-server/update-status');

    expect(res.body).toMatchObject({
      version: '0.1.1-dev',
      latestVersion: '0.3.0',
      updateAvailable: true,
      canUpgrade: true,
    });
  });

  it('GET /api/local-llm/llama-server/status publishes the drafter-free spec types', async () => {
    // The card renders the picker from this list, so a launch with no drafter
    // GGUF (`ngram-map-k`) has to be reachable without the user knowing the
    // llama.cpp vocabulary by heart.
    const res = await request(makeApp()).get('/api/local-llm/llama-server/status');
    expect(res.body.specTypes.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['ngram-map-k', 'draft-dflash', 'none']),
    );
  });

  it('POST /api/local-llm/llama-server/download-model fetches one preset GGUF', async () => {
    const { downloadSpecDecodeModel } = await import('../services/specDecodeModels.js');
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model')
      .send({ presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, path: 'models/base.gguf' });
    expect(downloadSpecDecodeModel).toHaveBeenCalledWith(expect.objectContaining({ presetId: 'test-preset', role: 'model' }));
  });

  it('POST /api/local-llm/llama-server/download-model rejects an unknown role', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model')
      .send({ presetId: 'test-preset', role: 'sneaky' });

    expect(res.status).toBe(400);
  });

  it('POST /api/local-llm/download-preflight returns size, dest, and free disk without starting a transfer', async () => {
    const { previewSpecDecodeDownload, downloadSpecDecodeModel } = await import('../services/specDecodeModels.js');
    downloadSpecDecodeModel.mockClear();
    const res = await request(makeApp())
      .post('/api/local-llm/download-preflight')
      .send({ kind: 'spec-decode', presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      kind: 'spec-decode',
      destPath: 'models/base.gguf',
      expectedBytes: 6,
      freeBytes: 1e12,
      verdict: 'ok',
    });
    expect(previewSpecDecodeDownload).toHaveBeenCalledWith({ presetId: 'test-preset', role: 'model' });
    expect(downloadSpecDecodeModel).not.toHaveBeenCalled();
  });

  it('POST /api/local-llm/llama-server/download-model/cancel cancels one active preset download', async () => {
    const { cancelSpecDecodeModelDownload } = await import('../services/specDecodeModels.js');
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model/cancel')
      .send({ presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, cancelled: true });
    expect(cancelSpecDecodeModelDownload).toHaveBeenCalledWith({ presetId: 'test-preset', role: 'model' });
  });

  it('POST /api/local-llm/llama-server/download-model/remove deletes one preset GGUF', async () => {
    const { removeSpecDecodeModel } = await import('../services/specDecodeModels.js');
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model/remove')
      .send({ presetId: 'test-preset', role: 'model' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, deleted: true, path: 'models/base.gguf' });
    expect(removeSpecDecodeModel).toHaveBeenCalledWith({ presetId: 'test-preset', role: 'model' });
  });

  it('POST /api/local-llm/llama-server/download-model/remove rejects an unknown role', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/download-model/remove')
      .send({ presetId: 'test-preset', role: 'sneaky' });

    expect(res.status).toBe(400);
  });

  it('POST /api/local-llm/llama-server/start rejects invalid payload', async () => {
    const res = await request(makeApp())
      .post('/api/local-llm/llama-server/start')
      .send({});
    expect(res.status).toBe(400);
  });

  it('ends install progress when llama.cpp installation rejects', async () => {
    const { installLlamaServer } = await import('../services/llamaServerManager.js');
    const start = { event: 'start', message: 'Installing llama.cpp via Homebrew…' };
    installLlamaServer.mockImplementationOnce(async ({ onProgress }) => {
      onProgress(start);
      throw new ServerError('package manager exited', { status: 502 });
    });
    const app = makeApp();

    const res = await request(app).post('/api/local-llm/llama-server/install');

    expect(res.status).toBe(502);
    const progressCalls = app.get('io').emit.mock.calls.filter(([event]) => event === 'localLlm:progress');
    expect(progressCalls).toEqual([
      ['localLlm:progress', start],
      ['localLlm:progress', { event: 'error', message: 'llama.cpp install failed: package manager exited' }],
    ]);
  });

  it('POST /api/local-llm/llama-server/upgrade emits progress and returns the result', async () => {
    const { upgradeLlamaServer } = await import('../services/llamaServerManager.js');
    upgradeLlamaServer.mockResolvedValueOnce({ success: true, note: 'updated and restarted' });
    const app = makeApp();

    const res = await request(app).post('/api/local-llm/llama-server/upgrade');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, note: 'updated and restarted' });
    expect(upgradeLlamaServer).toHaveBeenCalledWith({ onProgress: expect.any(Function) });
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress',
      { event: 'complete', message: 'llama.cpp updated — updated and restarted' },
    );
  });
});


describe('Jev integration policies', () => {
  it('resolves inherited modes and changes only scorer fields, preserving other policies', async () => {
    let persisted = { unrelated: true, untrustedContent: {
      defaults: { jevMode: 'prefer', classifierMode: 'required' },
      sources: { messages: { jevMode: 'only' }, email: { model: 'example-model' },
        'github-issue': { providerId: 'example-provider', jevMinMargin: 0.4 } },
    } };
    readSettingsStrict.mockImplementation(async () => ({ corrupt: false, settings: persisted }));
    updateSettingsWith.mockImplementation(async mutate => (persisted = mutate(persisted)));
    const app = makeApp();
    const before = await request(app).get('/api/local-llm/jev/policy');
    expect(before.body.sources.email.jevMode).toBe('only');
    expect(before.body.sources['github-issue']).toEqual({ jevMode: 'prefer', jevMinMargin: 0.4 });
    const changed = await request(app).put('/api/local-llm/jev/policy').send({
      sources: { email: { jevMode: 'disabled' } }, scopeAdherenceEnabled: false,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.scopeAdherenceEnabled).toBe(false);
    expect(changed.body.sources.email.jevMode).toBe('disabled');
    expect(persisted.untrustedContent.sources.email.model).toBe('example-model');
    expect(persisted.untrustedContent.sources['github-issue'].providerId).toBe('example-provider');
    expect(persisted.unrelated).toBe(true);
    const invalid = await request(app).put('/api/local-llm/jev/policy').send({ sources: { email: { classifierMode: 'optional' } } });
    expect(invalid.status).toBe(400);
  });
});


describe('local LLM default switching', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns the actionable conflict to the client and never emits completion', async () => {
    const error = 'LLM_BACKEND is exported as ollama. Change or unset that environment override and restart PortOS before setting lmstudio as the default.';
    switchBackend.mockResolvedValue({ success: false, code: 'BACKEND_OVERRIDE_CONFLICT', error });
    const app = makeApp();
    const res = await request(app).post('/api/local-llm/switch').send({ to: 'lmstudio' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(error);
    const progress = app.get('io').emit.mock.calls;
    expect(progress.some(([, payload]) => payload.event === 'complete')).toBe(false);
    expect(progress.some(([, payload]) => payload.event === 'error' && payload.message === error)).toBe(true);
  });

  it('returns 502 with the existing error envelope when a switch fails', async () => {
    const error = 'Backend unavailable';
    switchBackend.mockResolvedValue({ success: false, error });

    const res = await request(makeApp()).post('/api/local-llm/switch').send({ to: 'lmstudio' });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error, code: 'INTERNAL_ERROR' });
  });

  it('returns a successful default change and emits completion', async () => {
    switchBackend.mockResolvedValue({ success: true, backend: 'lmstudio' });
    const app = makeApp();
    const res = await request(app).post('/api/local-llm/switch').send({ to: 'lmstudio' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, backend: 'lmstudio' });
    expect(app.get('io').emit.mock.calls.some(([, payload]) => payload.event === 'complete')).toBe(true);
  });
});

describe('local LLM catalog and loaded query validation', () => {
  it('GET /catalog 400s on a repeated backend key and never lists models', async () => {
    listModels.mockClear();
    const res = await request(makeApp()).get('/api/local-llm/catalog?backend=ollama&backend=lmstudio');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(listModels).not.toHaveBeenCalled();
  });

  it.each([
    ['backend=invalid'],
    ['backend=ollama&variants=yes'],
    [`backend=ollama&q=${'x'.repeat(161)}`],
  ])('GET /catalog rejects invalid query %s before listing models', async (query) => {
    listModels.mockClear();
    const res = await request(makeApp()).get(`/api/local-llm/catalog?${query}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(listModels).not.toHaveBeenCalled();
  });

  it('GET /loaded 400s on a repeated fresh key and never reads residency', async () => {
    getLoadedModels.mockClear();
    const res = await request(makeApp()).get('/api/local-llm/loaded?fresh=1&fresh=0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(getLoadedModels).not.toHaveBeenCalled();
  });
});

describe.each([
  { id: 'splash', install: installSplashRuntime, start: startSplashServer, stop: stopSplashServer, uninstall: uninstallSplashRuntime },
  { id: 'mkserve', install: installMkserve, start: startMkserveServer, stop: stopMkserveServer, uninstall: uninstallMkserve },
])('$id lifecycle routes', ({ id, install, start, stop, uninstall }) => {
  const url = `/api/local-llm/${id}`;
  const readStatus = (app) => request(app).get(`${url}/status`);
  const mutate = (app, action) => request(app).post(`${url}/${action}`);

  it('returns immediately, reports install progress, and rejects concurrent operations', async () => {
    const app = makeApp();
    let finish;
    const transfer = new Promise((resolve) => { finish = resolve; });
    install.mockImplementationOnce(({ onProgress }) => {
      onProgress({ event: 'download', message: 'Downloading weights' });
      return transfer;
    });
    try {
      const accepted = await mutate(app, 'install');
      expect(accepted.status).toBe(202);
      expect(accepted.body.operation.action).toBe('install');
      expect((await readStatus(app)).body.operation).toMatchObject({
        action: 'install', message: expect.stringContaining('Downloading weights'),
      });
      expect((await mutate(app, 'start')).status).toBe(409);
    } finally {
      finish();
    }
    expect((await readStatus(app)).body).toMatchObject({ operation: null, lastError: null });
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress', expect.objectContaining({ event: 'complete', runtime: id }),
    );
  });

  it('routes Update and Stop to the managed service, rejecting launch overrides', async () => {
    const app = makeApp();
    install.mockClear().mockResolvedValueOnce({});
    stop.mockClear().mockResolvedValueOnce({});
    start.mockClear();
    const invalid = await mutate(app, 'start').send({ host: '0.0.0.0' });
    expect(invalid.status).toBe(400);
    expect(start).not.toHaveBeenCalled();
    expect((await mutate(app, 'upgrade')).status).toBe(202);
    expect(install).toHaveBeenCalledOnce();
    expect((await mutate(app, 'stop')).status).toBe(202);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('cancels only the addressed installation and keeps its slot until teardown', async () => {
    const app = makeApp();
    let signal;
    let finish;
    const transfer = new Promise((_resolve, reject) => { finish = () => reject(signal.reason); });
    install.mockImplementationOnce((options) => {
      signal = options.signal;
      return transfer;
    });
    const accepted = await mutate(app, 'upgrade');
    expect(accepted.status).toBe(202);
    const { operation } = accepted.body;
    try {
      expect((await mutate(app, 'cancel').send({ operationId: '61d3819b-c7ab-476c-be68-81355beebdae' })).body).toEqual({ cancelled: false });
      expect(signal.aborted).toBe(false);
      expect((await mutate(app, 'cancel').send({ operationId: operation.id })).body).toMatchObject({
        cancelled: true, operation: { id: operation.id, cancelling: true },
      });
      expect(signal.aborted).toBe(true);
      expect((await readStatus(app)).body.operation).toMatchObject({ cancelling: true });
      expect((await mutate(app, 'install')).status).toBe(409);
      expect((await mutate(app, 'uninstall')).status).toBe(409);
    } finally {
      finish();
    }
    expect((await readStatus(app)).body).toMatchObject({ operation: null, lastError: null });
    expect((await mutate(app, 'cancel')).body).toEqual({ cancelled: false });
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress', expect.objectContaining({ event: 'cancelled', runtime: id, operation: null }),
    );
  });

  it('accepts uninstall and reports its scoped completion without launching the server', async () => {
    const app = makeApp();
    uninstall.mockClear().mockResolvedValueOnce({ success: true });
    start.mockClear();
    const response = await mutate(app, 'uninstall');
    expect(response.status).toBe(202);
    expect(response.body.operation.action).toBe('uninstall');
    expect((await readStatus(app)).body).toMatchObject({ operation: null, lastError: null });
    expect(uninstall).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress', expect.objectContaining({ event: 'complete', runtime: id, message: expect.stringContaining('uninstalled') }),
    );
  });

  it('surfaces actionable refusal after accepting a background start', async () => {
    const app = makeApp();
    start.mockRejectedValueOnce(new ServerError('Preset port is occupied. Stop the external process first.', { status: 409 }));
    expect((await mutate(app, 'start')).status).toBe(202);
    expect((await readStatus(app)).body).toMatchObject({
      operation: null, lastError: 'Preset port is occupied. Stop the external process first.',
    });
    expect(app.get('io').emit).toHaveBeenCalledWith(
      'localLlm:progress', expect.objectContaining({ event: 'error', runtime: id }),
    );
  });
});

it('accepts the repair flag only on mkserve Install and requires operator authority for status logs', async () => {
  const app = makeApp();
  installMkserve.mockClear().mockResolvedValueOnce({});
  const accepted = await request(app).post('/api/local-llm/mkserve/install').send({ repair: true });
  expect(accepted.status).toBe(202);
  expect(accepted.body.operation.action).toBe('repair');
  expect(installMkserve).toHaveBeenCalledWith(expect.objectContaining({ repair: true }));
  expect((await request(app).post('/api/local-llm/mkserve/start').send({ repair: true })).status).toBe(400);
  expect((await request(app).post('/api/local-llm/splash/install').send({ repair: true })).status).toBe(400);
  expect((await request(app).get('/api/local-llm/mkserve/status')).status).toBe(200);
  expect(getMkserveRuntimeStatus).toHaveBeenLastCalledWith({ includeLogs: false });
  const operatorApp = express();
  operatorApp.use((req, _res, next) => {
    req.portosAuthContext = { enabled: true, authenticated: true, method: 'session' };
    next();
  });
  operatorApp.use('/api/local-llm', localLlmRoutes);
  expect((await request(operatorApp).get('/api/local-llm/mkserve/status')).status).toBe(200);
  expect(getMkserveRuntimeStatus).toHaveBeenLastCalledWith({ includeLogs: true });
});


describe('managed runtime provider-model refresh after a user lifecycle action', () => {
  const post = (path, body = {}) => request(makeApp()).post(`/api/local-llm/${path}`).send(body);
  const MODEL = 'example-org/example-model';

  beforeEach(() => {
    syncRuntimeProviderModels.mockClear();
  });

  it.each([
    ['llama', 'llama-server/start', startLlamaServer, waitForLlamaServerReady],
    ['mtplx', 'mtplx/start', startMtplxServer, waitForMtplxReady, {}],
    ['slotstream', 'slotstream/start', startSlotstreamServer, waitForSlotstreamReady, {}],
  ])('%s start refreshes after the response; a server still loading waits on its readiness probe', async (kind, path, start, waitFor) => {
    start.mockResolvedValueOnce({ success: true, online: true, endpoint: 'http://127.0.0.1:9000/v1' });
    const body = kind === 'llama' ? { model: 'preset' } : {};
    expect((await post(path, body)).status).toBe(200);
    expect(syncRuntimeProviderModels).toHaveBeenCalledTimes(1);
    expect(syncRuntimeProviderModels.mock.calls[0][0]).toMatchObject({ kind, waitForReady: null });
    expect(syncRuntimeProviderModels.mock.calls[0][0].io).toBeTruthy();

    syncRuntimeProviderModels.mockClear();
    start.mockResolvedValueOnce({ success: true, online: false, endpoint: 'http://127.0.0.1:9000/v1' });
    waitFor.mockResolvedValueOnce({ ready: true });
    expect((await post(path, body)).status).toBe(200);
    await syncRuntimeProviderModels.mock.calls[0][0].waitForReady();
    expect(waitFor).toHaveBeenCalledWith('http://127.0.0.1:9000/v1');
  });

  it('does not wait on the refresh: the response returns while it is still pending', async () => {
    startMtplxServer.mockResolvedValueOnce({ success: true, online: true, endpoint: 'http://127.0.0.1:8000/v1' });
    syncRuntimeProviderModels.mockReturnValueOnce(new Promise(() => {}));
    expect((await post('mtplx/start')).status).toBe(200);
  });

  it.each([
    ['llama-server/start', startLlamaServer, { model: 'preset' }],
    ['mtplx/start', startMtplxServer, {}],
    ['slotstream/start', startSlotstreamServer, {}],
    ['mtplx/models/pull', pullMtplxModel, { model: MODEL }],
    ['mtplx/models/remove', removeMtplxModel, { model: MODEL }],
    ['slotstream/models/download', downloadSlotstreamModel, { model: MODEL }],
  ])('%s that throws refreshes nothing', async (path, action, body) => {
    action.mockRejectedValueOnce(new ServerError('refused', { status: 400 }));
    expect((await post(path, body)).status).toBe(400);
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    ['mtplx', 'mtplx/models/pull', pullMtplxModel],
    ['slotstream', 'slotstream/models/download', downloadSlotstreamModel],
  ])('%s checkpoint download refreshes when it succeeds', async (kind, path, action) => {
    action.mockResolvedValueOnce({ success: true });
    expect((await post(path, { model: MODEL })).status).toBe(200);
    expect(syncRuntimeProviderModels.mock.calls[0][0]).toMatchObject({ kind, waitForReady: null });
  });

  it.each([
    ['mtplx/models/pull', pullMtplxModel, {}, 502, 'MTPLX_PULL_FAILED'],
    ['slotstream/models/download', downloadSlotstreamModel, {}, 502, 'SLOTSTREAM_DOWNLOAD_FAILED'],
    ['slotstream/models/download', downloadSlotstreamModel, { status: 401, code: 'HF_AUTH' }, 401, 'HF_AUTH'],
    ['slotstream/models/download', downloadSlotstreamModel, { status: 422, code: 'SLOTSTREAM_NO_WEIGHTS' }, 422, 'SLOTSTREAM_NO_WEIGHTS'],
    ['slotstream/models/download', downloadSlotstreamModel, { status: 504, code: 'SLOTSTREAM_METADATA_TIMEOUT' }, 504, 'SLOTSTREAM_METADATA_TIMEOUT'],
  ])('%s returns a structured error and skips refresh (%#)', async (path, action, details, status, code) => {
    action.mockResolvedValueOnce({ success: false, error: 'Checkpoint unavailable', ...details });

    const response = await post(path, { model: MODEL });

    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ error: 'Checkpoint unavailable', code });
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it('returns a successful HTTP response for Slotstream cancellation and skips refresh', async () => {
    downloadSlotstreamModel.mockResolvedValueOnce({
      success: false, cancelled: true, model: MODEL, error: 'Cancelled', code: 'SLOTSTREAM_DOWNLOAD_CANCELLED',
    });

    const response = await post('slotstream/models/download', { model: MODEL });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: false, cancelled: true, model: MODEL });
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it('mtplx checkpoint removal refreshes', async () => {
    removeMtplxModel.mockResolvedValueOnce({ success: true });
    await post('mtplx/models/remove', { model: MODEL });
    expect(syncRuntimeProviderModels.mock.calls[0][0]).toMatchObject({ kind: 'mtplx' });
  });

  it.each(['splash', 'mkserve'])('%s refreshes after a successful background start only', async (id) => {
    const start = { splash: startSplashServer, mkserve: startMkserveServer }[id];
    start.mockResolvedValueOnce({ success: true });
    expect((await post(`${id}/start`)).status).toBe(202);
    await vi.waitFor(() => expect(syncRuntimeProviderModels).toHaveBeenCalledTimes(1));
    expect(syncRuntimeProviderModels.mock.calls[0][0]).toMatchObject({ kind: id, waitForReady: null });

    syncRuntimeProviderModels.mockClear();
    start.mockRejectedValueOnce(new ServerError('port in use', { status: 409 }));
    const app = makeApp();
    expect((await request(app).post(`/api/local-llm/${id}/start`)).status).toBe(202);
    await vi.waitFor(async () => expect((await request(app).get(`/api/local-llm/${id}/status`)).body.lastError).toBe('port in use'));
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    ['llama-server/stop', stopLlamaServer],
    ['mtplx/stop', stopMtplxServer],
    ['slotstream/stop', stopSlotstreamServer],
  ])('%s never refreshes: an unreachable daemon is no evidence the set changed', async (path, stop) => {
    stop.mockResolvedValueOnce({ success: true });
    expect((await post(path)).status).toBe(200);
    expect(syncRuntimeProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    ['llama-server/stop', stopLlamaServer],
    ['mtplx/stop', stopMtplxServer],
    ['slotstream/stop', stopSlotstreamServer],
  ])('%s reports an externally owned daemon as a conflict', async (path, stop) => {
    stop.mockResolvedValueOnce({ success: false, message: 'An external process is listening.', code: 'EXTERNAL_PROCESS_RUNNING' });
    const res = await request(makeApp()).post(`/api/local-llm/${path}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'An external process is listening.', code: 'EXTERNAL_PROCESS_RUNNING' });
  });
});

it('validates and saves the Splash next-start context through the runtime route', async () => {
  const app = makeApp();
  const save = (contextWindow) => request(app).put('/api/local-llm/splash/context').send({ contextWindow });
  expect((await save(1010000)).status).toBe(400);
  expect((await save('1000000')).status).toBe(400);
  expect(saveSplashContextWindow).not.toHaveBeenCalled();
  saveSplashContextWindow.mockResolvedValueOnce({ requestedContextWindow: 1000000 });
  const result = await save(1000000);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ requestedContextWindow: 1000000 });
  expect(saveSplashContextWindow).toHaveBeenCalledWith(1000000);
});

it('save-startup leaves every on-demand runtime out of the boot dump', async () => {
  const res = await request(makeApp()).post('/api/local-llm/save-startup');
  expect(res.status).toBe(200);
  expect(saveProcessList).toHaveBeenCalledWith(null, {
    exclude: ['portos-mtplx', 'portos-slotstream', 'portos-splash', 'portos-mkserve'],
  });
});
