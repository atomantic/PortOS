#!/usr/bin/env node
/** Offline only. Explicit detached inputs; no runtime, data-root or peer discovery. */
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { nativeUsageCanonicalJson } from '../server/lib/nativeUsageContract.js';
import {
  buildNativeUsageBackup, buildNativeUsageRehearsalPreflight, buildNativeUsageRestoreReceipt,
  nativeUsageRehearsalRequestSchema, NATIVE_USAGE_REHEARSAL_FILES, NATIVE_USAGE_REHEARSAL_MAX_BYTES,
  refuseNativeUsageRehearsal as refuse, verifyNativeUsageBackup,
} from '../server/lib/nativeUsageRehearsal.js';
import { verifyNativeUsageStage } from '../server/lib/nativeUsageStaging.js';
import { verifyNativeUsageSnapshot } from './lib/nativeUsageSnapshot.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const STORES = ['usageLedger', 'peerDigests'];
const USAGE = 'Usage: native-usage-rehearse.js backup <stage.json> <request.json> <detached-snapshot-directory> <output-directory> | restore <stage.json> <backup.json> <rehearsal-parent> | preflight <stage.json> <backup.json> <restore-directory> [<backup.json> <restore-directory>...] | snapshot-preflight <stage.json> <backup.json> <detached-standard-snapshot>';
const same = (a, b) => nativeUsageCanonicalJson(a) === nativeUsageCanonicalJson(b);

// A growing/replaced file is not a frozen snapshot. The read has a hard byte cap;
// opening a FIFO, symlink or directory must not block or follow it.
async function readRegular(path, limit = MAX_ARTIFACT_BYTES) {
  const before = await lstat(path);
  if (!before.isFile() || before.size < 1 || before.size > limit) refuse('input-not-bounded-regular-file');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size) refuse('input-changed');
    const bytes = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await file.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    if (!current.isFile() || current.dev !== info.dev || current.ino !== info.ino) refuse('input-changed');
    // Unlinking a publisher's temporary hard link changes ctime, not content.
    // Size/mtime guard the read; callers additionally verify exact bytes/hashes.
    if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) refuse('input-changed');
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

async function readJson(path, limit) {
  const bytes = await readRegular(path, limit);
  return Promise.resolve().then(() => JSON.parse(bytes.toString('utf8'))).catch(() => refuse('input-json-invalid'));
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) refuse('output-not-directory');
}

async function publishBackup(directory, backup) {
  await privateDirectory(directory);
  const temporary = await mkdtemp(join(directory, '.native-usage-backup-'));
  const fileName = `native-usage-backup-${backup.contentHash}.json`;
  const target = join(directory, fileName);
  const bytes = nativeUsageCanonicalJson(backup);
  try {
    const candidate = join(temporary, 'backup.json');
    await writeFile(candidate, bytes, { flag: 'wx', mode: 0o600 });
    await link(candidate, target).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      if ((await readRegular(target)).toString('utf8') !== bytes) refuse('existing-backup-mismatch');
    });
    // Validate the actual published bytes, not merely the candidate in memory.
    if ((await readRegular(target)).toString('utf8') !== bytes) refuse('published-backup-mismatch');
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return fileName;
}

async function restoredFiles(directory) {
  if (!(await lstat(directory)).isDirectory()) refuse('restore-not-directory');
  return Object.fromEntries(await Promise.all(STORES.map(async role => [role, await readRegular(join(directory, `${role}.json`), NATIVE_USAGE_REHEARSAL_MAX_BYTES)])));
}

async function verifyRestored(stage, backup, directory) {
  if (!same((await readdir(directory)).sort(), ['peerDigests.json', 'receipt.json', 'usageLedger.json'])) refuse('restore-file-set-mismatch');
  const expected = buildNativeUsageRestoreReceipt(stage, backup, await restoredFiles(directory));
  if (!same(await readJson(join(directory, 'receipt.json')), expected)) refuse('restore-receipt-mismatch');
  return expected;
}

async function restore(stage, backup, parent) {
  // The caller can choose a parent, never a destination to overwrite. No native
  // paths, identity or barrier files are installed in this fresh directory.
  await privateDirectory(parent);
  const directory = await mkdtemp(join(parent, 'native-usage-restore-'));
  for (const role of STORES) await writeFile(join(directory, `${role}.json`), Buffer.from(backup.payload[role], 'base64'), { flag: 'wx', mode: 0o600 });
  const receipt = buildNativeUsageRestoreReceipt(stage, backup, await restoredFiles(directory));
  await writeFile(join(directory, 'receipt.json'), nativeUsageCanonicalJson(receipt), { flag: 'wx', mode: 0o600 });
  await verifyRestored(stage, backup, directory);
  // Failed/interrupted directories remain for diagnosis and have no valid receipt.
  return { directoryName: basename(directory), receipt };
}

export async function runNativeUsageRehearsalCli(argv, { stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  const [command, ...args] = argv;
  if (command === 'backup' && args.length === 4) {
    const [stagePath, requestPath, source, output] = args;
    const stage = verifyNativeUsageStage(await readJson(stagePath));
    const parsed = nativeUsageRehearsalRequestSchema.safeParse(await readJson(requestPath, 1024 * 1024));
    if (!parsed.success) refuse('request-or-schema-invalid');
    if (!(await lstat(source)).isDirectory()) refuse('snapshot-not-directory');
    const files = {};
    for (const [role, name] of Object.entries(NATIVE_USAGE_REHEARSAL_FILES)) files[role] = await readRegular(join(source, name), parsed.data.files[role].bytes);
    const backup = buildNativeUsageBackup({ stage, request: parsed.data, files });
    const fileName = await publishBackup(output, backup);
    stdout(nativeUsageCanonicalJson({ status: 'barrier-stores-backed-up', fileName, contentHash: backup.contentHash, fullRecoveryBackup: false, activationReady: false }));
    return 0;
  }
  if (command === 'restore' && args.length === 3) {
    const [stagePath, backupPath, parent] = args;
    const stage = verifyNativeUsageStage(await readJson(stagePath));
    const backup = verifyNativeUsageBackup(stage, await readJson(backupPath));
    const result = await restore(stage, backup, parent);
    stdout(nativeUsageCanonicalJson({ status: 'isolated-byte-restore-verified', directoryName: result.directoryName, receipt: result.receipt }));
    return 0;
  }
  if (command === 'snapshot-preflight' && args.length === 3) {
    const stage = verifyNativeUsageStage(await readJson(args[0]));
    const backup = verifyNativeUsageBackup(stage, await readJson(args[1]));
    stdout(nativeUsageCanonicalJson(await verifyNativeUsageSnapshot(stage, backup, args[2])));
    return 3;
  }
  if (command === 'preflight' && args.length >= 3 && args.length <= 129 && args.length % 2 === 1) {
    const stage = verifyNativeUsageStage(await readJson(args[0]));
    const backups = [];
    const receipts = [];
    for (let index = 1; index < args.length; index += 2) {
      const backup = verifyNativeUsageBackup(stage, await readJson(args[index]));
      receipts.push(await verifyRestored(stage, backup, args[index + 1]));
      backups.push(backup);
    }
    stdout(nativeUsageCanonicalJson(buildNativeUsageRehearsalPreflight(stage, backups, receipts)));
    // A verified rehearsal is NOT a green cutover preflight. Fail closed for
    // shell callers as well as people reading activationReady and holdReasons.
    return 3;
  }
  stderr(`${USAGE}\n`);
  return 2;
}

if (isDirectlyInvoked(import.meta.url)) {
  runNativeUsageRehearsalCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.log(`🚫 ${error.code === 'NATIVE_USAGE_REHEARSAL_REFUSED' ? error.message : 'Native usage rehearsal failed; check private input and output files'}`);
    process.exitCode = 1;
  });
}
