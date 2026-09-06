import { describe, expect, it } from 'vitest';
import {
  classifyMindRouteBilling,
  formatMindCallUsage,
  mindTurnElapsedMs,
  mindTurnOutcome,
  mintMindPresetId,
  sameMindRoute,
  temporaryMindTurns,
} from './mindThinkingPresets.js';

describe('classifyMindRouteBilling', () => {
  // The composer warns before spending the user's money, so the only failure
  // that matters is calling a billable route free. Every ambiguous shape must
  // therefore land on `spendsAccount: true`.
  it('treats a loopback HTTP backend as spending nothing', () => {
    const verdict = classifyMindRouteBilling({
      id: 'ollama', type: 'api', endpoint: 'http://127.0.0.1:11434',
    });
    expect(verdict.billing).toBe('local');
    expect(verdict.spendsAccount).toBe(false);
  });

  it('treats a canonical local backend with no endpoint as spending nothing', () => {
    // Every default an `ollama`/`lmstudio` record falls back to is a loopback
    // URL, so a blank endpoint on THAT record really is this machine.
    expect(classifyMindRouteBilling({ id: 'lmstudio', type: 'api' }).spendsAccount).toBe(false);
  });

  it('does NOT read a blank-endpoint cloud provider as local', () => {
    // `isLocalInstanceProvider` alone answers "true" here, which would badge a
    // paid vendor API as free — the exact regression this classification exists
    // to prevent.
    const verdict = classifyMindRouteBilling({
      id: 'example-cloud', name: 'Example Cloud', type: 'api', hasApiKey: true,
    });
    expect(verdict.billing).toBe('account');
    expect(verdict.spendsAccount).toBe(true);
  });

  it('reports a vendor CLI with no discoverable credential as unknown, not free', () => {
    const verdict = classifyMindRouteBilling({ id: 'example-cli', name: 'Example CLI', type: 'cli' });
    expect(verdict.billing).toBe('unknown');
    expect(verdict.spendsAccount).toBe(true);
  });

  it('reports a provider missing from the catalog as unknown, not free', () => {
    expect(classifyMindRouteBilling(null).spendsAccount).toBe(true);
  });
});

describe('formatMindCallUsage', () => {
  it('renders an unreported usage block as unknown rather than as zero', () => {
    expect(formatMindCallUsage({
      state: 'unknown', source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null,
    })).toBe('Usage unknown');
    expect(formatMindCallUsage(undefined)).toBe('Usage unknown');
  });

  it('renders a reported zero cost as a real measured value', () => {
    expect(formatMindCallUsage({
      state: 'reported', source: 'provider-reported', inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0,
    })).toBe('15 tokens · $0.0000');
  });
});

describe('mindTurnOutcome / mindTurnElapsedMs', () => {
  it('reads an unfinished turn as running rather than as a silent success', () => {
    expect(mindTurnOutcome({ turnId: 't', status: 'thinking', calls: [] })).toBe('running');
    expect(mindTurnElapsedMs({ turnId: 't', startedAt: '2026-09-01T00:00:00.000Z', calls: [] })).toBeNull();
  });

  it('keeps an in-flight multi-round turn running after an early round completes', () => {
    // A turn spans bounded tool rounds. Round 0 reporting `completed` is not a
    // finished turn, and the caller renders the answer as terminal.
    const turn = { turnId: 't', status: 'thinking', completedAt: null, calls: [{ outcome: 'completed', elapsedMs: 40 }] };
    expect(mindTurnOutcome(turn)).toBe('running');
  });

  it('falls back to the last receipt once the turn has finished', () => {
    const turn = {
      turnId: 't',
      status: 'thinking',
      completedAt: '2026-09-01T00:00:00.000Z',
      calls: [{ outcome: 'completed', elapsedMs: 40 }, { outcome: 'denied', elapsedMs: 2 }],
    };
    expect(mindTurnOutcome(turn)).toBe('denied');
    expect(mindTurnElapsedMs(turn)).toBe(42);
  });
});

describe('temporaryMindTurns', () => {
  it('keeps only turns that borrowed a route', () => {
    const turns = [
      { turnId: 'a', calls: [{ temporaryRoute: false }] },
      { turnId: 'b', thinkingPresetId: 'deep', calls: [{ temporaryRoute: true }] },
      { turnId: 'c', calls: [{ temporaryRoute: true }] },
    ];
    expect(temporaryMindTurns(turns).map((turn) => turn.turnId)).toEqual(['b', 'c']);
  });
});

describe('sameMindRoute', () => {
  it('ignores the label but not the effort', () => {
    const base = { providerId: 'p', model: 'm', effort: 'high' };
    expect(sameMindRoute(base, { ...base, label: 'Renamed' })).toBe(true);
    expect(sameMindRoute(base, { ...base, effort: 'low' })).toBe(false);
    expect(sameMindRoute({ providerId: 'p', model: 'm' }, { providerId: 'p', model: 'm', effort: '' })).toBe(true);
  });
});

describe('mintMindPresetId', () => {
  it('produces a server-legal id and never collides with an existing one', () => {
    const pattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
    expect(mintMindPresetId('Deep think')).toBe('deep-think');
    expect(mintMindPresetId('Deep think', ['deep-think'])).toBe('deep-think-2');
    // A label with no ASCII left still has to yield a usable id.
    expect(pattern.test(mintMindPresetId('🧠'))).toBe(true);
    expect(pattern.test(mintMindPresetId('-leading-dash'))).toBe(true);
  });
});
