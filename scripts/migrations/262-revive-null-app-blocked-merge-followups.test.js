import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { reviveStrandedFollowUps } from './262-revive-null-app-blocked-merge-followups.js';
import { parseTasksMarkdown } from '../../server/lib/legacyTaskMarkdown.js';

const STAMP = '2026-08-12T12:00:00.000Z';
const PR_URL = 'https://github.com/example-org/example-repo/pull/9';

// The shape spawnReviewLoopFollowUp wrote before the serialization fix: an
// `app: null` that came back as the app id 'null' and blocked the task.
const strandedFollowUp = (id, {
  mark = '!',
  app = 'null',
  category = 'app-unresolved',
  prUrl = PR_URL,
  updatedAt = '2026-08-01T00:00:00.000Z',
} = {}) => [
  `- [${mark}] #${id} | MEDIUM | AUTO | [Review Loop] example task (${prUrl})`,
  ...(app ? [`  - app: ${app}`] : []),
  '  - useWorktree: true',
  '  - existingBranch: cos/task-1/agent-1',
  ...(prUrl ? [`  - reviewLoopPRUrl: ${prUrl}`] : []),
  '  - reviewLoopPRBranch: cos/task-1/agent-1',
  ...(category ? [`  - blockedReason: App 'null' didn't resolve to a repository directory.`, `  - blockedCategory: ${category}`, '  - blockedAt: 2026-08-01T00:00:00.000Z'] : []),
  ...(updatedAt ? [`  - updatedAt: ${updatedAt}`] : []),
].join('\n');

const queue = (blocked = [], pending = []) => [
  '# Tasks', '',
  '## Pending', ...pending, '',
  '## Blocked', ...blocked, '',
].join('\n');

describe('reviveStrandedFollowUps', () => {
  it('moves the stranded follow-up back to pending and clears the block record', () => {
    const { markdown, revived } = reviveStrandedFollowUps(queue([strandedFollowUp('sys-rl-1')]), STAMP);
    expect(revived).toEqual(['sys-rl-1']);
    // Parsed through the REAL parser — the survivor has to still read, not just
    // look right in the raw text.
    const [task] = parseTasksMarkdown(markdown);
    expect(task.id).toBe('sys-rl-1');
    expect(task.status).toBe('pending');
    expect(task.metadata.app).toBeUndefined();
    expect(task.metadata.blockedCategory).toBeUndefined();
    expect(task.metadata.blockedReason).toBeUndefined();
    expect(task.metadata.blockedAt).toBeUndefined();
    // Everything the follow-up needs to actually run survives.
    expect(task.metadata.reviewLoopPRUrl).toBe(PR_URL);
    expect(task.metadata.existingBranch).toBe('cos/task-1/agent-1');
  });

  // A peer that hasn't migrated still holds the blocked copy at the old stamp;
  // without the bump the equal-status tie can adopt it and re-strand the task.
  it('re-stamps updatedAt so the revived copy wins the federation merge', () => {
    const { markdown } = reviveStrandedFollowUps(queue([strandedFollowUp('sys-rl-1')]), STAMP);
    expect(parseTasksMarkdown(markdown)[0].metadata.updatedAt).toBe(STAMP);
  });

  it('adds the stamp when the task carries none', () => {
    const md = queue([strandedFollowUp('sys-rl-1', { updatedAt: null })]);
    const { markdown, revived } = reviveStrandedFollowUps(md, STAMP);
    expect(revived).toEqual(['sys-rl-1']);
    expect(parseTasksMarkdown(markdown)[0].metadata.updatedAt).toBe(STAMP);
  });

  it('is idempotent — a revived task no longer matches', () => {
    const once = reviveStrandedFollowUps(queue([strandedFollowUp('sys-rl-1')]), STAMP);
    expect(reviveStrandedFollowUps(once.markdown, STAMP)).toEqual({ markdown: once.markdown, revived: [] });
  });

  it('returns the input untouched when nothing is stranded', () => {
    const md = queue([], ['- [ ] #task-1 | HIGH | Fix the failing test']);
    expect(reviveStrandedFollowUps(md, STAMP)).toEqual({ markdown: md, revived: [] });
  });

  // Each of the four conditions is load-bearing: a block that fails any one of
  // them may encode a real problem a human still has to judge.
  it('leaves a follow-up blocked at a REAL app alone', () => {
    const md = queue([strandedFollowUp('sys-rl-1', { app: 'example-app' })]);
    expect(reviveStrandedFollowUps(md, STAMP).revived).toEqual([]);
  });

  it('leaves a follow-up blocked for a different reason alone', () => {
    const md = queue([strandedFollowUp('sys-rl-1', { category: 'max-retries' })]);
    expect(reviveStrandedFollowUps(md, STAMP).revived).toEqual([]);
  });

  it('leaves an ordinary app-unresolved task that is not landing a PR alone', () => {
    const md = queue([strandedFollowUp('sys-1', { prUrl: null })]);
    expect(reviveStrandedFollowUps(md, STAMP).revived).toEqual([]);
  });

  it('leaves a follow-up that is not blocked alone', () => {
    const md = queue([], [strandedFollowUp('sys-rl-1', { mark: ' ' })]);
    expect(reviveStrandedFollowUps(md, STAMP).revived).toEqual([]);
  });

  it('keeps the other blocked tasks in the Blocked section', () => {
    const other = ['- [!] #task-2 | HIGH | Something a human must fix', '  - blockedCategory: needs-input'].join('\n');
    const { markdown } = reviveStrandedFollowUps(queue([strandedFollowUp('sys-rl-1'), other]), STAMP);
    const tasks = parseTasksMarkdown(markdown);
    expect(tasks.find(t => t.id === 'sys-rl-1').status).toBe('pending');
    expect(tasks.find(t => t.id === 'task-2').status).toBe('blocked');
  });

  it('preserves the tasks already pending, and their order', () => {
    const md = queue(
      [strandedFollowUp('sys-rl-1')],
      ['- [ ] #task-a | HIGH | First', '- [ ] #task-b | LOW | Second'],
    );
    const ids = parseTasksMarkdown(reviveStrandedFollowUps(md, STAMP).markdown).map(t => t.id);
    expect(ids).toEqual(['task-a', 'task-b', 'sys-rl-1']);
  });

  it('creates a Pending section when the file has none', () => {
    const md = ['# Tasks', '', '## Blocked', strandedFollowUp('sys-rl-1'), ''].join('\n');
    const { markdown, revived } = reviveStrandedFollowUps(md, STAMP);
    expect(revived).toEqual(['sys-rl-1']);
    expect(markdown).toContain('## Pending');
    expect(parseTasksMarkdown(markdown)[0].status).toBe('pending');
  });

  // `generateTasksMarkdown` interpolates the description verbatim, so a task
  // filed with embedded newlines sits in the file with prose/blank lines between
  // its header and its metadata until the next parse round-trip flattens it.
  it('reaches the metadata past a description that spilled onto its own lines', () => {
    const spilled = [
      `- [!] #sys-rl-1 | MEDIUM | AUTO | [Review Loop] example task (${PR_URL})`,
      '',
      'Landing the review fixes.',
      '  - app: null',
      `  - reviewLoopPRUrl: ${PR_URL}`,
      '  - blockedCategory: app-unresolved',
    ].join('\n');
    const { markdown, revived } = reviveStrandedFollowUps(queue([spilled]), STAMP);
    expect(revived).toEqual(['sys-rl-1']);
    expect(markdown).toContain('Landing the review fixes.');
    expect(parseTasksMarkdown(markdown)[0].status).toBe('pending');
  });
});

describe('migration 262 up()', () => {
  let rootDir;
  const userTasks = () => join(rootDir, 'data', 'TASKS.md');
  const cosTasks = () => join(rootDir, 'data', 'COS-TASKS.md');
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-262-'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the install has no task queue at all', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-task-file' });
  });

  it('no-ops when nothing is stranded', async () => {
    await writeFile(cosTasks(), queue([], ['- [ ] #task-1 | HIGH | Fix the failing test']));
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'none-stranded' });
  });

  it('revives the stranded follow-up on the internal queue', async () => {
    await writeFile(cosTasks(), queue([strandedFollowUp('sys-rl-msqahye2')]));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, revived: 1 });
    const [task] = parseTasksMarkdown(await readFile(cosTasks(), 'utf-8'));
    expect(task.status).toBe('pending');
    expect(task.metadata.app).toBeUndefined();
  });

  it('revives a follow-up that landed on the user queue too', async () => {
    await writeFile(userTasks(), queue([strandedFollowUp('sys-rl-1')]));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, revived: 1 });
    expect(parseTasksMarkdown(await readFile(userTasks(), 'utf-8'))[0].status).toBe('pending');
  });

  // An install that moved its queue in data/cos/state.json must be migrated
  // where the queue actually lives, not at the default path.
  it('honours a relocated queue path from data/cos/state.json', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'cos', 'state.json'), JSON.stringify({ config: { cosTasksFile: 'data/custom-cos.md' } }));
    await writeFile(join(rootDir, 'data', 'custom-cos.md'), queue([strandedFollowUp('sys-rl-1')]));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, revived: 1 });
    expect(parseTasksMarkdown(await readFile(join(rootDir, 'data', 'custom-cos.md'), 'utf-8'))[0].status).toBe('pending');
  });

  // A prior crash can leave data/cos/state.json truncated/corrupted. That must
  // fall back to the default queue paths exactly like a missing file, not abort
  // this migration (and every one queued after it in the same run).
  it('falls back to the default queue paths when state.json is corrupted', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'cos', 'state.json'), '{not valid json');
    await writeFile(cosTasks(), queue([strandedFollowUp('sys-rl-1')]));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, revived: 1 });
    expect(parseTasksMarkdown(await readFile(cosTasks(), 'utf-8'))[0].status).toBe('pending');
  });

  it('is idempotent across runs', async () => {
    await writeFile(cosTasks(), queue([strandedFollowUp('sys-rl-1')]));
    await migration.up({ rootDir, now: STAMP });
    const after = await readFile(cosTasks(), 'utf-8');
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, reason: 'none-stranded' });
    expect(await readFile(cosTasks(), 'utf-8')).toBe(after);
  });
});
