import { describe, expect, it } from 'vitest';
import {
  ALL_TOKEN_FIELDS,
  BASE_TOKEN_FIELDS,
  FAST_LEDGER_FIELDS,
  LONG_USAGE_FIELDS,
  MEDIA_USAGE_FIELDS,
  mergeCodexBoundary,
  rebuildDayTotals,
  SPEED_CLASS_FIELDS,
  SPEED_LEDGER_FIELDS,
  TOKEN_FIELDS,
  TOKEN_TIER_FIELDS,
  ULTRAFAST_LEDGER_FIELDS,
  USAGE_COUNT_FIELDS,
} from './usageFields.js';

describe('usageFields', () => {
  it('composes canonical field groups without duplicates', () => {
    expect(TOKEN_FIELDS).toEqual(['messages', ...BASE_TOKEN_FIELDS]);
    expect(SPEED_LEDGER_FIELDS).toEqual([...FAST_LEDGER_FIELDS, ...ULTRAFAST_LEDGER_FIELDS]);
    expect(SPEED_CLASS_FIELDS).toEqual([FAST_LEDGER_FIELDS, ULTRAFAST_LEDGER_FIELDS]);
    expect(TOKEN_TIER_FIELDS).toEqual([...BASE_TOKEN_FIELDS, ...LONG_USAGE_FIELDS, ...SPEED_LEDGER_FIELDS]);
    expect(ALL_TOKEN_FIELDS).toEqual(['messages', ...TOKEN_TIER_FIELDS]);
    expect(USAGE_COUNT_FIELDS).toEqual([...ALL_TOKEN_FIELDS, ...MEDIA_USAGE_FIELDS]);
    expect(new Set(USAGE_COUNT_FIELDS).size).toBe(USAGE_COUNT_FIELDS.length);
  });

  it('merges Codex boundaries by per-field max and omits zero speed fields', () => {
    const merged = mergeCodexBoundary(
      { messages: 3, tokensIn: 100, tokensOut: 40, cacheReadTokens: 20, cacheWriteTokens: 0, fastTokensIn: 50 },
      { messages: 2, tokensIn: 120, tokensOut: 30, cacheReadTokens: 25, cacheWriteTokens: 10, ultrafastTokensOut: 15 },
    );
    expect(merged).toEqual({
      messages: 3,
      tokensIn: 120,
      tokensOut: 40,
      cacheReadTokens: 25,
      cacheWriteTokens: 10,
      fastTokensIn: 50,
      ultrafastTokensOut: 15,
    });
    expect('fastTokensOut' in merged).toBe(false);
    expect('ultrafastTokensIn' in merged).toBe(false);
  });

  it('rebuilds day totals from byProvider while ignoring non-finite or negative values', () => {
    const day = {
      byProvider: {
        a: { sessions: 2, messages: 5, tokensIn: 100, tokensOut: 30 },
        b: { sessions: -1, messages: Number.NaN, tokensIn: 50, tokensOut: 20 },
      },
    };
    rebuildDayTotals(day);
    expect(day.sessions).toBe(2);
    expect(day.messages).toBe(5);
    expect(day.tokensIn).toBe(150);
    expect(day.tokensOut).toBe(50);
    expect(day.tokens).toBe(50);
  });
});
