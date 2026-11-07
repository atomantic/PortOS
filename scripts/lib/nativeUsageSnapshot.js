/** Read-only inspection of an explicitly supplied standard PortOS snapshot. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { nativeUsageCanonicalJson, nativeUsageParticipantKey } from '../../server/lib/nativeUsageContract.js';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { inspectDatabaseDump, REQUIRED_DUMP_TABLES } from '../../server/services/backupDatabaseDump.js';

const MAX_ENTRIES = 100000;
const MAX_DEPTH = 64;
const MAX_JSON_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 ** 3;
const MAX_MILLISECONDS = 15 * 60 * 1000;
const SQL_KEY = '../portos-db.sql';
export const NATIVE_USAGE_SNAPSHOT_TABLES = [...REQUIRED_DUMP_TABLES, 'cos_agents', 'ai_connections', 'ai_harness_bindings', 'ai_route_bindings', 'schema_migrations'];
const same = (a, b) => nativeUsageCanonicalJson(a) === nativeUsageCanonicalJson(b);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const metadata = name => ['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini'].includes(name) || name.startsWith('._');
const GROUPS = {
  usageLedger: 'usage.json', peerDigests: 'peer-usage.json', barrierEvidence: 'usage-cutover-barrier.json',
  legacyInteractiveScan: 'usage-interactive-scan.json', claudeTranscriptHistory: 'claude-code-transcript-usage.json',
  quotaReadings: 'provider-quotas.json', imageReceipts: /^image-render-usage\/[a-f0-9]{64}\.json$/,
  syncCursors: 'instances_sync_cursors.json', settings: 'settings.json', providerConfiguration: 'providers.json',
  instanceConfiguration: 'instances.json', privateConfiguration: 'private/api-keys.json',
  runMetadata: /^runs\/[^/]+\/metadata\.json$/, runOutput: /^runs\/[^/]+\/output\.txt$/,
  lifecycleLog: 'cos/run-events.jsonl', rotatedLifecycleLog: 'cos/run-events.1.jsonl',
  fileMigrations: 'migrations.applied.json', legacyFileMigrations: 'migrations/.applied.json',
};

function normalizedPath(value) {
  const path = value.replaceAll('\\', '/');
  if (/[\x00-\x1f:]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) refuse('snapshot-manifest-path-invalid');
  return path;
}

function manifestFiles(manifest) {
  if (!object(manifest) || !object(manifest.files) || !Number.isInteger(manifest.fileCount)
    || manifest.fileCount < 1 || manifest.fileCount > MAX_ENTRIES
    || typeof manifest.generatedAt !== 'string' || !Number.isFinite(Date.parse(manifest.generatedAt))
    || new Date(manifest.generatedAt).toISOString() !== manifest.generatedAt) refuse('snapshot-manifest-invalid');
  const entries = Object.entries(manifest.files);
  if (manifest.fileCount !== entries.length) refuse('snapshot-manifest-count-mismatch');
  const files = new Map();
  for (const [name, hash] of entries) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) refuse('snapshot-manifest-hash-invalid');
    const path = name === SQL_KEY ? name : normalizedPath(name);
    if (files.has(path)) refuse('snapshot-manifest-path-duplicate');
    files.set(path, hash);
  }
  if (!files.has(SQL_KEY)) refuse('snapshot-database-dump-missing');
  return files;
}

const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

function remainingTime(deadline) {
  const milliseconds = deadline - Date.now();
  if (milliseconds <= 0) refuse('snapshot-time-limit-exceeded');
  return milliseconds;
}

// Pin the descriptor, bound the read to the original size plus one byte and
// check it and its path again. Never open links, FIFOs or devices for inspection.
async function inspectRegular(path, { collect = false, database = false, spoolTo, budget } = {}) {
  const before = await lstat(path);
  if (!before.isFile() || (collect && before.size > MAX_JSON_BYTES)) refuse('snapshot-input-not-bounded-regular-file');
  if (before.size > budget.bytes) refuse('snapshot-byte-limit-exceeded');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !unchanged(before, info)) refuse('snapshot-input-changed');
    const stream = handle.createReadStream({ autoClose: false, start: 0, end: info.size, signal: AbortSignal.timeout(remainingTime(budget.deadline)) });
    let result;
    if (database) result = await inspectDatabaseDump(path, { inputStream: stream, spoolTo, omitVersionDirectives: Boolean(spoolTo), rejectPsqlCommands: Boolean(spoolTo), requiredTables: NATIVE_USAGE_SNAPSHOT_TABLES });
    else {
      const hash = createHash('sha256');
      const chunks = [];
      let sizeBytes = 0;
      for await (const chunk of stream) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        if (collect) chunks.push(chunk);
      }
      result = { sha256: hash.digest('hex'), sizeBytes, ...(collect ? { bytes: Buffer.concat(chunks) } : {}) };
    }
    const current = await lstat(path);
    if (!current.isFile() || !unchanged(info, current) || !unchanged(info, await handle.stat()) || result.sizeBytes !== info.size) refuse('snapshot-input-changed');
    budget.bytes -= result.sizeBytes;
    if (database) result.stat = info;
    return result;
  } catch (error) {
    if (error.code === 'ABORT_ERR') refuse('snapshot-time-limit-exceeded');
    throw error;
  } finally { await handle.close(); }
}

async function noFailureMarkers(root) {
  for (const path of [join(root, '.in-progress'), join(root, '.failed'), join(dirname(root), `.${basename(root)}.in-progress`)]) {
    const found = await lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (found) refuse('snapshot-incomplete-or-failed');
  }
}

async function inventory(root, manifest, budget) {
  const files = [];
  const states = [];
  let entries = 0;
  let ignoredMetadataFiles = 0;
  async function walk(directory, prefix = '', depth = 0) {
    const before = await lstat(directory);
    if (!before.isDirectory() || depth > MAX_DEPTH) refuse('snapshot-directory-invalid');
    states.push([prefix, before.dev, before.ino, before.size, before.mtimeMs]);
    for (const name of (await readdir(directory)).sort()) {
      remainingTime(budget.deadline);
      if (++entries > MAX_ENTRIES) refuse('snapshot-inventory-too-large');
      const path = prefix + name;
      const info = await lstat(join(directory, name));
      states.push([path, info.dev, info.ino, info.size, info.mtimeMs]);
      if (info.isDirectory()) await walk(join(directory, name), `${path}/`, depth + 1);
      else if (!info.isFile()) refuse('snapshot-input-not-bounded-regular-file');
      else if (metadata(name) && !manifest.has(path)) ignoredMetadataFiles += 1;
      else {
        if (normalizedPath(path) !== path) refuse('snapshot-manifest-path-invalid');
        files.push(path);
      }
    }
    if (!unchanged(before, await lstat(directory))) refuse('snapshot-input-changed');
  }
  await walk(root);
  return { files: files.sort(), ignoredMetadataFiles, states };
}

function migrationEvidence(files, checked) {
  const current = files.has('migrations.applied.json') ? 'migrations.applied.json' : null;
  const legacy = files.has('migrations/.applied.json') ? 'migrations/.applied.json' : null;
  for (const name of [current, legacy].filter(Boolean)) {
    const ledger = parseJson(checked.get(name).bytes);
    if (!Array.isArray(ledger) || ledger.some(id => typeof id !== 'string' || !/^\d+-[^/\\]+\.js$/.test(id) || id.endsWith('.test.js'))
      || new Set(ledger).size !== ledger.length) refuse('snapshot-migration-ledger-invalid');
  }
  const selected = current ?? legacy;
  return { status: selected ? 'present-in-snapshot' : 'absent-from-snapshot',
    selected: current ? 'current' : legacy ? 'legacy' : null,
    sha256: selected ? files.get(selected) : null, matchedToCode: false, appliedStateVerified: false };
}

function parseJson(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { refuse('snapshot-json-invalid'); }
}

/** Caller supplies the already verified stage and its verified barrier-store backup. */
export async function verifyNativeUsageSnapshot(stage, backup, directory) {
  const budget = { bytes: MAX_TOTAL_BYTES, deadline: Date.now() + MAX_MILLISECONDS };
  const root = resolve(directory);
  if (!(await lstat(root)).isDirectory()) refuse('snapshot-directory-invalid');
  await noFailureMarkers(root);
  const manifestRead = await inspectRegular(join(root, 'manifest.json'), { collect: true, budget });
  const manifest = parseJson(manifestRead.bytes);
  const files = manifestFiles(manifest);
  if (Date.parse(manifest.generatedAt) < Date.parse(backup.manifest.fencedAt)) refuse('snapshot-capture-precedes-fence');
  const source = join(root, 'data');
  const found = await inventory(source, files, budget);
  const expected = [...files.keys()].filter(name => name !== SQL_KEY).sort();
  if (!same(found.files, expected)) refuse('snapshot-inventory-mismatch');
  const checked = new Map();
  for (const [name, expectedHash] of files) {
    const database = name === SQL_KEY;
    const collect = ['migrations.applied.json', 'migrations/.applied.json', 'instances.json'].includes(name);
    const result = await inspectRegular(database ? join(root, 'portos-db.sql') : join(source, ...name.split('/')), { collect, database, budget });
    if (result.sha256 !== expectedHash) refuse('snapshot-file-hash-mismatch');
    checked.set(name, result);
  }
  for (const [role, name] of Object.entries({ usageLedger: 'usage.json', peerDigests: 'peer-usage.json', barrierRecord: 'usage-cutover-barrier.json' })) {
    // The separate barrier backup already preserves the record. If this snapshot
    // also carries it, divergent retained-write evidence cannot silently pass.
    if (role === 'barrierRecord' && !files.has(name)) continue;
    const bound = backup.request.files[role];
    if (files.get(name) !== bound.sha256 || checked.get(name)?.sizeBytes !== bound.bytes) refuse('snapshot-barrier-backup-mismatch');
  }
  if (!files.has('instances.json')) refuse('snapshot-participant-identity-missing');
  const identity = parseJson(checked.get('instances.json').bytes)?.self?.instanceId;
  if (typeof identity !== 'string' || !identity.trim() || identity.length > 256
    || nativeUsageParticipantKey(identity) !== backup.request.participantKey) refuse('snapshot-participant-identity-mismatch');
  const database = checked.get(SQL_KEY);
  if (!database.complete || database.missingTables.length) refuse('snapshot-database-envelope-invalid');
  const migrations = migrationEvidence(files, checked);
  if (!same(await inventory(source, files, budget), found)) refuse('snapshot-input-changed');
  if ((await inspectRegular(join(root, 'manifest.json'), { collect: true, budget })).sha256 !== manifestRead.sha256) refuse('snapshot-input-changed');
  const dumpStat = await lstat(join(root, 'portos-db.sql'));
  if (!dumpStat.isFile() || !unchanged(database.stat, dumpStat)) refuse('snapshot-input-changed');
  await noFailureMarkers(root);
  const groups = Object.fromEntries(Object.entries(GROUPS).map(([role, matcher]) => {
    const names = expected.filter(name => typeof matcher === 'string' ? name === matcher : matcher.test(name));
    return [role, { status: names.length ? 'present-in-snapshot' : 'absent-from-snapshot', files: names.length }];
  }));
  return {
    version: 1, kind: 'native-usage-snapshot-preflight', stageHash: stage.contentHash, backupHash: backup.contentHash,
    participantKey: backup.request.participantKey, migrationEpoch: backup.manifest.migrationEpoch,
    manifestSha256: manifestRead.sha256, snapshotGeneratedAt: manifest.generatedAt,
    snapshotIntegrityVerified: true, checkedFiles: files.size, ignoredMetadataFiles: found.ignoredMetadataFiles,
    inventoryScope: 'detached-snapshot-only', participantIdentityMatched: true, groups,
    code: { commit: backup.request.codeCommit, evidence: 'barrier-backup-operator-supplied', matchedRuntimeVerified: false },
    fileMigrations: migrations,
    database: { sha256: database.sha256, bytes: database.sizeBytes, tableCount: database.tableCount,
      envelopeVerified: true, requiredTableDefinitionsPresent: true, schemaAndMigrationsMatched: false, restoreVerified: false },
    fullStoreInventoryVerified: false, fullRecoveryBackup: false, activationReady: false,
    holdReasons: ['source-inventory-and-exclusions-not-verified', 'matched-code-schema-and-migrations-not-verified',
      'database-restore-not-verified', 'native-source-preservation-not-verified', 'matched-runtime-restore-not-verified',
      'runtime-not-registered', 'live-barrier-not-verified', 'fenced-interval-not-verified', 'source-freshness-not-verified-at-cutover'],
  };
}

/** Pin and spool the exact already-inspected SQL bytes for a private replay. */
export async function spoolNativeUsageSnapshotDatabase(directory, expected, spoolTo) {
  const result = await inspectRegular(join(directory, 'portos-db.sql'), {
    database: true, spoolTo, budget: { bytes: expected.bytes, deadline: Date.now() + MAX_MILLISECONDS },
  });
  if (result.sha256 !== expected.sha256 || result.sizeBytes !== expected.bytes
    || !result.complete || result.missingTables.length || !result.replayScanSafe) refuse('snapshot-database-replay-mismatch');
  return result;
}
