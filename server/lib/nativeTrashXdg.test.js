// Real temp-filesystem contract for the Linux freedesktop Trash adapter. The
// home trash is pointed at a temp XDG_DATA_HOME beside the sources so every
// case runs on one device; the cross-device cases use /dev/shm when it is a
// different device (Linux CI) and skip elsewhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { _topDirTrash, trashXdg } from './nativeTrashXdg.js';

const state = vi.hoisted(() => ({ homedir: null, renameError: null }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => state.homedir ?? actual.homedir() };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, rename: (...args) => (state.renameError ? Promise.reject(state.renameError) : actual.rename(...args)) };
});

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const exists = path => lstat(path).then(() => true, () => false);
const readInfo = async (infoPath) => {
  const text = await readFile(infoPath, 'utf8');
  const [header, pathLine, dateLine, trailing] = text.split('\n');
  expect(header).toBe('[Trash Info]');
  expect(trailing).toBe('');
  expect(dateLine.replace('DeletionDate=', '')).toMatch(DATE_SHAPE);
  return pathLine.replace('Path=', '');
};

// A second writable device, when the host offers one next to the temp root.
async function otherDevice(rootDev) {
  const info = await lstat('/dev/shm').catch(() => null);
  return info?.isDirectory() && info.dev !== rootDev ? '/dev/shm' : null;
}

describe.skipIf(process.platform === 'win32')('XDG trash adapter', () => {
  let root;
  let src;
  let homeTrash;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'portos-xdg-')));
    src = join(root, 'src');
    await mkdir(src);
    await mkdir(join(root, 'home'));
    state.homedir = join(root, 'home');
    vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg'));
    homeTrash = join(root, 'xdg', 'Trash');
  });
  afterEach(async () => {
    state.renameError = null;
    state.homedir = null;
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the original name, escapes Path per RFC 2396 and stamps a local DeletionDate', async () => {
    expect(root).toMatch(/^[A-Za-z0-9/._-]+$/);
    const cases = [
      ['a sp ace.txt', 'a%20sp%20ace.txt'],
      ['scene[1].png', 'scene%5B1%5D.png'],
      ['100%#?.txt', '100%25%23%3F.txt'],
      ['ünï 🎬.txt', '%C3%BCn%C3%AF%20%F0%9F%8E%AC.txt'],
    ];
    for (const [name, escaped] of cases) {
      const path = join(src, name);
      await writeFile(path, `payload:${name}`);
      const { trashedPath, infoPath } = await trashXdg(path);
      expect(trashedPath).toBe(join(homeTrash, 'files', name));
      expect(infoPath).toBe(join(homeTrash, 'info', `${name}.trashinfo`));
      expect(await exists(path)).toBe(false);
      expect(await readFile(trashedPath, 'utf8')).toBe(`payload:${name}`);
      expect(await readInfo(infoPath)).toBe(`${root}/src/${escaped}`);
    }
    expect((await lstat(homeTrash)).mode & 0o777).toBe(0o700);
  });

  it('suffixes a colliding name through the O_EXCL info reservation and never overwrites an orphan payload', async () => {
    const path = join(src, 'plain.txt');
    const names = [];
    for (const round of [0, 1]) {
      await writeFile(path, `round ${round}`);
      names.push(basename((await trashXdg(path)).trashedPath));
    }
    expect(names).toEqual(['plain.txt', 'plain.1.txt']);
    await writeFile(join(homeTrash, 'files', 'plain.2.txt'), 'orphan');
    await writeFile(path, 'round 2');
    expect(basename((await trashXdg(path)).trashedPath)).toBe('plain.3.txt');
    expect(await readFile(join(homeTrash, 'files', 'plain.2.txt'), 'utf8')).toBe('orphan');
    expect(await exists(join(homeTrash, 'info', 'plain.2.txt.trashinfo'))).toBe(false);
  });

  it('removes the reservation and leaves the original when the move fails', async () => {
    const path = join(src, 'kept.txt');
    await writeFile(path, 'kept');
    state.renameError = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' });
    await expect(trashXdg(path)).rejects.toMatchObject({ code: 'EXDEV' });
    expect(await readFile(path, 'utf8')).toBe('kept');
    expect(await readdir(join(homeTrash, 'info'))).toEqual([]);
    expect(await readdir(join(homeTrash, 'files'))).toEqual([]);
  });

  it('rejects a missing source with ENOENT', async () => {
    await expect(trashXdg(join(src, 'nope.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['the trash root is a symlink', dir => symlink(join(dir, '..', 'evil'), join(dir, 'Trash'))],
    ['files/ is a symlink', async dir => { await mkdir(join(dir, 'Trash'), { mode: 0o700 }); await symlink(join(dir, '..', 'evil'), join(dir, 'Trash', 'files')); }],
  ])('refuses the trash directory when %s and moves nothing', async (_label, plant) => {
    await mkdir(join(root, 'evil'));
    await mkdir(join(root, 'xdg'));
    await plant(join(root, 'xdg'));
    const path = join(src, 'victim.txt');
    await writeFile(path, 'victim');
    await expect(trashXdg(path)).rejects.toMatchObject({ code: 'TRASH_DIR_UNSAFE' });
    expect(await readFile(path, 'utf8')).toBe('victim');
    expect(await readdir(join(root, 'evil'))).toEqual([]);
  });

  it.each([
    ['a 255-byte basename', `${'a'.repeat(251)}.txt`],
    ['a 250-character extension', `f.${'x'.repeat(250)}`],
    ['a multibyte stem', `${'🎬'.repeat(62)}.png`],
  ])('shortens %s to fit NAME_MAX with the .trashinfo suffix and keeps the full path', async (_label, name) => {
    const path = join(src, name);
    await writeFile(path, 'long');
    const { trashedPath, infoPath } = await trashXdg(path);
    const trashed = basename(trashedPath);
    expect(trashed.length).toBeLessThan(name.length);
    expect(Buffer.byteLength(`${trashed}.trashinfo`)).toBeLessThanOrEqual(255);
    expect(Buffer.from(trashed).toString()).toBe(trashed);
    expect(trashed).not.toContain('�');
    expect(await readFile(trashedPath, 'utf8')).toBe('long');
    expect(decodeURIComponent(await readInfo(infoPath))).toBe(path);
  });

  it.each([
    ['world-writable', 0o777],
    ['publicly readable', 0o755],
    ['group-writable files/', 0o770],
  ])('tightens an owned %s trash directory to 0700 before moving anything', async (_label, mode) => {
    const target = mode === 0o770 ? join(homeTrash, 'files') : homeTrash;
    await mkdir(target, { recursive: true, mode: 0o700 });
    await chmod(target, mode);
    const path = join(src, 'private.txt');
    await writeFile(path, 'private', { mode: 0o644 });
    await trashXdg(path);
    for (const directory of [homeTrash, join(homeTrash, 'files'), join(homeTrash, 'info')]) {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(join(homeTrash, 'files', 'private.txt'), 'utf8')).toBe('private');
  });

  it('recycles a symlink source itself rather than its target', async () => {
    await writeFile(join(src, 'target.txt'), 'target');
    await symlink('target.txt', join(src, 'link.txt'));
    const { trashedPath } = await trashXdg(join(src, 'link.txt'));
    expect(await readFile(join(src, 'target.txt'), 'utf8')).toBe('target');
    expect(await readlink(trashedPath)).toBe('target.txt');
  });

  it('chooses $topdir/.Trash/$uid only for a sticky real directory', async () => {
    const uid = process.getuid();
    const top = join(root, 'vol');
    await mkdir(top);
    expect(await _topDirTrash(top, uid)).toBe(join(top, `.Trash-${uid}`));
    await mkdir(join(top, '.Trash'), { mode: 0o777 });
    expect(await _topDirTrash(top, uid)).toBe(join(top, `.Trash-${uid}`));
    await chmod(join(top, '.Trash'), 0o1777);
    expect(await _topDirTrash(top, uid)).toBe(join(top, '.Trash', String(uid)));
    const linked = join(root, 'vol2');
    await mkdir(linked);
    await symlink(join(top, '.Trash'), join(linked, '.Trash'));
    expect(await _topDirTrash(linked, uid)).toBe(join(linked, `.Trash-${uid}`));
  });

  describe('across devices', () => {
    let other = null;
    let otherRoot = null;
    beforeEach(async () => {
      other = await otherDevice((await lstat(root)).dev);
      if (other) otherRoot = await realpath(await mkdtemp(join(other, 'portos-xdg-')));
    });
    afterEach(async () => {
      if (otherRoot) await rm(otherRoot, { recursive: true, force: true });
      otherRoot = null;
    });

    it('uses the physical parent volume trash through a directory symlink and records a topdir-relative path', async ({ skip }) => {
      if (!otherRoot) skip();
      const uid = process.getuid();
      await mkdir(join(otherRoot, 'media'));
      await writeFile(join(otherRoot, 'media', 'file.txt'), 'remote');
      await symlink(join(otherRoot, 'media'), join(src, 'link'));
      const { trashedPath, infoPath } = await trashXdg(join(src, 'link', 'file.txt'));
      try {
        const volumeTrash = await _topDirTrash(other, uid);
        expect(trashedPath).toBe(join(volumeTrash, 'files', 'file.txt'));
        expect(await readFile(trashedPath, 'utf8')).toBe('remote');
        expect(await readInfo(infoPath)).toBe(`${basename(otherRoot)}/media/file.txt`);
        expect(await exists(join(otherRoot, 'media', 'file.txt'))).toBe(false);
      } finally {
        await rm(trashedPath, { force: true });
        await rm(infoPath, { force: true });
      }
    });

    it('falls back to .Trash-<uid> when the sticky shared .Trash cannot hold a per-user directory', async ({ skip }) => {
      if (!otherRoot) skip();
      const uid = process.getuid();
      const shared = join(other, '.Trash');
      if (await exists(shared)) skip();
      await mkdir(shared, { mode: 0o1500 });
      await chmod(shared, 0o1500);
      await writeFile(join(otherRoot, 'file.txt'), 'fallback');
      let trashed;
      try {
        trashed = await trashXdg(join(otherRoot, 'file.txt'));
        expect(trashed.trashedPath).toBe(join(other, `.Trash-${uid}`, 'files', 'file.txt'));
        expect(await readInfo(trashed.infoPath)).toBe(`${basename(otherRoot)}/file.txt`);
      } finally {
        await rm(shared, { recursive: true, force: true });
        if (trashed) { await rm(trashed.trashedPath, { force: true }); await rm(trashed.infoPath, { force: true }); }
      }
    });

    it('probes the home-trash device through a symlinked XDG_DATA_HOME before the trash exists', async ({ skip }) => {
      if (!otherRoot) skip();
      await mkdir(join(otherRoot, 'xdg'));
      await symlink(join(otherRoot, 'xdg'), join(root, 'xdg-link'));
      vi.stubEnv('XDG_DATA_HOME', join(root, 'xdg-link'));
      await mkdir(join(otherRoot, 'src'));
      const path = join(otherRoot, 'src', 'file.txt');
      await writeFile(path, 'through the link');
      const { trashedPath, infoPath } = await trashXdg(path);
      expect(trashedPath).toBe(join(root, 'xdg-link', 'Trash', 'files', 'file.txt'));
      expect(await readFile(join(otherRoot, 'xdg', 'Trash', 'files', 'file.txt'), 'utf8')).toBe('through the link');
      expect(await readInfo(infoPath)).toBe(path);
    });

    it('serves a file on the XDG_DATA_HOME device from the home trash even when $HOME is elsewhere', async ({ skip }) => {
      if (!otherRoot) skip();
      vi.stubEnv('XDG_DATA_HOME', join(otherRoot, 'xdg'));
      await mkdir(join(otherRoot, 'src'));
      const path = join(otherRoot, 'src', 'file.txt');
      await writeFile(path, 'data-home volume');
      const { trashedPath, infoPath } = await trashXdg(path);
      expect(trashedPath).toBe(join(otherRoot, 'xdg', 'Trash', 'files', 'file.txt'));
      expect(await readInfo(infoPath)).toBe(path);
    });
  });
});
