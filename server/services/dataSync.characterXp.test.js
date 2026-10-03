/**
 * Character federation — cumulative XP accounting across independent histories (#9819).
 *
 * `xp` is a cumulative scalar that each grant bumps alongside an identified event. The merge
 * used `Math.max` on the counters while UNIONING the events, so two machines that each took a
 * different grant while disconnected kept both events but only the larger counter — the lesser
 * grant vanished from `xp` for good, with no local write race involved (the sequence is
 * strictly serial, so a write queue would not help).
 *
 * These tests drive the real federation boundary: a peer's record is written to
 * `character.json`, its wire snapshot is read through `getSnapshot('character')`, and a
 * snapshot is delivered with `applyRemote('character')`, so the wire projection, the merge,
 * and the persisted record are all the production code.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup, tempRoot } = mockPathsDataRoot({ prefix: 'portos-datasync-character-xp-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const dataSync = await import('./dataSync.js');

const CHARACTER_FILE = join(tempRoot, 'character.json');

afterAll(cleanup);

beforeEach(async () => {
  await mkdir(tempRoot, { recursive: true });
});

let tick = 0;
const nextTimestamp = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();

// A grant exactly as the writers (addXP/addEvent/…) record it: counter bumped AND an
// identified event carrying the same amount.
const grant = (record, id, amount, extra = {}) => ({
  ...record,
  xp: record.xp + amount,
  events: [...record.events, { id, type: 'xp', description: `grant ${id}`, xp: amount, timestamp: nextTimestamp(), ...extra }],
  updatedAt: nextTimestamp(),
});

const baseRecord = (overrides = {}) => ({
  name: 'Example', class: '', xp: 0, hp: 15, maxHp: 15,
  events: [], syncedJiraTickets: [], syncedTaskIds: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const persist = (record) => writeFile(CHARACTER_FILE, JSON.stringify(record));
const readPersisted = async () => JSON.parse(await readFile(CHARACTER_FILE, 'utf8'));

// One federation hop: `remote`'s wire snapshot lands on a machine whose character.json is `local`.
async function deliver(local, remote) {
  await persist(remote);
  const { data: wire } = await dataSync.getSnapshot('character');
  await persist(local);
  const result = await dataSync.applyRemote('character', wire);
  return { result, persisted: await readPersisted() };
}

describe('dataSync character — cumulative XP across independent grants', () => {
  it('shared base 100 + independent +25 / +50 converges to 175 on both peers and stays there on redelivery', async () => {
    const shared = grant(baseRecord(), 'base', 100);
    const a = grant(shared, 'grant-a', 25);
    const b = grant(shared, 'grant-b', 50);

    const onA = await deliver(a, b);
    const onB = await deliver(b, a);

    expect(onA.persisted.xp).toBe(175);
    expect(onB.persisted.xp).toBe(175);
    expect(onA.persisted.events.map((e) => e.id).sort()).toEqual(['base', 'grant-a', 'grant-b']);

    // Each machine now receives the other's MERGED record, and the same snapshot again.
    const reA = await deliver(onA.persisted, onB.persisted);
    const reB = await deliver(onB.persisted, onA.persisted);
    const again = await deliver(reA.persisted, onB.persisted);
    expect(reA.persisted.xp).toBe(175);
    expect(reB.persisted.xp).toBe(175);
    expect(again.persisted.xp).toBe(175);
    // A redelivered snapshot changes nothing, so it must not rewrite the record.
    expect(again.result.applied).toBe(false);
  });

  it('counts a repeated event ID once, with the existing event LWW picking the winning copy', async () => {
    // The same grant id carries different payloads on each side; the later timestamp wins.
    const older = { id: 'dup', type: 'xp', description: 'old copy', xp: 25, timestamp: '2026-02-01T00:00:00.000Z' };
    const newer = { ...older, description: 'new copy', xp: 40, timestamp: '2026-02-02T00:00:00.000Z' };
    const a = baseRecord({ xp: 25, events: [older] });
    const b = baseRecord({ xp: 40, events: [newer] });

    const { persisted } = await deliver(a, b);

    expect(persisted.events).toHaveLength(1);
    expect(persisted.events[0].description).toBe('new copy');
    expect(persisted.xp).toBe(40);
  });
});

describe('dataSync character — legacy XP the event ledger does not explain', () => {
  it('retains a legacy baseline with no events exactly once (not summed across peers)', async () => {
    const { persisted } = await deliver(baseRecord({ xp: 300 }), baseRecord({ xp: 300 }));
    expect(persisted.xp).toBe(300);
  });

  it('keeps the shared legacy baseline once while counting each side\'s independent grant', async () => {
    const legacy = baseRecord({ xp: 300 });
    const a = grant(legacy, 'grant-a', 25);
    const b = grant(legacy, 'grant-b', 50);

    const onA = await deliver(a, b);
    const onB = await deliver(b, a);

    expect(onA.persisted.xp).toBe(375);
    expect(onB.persisted.xp).toBe(375);
  });

  it('keeps a baseline that only the incomplete-ledger side carries', async () => {
    // A has 100 XP from before events existed; B is a fresh machine with one grant.
    const a = baseRecord({ xp: 100 });
    const b = grant(baseRecord(), 'grant-b', 50);

    expect((await deliver(a, b)).persisted.xp).toBe(150);
    expect((await deliver(b, a)).persisted.xp).toBe(150);
  });

  it('applies a baseline-only increase even when the peer snapshot is older than the local record', async () => {
    // No new events and an older peer updatedAt used to short-circuit the write entirely.
    const local = baseRecord({ xp: 100, updatedAt: '2026-06-01T00:00:00.000Z' });
    const remote = baseRecord({ xp: 150, updatedAt: '2026-03-01T00:00:00.000Z' });

    const { result, persisted } = await deliver(local, remote);

    expect(persisted.xp).toBe(150);
    expect(result.applied).toBe(true);
  });
});

describe('dataSync character — malformed history', () => {
  it('never produces NaN or loses legacy XP from empty, non-XP or malformed events', async () => {
    const local = baseRecord({
      xp: 200,
      events: [
        { id: 'rest-1', type: 'rest', xp: 0, hpRecovered: 4, timestamp: '2026-02-01T00:00:00.000Z' },
        { id: 'bad-string', type: 'xp', xp: '25', timestamp: '2026-02-02T00:00:00.000Z' },
        { id: 'bad-nan', type: 'xp', xp: Number.NaN, timestamp: '2026-02-03T00:00:00.000Z' },
        { id: 'bad-null', type: 'xp', xp: null, timestamp: '2026-02-04T00:00:00.000Z' },
        { id: 'bad-negative', type: 'xp', xp: -50, timestamp: '2026-02-05T00:00:00.000Z' },
        { id: 'no-xp-field', type: 'custom', timestamp: '2026-02-06T00:00:00.000Z' },
        { type: 'xp', xp: 10, timestamp: '2026-02-07T00:00:00.000Z' }, // no id → not a ledger entry
        null,
      ].filter(Boolean),
    });
    const remote = baseRecord({ xp: 'not-a-number', events: [{ id: 'rest-1', type: 'rest', timestamp: '2026-02-01T00:00:00.000Z' }] });

    const { persisted } = await deliver(local, remote);

    expect(Number.isFinite(persisted.xp)).toBe(true);
    // 200 total with no valid ledger entries: the whole amount stays as the unrepresented baseline.
    expect(persisted.xp).toBe(200);
  });

  it('lands a malformed remote xp as a number when there is no local character yet', async () => {
    await persist(baseRecord({ xp: 'garbage', events: [{ id: 'g1', type: 'xp', xp: 30, timestamp: nextTimestamp() }] }));
    const { data: wire } = await dataSync.getSnapshot('character');
    await rm(CHARACTER_FILE, { force: true });

    const result = await dataSync.applyRemote('character', wire);

    expect(result.applied).toBe(true);
    // The grant on the ledger is XP the counter must not read below.
    expect((await readPersisted()).xp).toBe(30);
  });
});

describe('dataSync character — wire projection agrees with persistence', () => {
  it('serves the reconciled xp, with the legacy level derived from it, on the next snapshot', async () => {
    // Pick grants whose SUM crosses a legacy level threshold but whose larger counter alone does not.
    const shared = grant(baseRecord(), 'base', 100);
    const a = grant(shared, 'grant-a', 150);
    const b = grant(shared, 'grant-b', 100);

    const { persisted } = await deliver(a, b);
    expect(persisted.xp).toBe(350);

    const { data: wire } = await dataSync.getSnapshot('character');
    expect(wire.xp).toBe(persisted.xp);
    // Legacy curve: 300 ≤ 350 < 900 ⇒ level 2. Max-only merging would have read 250 ⇒ level 1.
    expect(wire.level).toBe(2);
    expect(persisted.level).toBeUndefined();
  });
});
