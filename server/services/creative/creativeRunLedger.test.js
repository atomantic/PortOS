import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { argsDigest, appendCreativeLedgerEntry, readCreativeLedger, countDailyBudgetedEntries, utcDayKey, MAX_LEDGER_ENTRIES } from './creativeRunLedger.js';

describe('argsDigest', () => {
  it("returns 'none' for null / non-object", () => {
    expect(argsDigest(null)).toBe('none');
    expect(argsDigest(undefined)).toBe('none');
    expect(argsDigest('str')).toBe('none');
  });

  it('lists sorted keys with a stable hash and is order-independent', () => {
    const a = argsDigest({ b: 1, a: 2 });
    const b = argsDigest({ a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a.startsWith('a,b#')).toBe(true);
  });

  it('changes when a value changes', () => {
    expect(argsDigest({ a: 1 })).not.toBe(argsDigest({ a: 2 }));
  });
});

describe('creative run ledger store', () => {
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'creative-ledger-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends entries and reads them back chronologically', async () => {
    await appendCreativeLedgerEntry('proj-1', { tool: 'a.x', outcome: 'executed' }, { dir });
    await appendCreativeLedgerEntry('proj-1', { tool: 'a.y', outcome: 'planned' }, { dir });
    const list = await readCreativeLedger('proj-1', { dir });
    expect(list.map((e) => e.tool)).toEqual(['a.x', 'a.y']);
    expect(typeof list[0].at).toBe('string');
  });

  it('scopes ledgers per project', async () => {
    await appendCreativeLedgerEntry('proj-1', { tool: 'a.x', outcome: 'executed' }, { dir });
    expect(await readCreativeLedger('proj-2', { dir })).toEqual([]);
  });

  it('caps at MAX_LEDGER_ENTRIES, keeping the most recent', async () => {
    // Exercise retention through the public append boundary with a persisted
    // full ledger, without 505 durable setup writes timing out on Windows.
    const existing = Array.from({ length: MAX_LEDGER_ENTRIES }, (_, i) => ({
      at: '2026-01-01T00:00:00.000Z', tool: `t.${i}`, outcome: 'executed',
    }));
    await writeFile(join(dir, 'proj-1.json'), JSON.stringify(existing));
    await appendCreativeLedgerEntry('proj-1', { tool: `t.${MAX_LEDGER_ENTRIES}`, outcome: 'executed' }, { dir });
    const list = await readCreativeLedger('proj-1', { dir });
    expect(list.length).toBe(MAX_LEDGER_ENTRIES);
    expect(list[0]).toEqual(existing[1]);
    expect(list[list.length - 1].tool).toBe(`t.${MAX_LEDGER_ENTRIES}`);
  });

  it('returns [] for an absent ledger', async () => {
    expect(await readCreativeLedger('missing', { dir })).toEqual([]);
  });
});

describe('countDailyBudgetedEntries / utcDayKey', () => {
  it('resolves UTC calendar day keys and rejects invalid timestamps', () => {
    expect(utcDayKey('2026-11-23T23:59:59.000Z')).toBe('2026-11-23');
    expect(utcDayKey('2026-11-23T22:00:00-05:00')).toBe('2026-11-24');
    expect(utcDayKey(null)).toBeNull();
    expect(utcDayKey('not-a-date')).toBeNull();
  });

  it('counts only same-UTC-day executed budgeted non-selfBudgeted entries', () => {
    const entries = [
      { at: '2026-11-23T00:05:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'executed' },
      { at: '2026-11-23T01:00:00.000Z', tool: 'media_enqueueImageJob', costClass: 'render', outcome: 'executed' },
      // Free tool does not count
      { at: '2026-11-23T02:00:00.000Z', tool: 'pipeline_createSeries', costClass: 'free', outcome: 'executed' },
      // Self-budgeted tool does not count
      { at: '2026-11-23T03:00:00.000Z', tool: 'pipeline_startSeriesAutopilot', costClass: 'llm', outcome: 'executed' },
      // Non-executed outcomes do not count
      { at: '2026-11-23T04:00:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'planned' },
      { at: '2026-11-23T05:00:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'rejected' },
      { at: '2026-11-23T06:00:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'budget-exceeded' },
      { at: '2026-11-23T07:00:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'error' },
      // Prior UTC day does not count
      { at: '2026-11-22T23:59:59.999Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'executed' },
      // Next UTC day does not count
      { at: '2026-11-24T00:00:00.000Z', tool: 'pipeline_generateStage', costClass: 'llm', outcome: 'executed' },
    ];
    expect(countDailyBudgetedEntries(entries, {
      dayKey: '2026-11-23',
      isSelfBudgeted: (name) => name === 'pipeline_startSeriesAutopilot',
    })).toBe(2);
  });
});
