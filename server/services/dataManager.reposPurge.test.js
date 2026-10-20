/**
 * "Cloned Repos" purge must keep managed app checkouts (issue #12439).
 *
 * data/repos holds both throwaway agent clones and installed app checkouts
 * (Eidoverse Worlds, its video companion, any registered app repo). Purging the
 * category must remove only the clones. Runs against a temp data root so the
 * install's real data/ is never touched.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'datamanager-repos-purge-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return makePathsProxy(actual, { dataRoot: TEST_DATA_ROOT });
});

vi.mock('../lib/db.js', () => ({ query: vi.fn() }));
vi.mock('./apps.js', () => ({ getAllApps: vi.fn(async () => []) }));
// The publication gate's admission directory is resolved from paths.js, which the
// fileUtils redirect above does not reach; this suite is about the purge rule, not admission.
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: (fn) => fn() }));

const { purgeCategory } = await import('./dataManager.js');
const { getAllApps } = await import('./apps.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const dataPath = (...parts) => join(TEST_DATA_ROOT, ...parts);
const writeRepoFile = (...parts) => {
  mkdirSync(dataPath('repos', ...parts.slice(0, -1)), { recursive: true });
  writeFileSync(dataPath('repos', ...parts), 'x');
};

beforeEach(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  vi.mocked(getAllApps).mockResolvedValue([]);
  writeRepoFile('acme', 'agent-clone', 'README.md');
  writeRepoFile('atomantic', 'eidoverse-worlds', '.env.portos');
  writeRepoFile('anima-research', 'eidoverse-video', 'package.json');
});

describe('purgeCategory — repos keeps managed app checkouts (#12439)', () => {
  it('removes an agent clone and leaves the Eidoverse worlds and video checkouts', async () => {
    await purgeCategory('repos');
    expect(existsSync(dataPath('repos', 'acme'))).toBe(false);
    expect(existsSync(dataPath('repos', 'atomantic', 'eidoverse-worlds', '.env.portos'))).toBe(true);
    expect(existsSync(dataPath('repos', 'anima-research', 'eidoverse-video', 'package.json'))).toBe(true);
  });

  it('keeps a registered app checkout that is not the Eidoverse default', async () => {
    writeRepoFile('acme', 'managed-app', 'app.json');
    vi.mocked(getAllApps).mockResolvedValue([{ repoPath: dataPath('repos', 'acme', 'managed-app') }]);
    await purgeCategory('repos');
    expect(existsSync(dataPath('repos', 'acme', 'managed-app', 'app.json'))).toBe(true);
    expect(existsSync(dataPath('repos', 'acme', 'agent-clone'))).toBe(false);
  });

  it('refuses an item purge that would delete a protected checkout or its ancestor', async () => {
    await expect(purgeCategory('repos', { subPath: 'anima-research' })).rejects.toThrow(/managed app checkout/);
    await expect(purgeCategory('repos', { subPath: 'atomantic' })).rejects.toThrow(/managed app checkout/);
    expect(existsSync(dataPath('repos', 'anima-research', 'eidoverse-video', 'package.json'))).toBe(true);
    expect(existsSync(dataPath('repos', 'atomantic', 'eidoverse-worlds', '.env.portos'))).toBe(true);
  });
});
