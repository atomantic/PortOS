import { describe, expect, it } from 'vitest';
import { nativeAgyUsageProjectionSchema, unionNativeAgyRecords } from './nativeAgyUsageRecords.js';

const record = (key = 'a', response = 'b') => ({ recordKey: key.repeat(64), responseKeys: [response.repeat(64)],
  values: [10, 5, 100, 0, 3, 2], model: 342, apiProvider: 24, stepType: 15,
  at: '2026-03-01T00:00:00.000Z', completedAt: '2026-03-01T00:00:01.000Z', conflict: false, final: true });
const projection = records => ({ version: 1, identityScheme: 'sha256-agy-message-response/1', truncated: false, records });

describe('Antigravity native record union', () => {
  it('deduplicates three participants and keeps six raw counters separate without inferring total or spend', () => {
    const row = record();
    const other = record('c', 'd');
    other.stepType = 23;
    const result = unionNativeAgyRecords([projection([row]), projection([row, other]), projection([other])]);
    expect(result).toMatchObject({ totals: { totalTokens: null, tokensIn: 20, tokensOut: 10, cacheReadTokens: 200,
      cacheWriteTokens: 0, thinkingOutputTokens: 6, responseOutputTokens: 4 }, coverage: { uniqueRecords: 2, measuredRecords: 2, duplicateRecords: 2 } });
    expect(result).not.toHaveProperty('cost');
    expect(nativeAgyUsageProjectionSchema.safeParse(projection(result.projectedRecords)).success).toBe(true);
  });

  it('preserves both identity indexes and deterministic tombstones so conflicting copies cannot be resurrected', () => {
    const first = record();
    const sameMessage = record('a', 'c');
    const sameResponse = record('d', 'b');
    const copies = [projection([first]), projection([sameMessage, sameResponse])];
    const result = unionNativeAgyRecords(copies);
    expect(result.totals).toBeNull();
    expect(result.coverage.excluded).toEqual({ 'conflicting-records': 2 });
    expect(result.projectedRecords[0].responseKeys).toEqual(['b'.repeat(64), 'c'.repeat(64)]);
    expect(unionNativeAgyRecords([...copies].reverse())).toEqual(result);
    expect(unionNativeAgyRecords([projection([first]), projection(result.projectedRecords)]).totals).toBeNull();
  });

  it('excludes counter/model/time disagreements, nonfinal responses and invalid output decomposition', () => {
    for (const change of [{ values: [11, 5, 100, 0, 3, 2] }, { model: 343 }, { completedAt: '2026-03-01T00:00:02.000Z' }]) {
      expect(unionNativeAgyRecords([projection([record()]), projection([{ ...record(), ...change }])]).totals).toBeNull();
    }
    expect(unionNativeAgyRecords([projection([{ ...record(), final: false }])]).coverage.excluded).toEqual({ 'unfinalized-records': 1 });
    expect(unionNativeAgyRecords([projection([{ ...record(), values: [10, 6, 100, 0, 3, 2] }])]).coverage.excluded).toEqual({ 'inconsistent-records': 1 });
  });

  it('refuses unsafe totals while validating strict private records and allowing opaque unknown model enums', () => {
    const huge = { ...record(), model: -1, values: [Number.MAX_SAFE_INTEGER, 5, 100, 0, 3, 2] };
    expect(nativeAgyUsageProjectionSchema.safeParse(projection([huge])).success).toBe(true);
    expect(unionNativeAgyRecords([projection([huge, record('c', 'd')])])).toMatchObject({ totals: null, findings: expect.arrayContaining(['counter-overflow']) });
    for (const rows of [[{ ...record(), privatePrompt: 'private' }], [record(), record()], [{ ...record(), values: [null] }]]) {
      expect(nativeAgyUsageProjectionSchema.safeParse(projection(rows)).success).toBe(false);
    }
  });
});
