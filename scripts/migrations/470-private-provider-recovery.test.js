import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import migration from './470-private-provider-recovery.js';

const recoveryName = 'providers.pre-graph.json';
const payload = Buffer.from('{"providers":{"example":{"apiKey":"example-token"}}}\n');
const mode = async path => (await lstat(path)).mode & 0o7777;

describe.skipIf(process.platform === 'win32')('provider recovery permissions upgrade', () => {
  let rootDir;
  let directory;
  let recovery;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'portos-provider-recovery-'));
    directory = join(rootDir, 'data', 'private');
    recovery = join(directory, recoveryName);
  });

  afterEach(() => rm(rootDir, { recursive: true, force: true }));

  it('tightens the file and directory in place and preserves stricter owner modes on rerun', async () => {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);
    await writeFile(recovery, payload);
    await chmod(recovery, 0o644);
    const original = await lstat(recovery);

    await migration.up({ rootDir });

    expect(await mode(directory)).toBe(0o700);
    expect(await mode(recovery)).toBe(0o600);
    expect(await readFile(recovery)).toEqual(payload);
    expect((await lstat(recovery)).ino).toBe(original.ino);

    await chmod(recovery, 0o400);
    await chmod(directory, 0o500);
    try {
      await migration.up({ rootDir });

      expect(await mode(directory)).toBe(0o500);
      expect(await mode(recovery)).toBe(0o400);
      expect(await readFile(recovery)).toEqual(payload);
    } finally {
      await chmod(directory, 0o700);
    }
  });

  it('leaves an absent recovery copy alone', async () => {
    await migration.up({ rootDir });
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);

    await migration.up({ rootDir });

    expect(await mode(directory)).toBe(0o755);
    await expect(lstat(recovery)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['file symlink', 'hard link', 'directory symlink', 'data symlink', 'directory at file path'])(
    'skips a %s without changing the target',
    async kind => {
      const outside = join(rootDir, 'outside');
      const target = join(outside, recoveryName);
      await mkdir(outside);
      await chmod(outside, 0o755);
      await writeFile(target, payload);
      await chmod(target, 0o644);

      if (kind === 'data symlink') {
        const outsidePrivate = join(outside, 'private');
        await mkdir(outsidePrivate);
        await chmod(outsidePrivate, 0o755);
        const nested = join(outsidePrivate, recoveryName);
        await writeFile(nested, payload);
        await chmod(nested, 0o644);
        await symlink(outside, join(rootDir, 'data'));
      } else if (kind === 'directory symlink') {
        await mkdir(join(rootDir, 'data'));
        await symlink(outside, directory);
      } else {
        await mkdir(directory, { recursive: true });
        if (kind === 'file symlink') await symlink(target, recovery);
        if (kind === 'hard link') await link(target, recovery);
        if (kind === 'directory at file path') {
          await mkdir(recovery);
          await chmod(recovery, 0o755);
        }
      }

      await migration.up({ rootDir });

      expect(await mode(outside)).toBe(0o755);
      expect(await mode(target)).toBe(0o644);
      expect(await readFile(target)).toEqual(payload);
      if (kind === 'data symlink') {
        expect(await mode(join(outside, 'private'))).toBe(0o755);
        expect(await mode(join(outside, 'private', recoveryName))).toBe(0o644);
      }
      if (kind === 'directory at file path') expect(await mode(recovery)).toBe(0o755);
    },
  );
});
