import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ providers: [], writes: [], enabled: '', specs: { platform: 'win32', cuda: { gpus: [{ name: 'NVIDIA RTX 3090', vramGb: 24 }] } } }));
vi.mock('../lib/systemCapabilities.js', () => ({ detectSystemCapabilities: async () => state.specs }));
vi.mock('../lib/cudaCapability.js', () => ({ getCudaUtilization: async () => ({ gpus: [{ memoryUsedMib: 1000 }] }) }));
vi.mock('../lib/tailscale.js', () => ({ getTailscaleStatus: async () => ({ running: true, dnsName: 'host-XXXX.example.ts.net' }) }));
vi.mock('../lib/fileUtils.js', () => ({ PATHS: { root: '/example' }, atomicWrite: async (path, value) => state.writes.push({ path, value }), tryReadFile: async () => state.enabled }));
vi.mock('node:fs/promises', () => ({ readFile: async () => 'VLLM_API_KEY=example-api-key-with-32-characters\n' }));
vi.mock('../lib/portosEnv.js', async (original) => ({ ...(await original()), upsertPortosEnvLine: async (key, value) => { state.enabled = `${key}=${value}`; } }));
vi.mock('../lib/commandExists.js', () => ({ commandOutput: async (_cmd, args) => args.includes('config') ? JSON.stringify({ services: { single: { image: 'example-runtime' } } }) : args.includes('inspect') ? 'sha256:' + 'a'.repeat(64) : '1.0' }));
vi.mock('../lib/vllmQwenProject.js', () => ({ inspectVllmQwenProject: async () => ({ dir: '/example', composeFile: '/example/compose.yaml', hasWeights: true }) }));
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: async () => ({ reachable: true, models: ['qwen3.8-27b'] }) }));
vi.mock('../lib/streamingSpawn.js', () => ({ runStreamingCommand: vi.fn(async () => ({ success: true })) }));
vi.mock('./vllmQwenManager.js', () => ({ ensureVllmProjectDir: async () => null, provisionVllmQwenProject: async () => ({ success: true }) }));
vi.mock('./providers.js', () => ({ getAllProviders: async () => ({ providers: state.providers }), createProvider: async (record) => state.providers.push(record), updateProvider: async (id, patch) => Object.assign(state.providers.find(p => p.id === id), patch) }));
vi.mock('./fleetLlmGateway.js', () => ({ createFleetLlmGateway: () => ({ server: { once() {}, on() {}, listen(_port, _host, done) { done(); } }, status: () => ({ active: 0, queued: 0 }), close: async () => {} }) }));
import { configureFleetLlmHost, getFleetLlmHostStatus, stopFleetLlmHost } from './fleetLlmHost.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
beforeEach(async () => { await stopFleetLlmHost(); state.writes = []; state.enabled = ''; state.providers = []; vi.clearAllMocks(); });
describe('dedicated host setup workflow', () => {
  it('pins the prepared image, keeps the runtime private and routes only local providers through the queue', async () => {
    state.providers = [
      { id: 'local', vllmBacked: true, endpoint: 'http://127.0.0.1:18020/v1' },
      { id: 'remote', vllmBacked: true, endpoint: 'http://host-XXXX.example.ts.net:18020/v1', apiKey: 'remote-secret' },
      { id: 'lmstudio', enabled: true, endpoint: 'http://127.0.0.1:1234/v1' },
    ];
    await expect(configureFleetLlmHost()).resolves.toEqual({ success: true });
    expect(state.writes.find(w => w.path.endsWith('.yaml')).value).toContain('127.0.0.1:18020:18020');
    expect(state.writes.find(w => w.path.endsWith('.yaml')).value).toContain('image: sha256:');
    expect(runStreamingCommand.mock.calls.at(-1)[1]).toEqual(expect.arrayContaining(['--no-build', '--pull', 'never']));
    expect(state.providers[0].endpoint).toBe('http://127.0.0.1:18022/v1');
    expect(state.providers[1]).toMatchObject({ endpoint: 'http://host-XXXX.example.ts.net:18020/v1', apiKey: 'remote-secret' });
    expect(state.providers[2].enabled).toBe(false);
    expect(state.providers.at(-1)).toMatchObject({ type: 'api', enabled: true, defaultModel: 'qwen3.8-27b' });
    const status = await getFleetLlmHostStatus();
    expect(status.serving).toBe(true);
    expect(JSON.stringify(status)).not.toContain('example-api-key');
  });
  it('cancels before starting a persistent runtime or enabling the gateway', async () => {
    await expect(configureFleetLlmHost({ isCancelled: () => true })).rejects.toThrow('cancelled');
    expect(runStreamingCommand).not.toHaveBeenCalled();
    expect(state.enabled).toBe('');
  });
});
