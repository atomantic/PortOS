import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildNativeUsageRollup, nativeModelUsageRefusal } from './nativeUsageRollups.js';

const aggregates = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/nativeUsageModelAttribution/v1/aggregate.json'), 'utf8'));

describe('received rollup contract', () => {
  for (const family of ['claude', 'grok']) {
    it.each(aggregates[family].map(example => [example.name, example]))(`${family}: %s`, (_name, { accept, reason, totals, modelUsage }) => {
      expect(nativeModelUsageRefusal(family, { totals, modelUsage })).toBe(accept ? null : reason);
    });
  }

  it('gives Antigravity per-day counters with no combined total and no model', () => {
    const rollup = buildNativeUsageRollup('agy', [{ at: '2026-03-01T00:00:00.000Z', values: [10, 5, 30, 0, 3, 2] }]);
    expect(rollup.totals).toMatchObject({ totalTokens: null, tokensIn: 10 });
    expect(rollup.modelUsage.buckets).toMatchObject([{ day: '2026-03-01', kind: 'unknown', key: 'model-unverified' }]);
    expect(nativeModelUsageRefusal('agy', rollup)).toBeNull();
  });
});

describe('rollup edges the reader corpus cannot reach', () => {
  it('leaves a record it cannot date out of both the buckets and the total, and says so', () => {
    const rollup = buildNativeUsageRollup('claude', [
      { at: '+012026-03-01T00:00:00.000Z', values: [1, 1, 1, 1], evidence: { kind: 'model-missing' } },
      { at: '2026-03-01T00:00:00.000Z', values: [2, 2, 0, 0], evidence: { kind: 'model-missing' } },
    ]);
    expect(rollup).toMatchObject({ totals: { totalTokens: 4 }, findings: ['undated-records'] });
    expect(nativeModelUsageRefusal('claude', rollup)).toBeNull();
  });

  it('refuses to publish a total past the safe integer range', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const rollup = buildNativeUsageRollup('claude', [
      { at: '2026-03-01T00:00:00.000Z', values: [big, 0, 0, 0], evidence: { kind: 'model-missing' } },
      { at: '2026-03-02T00:00:00.000Z', values: [big, 0, 0, 0], evidence: { kind: 'model-missing' } },
    ]);
    expect(rollup).toEqual({ modelUsage: { version: 1, buckets: [] }, totals: null, findings: ['counter-overflow'] });
  });
});
