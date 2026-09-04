/**
 * Assessment run + store behavior, driven against a real on-disk store with
 * `PATHS.data` re-rooted at a temp dir. The provider seam (`runLocalLlmTest`)
 * is the only thing stubbed — that is the boundary where a real LLM call would
 * otherwise happen, and stubbing it is what lets these tests assert the "never
 * call a provider from a read path" contract.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-local-assessment-');

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot }));

const runLocalLlmTest = vi.fn();
const runEndpointLlmTest = vi.fn();
vi.mock('./localLlmPlayground.js', () => ({
  runLocalLlmTest: (...args) => runLocalLlmTest(...args),
  runEndpointLlmTest: (...args) => runEndpointLlmTest(...args),
}));

// The endpoint runtimes (llama.cpp / MTPLX / vLLM) are reached over loopback
// HTTP. Left unmocked these tests probe whatever the DEVELOPER's machine happens
// to be serving — a live llama-server on this box put its real model id into the
// unassessed list. Default them to "up, serving nothing", which is the only
// state that keeps the managed-backend assertions about what they are about.
const probeOpenAiModels = vi.fn();
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: (...args) => probeOpenAiModels(...args) }));

// `runtimeApiKey` reads the provider registry to authenticate a key-gated
// runtime (a vLLM container started behind VLLM_API_KEY).
//
// `getAllProviders` resolves the toolkit ENVELOPE (`{ activeProvider, providers }`)
// and `listProviders` is the wrapper that unwraps it — mocked in that shape on
// purpose. A bare-array mock here is what let `runtimeApiKey`'s
// `Array.isArray(providers)` guard read as satisfied in tests while never being
// true in production, so a key-gated vLLM silently got no key.
const getAllProviders = vi.fn(async () => ({ activeProvider: null, providers: [] }));
vi.mock('./providers.js', () => ({
  getAllProviders: (...args) => getAllProviders(...args),
  listProviders: async () => {
    const data = await getAllProviders().catch(() => null);
    return Array.isArray(data?.providers) ? data.providers : [];
  },
}));

const getLlamaServerEndpoint = vi.fn();
const relaunchLlamaServerWithTuning = vi.fn();
const captureLlamaServerConfig = vi.fn(async () => null);
const restoreLlamaServerConfig = vi.fn(async () => ({ restored: false, reason: 'nothing was captured' }));
vi.mock('./llamaServerManager.js', () => ({
  getLlamaServerEndpoint: (...args) => getLlamaServerEndpoint(...args),
  relaunchLlamaServerWithTuning: (...args) => relaunchLlamaServerWithTuning(...args),
  captureLlamaServerConfig: (...args) => captureLlamaServerConfig(...args),
  restoreLlamaServerConfig: (...args) => restoreLlamaServerConfig(...args),
}));

// MTPLX's knobs are `mtplx serve` flags, so applying one relaunches the PM2
// daemon. Left unmocked this suite would shell out to the developer's real PM2
// and probe their real :8000 — the same reason llama-server is mocked above.
const getMtplxServerEndpoint = vi.fn(async () => 'http://127.0.0.1:8000/v1');
const relaunchMtplxServerWithTuning = vi.fn(async () => ({ applied: true, reason: null, config: null }));
// Consulted only when the live probe fails, to list what is on disk for a
// runtime that is not running.
const getMtplxServerStatus = vi.fn(async () => ({ cachedModels: [] }));
vi.mock('./mtplxServerManager.js', () => ({
  getMtplxServerEndpoint: (...args) => getMtplxServerEndpoint(...args),
  getMtplxServerStatus: (...args) => getMtplxServerStatus(...args),
  relaunchMtplxServerWithTuning: (...args) => relaunchMtplxServerWithTuning(...args),
}));

const getSpecDecodePresetStatus = vi.fn(async () => []);
vi.mock('./specDecodeModels.js', () => ({
  getSpecDecodePresetStatus: (...args) => getSpecDecodePresetStatus(...args),
}));

// The managed-backend listing carries its own "empty vs unreadable" sentinel
// (`{ models, error }`), so these tests drive that shape directly rather than
// re-deriving it from a manager error getter. Its composition is covered in
// localLlm.test.js.
const listManagedBackendModels = vi.fn();
const managedModels = (models, error = null) => ({ models, error });
vi.mock('./localLlm.js', () => ({
  listManagedBackendModels: (...args) => listManagedBackendModels(...args),
}));

const getLoadedModels = vi.fn();
const ollamaVersion = vi.fn(async () => '0.0.0-test');
// Ollama's tuning knobs are daemon environment, so applying one restarts the
// daemon. Default to "it worked" and let a test override to assert the refusal path.
const restartOllamaWithEnv = vi.fn(async () => ({ applied: true, reason: 'restarted' }));
vi.mock('./ollamaManager.js', () => ({
  getLoadedModels: (...args) => getLoadedModels(...args),
  // Recorded with each assessment so a backend UPDATE can later be detected as
  // staleness — see localModelAssessmentStore.captureEnvironment.
  getVersion: (...args) => ollamaVersion(...args),
  restartWithEnv: (...args) => restartOllamaWithEnv(...args),
}));

// LM Studio's knobs are load-time, so applying one reloads the model via `lms load`.
const loadLmStudioModelWithArgs = vi.fn(async () => ({ success: true }));
vi.mock('./lmStudioManager.js', () => ({
  loadModelWithArgs: (...args) => loadLmStudioModelWithArgs(...args),
}));

// A fixed, generous memory budget so the memory axis is deterministic.
vi.mock('./localMemory.js', () => ({ getAvailableMemoryGb: async () => 64 }));

const svc = await import('./localModelAssessments.js');
// The durable store is a separate module (no path to a provider); the read-only
// projections the catalog badge consumes live there.
const store = await import('./localModelAssessmentStore.js');
// Dynamic, like the two above: a static import hoists ABOVE the fileUtils mock,
// and this module resolves its claim path from `PATHS.data` at load time.
const { claimHeavyLocalJob } = await import('../lib/heavyJobClaim.js');
const { TUNING_SPECS, tuningSpecsFor } = await import('../lib/localModelTuning.js');

const STORE = join(tempRoot, 'local-llm', 'assessments.json');

const okRun = (chars = 40, charsPerSecond = 120, ttftMs = 250) => ({
  text: 'The answer is 4.',
  timings: { charsPerSecond, ttftMs, totalMs: 800, chars },
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(tempRoot, 'local-llm'), { recursive: true, force: true });
  runLocalLlmTest.mockReset();
  listManagedBackendModels.mockReset().mockResolvedValue(managedModels([{ id: 'example-model:7b', params: '7B' }]));
  getLoadedModels.mockReset().mockResolvedValue([{ id: 'example-model:7b', name: 'example-model:7b', size: 5 * 2 ** 30 }]);
  runEndpointLlmTest.mockReset();
  probeOpenAiModels.mockReset().mockResolvedValue({ reachable: true, models: [], error: null });
  getLlamaServerEndpoint.mockReset().mockResolvedValue('http://127.0.0.1:5568/v1');
  getAllProviders.mockReset().mockResolvedValue([]);
  // Mirrors each manager's real contract: an EMPTY request asks the daemon to
  // drop a tuning PortOS applied, and reports "nothing needed to change" when it
  // is already untuned. A flat `applied: true` here would let an untuned run
  // record the very claim `lib/localModelTuning.js` forbids.
  const empty = (v) => !v || (Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0);
  relaunchLlamaServerWithTuning.mockReset().mockImplementation(async (tuning) => (empty(tuning)
    ? { applied: null, reason: null, config: null }
    : { applied: true, reason: null, config: null }));
  restartOllamaWithEnv.mockReset().mockImplementation(async (env) => (empty(env)
    ? { applied: null, reason: 'already-untuned' }
    : { applied: true, reason: 'restarted' }));
  loadLmStudioModelWithArgs.mockReset().mockImplementation(async (_modelId, args) => (empty(args)
    ? { success: true, unchanged: true }
    : { success: true }));
  getMtplxServerEndpoint.mockReset().mockResolvedValue('http://127.0.0.1:8000/v1');
  relaunchMtplxServerWithTuning.mockReset().mockResolvedValue({ applied: true, reason: null, config: null });
});

describe('buildSamplePrompt', () => {
  it('scales the filler to the requested nominal context', () => {
    const small = svc.buildSamplePrompt(512);
    const large = svc.buildSamplePrompt(4096);
    expect(large.length).toBeGreaterThan(small.length * 4);
  });

  it('always ends with the question, so a model that ignores the filler still answers', () => {
    expect(svc.buildSamplePrompt(512).trimEnd()).toMatch(/what is 2 \+ 2\?/i);
  });

  it('uses distinct filler lines so a prefix cache cannot fake a cheap long prompt', () => {
    const prompt = svc.buildSamplePrompt(1024);
    expect(prompt).toContain('Reference item 1:');
    expect(prompt).toContain('Reference item 2:');
  });
});

describe('toSample', () => {
  it('records timings from a successful run', () => {
    expect(svc.toSample(512, okRun())).toMatchObject({
      contextTokens: 512, ok: true, charsPerSecond: 120, ttftMs: 250, totalMs: 800, error: null,
    });
  });

  it('treats an empty-text run as a FAILURE, not a zero-throughput success', () => {
    // runLocalLlmTest resolves rather than throwing on timeout, so an
    // error-free empty result is the shape a timed-out run actually takes.
    // Recording it as ok would feed a fabricated 0 into the speed average.
    const sample = svc.toSample(512, { text: '', timings: { totalMs: 120000 } });
    expect(sample.ok).toBe(false);
    expect(sample.charsPerSecond).toBeNull();
    expect(sample.error).toBe('model produced no output');
  });

  it('keeps the backend error verbatim', () => {
    expect(svc.toSample(512, { text: '', error: 'model requires more system memory' }).error)
      .toBe('model requires more system memory');
  });
});

describe('captureEnvironment', () => {
  it('records hardware shape without any machine identity', async () => {
    const env = await svc.captureEnvironment();
    expect(env).toHaveProperty('platform');
    expect(env).toHaveProperty('arch');
    expect(env.totalMemoryGb).toBeGreaterThan(0);
    expect(env.memoryBudgetGb).toBeGreaterThan(0);
    // Privacy: assessments end up in bug reports, so the record must never
    // carry a hostname, username, or path.
    const keys = Object.keys(env);
    expect(keys).not.toContain('hostname');
    expect(keys).not.toContain('username');
    for (const value of Object.values(env)) {
      if (typeof value === 'string') expect(value).not.toContain('/');
    }
  });
});

describe('loadAssessments / getAssessmentReport (read path)', () => {
  it('never calls a provider', async () => {
    await svc.loadAssessments();
    await svc.getAssessmentReport();
    // The AI Provider Usage Policy boundary: a read must be safe from boot,
    // from a poll, from anywhere.
    expect(runLocalLlmTest).not.toHaveBeenCalled();
  });

  it('reports an empty store as empty, with no read error', async () => {
    expect(await svc.loadAssessments()).toEqual([]);
    expect((await svc.getAssessmentReport()).readError).toBeNull();
  });

  it('lists installed-but-unmeasured models without ranking or penalizing them', async () => {
    const report = await svc.getAssessmentReport();
    expect(report.ranked).toEqual([]);
    expect(report.unassessed).toContainEqual({ backend: 'ollama', modelId: 'example-model:7b', params: '7B' });
  });

  // An embedding model has no chat/generation to measure, so it is not an
  // unanswered question — listing it here offered a Measure button that could
  // only ever spend a provider call to prove it fails.
  it('leaves embedding models out of the not-yet-measured list', async () => {
    listManagedBackendModels.mockImplementation(async (backend) => managedModels(backend === 'ollama'
      ? [{ id: 'example-model:7b', params: '7B' }, { id: 'all-minilm:latest' }, { id: 'nomic-embed-text:latest' }]
      : []));
    const report = await svc.getAssessmentReport();
    expect(report.unassessed.map((u) => u.modelId)).toEqual(['example-model:7b']);
    // ...and the consent gate's counts follow, since they derive from the same list.
    expect(report.sweepScopes.unmeasured).toBe(1);
  });

  // The backend's own capability metadata outranks the name heuristic in both
  // directions, so a chat model that merely LOOKS like an embedding one stays.
  it('keeps a model the backend reports as chat-capable', async () => {
    listManagedBackendModels.mockImplementation(async (backend) => managedModels(backend === 'ollama'
      ? [{ id: 'all-minilm:latest', capabilities: ['completion'] }]
      : []));
    const report = await svc.getAssessmentReport();
    expect(report.unassessed.map((u) => u.modelId)).toEqual(['all-minilm:latest']);
  });

  it('flags a backend whose model list could not be read, even though it returned []', async () => {
    // Both managers cache an EMPTY list on a failed read instead of throwing, so
    // the accompanying `error` is the only signal that separates "no models
    // installed" from "the list could not be read".
    listManagedBackendModels.mockImplementation(async (backend) => (backend === 'lmstudio'
      ? managedModels([], 'LM Studio is unavailable')
      : managedModels([{ id: 'example-model:7b', params: '7B' }])));
    const report = await svc.getAssessmentReport();
    expect(report.listErrors).toEqual(['lmstudio']);
  });

  it('still flags a backend when the model list throws outright', async () => {
    listManagedBackendModels.mockImplementation(async (backend) => (backend === 'ollama'
      ? managedModels(null, 'Ollama unreachable')
      : managedModels([])));
    expect((await svc.getAssessmentReport()).listErrors).toEqual(['ollama']);
  });

  it('falls back to the balanced intent for an unrecognized one', async () => {
    expect((await svc.getAssessmentReport({ intent: 'nonsense' })).intent).toBe('balanced');
  });

  it('leaves embedding-only models out of the measurable list', async () => {
    // They serve /api/embed, never /api/chat, so the benchmark sample comes back
    // `400 "<model>" does not support chat` — a failed run that also fires the
    // provider-failure hook and files a CoS investigation task. Offering a
    // Measure button for one, or sweeping it, is work that cannot succeed.
    listManagedBackendModels.mockImplementation(async (backend) => managedModels(backend === 'ollama'
      ? [{ id: 'example-model:7b', params: '7B' }, { id: 'nomic-embed-text:latest', params: '137M' }]
      : []));
    const report = await svc.getAssessmentReport();
    expect(report.unassessed.map((u) => u.modelId)).toEqual(['example-model:7b']);
    // Still counted as installed — the runtime really does serve it, and the
    // count is about the catalog, not about what a benchmark can measure.
    expect(report.runtimes.find((r) => r.id === 'ollama').modelCount).toBe(2);
  });
});

describe('runAssessment — machine-wide accelerator claim', () => {
  // A measurement is only valid if it had the machine to itself, so this is
  // enforced in the SERVICE, not by a disabled button: a second tab, ⌘K, or curl
  // has to hit the same wall. Refusing beats recording a corrupt reading.
  it('refuses when another heavy local job already holds the machine', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const held = await claimHeavyLocalJob({ kind: 'LoRA training', id: 'run-1' });
    expect(held.ok).toBe(true);
    try {
      await expect(svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] }))
        .rejects.toMatchObject({ code: 'HEAVY_LOCAL_JOB_BUSY' });
      // Nothing was measured, so nothing was recorded.
      expect(runLocalLlmTest).not.toHaveBeenCalled();
    } finally {
      await held.release();
    }
  });

  // The claim wait does not observe the abort signal, so a run cancelled WHILE
  // waiting would otherwise wake up and measure — relaunching llama-server under
  // the abandoned run's tuning and holding the machine against its replacement.
  it('does not measure a run that was cancelled while waiting for the claim', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const controller = new AbortController();
    controller.abort();

    const result = await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(relaunchLlamaServerWithTuning).not.toHaveBeenCalled();
    // Nothing measured means nothing recorded.
    expect(await svc.loadAssessments()).toEqual([]);
    // ...and the claim went back, so the replacement sweep can start.
    const after = await claimHeavyLocalJob({ kind: 'probe', id: 'after-cancel' });
    expect(after.ok).toBe(true);
    await after.release();
  });

  it('releases the claim afterwards, so the next measurement can run', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    const after = await claimHeavyLocalJob({ kind: 'probe', id: 'after' });
    expect(after.ok).toBe(true);
    await after.release();
  });

  it('releases the claim even when the run throws', async () => {
    // A relaunch failure escapes before any sample runs; a leaked claim would
    // wedge every local render on the machine until the process exited.
    relaunchLlamaServerWithTuning.mockRejectedValueOnce(new Error('boom'));
    getLlamaServerEndpoint.mockResolvedValue(null);
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512], tuning: { ubatchSize: 512 } })
      .catch(() => null);
    const after = await claimHeavyLocalJob({ kind: 'probe', id: 'after-throw' });
    expect(after.ok).toBe(true);
    await after.release();
  });
});

describe('runAssessment — embedding models are not assessable', () => {
  // An assessment measures a model by GENERATING with it. Ollama answers every
  // sample aimed at an embedding-only model with
  // `400 "<model>" does not support chat`, so the run is doomed by the model id
  // alone — and each doomed sample raised an AI-provider investigation task.
  // `selectSweepTargets` keeps these out of a sweep; this covers the direct
  // `POST /api/local-llm/assessments/run` route, which never goes through it.
  it('refuses before claiming the machine or calling a provider', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await expect(svc.runAssessment({ backend: 'ollama', modelId: 'all-minilm:latest', contextTokens: [512] }))
      .rejects.toMatchObject({ code: 'MODEL_NOT_ASSESSABLE', status: 400 });
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    // Nothing recorded — a stored `incompatible` reading would read as "this
    // machine cannot run it", which is not what happened.
    expect(await svc.loadAssessments()).toEqual([]);
    // ...and the machine claim was never taken, so the next job can start.
    const after = await claimHeavyLocalJob({ kind: 'probe', id: 'after-embed' });
    expect(after.ok).toBe(true);
    await after.release();
  });

  it('still measures a generation model whose id merely looks unusual', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect(result.verdict).toBe('fits');
  });
});

describe('runAssessment', () => {
  it('refuses an embedding-only model before claiming the machine', async () => {
    // Reaching here means a direct API call or a stale page — the report already
    // keeps embedding models out of `unassessed`. Every sample would come back
    // `400 "<model>" does not support chat`, which is not a verdict about this
    // machine, so fail fast with a reason instead of recording one.
    await expect(svc.runAssessment({ backend: 'ollama', modelId: 'nomic-embed-text:latest', contextTokens: [512] }))
      .rejects.toMatchObject({ code: 'MODEL_NOT_ASSESSABLE', status: 400 });
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(await svc.loadAssessments()).toEqual([]);
    // The claim was never taken, so the next measurement can start immediately.
    const after = await claimHeavyLocalJob({ kind: 'probe', id: 'after-embed-refusal' });
    expect(after.ok).toBe(true);
    await after.release();
  });

  it('samples every context in ascending order and persists the result', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [4096, 512] });

    expect(runLocalLlmTest.mock.calls.map((c) => c[0].prompt.length))
      .toEqual([...runLocalLlmTest.mock.calls.map((c) => c[0].prompt.length)].sort((a, b) => a - b));
    expect(result.verdict).toBe('fits');
    expect(result.samples.map((s) => s.contextTokens)).toEqual([512, 4096]);
    expect(existsSync(STORE)).toBe(true);
    expect((await svc.loadAssessments())[0].modelId).toBe('example-model:7b');
  });

  it('stops after a resource failure instead of burning minutes on larger contexts', async () => {
    runLocalLlmTest
      .mockResolvedValueOnce(okRun())
      .mockResolvedValueOnce({ text: '', error: 'model requires more system memory' })
      .mockResolvedValue(okRun());

    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096, 16384] });
    expect(runLocalLlmTest).toHaveBeenCalledTimes(2);
    // A smaller context worked, so the model DOES fit — the largest working
    // context is what carries the nuance.
    expect(result.verdict).toBe('fits');
    expect(result.performance.maxWorkingContextTokens).toBe(512);
  });

  it('records does-not-fit when every context exhausted memory', async () => {
    runLocalLlmTest.mockResolvedValue({ text: '', error: 'out of memory' });
    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096] });
    expect(result.verdict).toBe('does-not-fit');
    expect(result.verdictReason).toBe('out of memory');
    expect(result.residentGb).toBeNull();
  });

  it('turns a pre-stream throw into a recorded sample rather than losing the whole run', async () => {
    // runLocalLlmTest throws (not resolves) when the provider is unconfigured.
    // Letting that escape would abort the assessment with zero evidence.
    runLocalLlmTest.mockRejectedValue(new Error('Local provider "ollama" is not configured'));
    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect(result.samples).toHaveLength(1);
    expect(result.samples[0].error).toMatch(/not configured/);
    // Not attributable to hardware — must not become a permanent does-not-fit.
    expect(result.verdict).toBe('unknown');
  });

  it('records resident size for Ollama and null for LM Studio, which does not report one', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const ollama = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect(ollama.residentGb).toBe(5);

    const lmstudio = await svc.runAssessment({ backend: 'lmstudio', modelId: 'example-model:7b', contextTokens: [512] });
    // Copying the weight-file size here would silently re-introduce the estimate
    // this feature exists to replace.
    expect(lmstudio.residentGb).toBeNull();
  });

  it('replaces the previous measurement for the same model rather than accumulating', async () => {
    runLocalLlmTest.mockResolvedValue(okRun(40, 100));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    runLocalLlmTest.mockResolvedValue(okRun(40, 200));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    const stored = await svc.loadAssessments();
    expect(stored).toHaveLength(1);
    expect(stored[0].performance.meanCharsPerSecond).toBe(200);
  });

  it('keeps separate records per backend for the same model id', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    await svc.runAssessment({ backend: 'lmstudio', modelId: 'example-model:7b', contextTokens: [512] });
    expect(await svc.loadAssessments()).toHaveLength(2);
  });

  it('de-duplicates and sorts the requested context list', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [4096, 512, 4096] });
    expect(result.samples.map((s) => s.contextTokens)).toEqual([512, 4096]);
  });

  it('honors an already-aborted signal without calling the provider', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], signal: controller.signal,
    });
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(result.verdict).toBe('unknown');
  });

  it('feeds the ranking once evidence exists', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096] });
    const report = await svc.getAssessmentReport({ intent: 'fastest' });
    expect(report.ranked.map((r) => r.modelId)).toEqual(['example-model:7b']);
    // The stub lists the same model under both backends, so only the ollama
    // copy leaves the unassessed list — assessments are per (backend, model).
    expect(report.unassessed).toEqual([{ backend: 'lmstudio', modelId: 'example-model:7b', params: '7B' }]);
  });
});

describe('uninstalled models', () => {
  it('stops recommending a model the user has since deleted', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096] });

    listManagedBackendModels.mockResolvedValue(managedModels([]));
    const report = await svc.getAssessmentReport();
    // It can no longer run, so it must not be ranked — but the measurement stays
    // on disk so a re-install doesn't cost another run.
    expect(report.ranked).toEqual([]);
    expect(report.uninstalled).toContainEqual({ backend: 'ollama', modelId: 'example-model:7b', tuningLabel: null });
    expect(report.assessments).toHaveLength(1);
  });

  it('keeps recommending when the backend list is UNTRUSTWORTHY rather than wiping it', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096] });

    // An unreadable list returning [] must not be read as "everything was
    // uninstalled" — that is the same failed-read-as-empty mistake.
    listManagedBackendModels.mockResolvedValue(managedModels([], 'Ollama is unavailable'));
    const report = await svc.getAssessmentReport();
    expect(report.ranked.map((r) => r.modelId)).toEqual(['example-model:7b']);
    expect(report.uninstalled).toEqual([]);
  });
});

describe('cancellation', () => {
  it('does not persist a run the client aborted mid-way', async () => {
    // runLocalLlmTest turns a client disconnect into the same "Timed out" result
    // a real resource failure produces. Persisting it would record the user
    // closing the tab as `does-not-fit`.
    const controller = new AbortController();
    runLocalLlmTest.mockImplementation(async () => {
      controller.abort();
      return { text: '', error: 'Timed out after 120000ms' };
    });

    const result = await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096], signal: controller.signal,
    });
    expect(result.cancelled).toBe(true);
    expect(await svc.loadAssessments()).toEqual([]);
  });

  it('leaves an earlier measurement intact when a re-run is cancelled', async () => {
    runLocalLlmTest.mockResolvedValue(okRun(40, 150));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    const controller = new AbortController();
    controller.abort();
    await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], signal: controller.signal,
    });

    const stored = await svc.loadAssessments();
    expect(stored).toHaveLength(1);
    expect(stored[0].performance.meanCharsPerSecond).toBe(150);
  });
});

describe('an unreadable store', () => {
  const corrupt = () => {
    mkdirSync(join(tempRoot, 'local-llm'), { recursive: true });
    writeFileSync(STORE, '{ this is not json');
  };

  it('reports the read error instead of claiming nothing was assessed', async () => {
    corrupt();
    expect((await svc.getAssessmentReport()).readError).toBeTruthy();
  });

  it('parks the bad file rather than overwriting it with a single new record', async () => {
    corrupt();
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    // Writing straight through would have replaced whatever the old file held
    // with just this record — a read failure destroying minutes of measured
    // compute. The old bytes survive alongside a fresh, working store.
    const parked = readdirSync(join(tempRoot, 'local-llm')).filter((f) => f.includes('.corrupt-'));
    expect(parked).toHaveLength(1);
    expect(await svc.loadAssessments()).toHaveLength(1);
  });

  it('refuses to rewrite the file on a delete it cannot read', async () => {
    corrupt();
    expect(await svc.deleteAssessment('ollama', 'example-model:7b')).toEqual({ deleted: false });
    expect(existsSync(STORE)).toBe(true);
  });
});

describe('deleteAssessment', () => {
  it('removes a record and reports that it did', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect(await svc.deleteAssessment('ollama', 'example-model:7b')).toEqual({ deleted: true });
    expect(await svc.loadAssessments()).toEqual([]);
  });

  it('reports a miss rather than a phantom success', async () => {
    expect(await svc.deleteAssessment('ollama', 'example-model:404')).toEqual({ deleted: false });
  });
});

describe('progress streaming', () => {
  it('reports each sample as it lands, then one terminal complete frame', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const frames = [];
    await svc.runAssessment({
      backend: 'ollama',
      modelId: 'example-model:7b',
      contextTokens: [512, 4096],
      onProgress: (frame) => frames.push(frame),
    });

    // Every frame carries enough to be correlated on a channel shared with
    // model pulls and migrations.
    expect(frames.every((f) => f.scope === 'assessment' && f.backend === 'ollama' && f.modelId === 'example-model:7b')).toBe(true);
    expect(frames.filter((f) => f.event === 'complete')).toHaveLength(1);
    expect(frames.at(-1)).toMatchObject({ event: 'complete', verdict: 'fits' });
    // Per-sample: one "about to run" and one "here is what it measured" each.
    const withContext = frames.filter((f) => f.contextTokens);
    expect(withContext.map((f) => f.contextTokens)).toEqual([512, 512, 4096, 4096]);
    expect(withContext.every((f) => f.sampleCount === 2)).toBe(true);
  });

  it('emits a terminal frame for a cancelled run so a listener never hangs', async () => {
    const controller = new AbortController();
    runLocalLlmTest.mockImplementation(async () => { controller.abort(); return okRun(); });
    const frames = [];
    await svc.runAssessment({
      backend: 'ollama',
      modelId: 'example-model:7b',
      contextTokens: [512],
      signal: controller.signal,
      onProgress: (frame) => frames.push(frame),
    });
    expect(frames.at(-1)).toMatchObject({ event: 'complete', cancelled: true });
  });

  it('does not let a broken progress listener abort the measurement', async () => {
    // The listener runs outside the request error path; a throw there must not
    // cost the user the minutes of compute already spent.
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'ollama',
      modelId: 'example-model:7b',
      contextTokens: [512],
      onProgress: () => { throw new Error('listener exploded'); },
    });
    expect(result.verdict).toBe('fits');
  });
});

describe('staleness', () => {
  it('flags a stored reading taken on a different machine state', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    // Rewrite the recorded environment as if the box had half the RAM then.
    const store = JSON.parse(readFileSync(STORE, 'utf8'));
    store.assessments[0].environment.totalMemoryGb = 1;
    writeFileSync(STORE, JSON.stringify(store));

    const report = await svc.getAssessmentReport({});
    expect(report.assessments[0].staleness.stale).toBe(true);
    expect(report.assessments[0].staleness.description).toMatch(/installed memory/i);
    // And it travels with the ranked entry, so the panel doesn't recompute it.
    expect(report.ranked[0].staleness.stale).toBe(true);
  });

  it('does not flag a reading taken on the machine as it is now', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    const report = await svc.getAssessmentReport({});
    expect(report.assessments[0].staleness.stale).toBe(false);
    expect(report.liveEnvironments.ollama.platform).toBe(process.platform);
  });
});

describe('getMeasuredFits', () => {
  it('projects a stored assessment into the catalog fit vocabulary', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    const fits = await store.getMeasuredFits('ollama');
    expect(fits['example-model:7b']).toMatchObject({
      fit: 'comfortable', verdict: 'fits', stale: false, meanCharsPerSecond: 120, residentGb: 5,
    });
    // Scoped to the backend — an Ollama measurement says nothing about LM Studio.
    expect(await store.getMeasuredFits('lmstudio')).toEqual({});
  });

  it('returns an empty map when nothing has been measured', async () => {
    expect(await store.getMeasuredFits('ollama')).toEqual({});
  });

  it('marks a reading from a different machine state stale rather than hiding it', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    const raw = JSON.parse(readFileSync(STORE, 'utf8'));
    raw.assessments[0].environment.cpuCount = 1;
    writeFileSync(STORE, JSON.stringify(raw));

    const fits = await store.getMeasuredFits('ollama');
    expect(fits['example-model:7b'].stale).toBe(true);
    expect(fits['example-model:7b'].staleReason).toMatch(/CPU count/i);
  });
});

describe('backend-version staleness on the read paths', () => {
  beforeEach(() => store.__resetBackendVersionCache());

  it('marks a measurement stale after the backend is updated under it', async () => {
    ollamaVersion.mockResolvedValue('0.1.0');
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect((await store.getMeasuredFits('ollama'))['example-model:7b'].stale).toBe(false);

    store.__resetBackendVersionCache();
    ollamaVersion.mockResolvedValue('0.2.0');
    const fits = await store.getMeasuredFits('ollama');
    expect(fits['example-model:7b'].stale).toBe(true);
    expect(fits['example-model:7b'].staleReason).toMatch(/backend version 0\.1\.0 → 0\.2\.0/);
  });

  it('probes the version at most once per cache window, not once per keystroke', async () => {
    // The catalog path calls this on every debounced keystroke; an unconditional
    // probe there would be one loopback GET per character typed.
    ollamaVersion.mockClear();
    await store.getMeasuredFits('ollama');
    await store.getMeasuredFits('ollama');
    await store.getMeasuredFits('ollama');
    expect(ollamaVersion).toHaveBeenCalledTimes(1);
  });

  it('does not re-probe a backend that is down — null is a fetched answer', async () => {
    store.__resetBackendVersionCache();
    ollamaVersion.mockClear().mockResolvedValue(null);
    await store.getMeasuredFits('ollama');
    await store.getMeasuredFits('ollama');
    expect(ollamaVersion).toHaveBeenCalledTimes(1);
  });

  it('never probes for LM Studio, which reports no version at all', async () => {
    store.__resetBackendVersionCache();
    ollamaVersion.mockClear();
    await store.getMeasuredFits('lmstudio');
    expect(ollamaVersion).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Endpoint runtimes (llama.cpp / MTPLX / vLLM) and launch tuning
// ---------------------------------------------------------------------------

describe('endpoint runtimes', () => {
  it('lists a bare daemon\'s models from GET /v1/models, with no params to guess from', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    const result = await svc.listRuntimeModels('mtplx');
    expect(result).toEqual({ models: [{ id: 'dflash', params: null, quantization: null }], error: null });
  });

  // A stopped daemon has no catalog on disk to fall back to, so "unreachable"
  // must surface as an ERROR. Reported as an empty list it would silently hide
  // every model behind a daemon the user only needs to start.
  it('reports an unreachable daemon as an error, never as an empty catalog', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: false, models: null, error: 'ECONNREFUSED' });
    const result = await svc.listRuntimeModels('vllm');
    expect(result.models).toBeNull();
    expect(result.error).toMatch(/not reachable/);
  });

  it('reads llama.cpp\'s endpoint from the running server, not from the default port', async () => {
    getLlamaServerEndpoint.mockResolvedValue('http://127.0.0.1:9999/v1');
    expect(await svc.runtimeEndpoint('llama')).toBe('http://127.0.0.1:9999/v1');
  });

  it('falls back to the canonical base URL when llama-server cannot be reached', async () => {
    getLlamaServerEndpoint.mockRejectedValue(new Error('pm2 is not installed'));
    expect(await svc.runtimeEndpoint('llama')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  });

  // The read path runs on every Performance page load. `getLlamaServerStatus`
  // costs a network probe plus an `execPm2 logs` subprocess whose output this
  // caller would throw away.
  it('resolves the endpoint without paying for a status probe', async () => {
    await svc.getAssessmentReport();
    expect(getLlamaServerEndpoint).toHaveBeenCalled();
  });

  it('measures an endpoint runtime directly instead of through the provider path', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({ backend: 'mtplx', modelId: 'dflash', contextTokens: [512] });
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(runEndpointLlmTest).toHaveBeenCalledWith(expect.objectContaining({ runtime: 'mtplx', modelId: 'dflash' }));
    expect(result.verdict).toBe('fits');
    expect(result.endpoint).toBeTruthy();
  });

  // Only Ollama's /api/ps reports a footprint. Copying a weight-file size in
  // would re-introduce the estimate this whole feature exists to replace.
  it('records no resident footprint for a runtime that reports none', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512] });
    expect(result.residentGb).toBeNull();
  });
});

// The refusal in `applyLaunchTuning` catches a runtime with NO applier. This
// catches the sharper case: a runtime WITH one, whose catalog declares a knob
// that applier's transport cannot carry. Nothing fails at runtime there — the
// relaunch runs, `tuningApplied: true` is recorded, and the knob is dropped on
// the way to the launch line, which is exactly the un-applied-but-claimed
// reading the catalog exists to prevent.
describe('launch transports', () => {
  it('carries every launch knob each runtime with an applier declares', () => {
    for (const [runtime, transport] of Object.entries(svc.LAUNCH_TRANSPORTS)) {
      expect(transport, `${runtime} applier declares no transport`).toBeTruthy();
      for (const spec of tuningSpecsFor(runtime)) {
        if (spec.applies !== 'launch') continue;
        expect(spec[transport], `${runtime}/${spec.id} is not a \`${transport}\` knob`).toBeTruthy();
      }
    }
  });

  // The mirror: a runtime that declares launch knobs but has no applier would
  // offer a form whose every field is refused at run time.
  it('gives every runtime that declares a launch knob an applier to apply it', () => {
    for (const [runtime, specs] of Object.entries(TUNING_SPECS)) {
      if (!specs.some((spec) => spec.applies === 'launch')) continue;
      expect(svc.LAUNCH_TRANSPORTS, `${runtime} declares launch knobs`).toHaveProperty(runtime);
    }
  });
});

describe('tuning', () => {
  it('keeps two tunings of one model as two records rather than overwriting', async () => {
    runLocalLlmTest.mockResolvedValue(okRun(40, 120));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    const stored = await svc.loadAssessments();
    expect(stored).toHaveLength(2);
    expect(stored.map((a) => a.tuningKey).sort()).toEqual(['', 'numCtx=8192']);
  });

  it('re-running the SAME tuning replaces that record, not the untuned one', async () => {
    runLocalLlmTest.mockResolvedValue(okRun(40, 120));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    expect(await svc.loadAssessments()).toHaveLength(2);
  });

  // Ollama's OpenAI-compatible endpoint drops unknown body fields, so the only
  // spelling of a context window is the daemon's environment. Sending one in the
  // body would look applied and change nothing.
  it('restarts Ollama with the tuning env instead of putting it in the request body', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192, flashAttention: true },
    });
    expect(restartOllamaWithEnv).toHaveBeenCalledWith({ OLLAMA_CONTEXT_LENGTH: '8192', OLLAMA_FLASH_ATTENTION: '1' });
    expect(runLocalLlmTest).toHaveBeenCalledWith(expect.objectContaining({ extraBody: {} }));
    expect(result.tuningApplied).toBe(true);
  });

  it('records the reason when Ollama could not be restarted with the tuning', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    restartOllamaWithEnv.mockResolvedValueOnce({ applied: false, reason: 'stop-failed', error: 'Ollama would not stop' });
    const result = await svc.runAssessment({
      backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 },
    });
    expect(result.tuningApplied).toBe(false);
    expect(result.tuningNotApplied).toBe('Ollama would not stop');
  });

  // LM Studio picks context/offload/parallelism when the model LOADS, so a tuned
  // reading has to reload it through `lms load` first.
  it('reloads the LM Studio model with the tuning flags', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'lmstudio', modelId: 'example-model:7b', contextTokens: [512], tuning: { contextLength: 8192, gpuOffload: 0.5 },
    });
    expect(loadLmStudioModelWithArgs).toHaveBeenCalledWith('example-model:7b', ['--context-length', '8192', '--gpu', '0.5']);
    expect(result.tuningApplied).toBe(true);
    expect(result.tuningLabel).toBe('Context length 8k · GPU offload 0.5');
  });

  it('records the reason when LM Studio refused the tuned load', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    loadLmStudioModelWithArgs.mockResolvedValueOnce({ success: false, error: 'Model does not fit at that context length' });
    const result = await svc.runAssessment({
      backend: 'lmstudio', modelId: 'example-model:7b', contextTokens: [512], tuning: { contextLength: 1048576 },
    });
    expect(result.tuningApplied).toBe(false);
    expect(result.tuningNotApplied).toBe('Model does not fit at that context length');
  });

  it('puts llama.cpp launch knobs on the command line before the first sample', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'llama', modelId: 'dflash', contextTokens: [512], tuning: { ubatchSize: 512 },
    });
    expect(relaunchLlamaServerWithTuning).toHaveBeenCalledWith({ ubatchSize: 512 }, { reset: false });
    expect(result.tuningApplied).toBe(true);
    expect(result.tuningLabel).toBe('Micro-batch size 512');
  });

  // A reading taken under a tuning PortOS could NOT apply describes some other
  // configuration. Recording it as evidence for the requested tuning would be
  // the same lie as a fabricated measurement.
  it('records that a launch tuning was not applied, with the reason', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    relaunchLlamaServerWithTuning.mockResolvedValue({ applied: false, reason: 'llama-server is not running', config: null });
    const result = await svc.runAssessment({
      backend: 'llama', modelId: 'dflash', contextTokens: [512], tuning: { ubatchSize: 512 },
    });
    expect(result.tuningApplied).toBe(false);
    expect(result.tuningNotApplied).toBe('llama-server is not running');
  });

  // An untuned run applied nothing — `true` there is the exact claim
  // lib/localModelTuning.js forbids, and `false` would imply something went
  // wrong. `null` is the honest answer.
  it('records tuningApplied as null when there was nothing to apply', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    const untuned = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    expect(untuned.tuningApplied).toBeNull();
    expect(untuned.tuningNotApplied).toBeNull();
  });

  // The bug this covers: an untuned run took the no-applier branch, so a daemon
  // the PREVIOUS run tuned kept serving under that tuning while the reading was
  // stored with `tuningKey: ''` and rendered as "Backend defaults". Every applier
  // that CAN reset has to be asked to.
  it.each([
    ['ollama', () => restartOllamaWithEnv, (m) => expect(m).toHaveBeenCalledWith({})],
    ['llama', () => relaunchLlamaServerWithTuning, (m) => expect(m).toHaveBeenCalledWith({}, { reset: false })],
    ['lmstudio', () => loadLmStudioModelWithArgs, (m) => expect(m).toHaveBeenCalledWith('a-model', [])],
  ])('asks the %s applier to drop any tuning still on the daemon for an untuned run', async (backend, getMock, assertCall) => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['a-model'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    runLocalLlmTest.mockResolvedValue(okRun());

    const result = await svc.runAssessment({ backend, modelId: 'a-model', contextTokens: [512] });

    assertCall(getMock());
    expect(result.tuningKey).toBe('');
  });

  // A daemon that could NOT be put back on its defaults is measuring some other
  // configuration, and the record has to say so rather than call it a baseline.
  it('records that an untuned run could not clear the tuning still on the daemon', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    restartOllamaWithEnv.mockResolvedValue({ applied: false, reason: 'stop-failed', error: 'Ollama would not stop' });

    const result = await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });

    expect(result.tuningKey).toBe('');
    expect(result.tuningApplied).toBe(false);
    expect(result.tuningNotApplied).toBe('Ollama would not stop');
  });

  // A runtime with no launch path must not silently swallow a knob: the catalog
  // offers none for vLLM (a container from the shipped compose stack), and if
  // one is ever added without a transport the reading has to say so.
  it('refuses launch tuning for a runtime PortOS does not start', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['a-model'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'vllm', modelId: 'a-model', contextTokens: [512], tuning: { maxKvSize: 8192 },
    });
    // Not in the catalog, so it normalizes away entirely — no claim made.
    expect(result.tuningApplied).toBeNull();
    expect(result.tuningKey).toBe('');
  });

  it('relaunches `mtplx serve` to apply an MTPLX tuning', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['a-model'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    const result = await svc.runAssessment({
      backend: 'mtplx', modelId: 'a-model', contextTokens: [512], tuning: { depth: 5, kvQuant: 'q8' },
    });
    expect(relaunchMtplxServerWithTuning).toHaveBeenCalledWith({ depth: 5, kvQuant: 'q8' });
    expect(result.tuningApplied).toBe(true);
    expect(result.tuningKey).toBe('depth=5,kvQuant=q8');
  });

  // A launch line MTPLX rejects must not be filed as evidence FOR that tuning —
  // the manager puts the previous configuration back and says why, and the
  // reading has to carry the refusal rather than the claim.
  it('records an MTPLX tuning the daemon refused as not applied', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['a-model'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    relaunchMtplxServerWithTuning.mockResolvedValueOnce({
      applied: false, reason: 'MTPLX rejected that tuning: unrecognized arguments', config: null,
    });
    const result = await svc.runAssessment({
      backend: 'mtplx', modelId: 'a-model', contextTokens: [512], tuning: { contextWindow: 1048576 },
    });
    expect(result.tuningApplied).toBe(false);
    expect(result.tuningNotApplied).toMatch(/unrecognized arguments/);
  });

  // The user's launch flags live only in the running llama-server process, so an
  // ordinary measurement must never touch them. A reset is something a SWEEP
  // asks for, and only a sweep, because only a sweep puts the configuration back.
  it('never RESETS llama-server for an untuned run', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512] });
    // Asked to undo what PortOS applied, never to clear the user's own flags.
    expect(relaunchLlamaServerWithTuning).toHaveBeenCalledWith({}, { reset: false });
  });

  // The baseline variant of a tuning sweep: no knobs, which only means something
  // when the caller asked for a complete tuning.
  it('applies an empty tuning as a reset when the caller asked for one', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512], resetTuning: true });
    expect(relaunchLlamaServerWithTuning).toHaveBeenCalledWith({}, { reset: true });
  });

  // Only a runtime PortOS can reset AND put back may be swept — otherwise the
  // sweep leaves its knobs set for good and every later "backend defaults"
  // reading is taken under them (#4763).
  it('reports which runtimes a tuning sweep may drive', () => {
    expect(svc.isTuningSweepable('llama')).toBe(true);
    expect(svc.isTuningSweepable('ollama')).toBe(false);
    expect(svc.isTuningSweepable('lmstudio')).toBe(false);
    expect(svc.isTuningSweepable('mtplx')).toBe(false);
  });

  it('captures and restores nothing for a runtime with no launch state', async () => {
    expect(await svc.captureLaunchState('ollama')).toBeNull();
    expect(await svc.restoreLaunchState('ollama', null)).toEqual({ restored: false, reason: 'nothing to restore' });
  });

  it('deletes one tuning of a model and leaves the others', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    expect(await svc.deleteAssessment('ollama', 'example-model:7b', 'numCtx=8192')).toEqual({ deleted: true });
    const stored = await svc.loadAssessments();
    expect(stored.map((a) => a.tuningKey)).toEqual(['']);
  });

  it('reports which tuning won once a model has two measurements', async () => {
    runLocalLlmTest.mockResolvedValueOnce(okRun(40, 90)).mockResolvedValueOnce(okRun(40, 150));
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512] });
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    const report = await svc.getAssessmentReport();
    expect(report.tuningComparison).toHaveLength(1);
    expect(report.tuningComparison[0].best.label).toBe('Context size 8k');
  });

  // Once ONE tuning is measured the model is no longer an unanswered question.
  // Re-listing it under every un-run tuning would make the section unbounded.
  it('drops a model from "not yet measured" as soon as any tuning is recorded', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512], tuning: { numCtx: 8192 } });
    const report = await svc.getAssessmentReport();
    expect(report.unassessed.some((u) => u.backend === 'ollama')).toBe(false);
  });
});

describe('runtime roster', () => {
  it('reports every assessable runtime with its knob catalog', async () => {
    const report = await svc.getAssessmentReport();
    expect(report.runtimes.map((r) => r.id)).toEqual(['ollama', 'lmstudio', 'llama', 'mtplx', 'vllm', 'sglang', 'slotstream']);
    expect(report.runtimes.find((r) => r.id === 'llama').tuningSpecs.some((s) => s.id === 'ubatchSize')).toBe(true);
  });

  // `null` = the listing failed so the count is UNKNOWN; `0` = read, and this
  // runtime genuinely serves nothing. A UI must be able to tell them apart.
  it('reports an unknown model count as null and an empty one as 0', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: false, models: null, error: 'ECONNREFUSED' });
    const report = await svc.getAssessmentReport();
    expect(report.runtimes.find((r) => r.id === 'mtplx').modelCount).toBeNull();
    expect(report.runtimes.find((r) => r.id === 'ollama').modelCount).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// Key-gated runtimes, and evidence hygiene for a tuning that never landed
// ---------------------------------------------------------------------------

describe('key-gated runtimes', () => {
  // `vllmBacked` is the structural marker `localRuntimeKind` keys on — it
  // deliberately does NOT derive the backend from an editable name or endpoint.
  const vllmProvider = { id: 'vllm', name: 'vLLM', vllmBacked: true, endpoint: 'http://127.0.0.1:18020/v1', apiKey: 'secret-key' };

  // A vLLM container from the shipped compose stack sets VLLM_API_KEY and 401s
  // an unauthenticated request. Without the key the listing reads as
  // "unreadable" and every sample fails auth — recorded as a fit verdict.
  it('authenticates the model listing with the provider record\'s key', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [vllmProvider] });
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['qwen'], error: null });
    await svc.listRuntimeModels('vllm');
    expect(probeOpenAiModels).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ apiKey: 'secret-key' }));
  });

  it('authenticates the measurement with the same key', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [vllmProvider] });
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['qwen'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'vllm', modelId: 'qwen', contextTokens: [512] });
    expect(runEndpointLlmTest).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'secret-key' }));
  });

  // The usual loopback daemon is unauthenticated; attaching a key from an
  // unrelated provider would be worse than sending none.
  it('sends no key when no provider for that runtime carries one', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [{ id: 'ollama', ollamaBacked: true, endpoint: 'http://localhost:11434/v1', apiKey: 'not-mine' }] });
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: [], error: null });
    await svc.listRuntimeModels('mtplx');
    expect(probeOpenAiModels).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ apiKey: '' }));
  });
});

describe('unapplied tuning is not evidence', () => {
  const measureWithUnappliedTuning = async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun(40, 150));
    relaunchLlamaServerWithTuning.mockResolvedValue({ applied: false, reason: 'llama-server is not running', config: null });
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512], tuning: { ubatchSize: 512 } });
  };

  // The numbers describe the configuration that was ACTUALLY running. Ranking
  // them would recommend a tuning nobody measured.
  it('keeps the record but never ranks it', async () => {
    await measureWithUnappliedTuning();
    const report = await svc.getAssessmentReport();
    expect(report.assessments).toHaveLength(1);
    expect(report.ranked).toEqual([]);
    expect(report.excluded[0].reason).toMatch(/tuning was not applied/);
    expect(report.excluded[0].tuningKey).toBe('ubatchSize=512');
  });

  // Comparing it would credit the previous config's throughput to knobs that
  // never reached the daemon.
  it('never lets it win a tuning comparison', async () => {
    // A real, applied backend-defaults reading first — llama is an endpoint
    // runtime, so it measures through runEndpointLlmTest either way.
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun(40, 90));
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512] });
    // …then a faster one whose tuning never reached the daemon. Two records
    // exist, so the only thing stopping a comparison is the exclusion itself.
    await measureWithUnappliedTuning();
    expect(await svc.loadAssessments()).toHaveLength(2);
    const report = await svc.getAssessmentReport();
    expect(report.tuningComparison).toEqual([]);
  });

  it('still ranks a tuning that WAS applied', async () => {
    probeOpenAiModels.mockResolvedValue({ reachable: true, models: ['dflash'], error: null });
    runEndpointLlmTest.mockResolvedValue(okRun(40, 150));
    await svc.runAssessment({ backend: 'llama', modelId: 'dflash', contextTokens: [512], tuning: { ubatchSize: 512 } });
    const report = await svc.getAssessmentReport();
    expect(report.ranked.map((r) => r.tuningKey)).toEqual(['ubatchSize=512']);
  });
});
