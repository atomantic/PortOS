/**
 * Pure-logic tests for the broker case state machine + recheck backoff +
 * refresh parsers (issue #2144). No DB — the DB round-trip lives in
 * privacyBrokers.db.test.js.
 */

import { describe, it, expect } from 'vitest';
import {
  CASE_STATES,
  SCAN_VERDICTS,
  assertTransition,
  computeNextRecheckAt,
  parseCaRegistryCsv,
  parseBadboolList,
} from './privacyBrokers.js';

describe('assertTransition — valid paths', () => {
  it('allows every scan verdict from unscanned', () => {
    for (const to of SCAN_VERDICTS) {
      expect(() => assertTransition('unscanned', to)).not.toThrow();
    }
  });

  it('walks the opt-out lifecycle forward', () => {
    const chain = [
      ['found', 'optout_in_progress'],
      ['optout_in_progress', 'submitted'],
      ['submitted', 'verification_pending'],
      ['verification_pending', 'awaiting_processing'],
    ];
    for (const [from, to] of chain) expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('allows any state → human_task_queued', () => {
    for (const from of CASE_STATES) {
      if (from === 'human_task_queued') continue;
      expect(() => assertTransition(from, 'human_task_queued')).not.toThrow();
    }
  });

  it('allows idempotent same-state re-stamp', () => {
    expect(() => assertTransition('submitted', 'submitted')).not.toThrow();
  });
});

describe('assertTransition — confirmed_removed is rescan-only', () => {
  it('rejects confirmed_removed without viaRescan even from awaiting_processing', () => {
    expect(() => assertTransition('awaiting_processing', 'confirmed_removed'))
      .toThrowError(/only reachable from a verifying re-scan/i);
  });

  it('accepts confirmed_removed from awaiting_processing WITH viaRescan', () => {
    expect(() => assertTransition('awaiting_processing', 'confirmed_removed', { viaRescan: true })).not.toThrow();
  });

  it('rejects confirmed_removed from a submission state even with viaRescan', () => {
    // A submission page can never confirm removal — only verification_pending /
    // awaiting_processing / human_task_queued may.
    expect(() => assertTransition('submitted', 'confirmed_removed', { viaRescan: true }))
      .toThrowError(/invalid transition/i);
  });

  it('rejects a bare submitted → confirmed_removed (the classic hole)', () => {
    let code;
    try { assertTransition('submitted', 'confirmed_removed'); } catch (e) { code = e.code; }
    expect(code).toBe('CONFIRMED_REQUIRES_RESCAN');
  });
});

describe('assertTransition — reappeared is confirmed_removed + rescan only', () => {
  it('accepts confirmed_removed → reappeared via rescan', () => {
    expect(() => assertTransition('confirmed_removed', 'reappeared', { viaRescan: true })).not.toThrow();
  });
  it('rejects reappeared from any other state', () => {
    expect(() => assertTransition('found', 'reappeared', { viaRescan: true })).toThrow();
  });
  it('rejects reappeared without rescan', () => {
    expect(() => assertTransition('confirmed_removed', 'reappeared')).toThrow();
  });
});

describe('assertTransition — invalid transitions rejected', () => {
  it('rejects skipping the lifecycle (found → submitted)', () => {
    expect(() => assertTransition('found', 'submitted')).toThrowError(/invalid transition/i);
  });
  it('rejects an unknown target state', () => {
    let code;
    try { assertTransition('unscanned', 'banana'); } catch (e) { code = e.code; }
    expect(code).toBe('INVALID_CASE_STATE');
  });
  it('rejects an unknown source state', () => {
    expect(() => assertTransition('bogus', 'found')).toThrowError(/unknown case state/i);
  });
});

describe('computeNextRecheckAt — state-dependent backoff', () => {
  const now = new Date('2026-07-08T00:00:00.000Z');
  const days = (state) => (new Date(computeNextRecheckAt(state, now)) - now) / (24 * 60 * 60 * 1000);

  it('uses the documented backoffs', () => {
    expect(days('submitted')).toBe(3);
    expect(days('awaiting_processing')).toBe(7);
    expect(days('confirmed_removed')).toBe(30);
    expect(days('not_found')).toBe(60);
  });
  it('rechecks unscanned immediately (0 days)', () => {
    expect(days('unscanned')).toBe(0);
  });
  it('falls back to 14 days for an unmapped state', () => {
    expect(days('weird')).toBe(14);
  });
});

describe('parseCaRegistryCsv', () => {
  it('extracts name + url rows', () => {
    const csv = 'Business Name,Website URL\nAcme Data,https://acme.example\n"Beta, Inc.",https://beta.example';
    const out = parseCaRegistryCsv(csv);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ name: 'Acme Data', source: 'ca_registry', confidence: 'auto' });
    expect(out[0].id).toBe('ca-acme-data');
    expect(out[0].urls).toEqual({ home: 'https://acme.example' });
  });
  it('returns [] on empty / headerless input', () => {
    expect(parseCaRegistryCsv('')).toEqual([]);
    expect(parseCaRegistryCsv('just one line')).toEqual([]);
  });
});

describe('parseBadboolList', () => {
  it('normalizes a JSON array of broker entries', () => {
    const out = parseBadboolList([{ name: 'Foo Search', url: 'https://foo.example' }, { id: 'bar', name: 'Bar' }]);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: 'foo-search', name: 'Foo Search', source: 'badbool', confidence: 'auto' });
    expect(out[1].id).toBe('bar');
  });
  it('accepts a { brokers: [...] } wrapper and drops nameless rows', () => {
    const out = parseBadboolList({ brokers: [{ url: 'https://x.example' }, { name: 'Yes' }] });
    expect(out.map((b) => b.name)).toEqual(['Yes']);
  });
});
