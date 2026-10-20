/**
 * Migrations 018 + 019 against a real PostgreSQL: the Markdown task files and the
 * interim `cos_task_archive` table become `cos_tasks` rows, nothing is lost or
 * altered by the import, and the files are only set aside afterwards.
 *
 * Runs via `npm run test:db` (→ `portos_test`) ONLY; skips cleanly when no
 * database is reachable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  const override = { root: () => paths.root, data: () => `${paths.root}/data`, cos: () => `${paths.root}/data/cos` };
  return { ...actual, PATHS: new Proxy(actual.PATHS, { get: (target, key) => (key in override ? override[key]() : target[key]) }) };
});

const { checkHealth, close, ensureSchema, query, withTransaction } = await import('../../lib/db.js');
const { requireDbOrSkip } = await import('../../lib/dbTestGate.js');
const { up: importUp } = await import('./018-cos-tasks-from-files.js');
const { up: retireUp } = await import('./019-retire-cos-task-files.js');
const { parseTasksMarkdown, generateTasksMarkdown } = await import('../../lib/taskParser.js');

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/018-cos-tasks-from-files.db.test', health.connected, 'disposable PostgreSQL unavailable');

const clean = async () => {
  await query('DELETE FROM cos_tasks');
  await query('DELETE FROM cos_task_lists');
  await query('DROP TABLE IF EXISTS cos_task_archive');
};

beforeAll(async () => {
  if (!runDb) return;
  paths.root = mkdtempSync(join(tmpdir(), 'cos-task-migration-db-'));
  await clean();
});
afterAll(async () => {
  if (runDb) await clean();
  if (paths.root) rmSync(paths.root, { recursive: true, force: true });
  if (health.connected) await close();
});

describe.skipIf(!runDb)('migrations 018 + 019 — CoS task queues into PostgreSQL', () => {
  it('imports both files and the interim archive, keeps every task intact, then retires the files', async () => {
    const make = (n) => ({
      id: `task-example-${String(n).padStart(4, '0')}`,
      description: `Example task ${n} "quoted" and unicode: café`,
      status: n % 5 === 0 ? 'completed' : 'pending',
      priority: n % 3 === 0 ? 'HIGH' : 'LOW',
      metadata: { prompt: `Line one\nLine two\twith "quotes", \\backslash and emoji 🚀 #${n}`.repeat(10), updatedAt: '2026-10-01T00:00:00.000Z', openPR: true },
    });
    const userTasks = Array.from({ length: 230 }, (_, n) => make(n));
    mkdirSync(join(paths.root, 'data'), { recursive: true });
    writeFileSync(join(paths.root, 'data/TASKS.md'), generateTasksMarkdown(userTasks));
    writeFileSync(join(paths.root, 'data/COS-TASKS.md'), generateTasksMarkdown(
      [{ id: 'sys-example-1', description: 'System work', status: 'pending', priority: 'HIGH', approvalRequired: false, autoApproved: true, metadata: {} }], true));
    const expected = parseTasksMarkdown(generateTasksMarkdown(userTasks));

    // The interim archive: one row also in the file (the sweep's crash window), two only here.
    await query(`CREATE TABLE cos_task_archive (source TEXT NOT NULL, task_id TEXT COLLATE "C" NOT NULL, description TEXT NOT NULL DEFAULT '',
      completed_at TIMESTAMPTZ, archived_at TIMESTAMPTZ NOT NULL DEFAULT now(), task JSONB NOT NULL, PRIMARY KEY (source, task_id))`);
    for (const [id, description] of [[expected[0].id, 'Stale archive copy'], ['task-archived-1', 'Archived one'], ['task-archived-2', 'Archived two']]) {
      const task = { id, description, status: 'completed', priority: 'MEDIUM', priorityValue: 2, metadata: { updatedAt: '2026-09-01T00:00:00.000Z' } };
      await query(`INSERT INTO cos_task_archive (source, task_id, description, completed_at, task) VALUES ('user', $1, $2, '2026-09-01T00:00:00Z', $3::jsonb)`,
        [id, description, JSON.stringify(task)]);
    }

    await withTransaction(importUp);

    const counts = (await query('SELECT source, count(*)::int AS n FROM cos_tasks GROUP BY source ORDER BY source')).rows;
    expect(counts).toEqual([{ source: 'internal', n: 1 }, { source: 'user', n: 232 }]);
    const stored = new Map((await query(`SELECT task_id, task FROM cos_tasks WHERE source = 'user'`)).rows.map((row) => [row.task_id, row.task]));
    // The file copy won over the stale archive copy, and every file task is byte-for-byte what the reader returned.
    for (const task of expected) expect(stored.get(task.id)).toEqual(JSON.parse(JSON.stringify(task)));
    expect(stored.get('task-archived-2').description).toBe('Archived two');
    expect((await query(`SELECT to_regclass('cos_task_archive') AS archive`)).rows[0].archive).toBeNull();
    const ordered = (await query(`SELECT task_id FROM cos_tasks WHERE source = 'user' AND task_id LIKE 'task-example-%' ORDER BY position LIMIT 3`)).rows;
    expect(ordered.map((row) => row.task_id)).toEqual(expected.slice(0, 3).map((task) => task.id));
    expect((await query(`SELECT count(*)::int AS n FROM cos_tasks WHERE status = 'completed' AND completed_at IS NOT NULL`)).rows[0].n).toBeGreaterThan(40);

    // Files are only set aside after the import, and kept.
    expect(existsSync(join(paths.root, 'data/TASKS.md'))).toBe(true);
    await retireUp();
    expect(existsSync(join(paths.root, 'data/TASKS.md'))).toBe(false);
    expect(existsSync(join(paths.root, 'data/TASKS.md.imported'))).toBe(true);

    // With the files gone and the archive dropped, a re-run changes nothing.
    await withTransaction(importUp);
    expect((await query('SELECT count(*)::int AS n FROM cos_tasks')).rows[0].n).toBe(233);
  });
});
