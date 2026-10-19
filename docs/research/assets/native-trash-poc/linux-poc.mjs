// Linux harness for the XDG adapter (issue #12231 study; production module `server/lib/nativeTrashXdg.js`). Run through
// linux-docker-run.sh, which provides the extra volumes it expects. Exits 1 when
// any assertion fails so a broken adapter cannot produce a passing-looking report.
import { trashXdg } from './xdgTrash.mjs';
import { mkdir, writeFile, readFile, readdir, lstat, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
const sh = async (cmd, args, opts = {}) => { try { const { stdout, stderr } = await run(cmd, args, opts); return (stdout + stderr).trim(); } catch (e) { return `ERR(${e.code}): ${String(e.stderr || e.message).trim()}`; } };
const exists = p => lstat(p).then(() => true, () => false);
const failures = [];
const check = (name, ok) => { if (!ok) failures.push(name); return ok; };
const uid = process.getuid();
const out = { uid, home: homedir(), node: process.version, glib: await sh('gio', ['version']), trashCli: (await sh('trash-list', ['--version'])).split('\n')[0] };
const src = join(homedir(), 'poc-src'); await mkdir(src, { recursive: true });
const names = ['scene[1].png', 'a sp ace.txt', 'ünïcödé 🎬.txt', 'pct%25.txt', 'hash#q?.txt', 'plain.txt'];
for (const n of names) await writeFile(join(src, n), `payload:${n}`);
out.homeTrash = [];
for (const n of names) out.homeTrash.push(await trashXdg(join(src, n)).then(r => ({ n, ...r }), e => ({ n, error: e.code || e.message })));
check('home trash: every file moved', out.homeTrash.every(r => r.trashedPath));
check('home trash: originals gone', (await Promise.all(names.map(n => exists(join(src, n))))).every(v => !v));
out.infoSamples = {};
for (const n of ['scene[1].png', 'ünïcödé 🎬.txt', 'pct%25.txt', 'hash#q?.txt']) out.infoSamples[n] = await readFile(join(homedir(), '.local/share/Trash/info', `${n}.trashinfo`), 'utf8');
check('info: spec escaping', out.infoSamples['hash#q?.txt'].includes('Path=/home/node/poc-src/hash%23q%3F.txt'));
// Collision: a second plain.txt
await writeFile(join(src, 'plain.txt'), 'second');
out.collision = await trashXdg(join(src, 'plain.txt'));
check('collision: suffixed name', out.collision.trashedPath.endsWith('/files/plain.1.txt'));
// Long name: NAME_MAX-length basename must still be recyclable, with the full path in the info file.
const longName = 'l'.repeat(250) + '.txt';
await writeFile(join(src, longName), 'long');
out.longName = await trashXdg(join(src, longName)).then(r => ({ trashedBase: r.trashedPath.split('/').pop(), infoHasFullPath: false, r }), e => ({ error: e.code }));
if (out.longName.r) { out.longName.infoHasFullPath = (await readFile(out.longName.r.infoPath, 'utf8')).includes(longName); delete out.longName.r; }
check('long name: recycled with full original path recorded', out.longName.infoHasFullPath === true);
// Long extension ('a.' + 250 chars) and a multibyte stem (125 x 'ü' + '.txt' = 254 bytes): both must fit NAME_MAX
// without splitting a code point, with the full original path in the info file.
out.longVariants = {};
for (const [label, n] of [['longExt', 'a.' + 'x'.repeat(250)], ['multibyteStem', 'ü'.repeat(125) + '.txt']]) {
  await writeFile(join(src, n), label);
  out.longVariants[label] = await trashXdg(join(src, n)).then(async r => {
    const trashedBase = r.trashedPath.split('/').pop();
    return { trashedBytes: Buffer.byteLength(trashedBase), validUtf8: Buffer.from(trashedBase).toString() === trashedBase, infoHasFullPath: (await readFile(r.infoPath, 'utf8')).includes(encodeURIComponent(n)) };
  }, e => ({ error: e.code }));
  check(`${label}: recycled within NAME_MAX with full path recorded`, out.longVariants[label].trashedBytes <= 245 && out.longVariants[label].validUtf8 && out.longVariants[label].infoHasFullPath);
}
// Reference implementation: GLib `gio trash`, then compare the info file it writes.
await writeFile(join(src, 'ref ü#.txt'), 'ref');
out.gioTrash = await sh('gio', ['trash', join(src, 'ref ü#.txt')]);
out.gioInfo = await readFile(join(homedir(), '.local/share/Trash/info', 'ref ü#.txt.trashinfo'), 'utf8').catch(e => e.code);
out.trashDirMode = (await lstat(join(homedir(), '.local/share/Trash'))).mode.toString(8);
// Other volume (tmpfs owned by this uid) -> $topdir/.Trash-$uid with a topdir-relative Path.
await mkdir('/mnt/vol/clips', { recursive: true }); await writeFile('/mnt/vol/clips/clip.mp4', 'video');
out.volume = await trashXdg('/mnt/vol/clips/clip.mp4').catch(e => ({ error: e.code || e.message }));
out.volumeInfo = out.volume.infoPath ? await readFile(out.volume.infoPath, 'utf8') : null;
check('volume: .Trash-uid with relative Path', out.volumeInfo?.includes('Path=clips/clip.mp4') === true);
out.volumeTrashMode = out.volume.infoPath ? (await lstat(`/mnt/vol/.Trash-${uid}`)).mode.toString(8) : null;
// Directory symlink from home into the other volume: the trash must be the volume's own, not below the link.
await mkdir('/mnt/vol/linked', { recursive: true });
await symlink('/mnt/vol/linked', join(homedir(), 'linkdir'));
await writeFile(join(homedir(), 'linkdir', 'via-link.txt'), 'linked');
out.dirSymlink = await trashXdg(join(homedir(), 'linkdir', 'via-link.txt')).catch(e => ({ error: e.code || e.message }));
out.dirSymlinkInfo = out.dirSymlink.infoPath ? await readFile(out.dirSymlink.infoPath, 'utf8') : null;
check('directory symlink into another volume: that volume\'s trash, Path relative to its root', out.dirSymlink.trashedPath === `/mnt/vol/.Trash-${uid}/files/via-link.txt` && out.dirSymlinkInfo?.includes('Path=linked/via-link.txt') === true);
// XDG_DATA_HOME on that other volume: a file there is now on the home trash's device and goes there.
await writeFile('/mnt/vol/clips/same-dev.mp4', 'video');
process.env.XDG_DATA_HOME = '/mnt/vol/xdg';
out.xdgDataHomeElsewhere = await trashXdg('/mnt/vol/clips/same-dev.mp4').catch(e => ({ error: e.code || e.message }));
delete process.env.XDG_DATA_HOME;
check('XDG_DATA_HOME elsewhere: home trash chosen by device of the trash dir', out.xdgDataHomeElsewhere.trashedPath === '/mnt/vol/xdg/Trash/files/same-dev.mp4');
// Shared sticky $topdir/.Trash (root-created 1777) -> $topdir/.Trash/$uid
await writeFile('/mnt/vol3/pub/item.txt', 'shared');
out.sharedTrash = await trashXdg('/mnt/vol3/pub/item.txt').catch(e => ({ error: e.code || e.message }));
check('sticky .Trash: .Trash/uid used', out.sharedTrash.trashedPath === `/mnt/vol3/.Trash/${uid}/files/item.txt`);
// Planted symlink: root pre-created /mnt/vol2/.Trash-<uid> -> /tmp/evil. Must refuse, never follow.
await writeFile('/mnt/vol2/pub/bait.txt', 'bait');
out.plantedSymlink = await trashXdg('/mnt/vol2/pub/bait.txt').then(r => ({ unexpected: r }), e => ({ code: e.code }));
check('planted symlink: refused', out.plantedSymlink.code === 'TRASH_DIR_UNSAFE');
check('planted symlink: file intact', (await readFile('/mnt/vol2/pub/bait.txt', 'utf8')) === 'bait');
check('planted symlink: nothing moved into the link target', (await readdir('/tmp/evil').catch(() => [])).length === 0);
// Volume where no trash dir can be created (root-owned 755 topdir) -> bounded refusal, file untouched.
await writeFile('/mnt/vol4/pub/stuck.txt', 'stuck');
out.refusal = await trashXdg('/mnt/vol4/pub/stuck.txt').then(r => ({ unexpected: r }), e => ({ code: e.code, message: e.message.replace(/\/home\/[^/]+/, '~') }));
check('no trash dir creatable: EACCES', out.refusal.code === 'EACCES');
out.refusalFileIntact = await readFile('/mnt/vol4/pub/stuck.txt', 'utf8');
check('no trash dir creatable: file intact', out.refusalFileIntact === 'stuck');
out.refusalNoLeftoverInfo = !(await exists(`/mnt/vol4/.Trash-${uid}/info/stuck.txt.trashinfo`));
// Missing file -> ENOENT before anything is written.
out.missing = await trashXdg(join(src, 'nope.txt')).catch(e => e.code);
check('missing: ENOENT', out.missing === 'ENOENT');
// Interoperability: trash-cli lists our entries with their original paths, and restores one.
out.trashList = (await sh('trash-list', [])).split('\n').map(l => l.replace(/\/home\/[^/]+/, '~').replace(/l{250}/, 'l*250')).sort();
check('trash-cli lists the volume entry', out.trashList.some(l => l.endsWith('/mnt/vol/clips/clip.mp4')));
out.restoreAttempt = await sh('bash', ['-c', `printf '0\\n' | trash-restore ${JSON.stringify(src)} 2>&1 | tail -3`]);
out.restoredListing = (await readdir(src)).sort();
check('trash-cli restored one entry', out.restoredListing.length === 1);
out.volumeListing = { files: await readdir(`/mnt/vol/.Trash-${uid}/files`).catch(e => e.code), info: await readdir(`/mnt/vol/.Trash-${uid}/info`).catch(e => e.code) };
out.status = failures.length ? 'FAIL' : 'PASS';
out.failures = failures;
console.log(JSON.stringify(out, null, 1));
process.exit(failures.length ? 1 : 0);
