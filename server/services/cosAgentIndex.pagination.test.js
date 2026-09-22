import { afterAll, expect, it, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const fixture = await vi.hoisted(async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return await mkdtemp(join(tmpdir(), 'cos-history-page-'));
});
vi.mock('./cosState.js', () => ({ AGENTS_DIR: fixture }));
vi.mock('./codexSummaryRepair.js', () => ({ repairCodexTaskSummary: vi.fn(async () => null) }));
import { repairCodexTaskSummary } from './codexSummaryRepair.js';
import { getCompletedAgentPage, loadAgentIndex } from './cosAgentIndex.js';
afterAll(() => rm(fixture, { recursive: true, force: true }));

it('pages busy days with stable ties, live/archive deduplication and additions between reads', async () => {
  const date = '2026-01-02';
  const records = Array.from({ length: 65 }, (_, i) => ({ id: `agent-${String(i).padStart(3, '0')}`, status: 'completed', completedAt: `${date}T12:00:00.000Z`, metadata: {} }));
  await writeFile(join(fixture, 'index.json'), JSON.stringify(Object.fromEntries(records.map(agent => [agent.id, date]))));
  for (const agent of records) {
    const dir = join(fixture, date, agent.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(agent));
  }
  const liveAgents = [{ ...records[64], metadata: { taskSummary: 'Fresh live summary' } }];
  const first = await getCompletedAgentPage({ liveAgents, limit: 25 });
  expect(first.items).toHaveLength(25);
  expect(first.items[0].metadata.taskSummary).toBe('Fresh live summary');
  expect(first.total).toBe(65);
  expect(repairCodexTaskSummary).not.toHaveBeenCalled();
  // Newer completions must not shift the stable cursor or duplicate a row.
  liveAgents.push({ id: 'agent-new', status: 'completed', completedAt: '2026-01-03T12:00:00.000Z' });
  const second = await getCompletedAgentPage({ liveAgents, limit: 25, cursor: first.nextCursor });
  const third = await getCompletedAgentPage({ liveAgents, limit: 25, cursor: second.nextCursor });
  expect(second.items).toHaveLength(25);
  expect(third.items).toHaveLength(15);
  expect(third.nextCursor).toBeNull();
  expect(new Set([...first.items, ...second.items, ...third.items].map(agent => agent.id)).size).toBe(65);
  // A removed cursor record is still a valid boundary.
  const index = await loadAgentIndex();
  index.delete(first.items.at(-1).id);
  await rm(join(fixture, date, first.items.at(-1).id), { recursive: true });
  expect((await getCompletedAgentPage({ limit: 25, cursor: first.nextCursor })).items).toEqual(second.items);
});
