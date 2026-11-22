import { describe, expect, it } from 'vitest';
import { effectiveKvCacheType, kvCacheBytes, kvLayoutFromModelInfo, modelMemoryBudgetBytes, nativeContextFromModelInfo, planContextWindow } from './contextMemoryPlan.js';

const GB = 1024 ** 3;
// Hybrid state-space model: every 4th of 64 layers is full attention.
const hybrid = { 'general.architecture': 'hyb', 'hyb.block_count': 64, 'hyb.attention.head_count': 24, 'hyb.attention.head_count_kv': 4,
  'hyb.attention.key_length': 256, 'hyb.attention.value_length': 256, 'hyb.full_attention_interval': 4, 'hyb.context_length': 262144, 'hyb.embedding_length': 5120 };
// Listed sliding-window pattern with per-layer KV heads.
const listed = { 'general.architecture': 'swa', 'swa.block_count': 6, 'swa.attention.head_count': 32,
  'swa.attention.head_count_kv': [16, 16, 16, 16, 16, 4], 'swa.attention.sliding_window_pattern': [true, true, true, true, true, false],
  'swa.attention.sliding_window': 1024, 'swa.attention.key_length': 512, 'swa.attention.value_length': 512,
  'swa.attention.key_length_swa': 256, 'swa.attention.value_length_swa': 256, 'swa.context_length': 262144 };

describe('kvLayoutFromModelInfo', () => {
  it('counts only full-attention layers per token', () => {
    expect(kvLayoutFromModelInfo(hybrid)).toMatchObject({ perTokenElements: 16 * 4 * 512, fixedElements: 0, nativeContext: 262144 });
  });
  it('holds listed sliding-window layers at a fixed window', () => {
    expect(kvLayoutFromModelInfo(listed)).toMatchObject({ perTokenElements: 4 * 1024, fixedElements: 5 * 16 * 512 * 1024 });
  });
  it('applies the implicit sliding-window period for architectures that do not list it', () => {
    const gemma3 = { 'general.architecture': 'gemma3', 'gemma3.block_count': 12, 'gemma3.attention.head_count': 32, 'gemma3.attention.head_count_kv': 16,
      'gemma3.attention.key_length': 128, 'gemma3.attention.value_length': 128, 'gemma3.attention.sliding_window': 1024 };
    expect(kvLayoutFromModelInfo(gemma3).perTokenElements).toBe(2 * 16 * 256);
  });
  it('is null when the keys do not describe attention (an MLX build)', () => {
    const mlx = { 'general.architecture': 'loop', 'loop.block_count': 24, 'loop.context_length': 1048576 };
    expect(kvLayoutFromModelInfo(mlx)).toBeNull();
    expect(nativeContextFromModelInfo(mlx)).toBe(1048576);
    expect(kvLayoutFromModelInfo(null)).toBeNull();
  });
});

describe('planContextWindow', () => {
  const layout = kvLayoutFromModelInfo(hybrid);
  it('sizes the cache by type and stops at the native maximum', () => {
    expect(kvCacheBytes(layout, 131072, 'f16')).toBe(16 * 4 * 512 * 131072 * 2);
    expect(kvCacheBytes(layout, 131072, 'q8_0')).toBeLessThan(kvCacheBytes(layout, 131072, 'f16'));
    const plan = planContextWindow({ layout, weightsBytes: 17 * GB, budgetBytes: 96 * GB, cacheType: 'q8_0' });
    expect(plan.rows.at(-1).tokens).toBe(262144);
    expect(plan.recommended).toBe(262144);
  });
  it('caps the recommendation where the host runs out', () => {
    const plan = planContextWindow({ layout, weightsBytes: 17 * GB, budgetBytes: 26 * GB, cacheType: 'f16' });
    expect(plan.recommended).toBe(32768);
    expect(plan.rows.find((r) => r.tokens === 262144).fits).toBe(false);
    expect(planContextWindow({ layout, weightsBytes: 40 * GB, budgetBytes: 20 * GB }).recommended).toBeNull();
  });
  it('reports an unknown layout without a table', () => {
    expect(planContextWindow({ layout: null, nativeContext: 1048576 })).toMatchObject({ layoutKnown: false, rows: [], recommended: null, nativeContext: 1048576 });
  });
});

describe('host facts', () => {
  it('budgets the GPU share on Apple Silicon and VRAM on CUDA', () => {
    expect(modelMemoryBudgetBytes({ appleSilicon: true, totalMemoryGb: 128 })).toBe(96 * GB);
    expect(modelMemoryBudgetBytes({ totalMemoryGb: 64, cuda: { maxVramGb: 24 } })).toBe(24 * GB);
    expect(modelMemoryBudgetBytes({})).toBeNull();
  });
  it('treats a quantized cache without flash attention as f16', () => {
    expect(effectiveKvCacheType('q8_0', '1')).toBe('q8_0');
    expect(effectiveKvCacheType('q8_0', undefined)).toBe('f16');
    expect(effectiveKvCacheType('bogus', '1')).toBe('f16');
  });
});
