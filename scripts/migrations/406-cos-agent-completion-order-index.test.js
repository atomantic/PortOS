import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration from './406-cos-agent-completion-order-index.js';
import { decodeCompletionOrder } from '../../server/lib/cosAgentCompletionOrder.js';

const AGENTS_REL = join('data', 'cos', 'agents');

let rootDir;

const agentsDir = () => join(rootDir, AGENTS_REL);
const orderPath = () => join(agentsDir(), 'index.order.json');

const archived = (id, day, overrides = {}) => ({
  id,
  status: 'completed',
  completedAt: `${day}T09:30:00.000Z`,
  metadata: { taskType: 'user', taskDescription: `Example run ${id}` },
  ...overrides,
});

const seed = async (records) => {
  await mkdir(agentsDir(), { recursive: true });
  const index = {};
  for (const record of records) {
    const day = record.completedAt.slice(0, 10);
    index[record.id] = day;
    const dir = join(agentsDir(), day, record.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'metadata.json'), JSON.stringify(record));
  }
  await writeFile(join(agentsDir(), 'index.json'), JSON.stringify(index));
  return index;
};

const readProjections = async () => decodeCompletionOrder(JSON.parse(await readFile(orderPath(), 'utf-8')));

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 406 — CoS archive completion-order projection', () => {
  it('projects every indexed archive, recording completion order and feedback eligibility', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-406-'));
    await seed([
      archived('agent-open', '2026-04-01'),
      archived('agent-rated', '2026-04-01', { feedback: { rating: 'positive', comment: null, submittedAt: '2026-04-02T00:00:00.000Z' } }),
      archived('agent-scheduled', '2026-04-02', { metadata: { taskType: 'internal' } }),
    ]);

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ projected: 3, pruned: 0, unreadable: 0 });

    const projections = await readProjections();
    expect(projections.get('agent-open')).toEqual({
      completedAt: '2026-04-01T09:30:00.000Z', completed: true, feedbackEligible: true,
    });
    // A rated run and a scheduled (non-user) run both order a page, but neither
    // is still an answerable feedback ask.
    expect(projections.get('agent-rated').feedbackEligible).toBe(false);
    expect(projections.get('agent-scheduled')).toEqual({
      completedAt: '2026-04-02T09:30:00.000Z', completed: true, feedbackEligible: false,
    });
  });

  it('gates on the presence of its INPUT, never the absence of its output', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-406-'));
    await mkdir(agentsDir(), { recursive: true });

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ projected: 0, reason: 'no-index' });
    await expect(stat(orderPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-runs without rewriting, and drops a projection the index no longer owns', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-406-'));
    const index = await seed([archived('agent-kept', '2026-04-03'), archived('agent-gone', '2026-04-03')]);
    await migration.up({ rootDir });
    const firstWrite = (await stat(orderPath())).mtimeMs;

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ projected: 0, pruned: 0 });
    expect((await stat(orderPath())).mtimeMs).toBe(firstWrite);

    delete index['agent-gone'];
    await writeFile(join(agentsDir(), 'index.json'), JSON.stringify(index));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ projected: 0, pruned: 1 });
    expect([...(await readProjections()).keys()]).toEqual(['agent-kept']);
  });

  it('leaves an unreadable archive for the runtime to repair instead of guessing at it', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-406-'));
    await seed([archived('agent-readable', '2026-04-04')]);
    await mkdir(join(agentsDir(), '2026-04-04', 'agent-broken'), { recursive: true });
    await writeFile(join(agentsDir(), '2026-04-04', 'agent-broken', 'metadata.json'), '{ truncated');
    await writeFile(join(agentsDir(), 'index.json'), JSON.stringify({
      'agent-readable': '2026-04-04', 'agent-broken': '2026-04-04',
    }));

    await expect(migration.up({ rootDir })).resolves.toMatchObject({ projected: 1, unreadable: 1 });
    expect([...(await readProjections()).keys()]).toEqual(['agent-readable']);
  });
});
