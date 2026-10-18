import { trashXdg } from './xdgTrash.mjs';
import { mkdir, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);
const sh = async (cmd, args, opts = {}) => { try { const { stdout, stderr } = await run(cmd, args, opts); return (stdout + stderr).trim(); } catch (e) { return `ERR(${e.code}): ${String(e.stderr || e.message).trim()}`; } };
const exists = p => lstat(p).then(() => true, () => false);
const out = { uid: process.getuid(), home: homedir(), node: process.version, glib: await sh('gio', ['version']), trashCli: (await sh('trash-list', ['--version'])).split('\n')[0] };
const src = join(homedir(), 'poc-src'); await mkdir(src, { recursive: true });
const names = ['scene[1].png', 'a sp ace.txt', 'ünïcödé 🎬.txt', 'pct%25.txt', 'hash#q?.txt', 'plain.txt'];
for (const n of names) await writeFile(join(src, n), `payload:${n}`);
out.homeTrash = [];
for (const n of names) out.homeTrash.push(await trashXdg(join(src, n)).then(r => ({ n, ...r }), e => ({ n, error: e.code || e.message })));
out.originalsGone = (await Promise.all(names.map(n => exists(join(src, n))))).every(v => !v);
out.infoSamples = {};
for (const n of ['scene[1].png', 'ünïcödé 🎬.txt', 'pct%25.txt', 'hash#q?.txt']) out.infoSamples[n] = await readFile(join(homedir(), '.local/share/Trash/info', `${n}.trashinfo`), 'utf8');
// Collision: a second plain.txt
await writeFile(join(src, 'plain.txt'), 'second');
out.collision = await trashXdg(join(src, 'plain.txt'));
// Reference implementation: GLib `gio trash`, then compare the info file it writes.
await writeFile(join(src, 'ref ü#.txt'), 'ref');
out.gioTrash = await sh('gio', ['trash', join(src, 'ref ü#.txt')]);
out.gioInfo = await readFile(join(homedir(), '.local/share/Trash/info', 'ref ü#.txt.trashinfo'), 'utf8').catch(e => e.code);
out.trashDirMode = (await lstat(join(homedir(), '.local/share/Trash'))).mode.toString(8);
// Other volume (tmpfs owned by this uid) -> $topdir/.Trash-$uid with a topdir-relative Path.
await mkdir('/mnt/vol/clips', { recursive: true }); await writeFile('/mnt/vol/clips/clip.mp4', 'video');
out.volume = await trashXdg('/mnt/vol/clips/clip.mp4').catch(e => ({ error: e.code || e.message }));
out.volumeInfo = out.volume.infoPath ? await readFile(out.volume.infoPath, 'utf8') : null;
out.volumeTrashMode = out.volume.infoPath ? (await lstat('/mnt/vol/.Trash-' + process.getuid())).mode.toString(8) : null;
// Shared sticky $topdir/.Trash (root-created 1777) -> $topdir/.Trash/$uid
await writeFile('/mnt/vol3/pub/item.txt', 'shared');
out.sharedTrash = await trashXdg('/mnt/vol3/pub/item.txt').catch(e => ({ error: e.code || e.message }));
// Volume where no trash dir can be created (root-owned 755 topdir) -> bounded refusal, file untouched.
await writeFile('/mnt/vol2/pub/stuck.txt', 'stuck');
out.refusal = await trashXdg('/mnt/vol2/pub/stuck.txt').then(r => ({ unexpected: r }), e => ({ code: e.code, message: e.message.replace(/\/home\/[^/]+/, '~') }));
out.refusalFileIntact = await readFile('/mnt/vol2/pub/stuck.txt', 'utf8');
out.refusalNoLeftoverInfo = !(await exists('/mnt/vol2/.Trash-' + process.getuid() + '/info/stuck.txt.trashinfo'));
// Missing file -> ENOENT before anything is written.
out.missing = await trashXdg(join(src, 'nope.txt')).catch(e => e.code);
// Interoperability: trash-cli lists our entries with their original paths, and restores one.
out.trashList = (await sh('trash-list', [])).split('\n').map(l => l.replace(/\/home\/[^/]+/, '~')).sort();
out.restoreAttempt = await sh('bash', ['-c', `printf '0\\n' | trash-restore ${JSON.stringify(src)} 2>&1 | tail -3`]);
out.restoredListing = (await readdir(src)).sort();
out.volumeListing = { files: await readdir('/mnt/vol/.Trash-1000/files').catch(e => e.code), info: await readdir('/mnt/vol/.Trash-1000/info').catch(e => e.code) };
console.log(JSON.stringify(out, null, 1));
