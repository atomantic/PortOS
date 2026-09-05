vi.mock('./fleetLlmStartup.js', () => ({ installFleetHostLoginTask: async () => ({ success: true }), isFleetHostLoginTaskInstalled: async () => true }));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ providers: [], writes: [], enabled: '', specs: { platform: 'win32', cuda: { gpus: [{ name: 'NVIDIA RTX 3090', vramGb: 24 }] } }, peers: [], peerResponses: new Map() }));
vi.mock('./instances.js', () => ({ getPeers: async () => state.peers }));
vi.mock('../lib/peerHttpClient.js', () => ({
  peerFetch: async (url, opts, peer) => {
    const handler = state.peerResponses.get(url);
    if (handler) return handler(url, opts, peer);
    return { ok: false, status: 404, json: async () => ({}) };
  },
}));
vi.mock('../lib/peerUrl.js', () => ({
  peerBaseUrl: (peer) => peer.host ? `https://${peer.host}:${peer.port || 5555}` : `http://${peer.address}:${peer.port || 5555}`,
}));
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
import { configureFleetLlmHost, getFleetLlmHostStatus, getFleetPeerHosts, revealFleetPeerHostKey, stopFleetLlmHost } from './fleetLlmHost.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
beforeEach(async () => { await stopFleetLlmHost(); state.writes = []; state.enabled = ''; state.providers = []; state.peers = []; state.peerResponses.clear(); vi.clearAllMocks(); });
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

describe('fleet peer host discovery', () => {
  it('returns empty hosts list when no peers exist or no peers are serving', async () => {
    state.peers = [];
    const result = await getFleetPeerHosts();
    expect(result).toEqual({ hosts: [] });

    state.peers = [
      { id: 'offline-peer', name: 'Offline', host: 'offline.ts.net', status: 'offline', enabled: true },
      { id: 'disabled-peer', name: 'Disabled', host: 'disabled.ts.net', status: 'online', enabled: false },
    ];
    const res2 = await getFleetPeerHosts();
    expect(res2).toEqual({ hosts: [] });
  });

  it('discovers online peers running a federated host', async () => {
    state.peers = [
      { id: 'peer-1', name: 'Workstation GPU', host: 'gpu.ts.net', status: 'online', enabled: true },
      { id: 'peer-2', name: 'Laptop', address: '192.168.1.50', status: 'online', enabled: true },
    ];
    state.peerResponses.set('https://gpu.ts.net:5555/api/providers/fleet-host', async () => ({
      ok: true,
      json: async () => ({
        serving: true,
        enabled: true,
        endpoint: 'http://gpu.ts.net:18022/v1',
        model: 'qwen3.8-27b',
        hasApiKey: true,
        queue: { active: 0, queued: 0 },
      }),
    }));
    state.peerResponses.set('http://192.168.1.50:5555/api/providers/fleet-host', async () => ({
      ok: true,
      json: async () => ({ serving: false, enabled: false }),
    }));

    const result = await getFleetPeerHosts();
    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]).toMatchObject({
      peerId: 'peer-1',
      peerName: 'Workstation GPU',
      peerHost: 'gpu.ts.net',
      endpoint: 'http://gpu.ts.net:18022/v1',
      model: 'qwen3.8-27b',
      serving: true,
      hasApiKey: true,
    });
  });

  it('reveals API key from peer on request and handles missing peer', async () => {
    state.peers = [
      { id: 'peer-1', name: 'Workstation GPU', host: 'gpu.ts.net', status: 'online', enabled: true },
    ];
    state.peerResponses.set('https://gpu.ts.net:5555/api/providers/fleet-host/key', async () => ({
      ok: true,
      json: async () => ({ apiKey: 'secret-token-from-peer-1234567890' }),
    }));

    await expect(revealFleetPeerHostKey('unknown-peer')).rejects.toThrow('Peer not found');
    const keyRes = await revealFleetPeerHostKey('peer-1');
    expect(keyRes).toEqual({ apiKey: 'secret-token-from-peer-1234567890' });
  });
});

