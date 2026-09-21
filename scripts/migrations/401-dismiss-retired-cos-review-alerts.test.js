import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { isRetiredCosReviewAlert } from './401-dismiss-retired-cos-review-alerts.js';

const ITEMS_REL = join('data', 'review', 'items.json');

let rootDir;

const seed = async (items) => {
  await mkdir(join(rootDir, 'data', 'review'), { recursive: true });
  await writeFile(join(rootDir, ITEMS_REL), JSON.stringify(items, null, 2));
};

const readItems = async () => JSON.parse(await readFile(join(rootDir, ITEMS_REL), 'utf-8'));

const retiredAlert = (overrides = {}) => ({
  id: 'review-1',
  type: 'cos',
  title: '# ⚡ SWARM MODE — claim and ship up to 6 independent issues in parallel',
  description: 'Claim and ship the selected issues.',
  status: 'pending',
  metadata: { taskId: 'task-1', referenceId: 'task-1' },
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  ...overrides,
});

afterEach(async () => {
  if (rootDir) await rm(rootDir, { recursive: true, force: true });
  rootDir = null;
});

describe('migration 401 — dismiss retired CoS review alerts', () => {
  it('dismisses pending records from the retired task-ready bridge', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-401-'));
    await seed([
      retiredAlert(),
      retiredAlert({ id: 'review-2', title: 'Ordinary task description' }),
      { id: 'todo-1', type: 'todo', status: 'pending', title: 'Keep this todo' },
    ]);

    const result = await migration.up({ rootDir });

    expect(result.dismissed).toBe(2);
    const items = await readItems();
    expect(items[0]).toMatchObject({ status: 'dismissed', updatedAt: expect.any(String) });
    expect(items[1]).toMatchObject({ status: 'dismissed' });
    expect(items[2]).toMatchObject({ status: 'pending', title: 'Keep this todo' });
  });

  it('preserves already-triaged and future-shaped CoS records', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-401-'));
    await seed([
      retiredAlert({ id: 'completed', status: 'completed' }),
      retiredAlert({ id: 'dismissed', status: 'dismissed' }),
      retiredAlert({ id: 'categorized', metadata: { taskId: 'task-2', referenceId: 'task-2', category: 'task-approval' } }),
      retiredAlert({ id: 'source-owned', metadata: { taskId: 'task-3', referenceId: 'task-3', sourceOwned: true } }),
    ]);

    const result = await migration.up({ rootDir });

    expect(result).toEqual({ dismissed: 0 });
    expect((await readItems()).map((item) => item.status)).toEqual([
      'completed', 'dismissed', 'pending', 'pending',
    ]);
  });

  it('is idempotent and does not rewrite an install with no matching records', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-401-'));
    await seed([{ id: 'todo-1', type: 'todo', status: 'pending', title: 'Keep this todo' }]);
    const before = await readFile(join(rootDir, ITEMS_REL), 'utf-8');

    expect(await migration.up({ rootDir })).toEqual({ dismissed: 0 });
    expect(await readFile(join(rootDir, ITEMS_REL), 'utf-8')).toBe(before);
  });

  it('fails closed on missing or malformed review data', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-migration-401-'));
    expect(await migration.up({ rootDir })).toEqual({ dismissed: 0, reason: 'no-file' });

    await mkdir(join(rootDir, 'data', 'review'), { recursive: true });
    await writeFile(join(rootDir, ITEMS_REL), '{not json');
    expect(await migration.up({ rootDir })).toEqual({ dismissed: 0, reason: 'unparseable' });
    expect(await readFile(join(rootDir, ITEMS_REL), 'utf-8')).toBe('{not json');

    await writeFile(join(rootDir, ITEMS_REL), JSON.stringify({ items: [] }));
    expect(await migration.up({ rootDir })).toEqual({ dismissed: 0, reason: 'unexpected-shape' });
  });
});

describe('isRetiredCosReviewAlert', () => {
  it('requires the old task-ready metadata shape', () => {
    expect(isRetiredCosReviewAlert(retiredAlert())).toBe(true);
    expect(isRetiredCosReviewAlert(retiredAlert({ metadata: { taskId: 'task-1' } }))).toBe(false);
    expect(isRetiredCosReviewAlert(retiredAlert({ metadata: { taskId: 'task-1', referenceId: 'task-1', category: 'task-approval' } }))).toBe(false);
  });
});
