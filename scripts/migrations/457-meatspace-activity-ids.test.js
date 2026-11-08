import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './457-meatspace-activity-ids.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function install(doc) {
  const rootDir = await mkdtemp(join(tmpdir(), 'activity-ids-'));
  roots.push(rootDir);
  const dir = join(rootDir, 'data', 'meatspace');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'activities.json');
  if (doc !== undefined) await writeFile(path, JSON.stringify(doc));
  return { rootDir, read: async () => JSON.parse(await readFile(path, 'utf8')) };
}

describe('meatspace activity id backfill migration', () => {
  it('gives same-named, nameless and duplicate-id rows distinct ids and keeps an existing unique id', async () => {
    const m = await install({ activities: [
      { name: 'Walks', cadence: 'day', frequency: 1 },
      { name: 'Walks', cadence: 'week', frequency: 2 },
      { cadence: 'year', frequency: 1 },
      { id: 'kept', name: 'Books', cadence: 'month', frequency: 1 },
      { id: 'kept', name: 'Copy', cadence: 'month', frequency: 1 },
    ] });
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ assigned: 4 });
    const { activities } = await m.read();
    expect(new Set(activities.map(a => a.id)).size).toBe(5);
    expect(activities[3]).toEqual({ id: 'kept', name: 'Books', cadence: 'month', frequency: 1 });
    expect(activities[2]).toMatchObject({ cadence: 'year', frequency: 1 });
    expect(activities.map(a => a.name)).toEqual(['Walks', 'Walks', undefined, 'Books', 'Copy']);
  });

  it('a second pass keeps the ids the first one assigned', async () => {
    const m = await install({ activities: [{ name: 'Walks', cadence: 'day', frequency: 1 }] });
    await migration.up({ rootDir: m.rootDir });
    const before = await m.read();
    expect(await migration.up({ rootDir: m.rootDir })).toEqual({ assigned: 0 });
    expect(await m.read()).toEqual(before);
  });

  it('leaves an install with no activities file, or no stored list, untouched', async () => {
    const absent = await install();
    expect(await migration.up({ rootDir: absent.rootDir })).toEqual({ assigned: 0, reason: 'no-input' });
    const defaults = await install({ activities: null });
    expect(await migration.up({ rootDir: defaults.rootDir })).toEqual({ assigned: 0, reason: 'no-activities' });
    expect(await defaults.read()).toEqual({ activities: null });
  });
});
