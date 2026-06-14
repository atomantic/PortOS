import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mock state so the factory closures below can reach it.
const h = vi.hoisted(() => ({
  ollamaLoaded: [],
  ollamaUnload: vi.fn(),
  ollamaUrl: 'http://localhost:11434',
  lmLoaded: [],
  lmUnload: vi.fn(),
  lmUrl: 'http://localhost:1234',
  platform: 'darwin',
  totalBytes: 128 * 2 ** 30,
  freeBytes: 8 * 2 ** 30,
  vmStat: { stdout: '' },
  vmStatThrows: false,
}));

vi.mock('../ollamaManager.js', () => ({
  getLoadedModels: vi.fn(async () => h.ollamaLoaded),
  unloadModel: (...a) => h.ollamaUnload(...a),
  getBaseUrl: () => h.ollamaUrl,
}));
vi.mock('../lmStudioManager.js', () => ({
  getLoadedModels: vi.fn(async () => h.lmLoaded),
  unloadModel: (...a) => h.lmUnload(...a),
  getBaseUrl: () => h.lmUrl,
}));
vi.mock('os', () => ({
  platform: () => h.platform,
  totalmem: () => h.totalBytes,
  freemem: () => h.freeBytes,
}));
vi.mock('child_process', () => ({
  execFile: (_cmd, cb) => {
    if (h.vmStatThrows) return cb(new Error('vm_stat missing'));
    return cb(null, h.vmStat);
  },
}));

const { unloadResidentModels, getAvailableMemoryGb, prepareMemoryForTraining, isLocalBackendUrl, TRAINING_MIN_HEADROOM_GB } =
  await import('./memoryPrep.js');

// vm_stat with 16 KiB pages: free + inactive + speculative + purgeable pages
// sum to a known GB total so the parser assertion is exact.
const vmStatWith = (gb) => {
  const pages = (gb * 2 ** 30) / 16384;
  return `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                          ${Math.floor(pages / 4)}.
Pages active:                        100000.
Pages inactive:                      ${Math.floor(pages / 4)}.
Pages speculative:                   ${Math.floor(pages / 4)}.
Pages wired down:                    50000.
Pages purgeable:                     ${Math.ceil(pages / 4)}.
`;
};

beforeEach(() => {
  h.ollamaLoaded = [];
  h.lmLoaded = [];
  h.ollamaUnload = vi.fn(async () => ({ unloaded: true }));
  h.lmUnload = vi.fn(async () => ({ success: true }));
  h.ollamaUrl = 'http://localhost:11434';
  h.lmUrl = 'http://localhost:1234';
  h.platform = 'darwin';
  h.totalBytes = 128 * 2 ** 30;
  h.freeBytes = 8 * 2 ** 30;
  h.vmStat = { stdout: vmStatWith(100) };
  h.vmStatThrows = false;
});

describe('unloadResidentModels', () => {
  it('unloads every resident ollama + LM Studio model and labels them', async () => {
    h.ollamaLoaded = [{ name: 'llama3:70b' }, { id: 'qwen2.5' }];
    h.lmLoaded = [{ id: 'mlx-community/big' }];
    const freed = await unloadResidentModels();
    expect(freed).toEqual(['ollama:llama3:70b', 'ollama:qwen2.5', 'lmstudio:mlx-community/big']);
    expect(h.ollamaUnload).toHaveBeenCalledTimes(2);
    expect(h.lmUnload).toHaveBeenCalledWith('mlx-community/big');
  });

  it('swallows unload failures and omits the model from the freed list', async () => {
    h.ollamaLoaded = [{ name: 'a' }, { name: 'b' }];
    h.ollamaUnload = vi.fn()
      .mockResolvedValueOnce({ unloaded: false, reason: 'not loaded' })
      .mockRejectedValueOnce(new Error('server down'));
    const freed = await unloadResidentModels();
    expect(freed).toEqual([]);
  });

  it('returns empty when nothing is resident', async () => {
    expect(await unloadResidentModels()).toEqual([]);
  });

  it('skips a remote backend — never evicts a peer machine\'s models', async () => {
    h.ollamaLoaded = [{ name: 'remote-llm' }];
    h.lmLoaded = [{ id: 'local-lm' }];
    h.ollamaUrl = 'http://10.0.0.5:11434'; // LAN peer — unloading frees no local memory
    h.lmUrl = 'http://127.0.0.1:1234';     // loopback — still eligible
    const freed = await unloadResidentModels();
    expect(freed).toEqual(['lmstudio:local-lm']);
    expect(h.ollamaUnload).not.toHaveBeenCalled();
    expect(h.lmUnload).toHaveBeenCalledWith('local-lm');
  });
});

describe('isLocalBackendUrl', () => {
  it('accepts loopback hosts (incl. 127.0.0.0/8 and IPv6)', () => {
    for (const u of [
      'http://localhost:11434', 'http://127.0.0.1:1234', 'http://127.0.0.53:1234',
      'http://0.0.0.0:1234', 'http://[::1]:1234',
    ]) expect(isLocalBackendUrl(u)).toBe(true);
  });

  it('rejects LAN/remote hosts and unparseable input', () => {
    for (const u of [
      'http://10.0.0.5:11434', 'http://192.168.1.20:1234', 'http://peer.local:11434',
      'http://example.com', '', null, undefined, 'not a url',
    ]) expect(isLocalBackendUrl(u)).toBe(false);
  });
});

describe('getAvailableMemoryGb', () => {
  it('parses vm_stat (free+inactive+speculative+purgeable) on darwin', async () => {
    h.vmStat = { stdout: vmStatWith(64) };
    expect(await getAvailableMemoryGb()).toBeCloseTo(64, 0);
  });

  it('falls back to freemem() when vm_stat fails', async () => {
    h.vmStatThrows = true;
    h.freeBytes = 12 * 2 ** 30;
    expect(await getAvailableMemoryGb()).toBeCloseTo(12, 5);
  });

  it('uses freemem() off darwin', async () => {
    h.platform = 'linux';
    h.freeBytes = 7 * 2 ** 30;
    expect(await getAvailableMemoryGb()).toBeCloseTo(7, 5);
  });
});

describe('prepareMemoryForTraining', () => {
  it('clamps the budget to physical RAM and reports freed models', async () => {
    h.ollamaLoaded = [{ name: 'm' }];
    h.totalBytes = 96 * 2 ** 30;
    h.vmStat = { stdout: vmStatWith(200) }; // bogus over-report → clamp to total
    const r = await prepareMemoryForTraining();
    expect(r.unloaded).toEqual(['ollama:m']);
    expect(r.budgetGb).toBe(96);
    expect(r.totalGb).toBe(96);
  });

  it('budget tracks the post-unload available pool when below total', async () => {
    h.vmStat = { stdout: vmStatWith(40) };
    const r = await prepareMemoryForTraining();
    expect(r.budgetGb).toBeCloseTo(40, 0);
    expect(r.budgetGb).toBeLessThan(TRAINING_MIN_HEADROOM_GB + 100);
  });
});
