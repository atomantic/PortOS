import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { stampBurnTaskProvenance } from './225-quota-burn-task-provenance.js';
import { parseTasksMarkdown } from '../../server/lib/legacyTaskMarkdown.js';

const burnTask = (id, family = 'agy') => [
  `- [ ] #${id} | MEDIUM | AUTO | [Quota burn: ${family}] Performance issues for PortOS`,
  '  - provider: antigravity-tui',
  '  - app: portos-default',
].join('\n');

const queue = (...tasks) => ['# Tasks', '', '## Pending', ...tasks, ''].join('\n');

describe('stampBurnTaskProvenance', () => {
  it('inserts the family the description names, directly under the task line', () => {
    const { markdown, stamped } = stampBurnTaskProvenance(queue(burnTask('sys-1')));
    expect(stamped).toEqual(['sys-1']);
    // Parsed back through the REAL parser — a metadata line the queue's own
    // reader cannot see would be no better than not writing it.
    const [task] = parseTasksMarkdown(markdown);
    expect(task.metadata.quotaBurnFamily).toBe('agy');
    // The rest of the task survives verbatim.
    expect(task.metadata.provider).toBe('antigravity-tui');
    expect(task.metadata.app).toBe('portos-default');
  });

  it('leaves every other task untouched', () => {
    const other = ['- [ ] #sys-2 | HIGH | AUTO | Ordinary system work', '  - app: portos-default'].join('\n');
    const { markdown, stamped } = stampBurnTaskProvenance(queue(burnTask('sys-1'), other));
    expect(stamped).toEqual(['sys-1']);
    const parsed = parseTasksMarkdown(markdown);
    expect(parsed.find((t) => t.id === 'sys-2').metadata.quotaBurnFamily).toBeUndefined();
  });

  it('skips a task that already carries the key', () => {
    const already = [burnTask('sys-1'), '  - quotaBurnFamily: agy'].join('\n');
    const input = queue(already);
    expect(stampBurnTaskProvenance(input)).toEqual({ markdown: input, stamped: [] });
  });

  it('ignores a description that merely mentions a burn, and an unknown family', () => {
    const prose = '- [ ] #sys-3 | LOW | AUTO | Quota burn: agy should be investigated';
    const bogus = '- [ ] #sys-4 | LOW | AUTO | [Quota burn: notafamily] whatever for App';
    expect(stampBurnTaskProvenance(queue(prose, bogus)).stamped).toEqual([]);
  });

  it('stamps tasks in every section, including completed ones', () => {
    const md = [
      '# Tasks', '', '## Pending', burnTask('sys-1', 'claude'), '',
      '## Completed', burnTask('sys-2', 'grok').replace('- [ ]', '- [x]'), '',
    ].join('\n');
    expect(stampBurnTaskProvenance(md).stamped).toEqual(['sys-1', 'sys-2']);
  });
});

describe('migration 225 up()', () => {
  let rootDir;
  const tasksPath = () => join(rootDir, 'data', 'COS-TASKS.md');
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-225-'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the install has no CoS task queue', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-task-file' });
  });

  it('unsticks a burn task that was queued before the stamp existed', async () => {
    // Without the stamp this task inherits the per-app review cooldown, never
    // spawns, and blocks its own re-dispatch as a duplicate — so that job in the
    // family's plan is permanently unreachable, not merely late.
    await writeFile(tasksPath(), queue(burnTask('sys-msfm89zj')));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, stamped: 1 });
    const [task] = parseTasksMarkdown(await readFile(tasksPath(), 'utf-8'));
    expect(task.metadata.quotaBurnFamily).toBe('agy');
  });

  it('is idempotent — a second run leaves the file byte-identical', async () => {
    await writeFile(tasksPath(), queue(burnTask('sys-1')));
    await migration.up({ rootDir });
    const first = await readFile(tasksPath(), 'utf-8');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'already-stamped' });
    expect(await readFile(tasksPath(), 'utf-8')).toBe(first);
  });
});
