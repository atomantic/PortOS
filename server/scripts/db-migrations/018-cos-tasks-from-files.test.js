import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../lib/paths.js', () => ({
  PATHS: { get root() { return paths.root; }, get data() { return `${paths.root}/data`; }, get cos() { return `${paths.root}/data/cos`; } },
}));

const { up } = await import('./018-cos-tasks-from-files.js');

const USER_MARKDOWN = `# Tasks

## Pending
- [ ] #task-example-b | LOW | Second pending
- [ ] #task-example-a | HIGH | First pending
  - app: example-app
  - openPR: true

## Completed
- [x] #task-example-done | MEDIUM | Finished work
  - updatedAt: 2026-10-01T00:00:00.000Z
  - prompt: Example prompt body
`;
const INTERNAL_MARKDOWN = `# Tasks

## Pending
- [ ] #sys-example | HIGH | AUTO | System work
`;

let queries;
const client = (overrides = {}) => ({
  query: vi.fn(async (sql, params) => {
    queries.push({ sql, params });
    if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: params[1].length }] };
    if (/to_regclass/.test(sql)) return { rows: [{ archive: null }] };
    return { rows: [], rowCount: 0 };
  }),
  ...overrides,
});
const inserts = () => queries.filter((q) => /INSERT INTO cos_tasks \(source/.test(q.sql) && q.params?.[0]);
const write = (rel, text) => { mkdirSync(join(paths.root, rel, '..'), { recursive: true }); writeFileSync(join(paths.root, rel), text); };

beforeEach(() => {
  rmSync(paths.root, { recursive: true, force: true });
  paths.root = mkdtempSync(join(tmpdir(), 'cos-task-import-'));
  queries = [];
});
afterAll(() => rmSync(paths.root, { recursive: true, force: true }));

describe('db-migration 018 — CoS tasks from the Markdown files', () => {
  it('imports both queues in file order with stored-form rows and projection columns', async () => {
    write('data/TASKS.md', USER_MARKDOWN);
    write('data/COS-TASKS.md', INTERNAL_MARKDOWN);
    await up(client());

    const [user, internal] = inserts();
    expect(user.params[0]).toBe('user');
    expect(internal.params[0]).toBe('internal');
    const [, ids, statuses, priorities, positions, completedAt, descriptions, stored] = user.params;
    // File order is kept in `position`; the queue's priority order is applied when it is read.
    expect(ids).toEqual(['task-example-b', 'task-example-a', 'task-example-done']);
    expect(statuses).toEqual(['pending', 'pending', 'completed']);
    expect(priorities).toEqual([1, 3, 2]);
    expect(positions).toEqual([0, 1024, 2048]);
    expect(completedAt).toEqual([null, null, '2026-10-01T00:00:00.000Z']);
    expect(descriptions[1]).toBe('First pending');
    // Scalar metadata is stored as the Markdown reader returned it (strings).
    expect(JSON.parse(stored[1]).metadata).toEqual({ app: 'example-app', openPR: 'true' });
    expect(JSON.parse(stored[2]).metadata.prompt).toBe('Example prompt body');
    expect(internal.params[1]).toEqual(['sys-example']);
  });

  it('is input-gated: a missing file contributes nothing, and no file at all inserts nothing', async () => {
    write('data/COS-TASKS.md', INTERNAL_MARKDOWN);
    await up(client());
    expect(inserts().map((q) => q.params[0])).toEqual(['internal']);

    queries = [];
    rmSync(join(paths.root, 'data/COS-TASKS.md'));
    await up(client());
    expect(inserts()).toEqual([]);
  });

  it('honors a configured file location the way the old reader did', async () => {
    write('data/cos/config.json', JSON.stringify({ userTasksFile: 'custom/mine.md', cosTasksFile: 'custom/system.md' }));
    write('custom/mine.md', USER_MARKDOWN);
    write('data/TASKS.md', '# Tasks\n\n## Pending\n- [ ] #task-ignored | LOW | Default location is ignored\n');
    await up(client());
    expect(inserts()).toHaveLength(1);
    expect(inserts()[0].params[1]).toContain('task-example-a');
    expect(inserts()[0].params[1]).not.toContain('task-ignored');
  });

  it('falls back to the legacy state.json config when there is no config.json', async () => {
    write('data/cos/state.json', JSON.stringify({ config: { userTasksFile: 'legacy/user.md' }, agents: {} }));
    write('legacy/user.md', USER_MARKDOWN);
    await up(client());
    expect(inserts()[0].params[1]).toContain('task-example-a');
  });

  it('batches a large queue and keeps file order across batches', async () => {
    const rows = Array.from({ length: 250 }, (_, n) => `- [ ] #task-bulk-${String(n).padStart(3, '0')} | MEDIUM | Bulk ${n}`).join('\n');
    write('data/TASKS.md', `# Tasks\n\n## Pending\n${rows}\n`);
    await up(client());
    const batches = inserts();
    expect(batches.map((q) => q.params[1].length)).toEqual([100, 100, 50]);
    expect(batches[2].params[4][0]).toBe(200 * 1024);
  });

  it('throws, rolling the migration back, when a parsed task did not land as a row', async () => {
    write('data/TASKS.md', USER_MARKDOWN);
    const short = client({ query: vi.fn(async (sql) => (/SELECT count\(\*\)/.test(sql) ? { rows: [{ n: 2 }] } : { rows: [], rowCount: 0 })) });
    await expect(up(short)).rejects.toThrow(/verification failed for user: 2 of 3/);
  });

  it('folds the interim archive table into cos_tasks and drops it, only when it exists', async () => {
    write('data/TASKS.md', USER_MARKDOWN);
    const withArchive = client({ query: vi.fn(async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT count\(\*\)/.test(sql)) return { rows: [{ n: params[1].length }] };
      if (/to_regclass/.test(sql)) return { rows: [{ archive: 'cos_task_archive' }] };
      return { rows: [], rowCount: 7 };
    }) });
    await up(withArchive);
    const fold = queries.find((q) => /FROM cos_task_archive/.test(q.sql));
    expect(fold.sql).toMatch(/ON CONFLICT \(source, task_id\) DO NOTHING/);
    expect(queries.some((q) => /DROP TABLE cos_task_archive/.test(q.sql))).toBe(true);
    // The file copy is inserted before the archive row can claim the key.
    expect(queries.findIndex((q) => /INSERT INTO cos_tasks \(source/.test(q.sql) && q.params)).toBeLessThan(queries.indexOf(fold));

    queries = [];
    await up(client());
    expect(queries.some((q) => /cos_task_archive/.test(q.sql) && !/to_regclass/.test(q.sql))).toBe(false);
  });

  it('bumps both queue versions so no earlier cache can match', async () => {
    await up(client());
    const bump = queries.find((q) => /INSERT INTO cos_task_lists/.test(q.sql));
    expect(bump.sql).toMatch(/\('user', 1\), \('internal', 1\)/);
  });
});
