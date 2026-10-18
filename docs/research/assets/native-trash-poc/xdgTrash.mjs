// Proposed PortOS-owned Linux adapter (issue #12231 study): freedesktop.org Trash specification 1.0,
// built on node:fs only. One file per call; the caller owns batching and
// post-operation verification, exactly like the macOS/Windows helpers.
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const NAME_MAX_BYTES = 255;
const INFO_SUFFIX = '.trashinfo';

const homeTrashDir = () => {
  const dataHome = process.env.XDG_DATA_HOME;
  return join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), '.local', 'share'), 'Trash');
};
const missing = error => { if (error.code === 'ENOENT') return null; throw error; };
const refuse = (message, code) => Object.assign(new Error(message), { code });

// Device of a path that may not exist yet (the home trash before first use):
// the nearest existing ancestor decides.
async function deviceOf(path) {
  for (let dir = path; ; dir = dirname(dir)) {
    const info = await lstat(dir).catch(missing);
    if (info) return info.dev;
    if (dirname(dir) === dir) throw refuse(`No existing ancestor for ${path}`, 'ENOENT');
  }
}

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
  const info = await lstat(shared).catch(missing);
  if (info?.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o1000) !== 0) return join(shared, String(uid));
  return join(topDir, `.Trash-${uid}`);
}

// The home trash serves every file on the device the home trash itself lives on
// (XDG_DATA_HOME may sit on another volume than $HOME); anything else gets the
// per-volume trash of its own mount point.
async function trashLocation(absPath) {
  const home = homeTrashDir();
  const fileDev = (await lstat(absPath)).dev;
  if (fileDev === await deviceOf(home)) return { dir: home, topDir: null };
  const topDir = await topDirOf(absPath, fileDev);
  return { dir: await topDirTrash(topDir, process.getuid()), topDir };
}

// A per-user trash directory and its files/ and info/ children must be real
// directories owned by the caller. On a shared volume anyone can pre-create
// `.Trash-<uid>` as a symlink into a directory they control; following it would
// move the user's files there and report success. Re-check after creating, so a
// link planted between the probe and the mkdir is caught as well.
async function ensureOwnedDir(path, uid) {
  let info = await lstat(path).catch(missing);
  if (!info) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    info = await lstat(path);
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
    throw refuse(`Trash directory is not a directory owned by this user: ${path}`, 'TRASH_DIR_UNSAFE');
  }
}

// RFC 2396 escaping as the spec requires: every byte outside the unreserved set,
// keeping '/' as the segment separator.
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const pad = n => String(n).padStart(2, '0');
const deletionDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const exists = path => lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

// Name inside files/: the original basename, `stem.N.ext` on collision, shortened
// by whole code points when `<name>.trashinfo` would exceed NAME_MAX — the stem
// first (the extension keeps the file recognisable), then the extension itself.
// The complete original path always survives in the info file.
function trashName(base, attempt) {
  const suffix = attempt === 0 ? '' : `.${attempt}`;
  const budget = NAME_MAX_BYTES - Buffer.byteLength(INFO_SUFFIX) - Buffer.byteLength(suffix);
  let ext = extname(base);
  const stem = Array.from(base.slice(0, base.length - ext.length));
  while (stem.length > 1 && Buffer.byteLength(stem.join('') + ext) > budget) stem.pop();
  while (Buffer.byteLength(stem.join('') + ext) > budget) ext = Array.from(ext).slice(0, -1).join('');
  return `${stem.join('')}${suffix}${ext}`;
}

export async function trashXdg(path) {
  // Device and mount-point discovery need the physical parent: through a directory
  // symlink into another volume, lexical ancestors would place the volume trash
  // below the real mount root where no trash tool looks. The final component is
  // kept as given so a source that is itself a symlink is what gets recycled.
  const given = resolve(path);
  const absPath = join(await realpath(dirname(given)), basename(given));
  const { dir, topDir } = await trashLocation(absPath);
  const uid = process.getuid();
  const filesDir = join(dir, 'files');
  const infoDir = join(dir, 'info');
  for (const directory of [dir, filesDir, infoDir]) await ensureOwnedDir(directory, uid);
  const base = basename(absPath);
  const recordedPath = topDir ? relative(topDir, absPath) : absPath;
  for (let attempt = 0; attempt < 1000; attempt++) {
    const name = trashName(base, attempt);
    const infoPath = join(infoDir, `${name}${INFO_SUFFIX}`);
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
  throw refuse('No free name in the trash directory', 'TRASH_NAME_EXHAUSTED');
}
