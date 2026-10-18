// Proposed PortOS-owned Linux adapter (issue #12231 study): freedesktop.org Trash specification 1.0,
// built on node:fs only. One file per call; the caller owns batching and
// post-operation verification, exactly like the macOS/Windows helpers.
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const homeTrashDir = () => {
  const dataHome = process.env.XDG_DATA_HOME;
  return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local', 'share'), 'Trash');
};

// Mount point of `path`: the highest ancestor still on the same device.
async function topDirOf(path, dev) {
  let dir = dirname(path);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return dir;
    if ((await lstat(parent)).dev !== dev) return dir;
    dir = parent;
  }
}

// Spec §"Trash directories": prefer $topdir/.Trash/$uid when $topdir/.Trash is a
// sticky, non-symlink directory; otherwise $topdir/.Trash-$uid. A .Trash that
// fails the checks MUST NOT be used.
async function topDirTrash(topDir, uid) {
  const shared = join(topDir, '.Trash');
  const info = await lstat(shared).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info?.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o1000) !== 0) return join(shared, String(uid));
  return join(topDir, `.Trash-${uid}`);
}

async function trashLocation(absPath) {
  const [fileInfo, homeInfo] = await Promise.all([lstat(absPath), lstat(homedir())]);
  if (fileInfo.dev === homeInfo.dev) return { dir: homeTrashDir(), topDir: null };
  const topDir = await topDirOf(absPath, fileInfo.dev);
  return { dir: await topDirTrash(topDir, process.getuid()), topDir };
}

// RFC 2396 escaping as the spec requires: every byte outside the unreserved set,
// keeping '/' as the segment separator.
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const pad = n => String(n).padStart(2, '0');
const deletionDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export async function trashXdg(path) {
  const absPath = resolve(path);
  const { dir, topDir } = await trashLocation(absPath);
  const filesDir = join(dir, 'files');
  const infoDir = join(dir, 'info');
  await mkdir(filesDir, { recursive: true, mode: 0o700 });
  await mkdir(infoDir, { recursive: true, mode: 0o700 });
  const base = basename(absPath);
  const ext = extname(base);
  const stem = base.slice(0, base.length - ext.length);
  const recordedPath = topDir ? relative(topDir, absPath) : absPath;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = attempt === 0 ? base : `${stem}.${attempt}${ext}`;
    const infoPath = join(infoDir, `${name}.trashinfo`);
    const target = join(filesDir, name);
    // The info file is the atomic reservation (O_EXCL); an orphan in files/ also blocks the name.
    let handle;
    try { handle = await open(infoPath, 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') continue; throw error; }
    try {
      if (await exists(target)) { await handle.close(); handle = null; await unlink(infoPath); continue; }
      await handle.writeFile(`[Trash Info]\nPath=${encodePath(recordedPath)}\nDeletionDate=${deletionDate()}\n`);
      await handle.close();
      handle = null;
      await rename(absPath, target);
      return { trashedPath: target, infoPath };
    } catch (error) {
      // Nothing moved: EXDEV (no usable per-volume trash), EACCES, etc. surface as a bounded refusal.
      if (handle) await handle.close().catch(() => {});
      await unlink(infoPath).catch(() => {});
      throw error;
    }
  }
  throw new Error('No free name in the trash directory');
}
