import { describe, expect, it, vi } from 'vitest';

vi.mock('./ollamaManager.js', () => ({
  getModelLayout: vi.fn(async (id) => (id === 'mlx-model'
    ? { modelInfo: { 'general.architecture': 'loop', 'loop.block_count': 24, 'loop.context_length': 1048576 }, runner: 'mlx' }
    : { modelInfo: { 'general.architecture': 'hyb', 'hyb.block_count': 8, 'hyb.attention.head_count': 8, 'hyb.attention.head_count_kv': 2,
      'hyb.attention.key_length': 128, 'hyb.context_length': 262144 }, runner: null })),
}));
vi.mock('../lib/systemCapabilities.js', () => ({ detectSystemCapabilities: vi.fn(async () => ({ appleSilicon: true, totalMemoryGb: 128 })) }));

const { planModelContext, resolveDaemonKvCacheType } = await import('./contextMemoryPlanner.js');

describe('contextMemoryPlanner', () => {
  it('recommends the native maximum for an MLX build, whose cache grows as used', async () => {
    const plan = await planModelContext({ id: 'mlx-model', size: 20e9 }, { cacheType: 'q8_0', budgetBytes: 96 * 1024 ** 3 });
    expect(plan).toMatchObject({ lazyCache: true, layoutKnown: false, recommended: 1048576 });
  });
  it('recommends the largest fitting step for a GGUF model', async () => {
    const plan = await planModelContext({ id: 'gguf', size: 17e9 }, { cacheType: 'q8_0', budgetBytes: 96 * 1024 ** 3 });
    expect(plan).toMatchObject({ lazyCache: false, layoutKnown: true, recommended: 262144 });
  });
  it('recommends nothing for a GGUF model when the host budget is unknown, but keeps the MLX native maximum', async () => {
    expect((await planModelContext({ id: 'gguf', size: 17e9 }, { cacheType: 'q8_0', budgetBytes: null })).recommended).toBeNull();
    expect((await planModelContext({ id: 'mlx-model', size: 20e9 }, { cacheType: 'q8_0', budgetBytes: null })).recommended).toBe(1048576);
  });
  it('reads the cache type from env first, then a brew service plist, else f16', async () => {
    expect(await resolveDaemonKvCacheType({ env: { OLLAMA_KV_CACHE_TYPE: 'q8_0', OLLAMA_FLASH_ATTENTION: '1' } })).toEqual({ cacheType: 'q8_0', source: 'env' });
    const plist = '<key>OLLAMA_FLASH_ATTENTION</key>\n<string>1</string>\n<key>OLLAMA_KV_CACHE_TYPE</key>\n<string>q4_0</string>';
    const read = vi.fn(async () => plist);
    const fromPlist = await resolveDaemonKvCacheType({ env: {}, home: '/h', read });
    if (process.platform === 'darwin') expect(fromPlist).toEqual({ cacheType: 'q4_0', source: 'brew-service' });
    else expect(fromPlist).toEqual({ cacheType: 'f16', source: 'default' });
    expect(await resolveDaemonKvCacheType({ env: {}, home: '/h', read: async () => { throw new Error('none'); } })).toEqual({ cacheType: 'f16', source: 'default' });
  });
});
