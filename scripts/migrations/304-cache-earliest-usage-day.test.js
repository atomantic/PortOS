import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { up } from './304-cache-earliest-usage-day.js';

const roots = [];

const makeRoot = async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-304-'));
  roots.push(root);
  await mkdir(join(root, 'data'), { recursive: true });
  return root;
};

const readUsage = async (rootDir) =>
  JSON.parse(await readFile(join(rootDir, 'data', 'usage.json'), 'utf8'));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('migration 304 — earliest usage activity day', () => {
  it('caches the earliest daily or rolled-up activity date', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({
      dailyActivity: { '2026-08-20': {}, '2026-08-24': {} },
      monthlyActivity: { '2025-11': {}, '2026-07': {} }
    }));

    await up({ rootDir });

    expect((await readUsage(rootDir)).earliestActivityDay).toBe('2025-11-01');
  });

  it('writes null for an empty history and is idempotent', async () => {
    const rootDir = await makeRoot();
    await writeFile(join(rootDir, 'data', 'usage.json'), JSON.stringify({ dailyActivity: {}, monthlyActivity: {} }));

    await up({ rootDir });
    const first = await readUsage(rootDir);
    await up({ rootDir });

    expect(first.earliestActivityDay).toBeNull();
    expect(await readUsage(rootDir)).toEqual(first);
  });

  it('is a no-op when usage.json does not exist', async () => {
    await expect(up({ rootDir: await makeRoot() })).resolves.toBeUndefined();
  });
});
