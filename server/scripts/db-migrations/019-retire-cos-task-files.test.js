import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../../lib/paths.js', () => ({
  PATHS: { get root() { return paths.root; }, get data() { return `${paths.root}/data`; }, get cos() { return `${paths.root}/data/cos`; } },
}));

const { up } = await import('./019-retire-cos-task-files.js');

const write = (rel, text) => { mkdirSync(join(paths.root, rel, '..'), { recursive: true }); writeFileSync(join(paths.root, rel), text); };
const read = (rel) => readFileSync(join(paths.root, rel), 'utf-8');
const json = (rel) => JSON.parse(read(rel));

beforeEach(() => {
  rmSync(paths.root, { recursive: true, force: true });
  paths.root = mkdtempSync(join(tmpdir(), 'cos-task-retire-'));
});
afterAll(() => rmSync(paths.root, { recursive: true, force: true }));

describe('db-migration 019 — retire the CoS Markdown task files', () => {
  it('sets each file aside as *.imported (kept, not deleted) and drops the retired config keys', async () => {
    write('data/TASKS.md', '# Tasks\n');
    write('data/COS-TASKS.md', '# Tasks\n');
    write('data/cos/config.json', JSON.stringify({ userTasksFile: 'data/TASKS.md', cosTasksFile: 'data/COS-TASKS.md', maxConcurrentAgents: 3 }));
    await up();
    expect(existsSync(join(paths.root, 'data/TASKS.md'))).toBe(false);
    expect(read('data/TASKS.md.imported')).toBe('# Tasks\n');
    expect(read('data/COS-TASKS.md.imported')).toBe('# Tasks\n');
    expect(json('data/cos/config.json')).toEqual({ maxConcurrentAgents: 3 });
  });

  it('finds a configured location before dropping the key that names it', async () => {
    write('data/cos/config.json', JSON.stringify({ userTasksFile: 'custom/mine.md' }));
    write('custom/mine.md', '# Tasks\n');
    await up();
    expect(existsSync(join(paths.root, 'custom/mine.md.imported'))).toBe(true);
    expect(json('data/cos/config.json')).toEqual({});
  });

  it('also cleans a legacy state.json config without touching the rest of the state', async () => {
    write('data/cos/state.json', JSON.stringify({ running: true, config: { userTasksFile: 'data/TASKS.md', goalsFile: 'GOALS.md' }, agents: { a: { id: 'a' } } }));
    await up();
    expect(json('data/cos/state.json')).toEqual({ running: true, config: { goalsFile: 'GOALS.md' }, agents: { a: { id: 'a' } } });
  });

  it('is a no-op on a fresh install and on a second run', async () => {
    await up();
    write('data/TASKS.md', '# Tasks\n');
    await up();
    await up();
    expect(readdirSync(join(paths.root, 'data')).sort()).toEqual(['TASKS.md.imported']);
  });

  it('never overwrites an earlier recovery copy', async () => {
    write('data/TASKS.md.imported', 'earlier copy');
    write('data/TASKS.md', 'newer file');
    await up();
    expect(read('data/TASKS.md.imported')).toBe('earlier copy');
    const set = readdirSync(join(paths.root, 'data')).filter((name) => name.startsWith('TASKS.md.imported-'));
    expect(set).toHaveLength(1);
    expect(read(`data/${set[0]}`)).toBe('newer file');
  });
});
