/**
 * Assessment run + store behavior, driven against a real on-disk store with
 * `PATHS.data` re-rooted at a temp dir. The provider seam (`runLocalLlmTest`)
 * is the only thing stubbed — that is the boundary where a real LLM call would
 * otherwise happen, and stubbing it is what lets these tests assert the "never
 * call a provider from a read path" contract.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-local-assessment-');

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: tempRoot }));

const runLocalLlmTest = vi.fn();
vi.mock('./localLlmPlayground.js', () => ({ runLocalLlmTest: (...args) => runLocalLlmTest(...args) }));

const listModels = vi.fn();
vi.mock('./localLlm.js', () => ({ listModels: (...args) => listModels(...args) }));

const getLoadedModels = vi.fn();
const getOllamaListError = vi.fn();
vi.mock('./ollamaManager.js', () => ({
  getLoadedModels: (...args) => getLoadedModels(...args),
  getLastInstalledModelsError: () => getOllamaListError(),
}));

const getLmStudioListError = vi.fn();
vi.mock('./lmStudioManager.js', () => ({ getLastListError: () => getLmStudioListError() }));

// A fixed, generous memory budget so the memory axis is deterministic.
vi.mock('../lib/localMemory.js', () => ({ getAvailableMemoryGb: async () => 64 }));

const svc = await import('./localModelAssessments.js');

const STORE = join(tempRoot, 'local-llm', 'assessments.json');

const okRun = (chars = 40, charsPerSecond = 120, ttftMs = 250) => ({
  text: 'The answer is 4.',
  timings: { charsPerSecond, ttftMs, totalMs: 800, chars },
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

beforeEach(() => {
  rmSync(join(tempRoot, 'local-llm'), { recursive: true, force: true });
  runLocalLlmTest.mockReset();
  listModels.mockReset().mockResolvedValue([{ id: 'example-model:7b', params: '7B' }]);
  getLoadedModels.mockReset().mockResolvedValue([{ id: 'example-model:7b', name: 'example-model:7b', size: 5 * 2 ** 30 }]);
  getOllamaListError.mockReset().mockReturnValue(null);
  getLmStudioListError.mockReset().mockReturnValue(null);
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
      contextTokens: 512, ok: true, charsPerSecond: 120, ttftMs: 250, error: null,
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

  it('flags a backend whose model list could not be read, even though it returned []', async () => {
    // Both managers cache an EMPTY list on a failed read instead of throwing, so
    // the manager's own error getter is the only signal that separates "no
    // models installed" from "the list could not be read".
    listModels.mockImplementation(async (backend) => (backend === 'lmstudio' ? [] : [{ id: 'example-model:7b', params: '7B' }]));
    getLmStudioListError.mockReturnValue('LM Studio is unavailable');
    const report = await svc.getAssessmentReport();
    expect(report.listErrors).toEqual(['lmstudio']);
  });

  it('still flags a backend when the model list throws outright', async () => {
    listModels.mockImplementation(async (backend) => {
      if (backend === 'ollama') throw new Error('Ollama unreachable');
      return [];
    });
    expect((await svc.getAssessmentReport()).listErrors).toEqual(['ollama']);
  });

  it('falls back to the balanced intent for an unrecognized one', async () => {
    expect((await svc.getAssessmentReport({ intent: 'nonsense' })).intent).toBe('balanced');
  });
});

describe('runAssessment', () => {
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

    listModels.mockResolvedValue([]);
    const report = await svc.getAssessmentReport();
    // It can no longer run, so it must not be ranked — but the measurement stays
    // on disk so a re-install doesn't cost another run.
    expect(report.ranked).toEqual([]);
    expect(report.uninstalled).toContainEqual({ backend: 'ollama', modelId: 'example-model:7b' });
    expect(report.assessments).toHaveLength(1);
  });

  it('keeps recommending when the backend list is UNTRUSTWORTHY rather than wiping it', async () => {
    runLocalLlmTest.mockResolvedValue(okRun());
    await svc.runAssessment({ backend: 'ollama', modelId: 'example-model:7b', contextTokens: [512, 4096] });

    // An unreadable list returning [] must not be read as "everything was
    // uninstalled" — that is the same failed-read-as-empty mistake.
    listModels.mockResolvedValue([]);
    getOllamaListError.mockReturnValue('Ollama is unavailable');
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
