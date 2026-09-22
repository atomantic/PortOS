/**
 * The completion-order projection's reason to exist: a page of completed runs
 * must cost the rows it returns, not the size of the day it returns them from
 * (#7968). Every case here counts the actual filesystem work — a regression to
 * "read the whole day, then sort it" shows up as a day scan that a warm index
 * must never perform.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join: joinPath } = await import('node:path');
  return await mkdtemp(joinPath(tmpdir(), 'cos-completion-order-'));
});

// Counts the two reads that separate "bounded page" from "scan the day":
// one metadata.json per returned row, and a readdir of the date bucket.
const io = vi.hoisted(() => ({ metadata: 0, dayScans: 0 }));

vi.mock('./cosState.js', () => ({ AGENTS_DIR: fixture }));
vi.mock('./codexSummaryRepair.js', () => ({ repairCodexTaskSummary: vi.fn(async () => null) }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  const dateBucket = /[\\/]\d{4}-\d{2}-\d{2}$/;
  return {
    ...actual,
    readFile: async (path, ...rest) => {
      if (String(path).endsWith('metadata.json')) io.metadata += 1;
      return actual.readFile(path, ...rest);
    },
    readdir: async (path, ...rest) => {
      if (dateBucket.test(String(path))) io.dayScans += 1;
      return actual.readdir(path, ...rest);
    },
  };
});

import { encodeCompletionOrder } from '../lib/cosAgentCompletionOrder.js';

// Both modules under test memoize their index for the process, so each case
// re-imports them after vi.resetModules() rather than sharing a warm singleton
// across fixtures.

const DAY = '2026-03-04';
const DAY_SIZE = 10000;
// Only the newest slice is written to disk, so a day scan cannot masquerade as a
// bounded read: the projection alone has to order the other 9,940 runs.
const ON_DISK = 60;

const agentIdAt = (i) => `agent-${String(i).padStart(5, '0')}`;
const completedAtAt = (i) => new Date(Date.parse(`${DAY}T00:00:00.000Z`) + i * 1000).toISOString();
const recordAt = (i) => ({
  id: agentIdAt(i),
  status: 'completed',
  completedAt: completedAtAt(i),
  metadata: { taskType: 'user', taskDescription: `Synthetic run ${i}` },
});

async function writeArchive(record, day = DAY) {
  const dir = join(fixture, day, record.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'metadata.json'), JSON.stringify(record));
}

async function seedBusyDay() {
  await rm(fixture, { recursive: true, force: true });
  await mkdir(join(fixture, DAY), { recursive: true });
  const index = {};
  const projections = new Map();
  for (let i = 0; i < DAY_SIZE; i += 1) {
    index[agentIdAt(i)] = DAY;
    projections.set(agentIdAt(i), { completedAt: completedAtAt(i), completed: true, feedbackEligible: true });
  }
  await writeFile(join(fixture, 'index.json'), JSON.stringify(index));
  await writeFile(join(fixture, 'index.order.json'), JSON.stringify(encodeCompletionOrder(projections)));
  for (let i = DAY_SIZE - ON_DISK; i < DAY_SIZE; i += 1) await writeArchive(recordAt(i));
}

beforeEach(() => {
  io.metadata = 0;
  io.dayScans = 0;
  vi.resetModules();
});

afterAll(() => rm(fixture, { recursive: true, force: true }));

describe('bounded paging over a busy archive day (#7968)', () => {
  it('reads one metadata record per returned row and never scans the day', async () => {
    await seedBusyDay();
    const index = await import('./cosAgentIndex.js');

    const first = await index.getCompletedAgentPage({ limit: 25 });
    expect(first.items.map((agent) => agent.id))
      .toEqual(Array.from({ length: 25 }, (_, n) => agentIdAt(DAY_SIZE - 1 - n)));
    expect(first.total).toBe(DAY_SIZE);
    // limit + 1: the extra row is what proves another page exists.
    expect(io.metadata).toBeLessThanOrEqual(26);
    expect(io.dayScans).toBe(0);

    io.metadata = 0;
    const second = await index.getCompletedAgentPage({ limit: 25, cursor: first.nextCursor });
    expect(second.items.map((agent) => agent.id))
      .toEqual(Array.from({ length: 25 }, (_, n) => agentIdAt(DAY_SIZE - 26 - n)));
    expect(io.metadata).toBeLessThanOrEqual(26);
    expect(io.dayScans).toBe(0);
  });

  it('refills a page past an archive that went missing, without skipping or duplicating a row', async () => {
    await seedBusyDay();
    // Erase two records inside the first page's window — the projection still
    // orders them, so the page must fall through to the next ordered rows.
    await rm(join(fixture, DAY, agentIdAt(DAY_SIZE - 5)), { recursive: true, force: true });
    await rm(join(fixture, DAY, agentIdAt(DAY_SIZE - 6)), { recursive: true, force: true });
    const index = await import('./cosAgentIndex.js');

    const page = await index.getCompletedAgentPage({ limit: 25 });
    const ids = page.items.map((agent) => agent.id);
    expect(new Set(ids).size).toBe(25);
    expect(ids).not.toContain(agentIdAt(DAY_SIZE - 5));
    expect(ids).not.toContain(agentIdAt(DAY_SIZE - 6));
    expect(ids.at(-1)).toBe(agentIdAt(DAY_SIZE - 27));
    expect(io.dayScans).toBe(0);
  });
});

describe('projection maintenance', () => {
  it('reads a federation-imported day once, then answers from the projection it learned', async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'index.json'), '{}');
    for (let i = 0; i < 3; i += 1) await writeArchive(recordAt(i), '2026-03-05');
    const index = await import('./cosAgentIndex.js');
    // The peer receiver unions ids into the legacy map and knows nothing about
    // completion order — the imported day must still be listed, not skipped.
    await index.addAgentArchivesToIndex(
      Array.from({ length: 3 }, (_, i) => ({ agentId: agentIdAt(i), date: '2026-03-05' })),
    );

    const first = await index.getCompletedAgentPage({ limit: 25 });
    expect(first.items.map((agent) => agent.id)).toEqual([agentIdAt(2), agentIdAt(1), agentIdAt(0)]);
    expect(io.dayScans).toBe(1);

    io.dayScans = 0;
    const again = await index.getCompletedAgentPage({ limit: 25 });
    expect(again.items.map((agent) => agent.id)).toEqual(first.items.map((agent) => agent.id));
    expect(io.dayScans).toBe(0);
  });

  it('drops a projection whose id the archive index no longer owns', async () => {
    await rm(fixture, { recursive: true, force: true });
    await mkdir(fixture, { recursive: true });
    await writeFile(join(fixture, 'index.json'), '{}');
    for (let i = 0; i < 2; i += 1) await writeArchive(recordAt(i), '2026-03-06');
    const index = await import('./cosAgentIndex.js');
    const order = await import('./cosAgentCompletionIndex.js');
    await index.addAgentArchivesToIndex(
      Array.from({ length: 2 }, (_, i) => ({ agentId: agentIdAt(i), date: '2026-03-06' })),
    );
    await index.getCompletedAgentPage({ limit: 25 });
    expect([...(await order.loadCompletionOrderIndex()).keys()].sort()).toEqual([agentIdAt(0), agentIdAt(1)]);

    // Every delete / retention prune / clear-completed path ends in saveAgentIndex.
    (await index.loadAgentIndex()).delete(agentIdAt(0));
    await index.saveAgentIndex();

    expect([...(await order.loadCompletionOrderIndex()).keys()]).toEqual([agentIdAt(1)]);
    expect((await index.getCompletedAgentPage({ limit: 25 })).items.map((agent) => agent.id))
      .toEqual([agentIdAt(1)]);
  });
});
