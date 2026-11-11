import { describe, expect, it } from 'vitest';
import { overlayNativeUsage } from './nativeUsageOverlay.js';

const providers = [
  { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude' },
  { id: 'claude-tui', name: 'Claude TUI', type: 'tui', command: 'claude' },
  { id: 'anthropic-api', name: 'Anthropic API', type: 'api', endpoint: 'https://api.example.com' },
  { id: 'codex', name: 'Codex', type: 'cli', command: 'codex' },
];

const counts = (tokensIn, tokensOut, extra = {}) => ({ messages: 1, tokensIn, tokensOut, cacheReadTokens: 0, cacheWriteTokens: 0, ...extra });
const store = (days, { coverageStart = '2026-07-01', updatedAt = '2026-07-20T12:00:00.000Z' } = {}) => ({ days, coverageStart, updatedAt });
const native = (input, output, extra = {}) => ({ messages: 2, input, output, cacheRead: 0, cacheWrite: 0, ...extra });

describe('overlayNativeUsage', () => {
  it('replaces measured counts with the app history and keeps estimates, sessions, images and API providers', () => {
    const ledger = {
      '2026-07-10': {
        sessions: 3, byProvider: {
          'claude-code': {
            name: 'Claude Code', sessions: 2, ...counts(130, 60), source: 'mixed', estimated: counts(30, 10),
            byModel: { 'model-a': { sessions: 2, ...counts(130, 60), source: 'mixed', estimated: counts(30, 10) } },
          },
          'anthropic-api': { name: 'Anthropic API', sessions: 1, ...counts(5, 5), source: 'measured', byModel: { 'model-a': { ...counts(5, 5), source: 'measured' } } },
          codex: { name: 'Codex', sessions: 0, ...counts(0, 0), images: 3, byModel: { 'image-model': { images: 3, ...counts(0, 0) } } },
        },
      },
    };
    const out = overlayNativeUsage(ledger, { stores: { claude: store({ '2026-07-10': { 'model-a': native(1000, 400) } }) }, providers });
    const claude = out['2026-07-10'].byProvider['claude-code'];
    expect(claude).toMatchObject({ sessions: 2, tokensIn: 1030, tokensOut: 410, messages: 3, source: 'mixed' });
    expect(claude.byModel['model-a']).toMatchObject({ sessions: 2, tokensIn: 1030, tokensOut: 410, source: 'mixed' });
    expect(out['2026-07-10'].byProvider['anthropic-api']).toEqual(ledger['2026-07-10'].byProvider['anthropic-api']);
    expect(out['2026-07-10'].byProvider.codex.images).toBe(3);
    expect(out['2026-07-10']).toMatchObject({ sessions: 3, tokensIn: 1035, tokensOut: 415 });
    // The input is not modified.
    expect(ledger['2026-07-10'].byProvider['claude-code'].tokensIn).toBe(130);
  });

  it('drops measured counts of every family provider, not only the reported one', () => {
    const ledger = { '2026-07-10': { byProvider: {
      'claude-tui': { name: 'Claude TUI', ...counts(50, 50), source: 'measured', byModel: { 'model-a': { ...counts(50, 50), source: 'measured' } } },
    } } };
    const out = overlayNativeUsage(ledger, { stores: { claude: store({ '2026-07-10': { 'model-a': native(100, 20) } }) }, providers });
    expect(out['2026-07-10'].byProvider['claude-tui']).toMatchObject({ tokensIn: 0, tokensOut: 0 });
    expect(out['2026-07-10'].byProvider['claude-code']).toMatchObject({ tokensIn: 100, tokensOut: 20, source: 'measured' });
    expect(out['2026-07-10'].tokensIn).toBe(100);
  });

  it('reads buckets from before the estimated split by their source label', () => {
    const ledger = { '2026-07-10': { byProvider: { 'claude-code': { name: 'Claude Code', ...counts(80, 20), byModel: {
      'model-a': { ...counts(50, 10), source: 'measured' },
      'model-b': { ...counts(30, 10), source: 'estimate' },
    } } } } };
    const out = overlayNativeUsage(ledger, { stores: { claude: store({ '2026-07-10': { 'model-a': native(500, 50) } }) }, providers });
    const provider = out['2026-07-10'].byProvider['claude-code'];
    expect(provider.byModel['model-a']).toMatchObject({ tokensIn: 500, tokensOut: 50, source: 'measured' });
    expect(provider.byModel['model-b']).toMatchObject({ tokensIn: 30, tokensOut: 10, source: 'estimate' });
    // Provider totals match its models, whether the provider was unlabeled or mixed.
    expect(provider).toMatchObject({ tokensIn: 530, tokensOut: 60 });
    const mixed = structuredClone(ledger);
    mixed['2026-07-10'].byProvider['claude-code'].source = 'mixed';
    expect(overlayNativeUsage(mixed, { stores: { claude: store({ '2026-07-10': { 'model-a': native(500, 50) } }) }, providers })['2026-07-10']
      .byProvider['claude-code']).toMatchObject({ tokensIn: 530, tokensOut: 60 });
  });

  it('before coverage uses the app history only where it shows more than the ledger', () => {
    const ledger = {
      '2026-06-01': { byProvider: { 'claude-code': { name: 'Claude Code', ...counts(900, 100), source: 'measured', byModel: { 'model-a': { ...counts(900, 100), source: 'measured' } } } } },
      '2026-06-02': { byProvider: { 'claude-code': { name: 'Claude Code', ...counts(10, 10), source: 'measured', byModel: { 'model-a': { ...counts(10, 10), source: 'measured' } } } } },
    };
    const out = overlayNativeUsage(ledger, { stores: { claude: store({
      '2026-06-01': { 'model-a': native(100, 10) }, // pruned: partial
      '2026-06-02': { 'model-a': native(400, 40) },
    }) }, providers });
    expect(out['2026-06-01'].byProvider['claude-code'].tokensIn).toBe(900);
    expect(out['2026-06-02'].byProvider['claude-code'].tokensIn).toBe(400);
  });

  it('replaces an equal pre-coverage base when the native row carries more speed', () => {
    const ledger = {
      '2026-06-01': { byProvider: { codex: { name: 'Codex', ...counts(100, 10), source: 'measured', byModel: { 'model-c': { ...counts(100, 10), source: 'measured' } } } } },
    };
    const out = overlayNativeUsage(ledger, { stores: { codex: store({
      '2026-06-01': { 'model-c': native(100, 10, { fastInput: 100, fastOutput: 10 }) },
    }, { coverageStart: '2026-07-01' }) }, providers });
    expect(out['2026-06-01'].byProvider.codex.byModel['model-c']).toMatchObject({ tokensIn: 100, fastTokensIn: 100, fastTokensOut: 10 });
  });

  it('keeps a larger pre-coverage ledger when the native row is smaller, even with speed', () => {
    const ledger = {
      '2026-06-01': { byProvider: { codex: { name: 'Codex', ...counts(900, 100), source: 'measured', byModel: { 'model-c': { ...counts(900, 100), source: 'measured' } } } } },
    };
    const out = overlayNativeUsage(ledger, { stores: { codex: store({
      '2026-06-01': { 'model-c': native(100, 10, { fastInput: 100 }) },
    }, { coverageStart: '2026-07-01' }) }, providers });
    expect(out['2026-06-01'].byProvider.codex.tokensIn).toBe(900);
    expect(out['2026-06-01'].byProvider.codex.fastTokensIn).toBeUndefined();
  });

  it('keeps the ledger after the last refresh, and ignores a store with no history', () => {
    const ledger = { '2026-07-25': { byProvider: { 'claude-code': { name: 'Claude Code', ...counts(10, 10), source: 'measured', byModel: {} } } } };
    const later = overlayNativeUsage(ledger, { stores: { claude: store({ '2026-07-10': { 'model-a': native(1, 1) } }) }, providers });
    expect(later['2026-07-25']).toEqual(ledger['2026-07-25']);
    expect(overlayNativeUsage(ledger, { stores: { claude: store({}) }, providers })).toBe(ledger);
    expect(overlayNativeUsage(ledger, { stores: { claude: { days: { '2026-07-25': { m: native(1, 1) } }, updatedAt: null, coverageStart: null } }, providers })).toBe(ledger);
  });

  it('adds days PortOS never saw and reports them without a configured provider', () => {
    const out = overlayNativeUsage({}, { stores: { codex: store({ '2026-07-05': { 'model-c': native(70, 7, { cacheRead: 300 }) } }) }, providers: [] });
    expect(out['2026-07-05'].byProvider['native-codex']).toMatchObject({ name: 'Codex', tokensIn: 70, tokensOut: 7, cacheReadTokens: 300, source: 'measured' });
    expect(out['2026-07-05']).toMatchObject({ tokensIn: 70, tokensOut: 7 });
  });

  it('reports under an enabled CLI provider when the first one is disabled', () => {
    const out = overlayNativeUsage({}, { stores: { claude: store({ '2026-07-05': { 'model-a': native(10, 1) } }) },
      providers: [{ ...providers[0], enabled: false }, ...providers.slice(1)] });
    expect(Object.keys(out['2026-07-05'].byProvider)).toEqual(['claude-tui']);
  });

  it('carries Grok long-context subsets for pricing', () => {
    const out = overlayNativeUsage({}, { stores: { grok: store({ '2026-07-05': { 'grok-x': native(300000, 10, { longInput: 300000, longOutput: 10 }) } }) }, providers: [] });
    expect(out['2026-07-05'].byProvider['native-grok'].byModel['grok-x']).toMatchObject({ longTokensIn: 300000, longTokensOut: 10 });
  });
});
