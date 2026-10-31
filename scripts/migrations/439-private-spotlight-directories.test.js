import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { excludeFromSpotlight, SPOTLIGHT_EXCLUDED_DIRS } from '../lib/spotlightExclude.js';
import migration from './439-private-spotlight-directories.js';

let rootDir;
const directory = rel => join(rootDir, 'data', rel);
const mode = async path => (await stat(path)).mode & 0o777;
beforeEach(async () => { rootDir = await mkdtemp(join(tmpdir(), 'private-spotlight-')); });
afterEach(() => rm(rootDir, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('macOS Spotlight directory repair', () => {
  it('repairs an existing Spotlight-marked install so private directories are 0o700', async () => {
    excludeFromSpotlight(join(rootDir, 'data'), { platform: 'darwin' });
    for (const rel of SPOTLIGHT_EXCLUDED_DIRS) await chmod(directory(rel), 0o755);

    await migration.up({ rootDir, platform: 'darwin' });

    for (const rel of SPOTLIGHT_EXCLUDED_DIRS) expect(await mode(directory(rel)), rel).toBe(0o700);
    await migration.up({ rootDir, platform: 'darwin' });
    for (const rel of SPOTLIGHT_EXCLUDED_DIRS) expect(await mode(directory(rel)), rel).toBe(0o700);
  });

  it('leaves symlinks, non-directories, absent paths and more restrictive modes untouched', async () => {
    await mkdir(directory('cos'), { recursive: true });
    const target = join(rootDir, 'symlink-target');
    await mkdir(target, { mode: 0o755 });
    await chmod(target, 0o755);
    await symlink(target, directory('browser-profile'));
    await writeFile(directory('python'), 'retained');
    await mkdir(directory('repos'), { mode: 0o500 });
    await chmod(directory('repos'), 0o500);
    try {
      await migration.up({ rootDir, platform: 'darwin' });
      expect((await lstat(directory('browser-profile'))).isSymbolicLink()).toBe(true);
      expect(await mode(target)).toBe(0o755);
      expect(await readFile(directory('python'), 'utf8')).toBe('retained');
      expect(await mode(directory('repos'))).toBe(0o500);
      await expect(lstat(directory('training-runs'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await chmod(directory('repos'), 0o700); }
  });

  it('does not chmod a directory owned by a different user', async () => {
    await mkdir(directory('browser-profile'), { recursive: true });
    await chmod(directory('browser-profile'), 0o755);
    await migration.up({ rootDir, platform: 'darwin', uid: process.getuid() + 1 });
    expect(await mode(directory('browser-profile'))).toBe(0o755);
  });
});

it('does not create directories or change permissions on other platforms', async () => {
  await mkdir(directory('browser-profile'), { recursive: true });
  const before = await mode(directory('browser-profile'));
  await migration.up({ rootDir, platform: 'linux' });
  expect(await mode(directory('browser-profile'))).toBe(before);
  await expect(lstat(directory('cos'))).rejects.toMatchObject({ code: 'ENOENT' });
});
