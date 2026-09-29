import { describe, it, expect } from 'vitest';
import { summarizeTranscriptDays, mergeModelRows } from './claudeCodeModelReport.js';

describe('claude code model report', () => {
  it('prices per model at API rates and merges instances into a fleet list', async () => {
    const days = { '2026-09-10': { 'claude-opus-5-5': { messages: 1, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, 'qwen3-coder:30b': { messages: 1, input: 5e6, output: 5e6, cacheRead: 0, cacheWrite: 0 } } };
    const a = summarizeTranscriptDays(days, { from: '2026-09-01', to: '2026-09-30' });
    const opus = a.models.find((m) => m.model === 'claude-opus-5-5');
    expect(opus.estimatedCost).toBeGreaterThan(0);
    expect(a.models.some((m) => m.model.startsWith('qwen'))).toBe(false); // local backends are not Claude models
    expect(summarizeTranscriptDays(days, { from: '2026-10-01' }).models).toEqual([]);
    const fleet = mergeModelRows([a.models, a.models]);
    expect(fleet.totals.estimatedCost).toBeCloseTo(opus.estimatedCost * 2, 1);
    expect(fleet.models.find((m) => m.model === 'claude-opus-5-5').messages).toBe(2);
  });

});
