// Windows proof (issue #12231 study) — NOT YET EXECUTED. No Windows host was
// available to the investigation; this is the proposed mechanism in runnable form
// so the implementation PR (or a Windows CI job) can validate it. It recycles
// synthetic files through Windows PowerShell 5.1 (a Windows component) calling
// shell32 SHFileOperationW with FOF_ALLOWUNDO, the same shell path the
// Microsoft.VisualBasic FileSystem.DeleteFile(..., SendToRecycleBin) wrapper uses,
// checks the Recycle Bin's $I<id> metadata records the original path, restores
// one file by moving its $R<id> twin back, and cleans up after itself.
//
// Run from an interactive user session:
//   set PORTOS_POC_NO_BIN_DIR=Z:\some\writable\dir   (a mapped share or other volume with no Recycle Bin)
//   set PORTOS_POC_OVER_CAPACITY_BYTES=<bytes larger than the bin's MaxCapacity for the temp volume>
//   node windows-poc.mjs > report.json
// The report ends with status PASS, FAIL or INCOMPLETE, and the process exits 1 for
// anything but PASS. The two refusal scenarios are REQUIRED: without their
// environment variables the run is INCOMPLETE, never a pass. Acceptance:
//   1. every recycled file is gone from its original path and has a $I record
//      whose embedded path equals the original;
//   2. a file on a volume with no Recycle Bin is REFUSED and left intact — never
//      permanently deleted;
//   3. a file larger than the bin's MaxCapacity is refused and left intact
//      (FOF_WANTNUKEWARNING + FOF_NOERRORUI must not fall through to a permanent delete);
//   4. a missing path reports a non-zero code without affecting the other paths;
//   5. names with spaces, brackets, apostrophes and non-ASCII characters round-trip;
//   6. the whole batch, including the Add-Type compile, completes well inside the
//      30-second deadline (the report records the milliseconds).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile, readdir, lstat, rename, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, parse } from 'node:path';

const execFileAsync = promisify(execFile);
// The exact script and PowerShell path `server/lib/nativeTrash.js` uses, so this
// harness proves the production body rather than a copy of it.
import { WINDOWS_TRASH_SCRIPT as SCRIPT } from '../../../../server/lib/nativeTrash.js';
import { windowsPowerShell51Path } from '../../../../server/lib/processEnv.js';
const POWERSHELL = windowsPowerShell51Path();

async function powershellRecycle(paths) {
  const started = Date.now();
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')];
  const options = { timeout: 30_000, windowsHide: true, env: { ...process.env, PORTOS_TRASH_PATHS: paths.join('\n') } };
  try {
    const { stdout } = await execFileAsync(POWERSHELL, args, options);
    return { ok: true, ms: Date.now() - started, results: [].concat(JSON.parse(stdout.trim())) };
  } catch (error) {
    let results = null;
    try { results = [].concat(JSON.parse(String(error.stdout || '').replace(/^\uFEFF/, '').trim())); } catch {}
    return { ok: false, ms: Date.now() - started, exitCode: error.code, killed: error.killed, results, stderr: results ? undefined : String(error.stderr || '').trim().slice(0, 500) };
  }
}

// $I<id>.<ext>: 8-byte header, 8-byte size, 8-byte FILETIME, then (Win10+) a 4-byte
// path length and the UTF-16LE original path. The matching $R<id>.<ext> is the payload.
async function recycleBinRecords(drive) {
  const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true });
  const binDir = join(drive, '$Recycle.Bin', stdout.trim());
  const records = [];
  for (const name of await readdir(binDir)) {
    if (!name.startsWith('$I')) continue;
    const buf = await readFile(join(binDir, name));
    const version = buf.readBigUInt64LE(0);
    const original = version >= 2n
      ? buf.toString('utf16le', 28, 28 + (buf.readUInt32LE(24) - 1) * 2)
      : buf.toString('utf16le', 24).replace(/\0.*$/s, '');
    records.push({ infoFile: join(binDir, name), payloadFile: join(binDir, '$R' + name.slice(2)), original });
  }
  return records;
}
const exists = p => lstat(p).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; });
const sameFile = (a, b) => a.toLowerCase() === b.toLowerCase();
const failures = [];
const incomplete = [];
const check = (name, ok) => { if (!ok) failures.push(name); return ok; };

const root = join(tmpdir(), `portos-trash-poc-${Date.now()}`);
await mkdir(root, { recursive: true });
const names = ['a sp ace.txt', 'scene[1].png', "it's.txt", 'ünïcödé émoji 🎬.txt', 'plain.txt'];
const paths = names.map(n => join(root, n));
const report = { host: { windows: process.env.OS, node: process.version, powershell: POWERSHELL } };
// Everything this run may leave in the Recycle Bin, keyed by original path: a small text
// body to compare, or an exact byte size for the oversized probe, which is never read.
const owned = new Map();
const own = async (path, body) => { await writeFile(path, body); owned.set(path.toLowerCase(), { body }); };
const noBinDir = process.env.PORTOS_POC_NO_BIN_DIR;
const overBytes = Number(process.env.PORTOS_POC_OVER_CAPACITY_BYTES);
const bait = noBinDir ? join(noBinDir, `portos-poc-no-bin-${Date.now()}.txt`) : null;
const huge = join(root, 'over-capacity.bin');

try {
  for (const p of paths) await own(p, `payload:${basename(p)}`);

  // 1 + 5 + 6: batch of awkward names, one PowerShell process.
  report.batch = await powershellRecycle(paths);
  check('batch: exit 0', report.batch.ok);
  check('batch: originals gone', (await Promise.all(paths.map(p => exists(p)))).every(v => v === false));
  check('batch: inside deadline with margin (<10 s)', report.batch.ms < 10_000);
  let records = await recycleBinRecords(parse(root).root);
  report.restoreMetadata = Object.fromEntries(paths.map(p => [basename(p), records.some(r => sameFile(r.original, p))]));
  check('batch: every file has a $I record naming its original path', Object.values(report.restoreMetadata).every(Boolean));

  // 4: missing path alone, and beside a real one (partial success).
  report.missing = await powershellRecycle([join(root, 'does-not-exist.txt')]);
  check('missing: non-zero exit with a per-file code', !report.missing.ok && report.missing.results?.[0]?.code === 2);
  const partialOk = join(root, 'partial-ok.txt'); await own(partialOk, 'p');
  report.partial = await powershellRecycle([join(root, 'nope.txt'), partialOk]);
  check('partial: real file recycled, missing one reported', !report.partial.ok && !(await exists(partialOk)) && report.partial.results?.some(r => r.recycled));

  // Collision: the shell assigns a fresh $I/$R id; both copies must be in the bin.
  await own(paths[4], 'second plain');
  report.collision = await powershellRecycle([paths[4]]);
  records = await recycleBinRecords(parse(root).root);
  check('collision: two $I records for the same original path', records.filter(r => sameFile(r.original, paths[4])).length === 2);

  // 2: a volume with no Recycle Bin must be refused, file intact. Requires an operator-supplied directory.
  if (bait) {
    await own(bait, 'bait');
    report.noRecycleBinVolume = await powershellRecycle([bait]);
    check('no-bin volume: refused', !report.noRecycleBinVolume.ok);
    check('no-bin volume: file intact (never permanently deleted)', (await readFile(bait, 'utf8').catch(() => null)) === 'bait');
  } else {
    incomplete.push('no-bin volume (set PORTOS_POC_NO_BIN_DIR)');
  }

  // 3: a file larger than the bin's MaxCapacity must be refused, file intact.
  if (Number.isFinite(overBytes) && overBytes > 0) {
    await execFileAsync('fsutil', ['file', 'createnew', huge, String(overBytes)], { windowsHide: true });
    owned.set(huge.toLowerCase(), { size: overBytes });
    report.overCapacity = await powershellRecycle([huge]);
    const stat = await lstat(huge).catch(() => null);
    check('over-capacity: refused', !report.overCapacity.ok);
    check('over-capacity: file intact with its full size', stat?.size === overBytes);
  } else {
    incomplete.push('over-capacity file (set PORTOS_POC_OVER_CAPACITY_BYTES)');
  }

  // Restore: move the $R payload of the first file back where it came from, drop its $I.
  const first = records.find(r => sameFile(r.original, paths[0]));
  if (first) { await rename(first.payloadFile, paths[0]); await unlink(first.infoFile); }
  report.restore = { restored: await exists(paths[0]), content: first ? await readFile(paths[0], 'utf8') : null };
  check('restore: byte-identical content back at the original path', report.restore.content === `payload:${names[0]}`);
} finally {
  // Cleanup runs even when a check threw: remove every owned $I/$R pair (matched by exact
  // original path and by body or by size, never by reading an oversized payload), then
  // whatever is still at the original paths, then the run directory.
  let removed = 0;
  for (const r of await recycleBinRecords(parse(root).root).catch(() => [])) {
    const expected = owned.get(r.original.toLowerCase());
    if (!expected) continue;
    const stat = await lstat(r.payloadFile).catch(() => null);
    if (!stat) continue;
    const mine = 'size' in expected
      ? stat.size === expected.size
      : stat.size < 1024 && (await readFile(r.payloadFile, 'utf8').catch(() => null)) === expected.body;
    if (mine) { await unlink(r.payloadFile); await unlink(r.infoFile); removed++; }
  }
  if (bait) await unlink(bait).catch(() => {});
  await rm(root, { recursive: true, force: true });
  report.cleanup = { removed };
  report.failures = failures;
  report.incomplete = incomplete;
  report.status = failures.length ? 'FAIL' : incomplete.length ? 'INCOMPLETE' : 'PASS';
  console.log(JSON.stringify(report, null, 2));
}
process.exit(report.status === 'PASS' ? 0 : 1);
