import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { splitPromptMetadata } from './270-cos-task-prompt-split.js';
import { parseTasksMarkdown, generateTasksMarkdown } from '../../server/lib/taskParser.js';

const STAMP = '2026-08-15T12:00:00.000Z';
const AGENT_BODY = 'Improve Example App\n\n## Phase 1\n- Read PLAN.md\n## Phase 2\nShip a PR.';

// Build the queue file the way the store does, so the metadata escaping under
// test is the REAL escaping (JSON sentinel) rather than a hand-rolled guess.
const queue = (...tasks) => generateTasksMarkdown(tasks, true);

const task = (id, metadata, { status = 'pending', description = 'Improve Example App' } = {}) => ({
  id,
  status,
  priority: 'MEDIUM',
  priorityValue: 2,
  description,
  autoApproved: true,
  approvalRequired: false,
  metadata,
});

describe('splitPromptMetadata', () => {
  it('moves a multi-line context payload to prompt', () => {
    const md = queue(task('sys-1', { context: AGENT_BODY, app: 'a1' }));
    const { markdown, split } = splitPromptMetadata(md, { stamp: STAMP });
    expect(split).toEqual(['sys-1']);
    // Parsed back through the REAL parser — the rewritten line has to still
    // read, not merely look right in the raw text.
    const [parsed] = parseTasksMarkdown(markdown);
    expect(parsed.metadata.prompt).toBe(AGENT_BODY);
    expect(parsed.metadata.context).toBeUndefined();
    expect(parsed.metadata.app).toBe('a1');
  });

  it('leaves a one-line human note as context', () => {
    const md = queue(task('sys-1', { context: 'Manually triggered autonomous job: nightly' }));
    expect(splitPromptMetadata(md, { stamp: STAMP })).toEqual({ markdown: md, split: [] });
  });

  it('re-stamps updatedAt so the migrated copy wins the federation merge', () => {
    const md = queue(task('sys-1', { context: AGENT_BODY, updatedAt: '2026-08-01T00:00:00.000Z' }));
    const { markdown } = splitPromptMetadata(md, { stamp: STAMP });
    expect(parseTasksMarkdown(markdown)[0].metadata.updatedAt).toBe(STAMP);
  });

  it('adds the stamp when the task carries none', () => {
    const md = queue(task('sys-1', { context: AGENT_BODY }));
    const { markdown } = splitPromptMetadata(md, { stamp: STAMP });
    expect(parseTasksMarkdown(markdown)[0].metadata.updatedAt).toBe(STAMP);
  });

  it('is idempotent — a second run changes nothing', () => {
    const md = queue(task('sys-1', { context: AGENT_BODY }));
    const once = splitPromptMetadata(md, { stamp: STAMP });
    const twice = splitPromptMetadata(once.markdown, { stamp: '2026-09-09T00:00:00.000Z' });
    expect(twice).toEqual({ markdown: once.markdown, split: [] });
  });

  it('never overwrites a task that already carries a prompt', () => {
    const md = queue(task('sys-1', { prompt: 'explicit prompt', context: AGENT_BODY }));
    expect(splitPromptMetadata(md, { stamp: STAMP })).toEqual({ markdown: md, split: [] });
  });

  it('migrates every non-completed status, and completed ones too', () => {
    const md = queue(
      task('sys-p', { context: AGENT_BODY }),
      task('sys-i', { context: AGENT_BODY }, { status: 'in_progress' }),
      task('sys-b', { context: AGENT_BODY }, { status: 'blocked' }),
      task('sys-x', { context: AGENT_BODY }, { status: 'completed' }),
    );
    expect(splitPromptMetadata(md, { stamp: STAMP }).split.sort())
      .toEqual(['sys-b', 'sys-i', 'sys-p', 'sys-x']);
  });

  it('ignores a JSON-encoded context array that happens to serialize with a newline escape', () => {
    const md = queue(task('sys-1', { context: ['line one\nline two'] }));
    expect(splitPromptMetadata(md, { stamp: STAMP })).toEqual({ markdown: md, split: [] });
  });

  // `generateTasksMarkdown` interpolates the description verbatim, so a task
  // filed with embedded newlines sits in the file with prose/blank lines between
  // its header and its metadata until the next parse round-trip flattens it. A
  // scan that stopped at the first non-metadata line would walk past the
  // `context:` line and leave the payload unsplit.
  it('reaches the metadata past a description that spilled onto its own lines', () => {
    const spilled = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #sys-1 | MEDIUM | AUTO | Improve Example App',
      '',
      'Some prose the producer left behind.',
      '  - context: __json__:"line one\\nline two"',
      '',
    ].join('\n');
    const { markdown, split } = splitPromptMetadata(spilled, { stamp: STAMP });
    expect(split).toEqual(['sys-1']);
    expect(markdown).toContain('- prompt: __json__:"line one\\nline two"');
    expect(markdown).toContain(`- updatedAt: ${STAMP}`);
    expect(markdown).toContain('Some prose the producer left behind.');
  });

  // `parseMetadataLine` normalizes legacy Title-Case keys, so an old install's
  // `- Context:` line reads back as `metadata.context`. A case-sensitive compare
  // here would skip it, record the migration applied, and leave it unsplit
  // forever.
  it('migrates a legacy Title-Case Context key', () => {
    const titleCase = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #sys-1 | MEDIUM | AUTO | Improve Example App',
      '  - Context: __json__:"line one\\nline two"',
      '',
    ].join('\n');
    const { markdown, split } = splitPromptMetadata(titleCase, { stamp: STAMP });
    expect(split).toEqual(['sys-1']);
    expect(parseTasksMarkdown(markdown)[0].metadata.prompt).toBe('line one\nline two');
  });

  it('skips a task whose existing prompt is spelled Title-Case', () => {
    const titleCase = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #sys-1 | MEDIUM | AUTO | Improve Example App',
      '  - Prompt: already split',
      '  - context: __json__:"line one\\nline two"',
      '',
    ].join('\n');
    expect(splitPromptMetadata(titleCase, { stamp: STAMP }))
      .toEqual({ markdown: titleCase, split: [] });
  });

  // The payloads this migration targets are generated agent bodies whose
  // continuation lines are markdown headings (`## Phase 1`). Ending the block
  // scan at a `#` line would walk right past the `context:` line below it —
  // and `parseTasksMarkdown` does not end a task there either.
  it('reaches the metadata past a spilled description made of markdown headings', () => {
    const spilled = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #sys-1 | MEDIUM | AUTO | Improve Example App',
      '',
      '## Phase 1',
      'Read PLAN.md.',
      '  - context: __json__:"line one\\nline two"',
      '',
    ].join('\n');
    const { markdown, split } = splitPromptMetadata(spilled, { stamp: STAMP });
    expect(split).toEqual(['sys-1']);
    expect(markdown).toContain('- prompt: __json__:"line one\\nline two"');
    expect(markdown).toContain('## Phase 1');
  });

  it('handles a legacy pre-sentinel escaped value', () => {
    const legacy = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #sys-1 | MEDIUM | AUTO | Improve Example App',
      '  - context: line one\\nline two',
      '',
    ].join('\n');
    const { markdown, split } = splitPromptMetadata(legacy, { stamp: STAMP });
    expect(split).toEqual(['sys-1']);
    expect(parseTasksMarkdown(markdown)[0].metadata.prompt).toBe('line one\nline two');
  });
});

describe('migration 270 up()', () => {
  let rootDir;
  const userTasks = () => join(rootDir, 'data', 'TASKS.md');
  const cosTasks = () => join(rootDir, 'data', 'COS-TASKS.md');

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-270-'));
    await mkdir(join(rootDir, 'data'), { recursive: true });
  });
  afterEach(async () => { await rm(rootDir, { recursive: true, force: true }); });

  it('no-ops when the install has no task queue at all', async () => {
    await expect(migration.up({ rootDir })).resolves.toMatchObject({ ok: true, reason: 'no-task-file' });
  });

  it('splits both queues', async () => {
    await writeFile(userTasks(), queue(task('task-1', { context: AGENT_BODY })));
    await writeFile(cosTasks(), queue(task('sys-1', { context: AGENT_BODY })));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, split: 2 });
    expect(parseTasksMarkdown(await readFile(userTasks(), 'utf-8'))[0].metadata.prompt).toBe(AGENT_BODY);
    expect(parseTasksMarkdown(await readFile(cosTasks(), 'utf-8'))[0].metadata.prompt).toBe(AGENT_BODY);
  });

  it('reports already-split when nothing carries a prompt payload', async () => {
    await writeFile(cosTasks(), queue(task('sys-1', { context: 'one-line note' })));
    await expect(migration.up({ rootDir, now: STAMP }))
      .resolves.toMatchObject({ ok: true, reason: 'already-split', split: 0 });
  });

  // An install that moved its queue in data/cos/state.json must be migrated
  // there, not at the default path.
  it('honours a relocated queue file', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(
      join(rootDir, 'data', 'cos', 'state.json'),
      JSON.stringify({ config: { cosTasksFile: 'data/cos/MY-TASKS.md' } })
    );
    const moved = join(rootDir, 'data', 'cos', 'MY-TASKS.md');
    await writeFile(moved, queue(task('sys-1', { context: AGENT_BODY })));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, split: 1 });
    expect(parseTasksMarkdown(await readFile(moved, 'utf-8'))[0].metadata.prompt).toBe(AGENT_BODY);
  });

  it('falls back to the default queues when CoS state is malformed', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(join(rootDir, 'data', 'cos', 'state.json'), '{not valid json');
    await writeFile(cosTasks(), queue(task('sys-1', { context: AGENT_BODY })));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, split: 1 });

    expect(parseTasksMarkdown(await readFile(cosTasks(), 'utf-8'))[0].metadata.prompt).toBe(AGENT_BODY);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid JSON in data/cos/state.json'));
  });

  // Config moved to its own file in migration 339. A fresh install runs 270
  // against that shape, so the relocated queue must still resolve from there.
  it('honours a relocated queue file recorded in data/cos/config.json', async () => {
    await mkdir(join(rootDir, 'data', 'cos'), { recursive: true });
    await writeFile(
      join(rootDir, 'data', 'cos', 'config.json'),
      JSON.stringify({ cosTasksFile: 'data/cos/MY-TASKS.md' })
    );
    const moved = join(rootDir, 'data', 'cos', 'MY-TASKS.md');
    await writeFile(moved, queue(task('sys-1', { context: AGENT_BODY })));
    await expect(migration.up({ rootDir, now: STAMP })).resolves.toMatchObject({ ok: true, split: 1 });
    expect(parseTasksMarkdown(await readFile(moved, 'utf-8'))[0].metadata.prompt).toBe(AGENT_BODY);
  });
});
