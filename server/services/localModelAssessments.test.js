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
vi.mock('./localLlmPlayground.js', () => ({ runLocalLlmTest: (...args) => runLocalLlmTest(...args) }));

const listModels = vi.fn();
vi.mock('./localLlm.js', () => ({ listModels: (...args) => listModels(...args) }));

const getLoadedModels = vi.fn();
const getOllamaListError = vi.fn();
const ollamaVersion = vi.fn(async () => '0.0.0-test');
vi.mock('./ollamaManager.js', () => ({
  getLoadedModels: (...args) => getLoadedModels(...args),
  getLastInstalledModelsError: () => getOllamaListError(),
  // Recorded with each assessment so a backend UPDATE can later be detected as
  // staleness — see localModelAssessmentStore.captureEnvironment.
  getVersion: (...args) => ollamaVersion(...args),
}));

const getLmStudioListError = vi.fn();
vi.mock('./lmStudioManager.js', () => ({ getLastListError: () => getLmStudioListError() }));

// A fixed, generous memory budget so the memory axis is deterministic.
vi.mock('../lib/localMemory.js', () => ({ getAvailableMemoryGb: async () => 64 }));

const svc = await import('./localModelAssessments.js');
// The durable store is a separate module (no path to a provider); the read-only
// projections the catalog badge consumes live there.
const store = await import('./localModelAssessmentStore.js');

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
