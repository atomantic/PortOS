import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_ROOT = await mkdtemp(join(tmpdir(), 'portos-captests-'));
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  actual.PATHS.data = TEST_ROOT;
  return actual;
});

vi.mock('./localModelAssessments.js', () => ({
  listRuntimeModels: vi.fn(async () => ({ models: [], error: null })),
  runtimeEndpoint: vi.fn(async () => 'http://127.0.0.1:8080/v1'),
  runtimeApiKey: vi.fn(async () => ''),
}));
vi.mock('./localLlmPlayground.js', () => ({
  runLocalLlmTest: vi.fn(),
  runEndpointLlmTest: vi.fn(),
}));
// `getAllProviders` resolves the toolkit ENVELOPE (`{ activeProvider, providers }`),
// and `listProviders` is the wrapper that unwraps it. Mocked in that shape on
// purpose: a bare-array mock is exactly what let the matcher ship returning null
// for every runtime while this suite stayed green.
vi.mock('./providers.js', () => {
  const getAllProviders = vi.fn(async () => ({ activeProvider: null, providers: [] }));
  return {
    getAllProviders,
    listProviders: async () => {
      const data = await getAllProviders().catch(() => null);
      return Array.isArray(data?.providers) ? data.providers : [];
    },
  };
});
vi.mock('./ollamaManager.js', () => ({ getModelCapabilities: vi.fn(async () => null) }));
vi.mock('./localLlm.js', () => ({ ollamaBadgeCapabilities: (raw) => raw }));
vi.mock('../lib/bufferedSpawn.js', () => ({
  bufferedSpawn: vi.fn(),
  prepareCliSpawn: vi.fn((command, args) => ({ command, args })),
}));
// The agent runs through the streaming lane; `bufferedSpawn` above is only
// PortOS's own verification run. Mocking the spawn rather than `opencodeTask`
// keeps the real provider matching under test.
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn() }));
// The claim is a real cross-process file lock; the suite is not testing it here.
vi.mock('../lib/heavyJobClaim.js', () => ({
  claimHeavyLocalJob: vi.fn(async () => ({ ok: true, holder: null, release: async () => {} })),
}));
vi.mock('../lib/cliChildEnv.js', () => ({ buildCliChildEnv: vi.fn(() => ({ PATH: '/example/bin' })) }));

const { listRuntimeModels } = await import('./localModelAssessments.js');
const { runLocalLlmTest, runEndpointLlmTest } = await import('./localLlmPlayground.js');
const { getAllProviders } = await import('./providers.js');
const { getModelCapabilities } = await import('./ollamaManager.js');
const { bufferedSpawn } = await import('../lib/bufferedSpawn.js');
const { runStreamingCommand } = await import('../lib/streamingSpawn.js');
const { claimHeavyLocalJob } = await import('../lib/heavyJobClaim.js');
const {
  getCapabilityTestReport, getCapabilityTestResult, runCapabilityTest,
  resolveModelCapabilities, SANDBOX_FILES, __resetFixtureCaches,
} = await import('./modelCapabilityTests.js');
const { loadResults } = await import('./modelCapabilityTestStore.js');

const OPENCODE_LLAMA = {
  id: 'opencode-llama-tui', name: 'OpenCode llama TUI', type: 'tui', command: 'opencode', args: [], llamaBacked: true,
};

// One installed model on one runtime; every other runtime lists nothing.
const installOn = (runtime, models) => {
  listRuntimeModels.mockImplementation(async (id) => (id === runtime ? { models, error: null } : { models: [], error: null }));
};

const testFor = (model, testId) => model.tests.find((t) => t.testId === testId);

const spawnResult = (over = {}) => ({ success: true, code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...over });

beforeEach(async () => {
  vi.clearAllMocks();
  await rm(join(TEST_ROOT, 'local-llm'), { recursive: true, force: true });
  await rm(join(TEST_ROOT, 'model-tests'), { recursive: true, force: true });
  listRuntimeModels.mockResolvedValue({ models: [], error: null });
  getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
  claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: null, release: async () => {} });
  __resetFixtureCaches();
});

afterEach(async () => {
  await rm(join(TEST_ROOT, 'model-tests'), { recursive: true, force: true });
});

describe('resolveModelCapabilities', () => {
  it('keeps "the runtime reported nothing" distinct from "the model claims nothing"', async () => {
    // A bare endpoint reports ids only — unknown, so tests stay on offer.
    expect(await resolveModelCapabilities('llama', { id: 'some-model' })).toBeNull();
    // LM Studio always names at least chat, so its list IS an answer.
    expect(await resolveModelCapabilities('lmstudio', { id: 'm', capabilities: ['chat'] })).toEqual(['chat']);
  });

  it('asks Ollama for capabilities its model list does not carry', async () => {
    getModelCapabilities.mockResolvedValue(['completion', 'tools']);
    expect(await resolveModelCapabilities('ollama', { id: 'qwen', capabilities: [] })).toEqual(['completion', 'tools']);
    expect(getModelCapabilities).toHaveBeenCalledWith('qwen');
  });

  it('reports unknown — not "claims nothing" — when the Ollama probe fails', async () => {
    getModelCapabilities.mockRejectedValue(new Error('daemon down'));
    expect(await resolveModelCapabilities('ollama', { id: 'qwen', capabilities: [] })).toBeNull();
  });
});

describe('getCapabilityTestReport', () => {
  it('gates each test on the badges the model claims', async () => {
    installOn('lmstudio', [{ id: 'vision-only', capabilities: ['chat', 'vision'] }]);
    const report = await getCapabilityTestReport();
    const model = report.models.find((m) => m.modelId === 'vision-only');

    expect(testFor(model, 'image-analysis').state).toBe('applicable');
    expect(testFor(model, 'story-outline').state).toBe('applicable');
    // No `tools` badge — skipped, and the reason names what is missing.
    expect(testFor(model, 'sandbox-repair').state).toBe('not-applicable');
    expect(testFor(model, 'sandbox-repair').reason).toContain('tools');
  });

  it('marks a tool-use test unavailable — not failed — when no agent driver is configured', async () => {
    installOn('lmstudio', [{ id: 'tool-caller', capabilities: ['chat', 'tools'] }]);
    // LM Studio has no OpenCode namespace, so nothing can drive the TUI there.
    const report = await getCapabilityTestReport();
    const sandbox = testFor(report.models.find((m) => m.modelId === 'tool-caller'), 'sandbox-repair');
    expect(sandbox.state).toBe('unavailable');
    expect(sandbox.reason).toContain('OpenCode');
  });

  it('offers the tool-use test once a matching TUI provider exists', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [OPENCODE_LLAMA] });
    installOn('llama', [{ id: 'qwen-local' }]);
    const report = await getCapabilityTestReport();
    const model = report.models.find((m) => m.modelId === 'qwen-local');
    // Capabilities are unknown on a bare endpoint, so every test is on offer
    // with the claim marked unverified rather than hidden.
    expect(model.capabilities).toBeNull();
    expect(testFor(model, 'sandbox-repair').state).toBe('unknown');
  });

  it('reports no verdict for a model nothing has been run against', async () => {
    installOn('lmstudio', [{ id: 'fresh', capabilities: ['chat'] }]);
    const report = await getCapabilityTestReport();
    expect(report.models.find((m) => m.modelId === 'fresh').verdict).toBeNull();
    expect(report.counts.passed).toBe(0);
  });

  it('calls no provider — the report is a read path', async () => {
    installOn('lmstudio', [{ id: 'anything', capabilities: ['chat', 'vision', 'tools'] }]);
    await getCapabilityTestReport();
    expect(runLocalLlmTest).not.toHaveBeenCalled();
    expect(runEndpointLlmTest).not.toHaveBeenCalled();
    expect(bufferedSpawn).not.toHaveBeenCalled();
  });
});

describe('runCapabilityTest — image analysis', () => {
  it('scores the answer and keeps the model output verbatim', async () => {
    runLocalLlmTest.mockResolvedValue({
      text: 'A red bicycle beside a blue bench, a dog underneath, a lit street lamp and a sign reading 3.',
      timings: { totalMs: 4200 },
    });
    const record = await runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' });

    expect(record.verdict).toBe('passed');
    expect(record.output).toContain('red bicycle');
    expect(record.detail.requiredHit).toBe(record.detail.requiredTotal);
    // The image really was attached, as a data URL rather than a path.
    expect(runLocalLlmTest.mock.calls[0][0].images[0]).toMatch(/^data:image\/png;base64,/);
  });

  it('records a partial answer as partial and still stores what came back', async () => {
    runLocalLlmTest.mockResolvedValue({ text: 'A bicycle and a bench at night.', timings: null });
    const record = await runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' });
    expect(record.verdict).toBe('partial');
    expect(record.output).toBe('A bicycle and a bench at night.');
  });

  it('scores a mid-stream failure on what it produced, keeping the error beside it', async () => {
    runLocalLlmTest.mockResolvedValue({
      text: 'A bicycle, a bench, a dog and a street lamp.',
      error: 'Timed out after 300000ms',
      timings: null,
    });
    const record = await runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' });
    expect(record.verdict).toBe('passed');
    expect(record.error).toContain('Timed out');
  });

  it('routes a bare endpoint runtime straight at its endpoint', async () => {
    runEndpointLlmTest.mockResolvedValue({ text: 'a bicycle, a bench, a dog, a lamp', timings: null });
    await runCapabilityTest({ backend: 'llama', modelId: 'local-vlm', testId: 'image-analysis' });
    expect(runEndpointLlmTest).toHaveBeenCalled();
    expect(runLocalLlmTest).not.toHaveBeenCalled();
  });
});

describe('runCapabilityTest — story outline', () => {
  it('stores the whole outline, not just the score', async () => {
    const outline = ['Ordinary world', 'Call to adventure', 'The ordeal', 'Return with the elixir']
      .map((b) => `## ${b}\nA paragraph about it.`).join('\n\n');
    runLocalLlmTest.mockResolvedValue({ text: outline, timings: null });
    const record = await runCapabilityTest({ backend: 'ollama', modelId: 'writer', testId: 'story-outline' });
    expect(record.output).toBe(outline);
    expect(record.detail.found).toBe(4);
    expect(record.verdict).toBe('failed');
  });
});

describe('runCapabilityTest — fiction scene', () => {
  it('keeps the scene and returns the structural craft score', async () => {
    runLocalLlmTest.mockResolvedValue({
      text: [
        'The tidal marsh smelled of mud as the oyster farmer watched the dying beds.',
        'She waded to the sea wall and pulled the gate open.',
        '“No,” she said, as black water spilled through the breach.',
      ].join('\n\n'),
      timings: null,
    });
    const record = await runCapabilityTest({ backend: 'ollama', modelId: 'writer', testId: 'fiction-scene' });
    expect(record.output).toContain('oyster farmer');
    expect(record.detail.wordCount).toBeGreaterThan(0);
    expect(record.detail.hasDialogue).toBe(true);
    expect(record.verdict).toBe('partial');
  });
});

describe('runCapabilityTest — sandbox repair', () => {
  beforeEach(() => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [OPENCODE_LLAMA] });
  });

  // The agent is simulated by having the spawn mock edit the sandbox the way a
  // model would, so the verdict is produced by the real on-disk checks.
  const withAgent = (edit) => {
    runStreamingCommand.mockImplementation(async (_cmd, _args, onLine, opts) => {
      await edit(opts.cwd, opts);
      for (const line of [
        JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'read', input: { filePath: 'cart-totals.mjs' } } }),
        JSON.stringify({ type: 'text', part: { type: 'text', text: 'Rewriting cartTotal.' } }),
        JSON.stringify({ type: 'tool', part: { type: 'tool', tool: 'write', input: { filePath: 'cart-totals.mjs' } } }),
      ]) onLine(line);
      return { success: true };
    });
    // PortOS's own verification run really executes the sandbox test, so the
    // exit code the verdict turns on is a real one.
    bufferedSpawn.mockImplementation(async (cmd, args, opts) => {
      const { execFileSync } = await import('child_process');
      try {
        return spawnResult({ stdout: execFileSync(cmd, args, { cwd: opts.cwd, encoding: 'utf8', stdio: 'pipe' }) });
      } catch (err) {
        return spawnResult({ success: false, code: err.status ?? 1, stdout: String(err.stdout || ''), stderr: String(err.stderr || '') });
      }
    });
  };

  const fixedModule = `import { readFile } from 'node:fs/promises';
export const TAX = { 'us-ca': 0.0875, 'us-ny': 0.08875, uk: 0.2, default: 0.05 };
export function round2(value) { return Math.round(value * 100) / 100; }
export async function loadOrders(path = new URL('./orders.json', import.meta.url)) {
  return JSON.parse(await readFile(path, 'utf8'));
}
export function cartTotal({ items, region, discount = 0 }) {
  const sub = items.reduce((acc, item) => acc + item.price * item.qty, 0);
  const rate = TAX[region] ?? TAX.default;
  return round2(sub + sub * rate - discount);
}
`;

  it('passes only when PortOS’s own test run exits 0', async () => {
    withAgent(async (cwd) => writeFile(join(cwd, SANDBOX_FILES.module), fixedModule));
    const record = await runCapabilityTest({ backend: 'llama', modelId: 'coder', testId: 'sandbox-repair' });

    expect(record.verdict).toBe('passed');
    expect(record.detail.verifyExitCode).toBe(0);
    expect(record.detail.toolCalls).toBe(2);
    // Watching it work is the point: the transcript survives the run.
    expect(record.transcript).toContain('● read cart-totals.mjs');
    expect(record.transcript).toContain('Rewriting cartTotal.');
  });

  it('fails a model that only SAYS it fixed the module', async () => {
    // Touches nothing on disk, narrates success.
    withAgent(async () => {});
    const record = await runCapabilityTest({ backend: 'llama', modelId: 'talker', testId: 'sandbox-repair' });
    expect(record.verdict).toBe('failed');
    expect(record.summary).toContain('never wrote a fix');
  });

  it('fails a model that edited the test into passing', async () => {
    withAgent(async (cwd) => {
      await writeFile(join(cwd, SANDBOX_FILES.module), fixedModule);
      await writeFile(join(cwd, SANDBOX_FILES.test), '// deleted every assertion\n');
    });
    const record = await runCapabilityTest({ backend: 'llama', modelId: 'cheater', testId: 'sandbox-repair' });
    expect(record.verdict).toBe('failed');
    expect(record.summary).toContain('edited the test');
  });

  it('records a wrong fix as partial rather than as no attempt', async () => {
    withAgent(async (cwd) => writeFile(join(cwd, SANDBOX_FILES.module), `${fixedModule}\n// still wrong\nexport const BROKEN = true;\n`
      .replace('return round2(sub + sub * rate - discount);', 'return sub;')));
    const record = await runCapabilityTest({ backend: 'llama', modelId: 'trier', testId: 'sandbox-repair' });
    expect(record.verdict).toBe('partial');
  });

  it('refuses when no agent driver can reach the runtime', async () => {
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [] });
    await expect(runCapabilityTest({ backend: 'lmstudio', modelId: 'x', testId: 'sandbox-repair' }))
      .rejects.toThrow(/OpenCode/);
  });

  it('gives the agent a fresh copy of the fixture, never the repo one', async () => {
    let sandboxDir = null;
    withAgent(async (cwd) => { sandboxDir = cwd; await writeFile(join(cwd, SANDBOX_FILES.module), fixedModule); });
    await runCapabilityTest({ backend: 'llama', modelId: 'coder', testId: 'sandbox-repair' });

    expect(sandboxDir.startsWith(join(TEST_ROOT, 'model-tests', 'sandboxes'))).toBe(true);
    // The repo fixture is untouched: still the broken version.
    const repoFixture = await readFile(new URL(`../fixtures/model-tests/sandbox/cart-totals/${SANDBOX_FILES.module}`, import.meta.url), 'utf8');
    expect(repoFixture).not.toContain('?? TAX.default');
  });
});

describe('runCapabilityTest — cancellation', () => {
  it('records nothing when the client disconnects mid-run', async () => {
    runLocalLlmTest.mockResolvedValue({ text: 'a bicycle, a bench, a dog, a lamp', timings: null });
    const controller = new AbortController();
    controller.abort();
    const result = await runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis', signal: controller.signal });

    expect(result.cancelled).toBe(true);
    expect(await loadResults()).toEqual([]);
  });
});

describe('runCapabilityTest — input guards', () => {
  it('rejects an unknown test id at the service boundary', async () => {
    await expect(runCapabilityTest({ backend: 'ollama', modelId: 'm', testId: 'nope' })).rejects.toThrow(/Unknown capability test/);
  });

  it('rejects a runtime PortOS cannot assess', async () => {
    await expect(runCapabilityTest({ backend: 'openai', modelId: 'm', testId: 'story-outline' })).rejects.toThrow(/Unsupported runtime/);
  });
});

describe('the machine-wide heavy-job claim', () => {
  it('refuses to run on top of an assessment sweep', async () => {
    claimHeavyLocalJob.mockResolvedValue({
      ok: false, holder: { kind: 'local-model assessment sweep' }, message: 'A local-model assessment sweep is running', release: async () => {},
    });
    await expect(runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' }))
      .rejects.toThrow(/sweep is running/);
    // Nothing reached a provider — the claim is taken before the model is.
    expect(runLocalLlmTest).not.toHaveBeenCalled();
  });

  it('releases the claim even when the run throws', async () => {
    const release = vi.fn(async () => {});
    claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: null, release });
    runLocalLlmTest.mockRejectedValue(new Error('llama.cpp went away'));

    await expect(runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' })).rejects.toThrow();
    expect(release).toHaveBeenCalled();
  });

  it('releases the claim when the progress consumer disconnects before the runner starts', async () => {
    const release = vi.fn(async () => {});
    claimHeavyLocalJob.mockResolvedValue({ ok: true, holder: null, release });
    let firstFrame = true;
    const onProgress = vi.fn(() => {
      if (firstFrame) {
        firstFrame = false;
        throw new Error('progress consumer disconnected');
      }
    });

    await expect(runCapabilityTest({
      backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis', onProgress,
    })).rejects.toThrow(/progress consumer disconnected/);
    expect(release).toHaveBeenCalledOnce();
    expect(runLocalLlmTest).not.toHaveBeenCalled();
  });
});

describe('what the report ships', () => {
  beforeEach(async () => {
    runLocalLlmTest.mockResolvedValue({
      text: 'A red bicycle beside a blue bench, a dog underneath, a lit street lamp and a sign reading 3.',
      timings: null,
    });
    installOn('lmstudio', [{ id: 'vlm', capabilities: ['chat', 'vision'] }]);
    await runCapabilityTest({ backend: 'lmstudio', modelId: 'vlm', testId: 'image-analysis' });
  });

  it('summarises each result rather than shipping every stored transcript', async () => {
    const report = await getCapabilityTestReport();
    const slot = testFor(report.models.find((m) => m.modelId === 'vlm'), 'image-analysis');

    expect(slot.result.verdict).toBe('passed');
    // The score detail is what the matrix and the Checks tab render, so it rides
    // along; the model's own text does not — that is a per-pairing fetch.
    expect(slot.result.detail.requiredHit).toBe(4);
    expect(slot.result).not.toHaveProperty('output');
    expect(slot.result).not.toHaveProperty('transcript');
  });

  it('serves the full record for one pairing on demand', async () => {
    const full = await getCapabilityTestResult('lmstudio', 'vlm', 'image-analysis');
    expect(full.output).toContain('red bicycle');
    expect(await getCapabilityTestResult('lmstudio', 'vlm', 'story-outline')).toBeNull();
  });

  it('names a runtime whose model list could not be read', async () => {
    listRuntimeModels.mockImplementation(async (id) => (id === 'ollama'
      ? { models: null, error: 'not reachable at http://127.0.0.1:11434/v1' }
      : { models: [], error: null }));
    const report = await getCapabilityTestReport();
    // Missing models must read as "could not look", not as "none installed".
    expect(report.listErrors).toEqual([expect.objectContaining({
      id: 'ollama', label: 'Ollama', error: 'not reachable at http://127.0.0.1:11434/v1',
    })]);
  });
});

describe('sandbox housekeeping', () => {
  it('keeps the newest sandboxes and prunes the rest', async () => {
    const { mkdir, readdir } = await import('fs/promises');
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [OPENCODE_LLAMA] });
    const root = join(TEST_ROOT, 'model-tests', 'sandboxes');
    // 25 older runs, named the way runCapabilityTest names them (a base36
    // timestamp of fixed width, so a plain sort is chronological).
    await mkdir(root, { recursive: true });
    for (let i = 0; i < 25; i += 1) await mkdir(join(root, `aaaaaaa${String(i).padStart(2, '0')}-old`), { recursive: true });

    runStreamingCommand.mockResolvedValue({ success: true });
    bufferedSpawn.mockResolvedValue(spawnResult({ success: false, code: 1 }));
    await runCapabilityTest({ backend: 'llama', modelId: 'coder', testId: 'sandbox-repair' });

    const left = await readdir(root);
    expect(left.length).toBe(20);
    // The run that just happened is never the one pruned.
    expect(left.some((name) => !name.endsWith('-old'))).toBe(true);
  });
});

describe('a runtime that is not running', () => {
  const offlineListing = (models) => {
    listRuntimeModels.mockImplementation(async (id) => (id === 'llama'
      ? { models, error: 'not reachable at http://127.0.0.1:5568/v1 (ECONNREFUSED)', offline: true }
      : { models: [], error: null }));
  };

  it('still lists what PortOS has on disk, rather than hiding it', async () => {
    offlineListing([{ id: 'qwen3.8-27b-dspark', params: null, quantization: 'Q4_K_M' }]);
    const report = await getCapabilityTestReport();
    const model = report.models.find((m) => m.modelId === 'qwen3.8-27b-dspark');

    expect(model).toBeTruthy();
    expect(model.offline).toBe(true);
  });

  it('blocks its tests with the daemon as the reason, not the model', async () => {
    offlineListing([{ id: 'qwen3.8-27b-dspark' }]);
    const report = await getCapabilityTestReport();
    const model = report.models.find((m) => m.modelId === 'qwen3.8-27b-dspark');

    // Nothing can run until it is started — but that is never scored as a
    // failure the model earned.
    for (const slot of model.tests) {
      expect(slot.state).toBe('unavailable');
      expect(slot.reason).toBe('llama.cpp is not running');
    }
  });

  it('carries the fix: where to start it, and how many models it recovered', async () => {
    offlineListing([{ id: 'a' }, { id: 'b' }]);
    const report = await getCapabilityTestReport();

    expect(report.listErrors).toEqual([expect.objectContaining({
      id: 'llama', label: 'llama.cpp', offline: true, recovered: 2, manageUrl: '/models/llms',
    })]);
  });

  it('says nothing was recovered when PortOS holds no catalog for it', async () => {
    // vLLM and SGLang are containers the user runs — an honest zero, not a gap.
    listRuntimeModels.mockImplementation(async (id) => (id === 'vllm'
      ? { models: null, error: 'not reachable at http://127.0.0.1:18020/v1 (ECONNREFUSED)', offline: true }
      : { models: [], error: null }));
    const report = await getCapabilityTestReport();
    expect(report.listErrors[0]).toMatchObject({ id: 'vllm', recovered: 0, manageUrl: null });
  });
});
