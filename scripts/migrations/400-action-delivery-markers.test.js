import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration from './400-action-delivery-markers.js';

let rootDir;
afterEach(async () => { if (rootDir) await rm(rootDir, { recursive: true, force: true }); });

it('adds history visibility without resetting existing reads or hidden obligations, and is idempotent', async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'action-delivery-migration-'));
  await migration.up({ rootDir });
  await mkdir(join(rootDir, 'data'));
  const file = join(rootDir, 'data/notifications.json');
  await writeFile(file, JSON.stringify({ version: 1, notifications: [
    { id: 'legacy', read: true }, { id: 'hidden', read: false, historyHidden: true },
  ] }));
  await migration.up({ rootDir });
  const migrated = await readFile(file, 'utf8');
  expect(JSON.parse(migrated).notifications).toEqual([
    { id: 'legacy', read: true, historyHidden: false }, { id: 'hidden', read: false, historyHidden: true },
  ]);
  await migration.up({ rootDir });
  expect(await readFile(file, 'utf8')).toBe(migrated);
});
