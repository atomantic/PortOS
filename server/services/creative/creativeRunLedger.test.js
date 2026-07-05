import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { argsDigest, appendCreativeLedgerEntry, readCreativeLedger, MAX_LEDGER_ENTRIES } from './creativeRunLedger.js';

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
    for (let i = 0; i < MAX_LEDGER_ENTRIES + 5; i += 1) {
      await appendCreativeLedgerEntry('proj-1', { tool: `t.${i}`, outcome: 'executed' }, { dir });
    }
    const list = await readCreativeLedger('proj-1', { dir });
    expect(list.length).toBe(MAX_LEDGER_ENTRIES);
    expect(list[list.length - 1].tool).toBe(`t.${MAX_LEDGER_ENTRIES + 4}`);
  });

  it('returns [] for an absent ledger', async () => {
    expect(await readCreativeLedger('missing', { dir })).toEqual([]);
  });
});
