// macOS proof (issue #12231 study): recycle synthetic files through
// /usr/bin/osascript running JXA with the ObjC bridge (NSFileManager.trashItemAtURL),
// then verify Trash placement, Finder "Put Back" records (ptbN/ptbL in the Trash's
// .DS_Store), restore, name collisions, the failure matrix, and a second volume
// (a RAM disk -> /Volumes/<name>/.Trashes/<uid>). Every file it creates is removed
// again, including from the Trash. Run: node mac-poc.mjs > report.json
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, lstat, rename, unlink, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);
// The exact script `server/lib/nativeTrash.js` embeds, so this harness proves
// the production body rather than a copy of it.
import { MACOS_TRASH_SCRIPT as JXA } from '../../../../server/lib/nativeTrash.js';

async function osascriptTrash(paths) {
  const started = Date.now();
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA, ...paths], { timeout: 30_000 });
    return { ok: true, ms: Date.now() - started, results: JSON.parse(stdout.trim()) };
  } catch (error) {
    let results = null;
    try { results = JSON.parse(String(error.stdout || '').trim()); } catch {}
    return { ok: false, ms: Date.now() - started, exitCode: error.code, killed: error.killed, results, stderr: results ? undefined : String(error.stderr || '').trim().slice(0, 300) };
  }
}

// Finder keeps Put Back data as `ptbN` (original name) / `ptbL` (original directory)
// `ustr` records keyed by the trashed file name inside the Trash's .DS_Store.
const utf16be = buf => Buffer.from(buf).swap16().toString('utf16le');
function ptbRecords(ds) {
  const out = [];
  for (const type of ['ptbN', 'ptbL']) {
    let i = -1;
    while ((i = ds.indexOf(type, i + 1, 'latin1')) !== -1) {
      if (ds.toString('latin1', i + 4, i + 8) !== 'ustr') continue;
      const len = ds.readUInt32BE(i + 8);
      const value = utf16be(ds.subarray(i + 12, i + 12 + len * 2));
      let name = null;
      for (let L = 1; L < 256 && i - 2 * L - 4 >= 0; L++) {
        if (ds.readUInt32BE(i - 2 * L - 4) === L) { name = utf16be(ds.subarray(i - 2 * L, i)); break; }
      }
      out.push({ name, type, value });
    }
  }
  return out;
}
async function putBackFor(trashDir, trashedNames) {
  // ~/.Trash is TCC-protected: a terminal without Full Disk Access can stat and open
  // known paths but cannot list the directory, and the .DS_Store read may be EPERM.
  const ds = await readFile(join(trashDir, '.DS_Store')).catch(e => e.code);
  if (typeof ds === 'string') return { dsStore: ds, records: {} };
  const recs = ptbRecords(ds);
  const records = {};
  for (const n of trashedNames) {
    const mine = recs.filter(r => r.name === n);
    const ptbL = mine.find(r => r.type === 'ptbL')?.value ?? null;
    records[n] = { ptbN: mine.find(r => r.type === 'ptbN')?.value ?? null, ptbL: ptbL === null ? null : redact('/' + ptbL) };
  }
  return { dsStore: 'present', records };
}
const exists = p => lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const redact = p => p.replace(homedir(), '~');
const redactResults = r => ({ ...r, results: r.results?.map(x => ({ ...x, path: redact(x.path), trashedPath: x.trashedPath && redact(x.trashedPath), error: x.error && redact(x.error) })) });
const trashedOf = r => (r.results || []).filter(x => x.trashedPath);

async function exercise(root, label) {
  const report = {};
  await mkdir(root, { recursive: true });
  const names = ['a sp ace.txt', 'scene[1].png', 'ünïcödé émoji 🎬.txt', 'plain.txt'];
  const paths = names.map(n => join(root, n));
  for (const p of paths) await writeFile(p, `payload:${basename(p)}`);
  // 1. Batch: four files in ONE osascript process.
  const batch = await osascriptTrash(paths);
  report.batch = redactResults(batch);
  const trashed = trashedOf(batch);
  const trashDir = dirname(trashed[0].trashedPath);
  report.batchVerify = {
    originalsGone: (await Promise.all(paths.map(p => exists(p)))).every(v => v === false),
    trashedExist: (await Promise.all(trashed.map(r => exists(r.trashedPath)))).every(Boolean),
    trashDir: redact(trashDir),
    contentIntact: (await readFile(trashed[1].trashedPath, 'utf8')) === `payload:${names[1]}`,
  };
  await sleep(1500);
  report.batchPutBack = await putBackFor(trashDir, trashed.map(r => basename(r.trashedPath)));
  // 2. One osascript process PER FILE.
  const perPaths = ['per-1.txt', 'per-2.txt'].map(n => join(root, n));
  for (const p of perPaths) await writeFile(p, 'per');
  const per = [];
  for (const p of perPaths) per.push(await osascriptTrash([p]));
  report.perFile = per.map(r => ({ ok: r.ok, ms: r.ms }));
  await sleep(1500);
  const perTrashed = per.flatMap(trashedOf);
  report.perFilePutBack = await putBackFor(trashDir, perTrashed.map(r => basename(r.trashedPath)));
  // 3. Failure matrix: missing file; a batch with one missing path (partial success).
  report.missing = redactResults(await osascriptTrash([join(root, 'does-not-exist.txt')]));
  const partialOk = join(root, 'partial-ok.txt'); await writeFile(partialOk, 'p');
  report.partial = redactResults(await osascriptTrash([join(root, 'nope.txt'), partialOk]));
  report.partialVerify = { okFileGone: !(await exists(partialOk)) };
  // 4. Collision: a second file whose name is already in the Trash.
  await writeFile(paths[3], 'second plain');
  report.collision = redactResults(await osascriptTrash([paths[3]]));
  // 5. Restore: move a trashed file back to its original path (what Finder's Put Back does).
  await rename(trashed[0].trashedPath, trashed[0].path);
  report.restore = { restored: await exists(trashed[0].path), content: await readFile(trashed[0].path, 'utf8') };
  // Cleanup: remove every PoC file still in the Trash (content-checked), then the run dir.
  const leftovers = [...trashed.slice(1), ...perTrashed, ...trashedOf(report.partial), ...trashedOf(report.collision)];
  let removed = 0;
  for (const r of leftovers) {
    const p = r.trashedPath.replace(/^~/, homedir());
    const body = await readFile(p, 'utf8').catch(() => null);
    if (body !== null && /^(payload:|per$|p$|second plain$)/.test(body)) { await unlink(p); removed++; }
  }
  report.cleanup = { leftovers: leftovers.length, removed };
  await rm(root, { recursive: true, force: true });
  return { label, ...report };
}

const out = { host: { macOS: (await execFileAsync('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim(), node: process.version, osascript: '/usr/bin/osascript -l JavaScript' } };
const here = dirname(new URL(import.meta.url).pathname);
out.homeVolume = await exercise(join(here, `run-${Date.now()}`), 'same volume as home (~/.Trash)');
// Second volume: a RAM disk, so the per-volume .Trashes/<uid> path is exercised and torn down.
const { stdout: dev } = await execFileAsync('/usr/bin/hdiutil', ['attach', '-nomount', 'ram://65536']);
const disk = dev.trim();
try {
  await execFileAsync('/usr/sbin/diskutil', ['erasevolume', 'APFS', 'PortOSTrashPoc', disk]);
  out.ramDiskVolume = await exercise('/Volumes/PortOSTrashPoc/poc', 'separate volume (RAM disk)');
} finally {
  await execFileAsync('/usr/sbin/diskutil', ['eject', disk]).catch(() => execFileAsync('/usr/bin/hdiutil', ['detach', disk, '-force']));
}
console.log(JSON.stringify(out, null, 2));
