import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setAIToolkit } from './providers.js';

// Hoisted mock state so the factory closures below can reach it.
const h = vi.hoisted(() => ({
  memoryThrows: false,
  platform: null,
  providers: [],
  providersThrows: false,
  cuda: { status: 'available' },
  probe: vi.fn(),
  ollamaUnload: vi.fn(),
  lmUnload: vi.fn(),
}));

vi.mock('os', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, platform: () => h.platform || actual.platform(), freemem: () => {
    if (h.memoryThrows) throw new Error('memory probe unavailable');
    return actual.freemem();
  } };
});

vi.mock('./ollamaManager.js', () => ({
  getLoadedModels: vi.fn(async () => [{ name: 'llama3' }]),
  unloadModel: (...a) => h.ollamaUnload(...a),
  getBaseUrl: () => 'http://localhost:11434',
}));
vi.mock('./lmStudioManager.js', () => ({
  getLoadedModels: vi.fn(async () => []),
  unloadModel: (...a) => h.lmUnload(...a),
  getBaseUrl: () => 'http://localhost:1234',
}));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaCapability: vi.fn(async () => h.cuda) }));
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: (...a) => h.probe(...a) }));

const { detectGpuBlockers, gpuBlockersMessage, prepareLocalMemory } = await import('./localMemory.js');
const { getCudaCapability } = await import('../lib/cudaCapability.js');

const VLLM_ENDPOINT = 'http://127.0.0.1:18020/v1';
const vllmProvider = (over = {}) => ({
  id: 'opencode-vllm-tui', name: 'OpenCode vLLM TUI', enabled: true, vllmBacked: true,
  endpoint: VLLM_ENDPOINT, ...over,
});
const SGLANG_ENDPOINT = 'http://127.0.0.1:18021/v1';
const sglangProvider = (over = {}) => ({
  id: 'opencode-sglang-tui', name: 'OpenCode SGLang TUI', enabled: true, sglangBacked: true,
  endpoint: SGLANG_ENDPOINT, ...over,
});
const serving = { reachable: true, models: ['qwen3.8-27b'], error: null };
const notServing = { reachable: false, models: null, error: 'ECONNREFUSED' };

beforeEach(() => {
  // Keep the real provider facade: the toolkit returns an envelope, while
  // consumers needing records use listProviders().
  setAIToolkit({ services: { providers: { getAllProviders: async () => {
    if (h.providersThrows) throw new Error('toolkit not initialized');
    return { activeProvider: null, providers: h.providers };
  } } } });
  h.memoryThrows = false;
  h.platform = null;
  h.providers = [];
  h.providersThrows = false;
  h.cuda = { status: 'available' };
  h.probe = vi.fn(async () => serving);
  h.ollamaUnload = vi.fn(async () => ({ unloaded: true }));
  h.lmUnload = vi.fn(async () => ({ success: true }));
  getCudaCapability.mockClear();
  // Deliberately fake homes so no assertion can be answered by the developer's
  // real `~/qwen-serving` or `~/sglang-qwen38`.
  process.env.VLLM_QWEN_PROJECT_DIR = '/srv/example/qwen-serving';
  process.env.SGLANG_QWEN_PROJECT_DIR = '/srv/example/sglang-qwen38';
});

afterEach(() => setAIToolkit(null));

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

  // The SGLang container holds the GPU exactly as the vLLM one does, so the
  // guard is table-driven over both markers rather than forked per runtime.
  describe('SGLang container', () => {
    it('issues no probe when only a disabled sglangBacked provider exists', async () => {
      h.providers = [sglangProvider({ enabled: false })];
      await expect(detectGpuBlockers()).resolves.toEqual([]);
      expect(h.probe).not.toHaveBeenCalled();
      expect(getCudaCapability).not.toHaveBeenCalled();
    });

    it('names the container, its own project directory, and its own stop command', async () => {
      h.providers = [sglangProvider()];
      const [blocker] = await detectGpuBlockers({ env: { SGLANG_QWEN_PROJECT_DIR: '/opt/example/sglang' } });
      expect(blocker).toMatchObject({ runtime: 'sglang', providerId: 'opencode-sglang-tui', endpoint: SGLANG_ENDPOINT });
      expect(blocker.reason).toContain('SGLang (Qwen3.8-27B)');
      expect(blocker.reason).toContain('/opt/example/sglang');
      // NOT vLLM's `--profile single` — this compose file has no profiles.
      expect(blocker.reason).toContain('docker compose stop');
      expect(blocker.reason).not.toContain('--profile single');
      expect(blocker.reason).toMatch(/will not stop it for you/i);
    });

    it('reports both containers when both answer', async () => {
      h.providers = [vllmProvider(), sglangProvider()];
      const blockers = await detectGpuBlockers();
      expect(blockers.map((b) => b.runtime).sort()).toEqual(['sglang', 'vllm']);
    });

    it('does not block on an SGLang served from another machine', async () => {
      h.providers = [sglangProvider({ endpoint: 'http://192.0.2.10:18021/v1' })];
      await expect(detectGpuBlockers()).resolves.toEqual([]);
      expect(h.probe).not.toHaveBeenCalled();
    });

    it('does not block when its probe fails', async () => {
      h.providers = [sglangProvider()];
      h.probe = vi.fn(async () => notServing);
      await expect(detectGpuBlockers()).resolves.toEqual([]);
    });
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
  it('preserves an unavailable memory probe as unknown rather than measured zero', async () => {
    h.platform = 'linux';
    h.memoryThrows = true;
    const report = await prepareLocalMemory();
    expect(report.availableGb).toBeNull();
    expect(report.budgetGb).toBeNull();
  });

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
