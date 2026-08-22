import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock state so the factory closures below can reach it.
const h = vi.hoisted(() => ({
  providers: [],
  providersThrows: false,
  cuda: { status: 'available' },
  probe: vi.fn(),
  ollamaUnload: vi.fn(),
  lmUnload: vi.fn(),
}));

vi.mock('../services/ollamaManager.js', () => ({
  getLoadedModels: vi.fn(async () => [{ name: 'llama3' }]),
  unloadModel: (...a) => h.ollamaUnload(...a),
  getBaseUrl: () => 'http://localhost:11434',
}));
vi.mock('../services/lmStudioManager.js', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadModel: (...a) => h.lmUnload(...a),
  getBaseUrl: () => 'http://localhost:1234',
}));
vi.mock('../services/providers.js', () => ({
  getAllProviders: vi.fn(async () => {
    // The real one rejects when the AI toolkit was never initialized — the
    // failure mode this module must survive without blocking a job.
    if (h.providersThrows) throw new Error('toolkit not initialized');
    return h.providers;
  }),
}));
vi.mock('./cudaCapability.js', () => ({ getCudaCapability: vi.fn(async () => h.cuda) }));
vi.mock('./openAiModelsProbe.js', () => ({ probeOpenAiModels: (...a) => h.probe(...a) }));

const { detectGpuBlockers, gpuBlockersMessage, prepareLocalMemory } = await import('./localMemory.js');
const { getCudaCapability } = await import('./cudaCapability.js');

const VLLM_ENDPOINT = 'http://127.0.0.1:18020/v1';
const vllmProvider = (over = {}) => ({
  id: 'opencode-vllm-tui', name: 'OpenCode vLLM TUI', enabled: true, vllmBacked: true,
  endpoint: VLLM_ENDPOINT, ...over,
});
const serving = { reachable: true, models: ['qwen3.8-27b'], error: null };
const notServing = { reachable: false, models: null, error: 'ECONNREFUSED' };

beforeEach(() => {
  h.providers = [];
  h.providersThrows = false;
  h.cuda = { status: 'available' };
  h.probe = vi.fn(async () => serving);
  h.ollamaUnload = vi.fn(async () => ({ unloaded: true }));
  h.lmUnload = vi.fn(async () => ({ success: true }));
  getCudaCapability.mockClear();
  // A deliberately fake home so no assertion can be answered by the developer's
  // real `~/qwen-serving`.
  process.env.VLLM_QWEN_PROJECT_DIR = '/srv/example/qwen-serving';
});

describe('detectGpuBlockers', () => {
  it('issues no probe when no vllmBacked provider is enabled', async () => {
    h.providers = [{ id: 'ollama', enabled: true, ollamaBacked: true, endpoint: 'http://127.0.0.1:11434/v1' }];
    await expect(detectGpuBlockers()).resolves.toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
    // The cheapest gate first: a host with nothing to contend over never even
    // pays for the (memoized, but still spawning) nvidia-smi probe.
    expect(getCudaCapability).not.toHaveBeenCalled();
  });

  it('issues no probe when the only vllmBacked provider is disabled', async () => {
    h.providers = [vllmProvider({ enabled: false })];
    await expect(detectGpuBlockers()).resolves.toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('issues no probe on a non-CUDA host', async () => {
    h.providers = [vllmProvider()];
    h.cuda = { status: 'absent' };
    await expect(detectGpuBlockers()).resolves.toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('still probes when the CUDA probe itself could not answer', async () => {
    // `unknown` means nvidia-smi failed, NOT that there is no GPU — collapsing
    // the two would silently disarm the guard on a host with a wedged driver.
    h.providers = [vllmProvider()];
    h.cuda = { status: 'unknown' };
    await expect(detectGpuBlockers()).resolves.toHaveLength(1);
  });

  it('reports a blocker when the container answers', async () => {
    h.providers = [vllmProvider()];
    const blockers = await detectGpuBlockers();
    expect(blockers).toEqual([expect.objectContaining({
      runtime: 'vllm', providerId: 'opencode-vllm-tui', endpoint: VLLM_ENDPOINT,
    })]);
    expect(h.probe).toHaveBeenCalledWith(VLLM_ENDPOINT, expect.objectContaining({ apiKey: '' }));
  });

  it('names the container, the project directory and the stop command', async () => {
    h.providers = [vllmProvider()];
    const [blocker] = await detectGpuBlockers();
    expect(blocker.reason).toContain('vLLM (Qwen3.8-27B)');
    expect(blocker.reason).toContain('/srv/example/qwen-serving');
    expect(blocker.reason).toContain('docker compose --profile single stop');
    // The decision in #4766: PortOS refuses, it never stops the container.
    expect(blocker.reason).toMatch(/will not stop it for you/i);
  });

  it('reads the project directory off the passed env, not the ambient one', async () => {
    h.providers = [vllmProvider()];
    const [blocker] = await detectGpuBlockers({ env: { VLLM_QWEN_PROJECT_DIR: '/opt/example/vllm' } });
    expect(blocker.reason).toContain('/opt/example/vllm');
  });

  it('does not block when the probe says nothing is serving', async () => {
    h.providers = [vllmProvider()];
    h.probe = vi.fn(async () => notServing);
    await expect(detectGpuBlockers()).resolves.toEqual([]);
  });

  it('does not block when the probe times out', async () => {
    h.providers = [vllmProvider()];
    h.probe = vi.fn(async () => ({ reachable: false, models: null, error: 'timed out' }));
    await expect(detectGpuBlockers()).resolves.toEqual([]);
  });

  it('does not block when the probe throws outright', async () => {
    h.providers = [vllmProvider()];
    h.probe = vi.fn(async () => { throw new Error('boom'); });
    await expect(detectGpuBlockers()).resolves.toEqual([]);
  });

  it('does block on a 401 — a container behind VLLM_API_KEY is definitively up', async () => {
    h.providers = [vllmProvider()];
    h.probe = vi.fn(async () => ({ reachable: true, models: null, error: 'authentication required' }));
    await expect(detectGpuBlockers()).resolves.toHaveLength(1);
  });

  it('does not block on a vLLM served from another machine', async () => {
    // Another box's GPU is not this box's GPU — `localRuntimeForProvider` drops it.
    h.providers = [vllmProvider({ endpoint: 'http://192.0.2.10:18020/v1' })];
    await expect(detectGpuBlockers()).resolves.toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('probes one endpoint once and prefers the credentialed record', async () => {
    h.providers = [
      vllmProvider({ id: 'a', apiKey: '' }),
      vllmProvider({ id: 'b', apiKey: 'vllm-key' }),
    ];
    const blockers = await detectGpuBlockers();
    expect(blockers).toHaveLength(1);
    expect(h.probe).toHaveBeenCalledTimes(1);
    expect(h.probe).toHaveBeenCalledWith(VLLM_ENDPOINT, expect.objectContaining({ apiKey: 'vllm-key' }));
  });

  it('does not block when the provider store cannot be read', async () => {
    h.providersThrows = true;
    await expect(detectGpuBlockers()).resolves.toEqual([]);
    expect(h.probe).not.toHaveBeenCalled();
  });
});

describe('gpuBlockersMessage', () => {
  it('joins every reason and tolerates an empty or absent list', () => {
    expect(gpuBlockersMessage([{ reason: 'one.' }, { reason: 'two.' }])).toBe('one. two.');
    expect(gpuBlockersMessage([])).toBe('');
    expect(gpuBlockersMessage(undefined)).toBe('');
  });
});

describe('prepareLocalMemory', () => {
  it('reports no blockers and still unloads on a clean host', async () => {
    const report = await prepareLocalMemory();
    expect(report.blockers).toEqual([]);
    expect(report.unloaded).toEqual(['ollama:llama3']);
  });

  it('evicts nothing while blocked — the job is about to be refused', async () => {
    h.providers = [vllmProvider()];
    const report = await prepareLocalMemory();
    expect(report.blockers).toHaveLength(1);
    expect(report.unloaded).toEqual([]);
    expect(h.ollamaUnload).not.toHaveBeenCalled();
    // The headroom fields stay populated so no caller trips over `undefined`.
    expect(Number.isFinite(report.budgetGb)).toBe(true);
  });
});
