import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm, utimes } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { _sweepScreenshots } from './screenshotsGc.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T00:00:00Z');

let dir;

async function put(name, ageDays) {
  const p = join(dir, name);
  await writeFile(p, 'x');
  const secs = (NOW - ageDays * DAY) / 1000;
  await utimes(p, secs, secs);
}

const tasks = (list) => async () => ({ user: { tasks: list }, cos: { tasks: [] } });

beforeEach(async () => {
  dir = join(tmpdir(), `portos-screenshotsgc-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('_sweepScreenshots', () => {
  it('expires shell drops after 7 days, even when a task names them', async () => {
    await put('shell-aaaa1111-old.png', 8);
    await put('shell-bbbb2222-new.png', 6);
    const result = await _sweepScreenshots({
      now: NOW,
      dir,
      readTasks: tasks([{ status: 'pending', metadata: { screenshots: ['/api/screenshots/shell-aaaa1111-old.png'] } }]),
    });
    expect(existsSync(join(dir, 'shell-aaaa1111-old.png'))).toBe(false);
    expect(existsSync(join(dir, 'shell-bbbb2222-new.png'))).toBe(true);
    expect(result).toEqual({ deleted: 1, keptReferenced: 0, keptYoung: 1 });
  });

  it('keeps a 40-day-old screenshot a live task references and removes unreferenced ones', async () => {
    await put('my shot.png', 40);
    await put('orphan.png', 40);
    await put('done-task.png', 40);
    await put('recent.png', 20);
    const result = await _sweepScreenshots({
      now: NOW,
      dir,
      readTasks: tasks([
        { status: 'pending', metadata: { screenshots: [`/api/screenshots/${encodeURIComponent('my shot.png')}`] } },
        { status: 'completed', metadata: { screenshots: ['/api/screenshots/done-task.png'] } },
      ]),
    });
    expect(existsSync(join(dir, 'my shot.png'))).toBe(true);
    expect(existsSync(join(dir, 'orphan.png'))).toBe(false);
    expect(existsSync(join(dir, 'done-task.png'))).toBe(false);
    expect(existsSync(join(dir, 'recent.png'))).toBe(true);
    expect(result).toEqual({ deleted: 2, keptReferenced: 1, keptYoung: 1 });
  });

  it('deletes nothing and logs an error when the task store read throws', async () => {
    await put('shell-cccc3333-old.png', 30);
    await put('old.png', 90);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await _sweepScreenshots({
      now: NOW,
      dir,
      readTasks: async () => { throw new Error('TASKS.md unreadable'); },
    });
    expect(result.skipped).toBe(true);
    expect(existsSync(join(dir, 'shell-cccc3333-old.png'))).toBe(true);
    expect(existsSync(join(dir, 'old.png'))).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('TASKS.md unreadable'));
  });
});
