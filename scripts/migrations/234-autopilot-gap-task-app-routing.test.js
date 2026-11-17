import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { unrouteTasks } from './234-autopilot-gap-task-app-routing.js';
import { parseTasksMarkdown } from '../../server/lib/legacyTaskMarkdown.js';

const STAMP = '2026-08-09T12:00:00.000Z';
const GAP = { headline: /^Autopilot \S+ gap — series \S+/, app: 'pipeline', stamp: STAMP };

const gapTask = (id, { mark = ' ', app = 'pipeline', updatedAt = '2026-08-01T00:00:00.000Z' } = {}) => [
  `- [${mark}] #${id} | MEDIUM | Autopilot script-unparseable gap — series 11111111-2222-3333-4444-555555555555`,
  '  - context: the comic script has no parseable pages',
  ...(app ? [`  - app: ${app}`] : []),
  ...(updatedAt ? [`  - updatedAt: ${updatedAt}`] : []),
].join('\n');

const queue = (...tasks) => ['# Tasks', '', '## Pending', ...tasks, ''].join('\n');

describe('unrouteTasks', () => {
  it('drops the mis-routed app line and keeps the rest of the task', () => {
    const { markdown, unrouted } = unrouteTasks(queue(gapTask('task-1')), GAP);
    expect(unrouted).toEqual(['task-1']);
    // Parsed back through the REAL parser — the surviving metadata has to still
    // read, not merely look right in the raw text.
    const [task] = parseTasksMarkdown(markdown);
    expect(task.metadata.app).toBeUndefined();
    expect(task.metadata.context).toBe('the comic script has no parseable pages');
  });

  // A peer that hasn't migrated still holds the routed copy at the old stamp;
  // without the bump the equal-status tie can adopt it and re-strand the task.
  it('re-stamps updatedAt so the un-routed copy wins the federation merge', () => {
    const { markdown } = unrouteTasks(queue(gapTask('task-1')), GAP);
    expect(parseTasksMarkdown(markdown)[0].metadata.updatedAt).toBe(STAMP);
  });

  it('adds the stamp when the task carries none', () => {
    const { markdown, unrouted } = unrouteTasks(queue(gapTask('task-1', { updatedAt: null })), GAP);
    expect(unrouted).toEqual(['task-1']);
    const [task] = parseTasksMarkdown(markdown);
    expect(task.metadata.app).toBeUndefined();
    expect(task.metadata.updatedAt).toBe(STAMP);
  });

  it('un-routes in-progress, blocked and challenged tasks too', () => {
    const md = queue(gapTask('task-p'), gapTask('task-i', { mark: '~' }), gapTask('task-b', { mark: '!' }), gapTask('task-c', { mark: '?' }));
    expect(unrouteTasks(md, GAP).unrouted).toEqual(['task-p', 'task-i', 'task-b', 'task-c']);
  });

  it('leaves a completed task alone — it already ran, its metadata is history', () => {
    const md = queue(gapTask('task-done', { mark: 'x' }));
    expect(unrouteTasks(md, GAP)).toEqual({ markdown: md, unrouted: [] });
  });

  it('leaves every task from another producer routed, including one on a real app named pipeline', () => {
    const other = ['- [ ] #task-2 | HIGH | Fix the failing test', '  - app: pipeline'].join('\n');
    const { markdown, unrouted } = unrouteTasks(queue(gapTask('task-1'), other), GAP);
    expect(unrouted).toEqual(['task-1']);
    expect(parseTasksMarkdown(markdown).find((t) => t.id === 'task-2').metadata.app).toBe('pipeline');
  });

  it('leaves a gap task routed at a different app alone', () => {
    const md = queue(gapTask('task-1', { app: 'booklooom' }));
    expect(unrouteTasks(md, GAP)).toEqual({ markdown: md, unrouted: [] });
  });

  it('skips a gap task that carries no app line', () => {
    const md = queue(gapTask('task-1', { app: null }));
    expect(unrouteTasks(md, GAP)).toEqual({ markdown: md, unrouted: [] });
  });

  // `generateTasksMarkdown` interpolates the description verbatim, so a task
  // filed with embedded newlines sits in the file with prose/blank lines between
  // its header and its metadata until the next parse round-trip flattens it. A
  // scan that stopped at the first non-metadata line would walk right past the
  // `app:` line and leave the task stranded.
  it('reaches the metadata past a description that spilled onto its own lines', () => {
    const spilled = [
      '- [ ] #task-1 | MEDIUM | Autopilot script-unparseable gap — series 11111111-2222-3333-4444-555555555555',
      '',
      'The comic script has no parseable pages.',
      '  - app: pipeline',
      '  - updatedAt: 2026-08-01T00:00:00.000Z',
    ].join('\n');
    const { markdown, unrouted } = unrouteTasks(queue(spilled), GAP);
    expect(unrouted).toEqual(['task-1']);
    expect(markdown).not.toContain('- app: pipeline');
    expect(markdown).toContain(`- updatedAt: ${STAMP}`);
    expect(markdown).toContain('The comic script has no parseable pages.');
  });

  it('inserts a missing stamp with the metadata, not after trailing prose', () => {
    const spilled = [
      '- [ ] #task-1 | MEDIUM | Autopilot script-unparseable gap — series 11111111-2222-3333-4444-555555555555',
      '  - app: pipeline',
      'trailing prose line',
    ].join('\n');
    const { markdown } = unrouteTasks(queue(spilled), GAP);
    const lines = markdown.split('\n');
    expect(lines[lines.indexOf('trailing prose line') - 1]).toBe(`  - updatedAt: ${STAMP}`);
  });
});

describe('migration 234 up()', () => {
  let rootDir;
  const userTasks = () => join(rootDir, 'data', 'TASKS.md');
  const cosTasks = () => join(rootDir, 'data', 'COS-TASKS.md');
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-234-'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the install has no task queue at all', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-task-file' });
  });

  it('unsticks a gap task that can never spawn while it names a non-existent app', async () => {
    await writeFile(userTasks(), queue(gapTask('task-msl2dqxk')));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, unrouted: 1 });
    const [task] = parseTasksMarkdown(await readFile(userTasks(), 'utf-8'));
    expect(task.metadata.app).toBeUndefined();
  });

  // The auto-fixer's provider investigations were stranded the same way, on the
  // internal queue, at an app id no install has ('portos' vs 'portos-default').
  it('un-routes the auto-fixer provider investigations in the internal queue', async () => {
    const investigation = [
      '- [ ] #sys-1 | MEDIUM | APPROVAL | Investigate AI provider failure: claude (claude-opus-5)',
      '  - app: portos',
      '  - updatedAt: 2026-08-01T00:00:00.000Z',
    ].join('\n');
    await writeFile(cosTasks(), queue(investigation));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, unrouted: 1 });
    const [task] = parseTasksMarkdown(await readFile(cosTasks(), 'utf-8'));
    expect(task.metadata.app).toBeUndefined();
  });

  // An install that moved its queue in data/cos/state.json must be migrated
  // there — migrating only the default path records this as applied while the
  // live queue stays stranded.
  it('follows a relocated queue path from the CoS config', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'cos', 'state.json'),
      JSON.stringify({ config: { userTasksFile: 'data/cos/MY-TASKS.md' } }));
    const relocated = join(rootDir, 'data', 'cos', 'MY-TASKS.md');
    await writeFile(relocated, queue(gapTask('task-1')));
    await writeFile(userTasks(), queue(gapTask('task-untouched')));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, unrouted: 1 });
    expect(parseTasksMarkdown(await readFile(relocated, 'utf-8'))[0].metadata.app).toBeUndefined();
    expect(parseTasksMarkdown(await readFile(userTasks(), 'utf-8'))[0].metadata.app).toBe('pipeline');
  });

  it('is idempotent — a second run leaves the file byte-identical', async () => {
    await writeFile(userTasks(), queue(gapTask('task-1')));
    await migration.up({ rootDir });
    const first = await readFile(userTasks(), 'utf-8');
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ reason: 'already-unrouted' });
    expect(await readFile(userTasks(), 'utf-8')).toBe(first);
  });
});
