import { describe, expect, it, vi } from 'vitest';
import { detectQuotaBurn, selectBurnCandidates } from './quotaBurn.js';
import { sanitizeTaskMetadata } from '../lib/validation.js';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const config = {
  families: {
    grok: { enabled: true, prompt: 'Animate eligible sprites.', resetWithinHours: 24, reservePercent: 20, maxDispatchesPerWindow: 2 },
    codex: { enabled: true, prompt: 'Prepare assets.', resetWithinHours: 24, reservePercent: 0, priority: 1 },
  },
};
const quota = (family, resetsAt, percentRemaining = 50, extras = {}) => ({
  family, supported: true, limits: [{ key: 'week', scope: 'week', label: 'Weekly', resetsAt, percentRemaining }], ...extras,
});

describe('selectBurnCandidates', () => {
  it('selects burnable windows by reset time then priority', () => {
    const candidates = selectBurnCandidates([
      quota('codex', '2026-07-27T00:00:00.000Z'),
      quota('grok', '2026-07-26T18:00:00.000Z'),
    ], config, { now: NOW });
    expect(candidates.map((candidate) => candidate.family.id)).toEqual(['grok', 'codex']);
  });

  it('skips unknown, out-of-window, reserved, unsupported, and exhausted windows', () => {
    expect(selectBurnCandidates([quota('grok', null)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-28T12:00:00.000Z')], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 20)], config, { now: NOW })).toEqual([]);
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z', 50, { supported: false })], config, { now: NOW })).toEqual([]);
    const selected = selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, { now: NOW })[0];
    expect(selectBurnCandidates([quota('grok', '2026-07-26T18:00:00.000Z')], config, {
      now: NOW, dispatches: { [selected.dispatchKey]: 2 },
    })).toEqual([]);
  });
});

describe('detectQuotaBurn', () => {
  it('parks an empty configuration without reading provider usage', async () => {
    const getQuotas = vi.fn();
    await expect(detectQuotaBurn({ taskTypeOverrides: {} }, { getQuotas, now: NOW }))
      .resolves.toMatchObject({ actionable: false, reason: 'no-enabled-families' });
    expect(getQuotas).not.toHaveBeenCalled();
  });

  it('reports a transient result when every configured quota probe failed', async () => {
    await expect(detectQuotaBurn({ taskTypeOverrides: { 'quota-burn': { taskMetadata: config } } }, {
      getQuotas: async () => [quota('grok', null, 0, { error: 'signed out' })], now: NOW,
    })).resolves.toMatchObject({ actionable: false, transient: true });
  });
});

describe('quota-burn metadata validation', () => {
  it('keeps valid family configuration and rejects unknown families or unsafe reserves', () => {
    expect(sanitizeTaskMetadata({ families: { grok: { enabled: true, reservePercent: 20 } } }))
      .toMatchObject({ families: { grok: { enabled: true, reservePercent: 20 } } });
    expect(sanitizeTaskMetadata({ families: { unknown: { enabled: true } } })).toBeNull();
    expect(sanitizeTaskMetadata({ families: { grok: { reservePercent: 101 } } })).toBeNull();
  });
});
