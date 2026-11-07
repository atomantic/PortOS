import { opendir, open, lstat, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { canonicalStringify } from '../lib/objects.js';
import { parseNativeAgyMetadata } from '../lib/nativeAgyMetadata.js';
import { AGY_USAGE_FIELDS, AGY_USAGE_RECORD_LIMIT, unionNativeAgyRecords } from '../lib/nativeAgyUsageRecords.js';

const LIMITS = { bytes: 128 * 1024 ** 2, lineBytes: 1024 ** 2, entries: 30000, records: 100000, milliseconds: 5000, depth: 8 };
const MAX_DATABASE_BYTES = 256 * 1024 ** 2;
const hash = value => createHash('sha256').update(canonicalStringify(value)).digest('hex');
const counter = value => Number.isSafeInteger(value) && value >= 0;
const expectedColumns = {
  steps: { idx: ['INTEGER', 0, 1], step_type: ['INTEGER', 1, 0], status: ['INTEGER', 1, 0], has_subtrajectory: ['NUMERIC', 1, 0],
    metadata: ['BLOB', 0, 0], error_details: ['BLOB', 0, 0], permissions: ['BLOB', 0, 0], task_details: ['BLOB', 0, 0],
    render_info: ['BLOB', 0, 0], step_payload: ['BLOB', 0, 0], step_format: ['INTEGER', 1, 0] },
  trajectory_meta: { trajectory_id: ['TEXT', 0, 1], cascade_id: ['TEXT', 0, 0], trajectory_type: ['INTEGER', 0, 0], source: ['INTEGER', 0, 0] },
};
const schemaMatches = db => db.prepare('PRAGMA user_version').get().user_version === 1
  && db.prepare('PRAGMA application_id').get().application_id === 0
  && Object.entries(expectedColumns).every(([table, columns]) => {
    if (db.prepare('SELECT type FROM sqlite_schema WHERE name = ?').get(table)?.type !== 'table') return false;
    const actual = db.prepare(`PRAGMA table_xinfo(${table})`).all();
    return actual.length === Object.keys(columns).length && actual.every(row => {
      const expected = columns[row.name];
      return expected && row.hidden === 0 && row.type.toUpperCase() === expected[0] && row.notnull === expected[1] && row.pk === expected[2];
    });
  });

/** Read only CLI v1 SQLite metadata. A private, bounded main-file copy avoids
 * SQLite creating source WAL/SHM files or locking a live conversation. Valid
 * headers, stable file metadata and absent sidecars are required around the copy.
 * Native transcripts and gen_metadata duplicate this source and are never added.
 */
export async function getNativeAgyUsageCoverage({ home, cliConversationsRoot, legacyBrainRoot, appConversationsRoot, ideConversationsRoot, limits: overrides = {}, deadline = Infinity } = {}) {
  const limits = { ...LIMITS, ...overrides };
  limits.records = Math.min(limits.records, AGY_USAGE_RECORD_LIMIT + 1);
  const coverage = { files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0,
    duplicateRecords: 0, conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0,
    skippedLinks: 0, missingSource: false, capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0,
    unfinalizedRecords: 0, fieldInconsistentRecords: 0, runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null,
    firstObservedAt: null, lastObservedAt: null, retention: 'unknown' };
  const nativeAgyCoverage = { validDatabases: 0, invalidDatabases: 0, unsupportedSchemas: 0, unstableDatabases: 0,
    rowsWithoutUsage: 0, invalidMetadata: 0, checkpointRecords: 0, unverifiedAppFiles: 0, unverifiedIdeFiles: 0,
    legacyOnlySources: 0 };
  const findings = new Set();
  const projections = [];
  const started = Date.now();
  let bytes = 0;
  let entries = 0;
  let rows = 0;
  let refusedSource = false;
  let temporary;
  const stop = () => { coverage.capped = true; coverage.stoppedEarly = true; };
  const exhausted = () => {
    if (Date.now() >= deadline || Date.now() - started >= limits.milliseconds || bytes >= limits.bytes || entries >= limits.entries || rows >= limits.records) stop();
    return coverage.stoppedEarly;
  };
  const info = async path => lstat(path, { bigint: true }).catch(error => {
    if (error.code !== 'ENOENT') { coverage.unreadableFiles++; refusedSource = true; }
    return null;
  });
  const directory = async (parts, explicitRoot) => {
    // Explicit offline roots must not depend on the host home or its native layout.
    let path = explicitRoot === undefined ? home ?? homedir() : '';
    if (explicitRoot !== undefined) parts = [explicitRoot];
    for (const part of parts) {
      path = join(path, part);
      const stat = await info(path);
      if (!stat) return null;
      if (stat.isSymbolicLink()) { coverage.skippedLinks++; refusedSource = true; return null; }
      if (!stat.isDirectory()) { coverage.unreadableFiles++; refusedSource = true; return null; }
    }
    return path;
  };
  const hasSidecars = async path => {
    for (const suffix of ['-wal', '-shm', '-journal']) if (await info(`${path}${suffix}`)) return true;
    return false;
  };
  const consume = row => {
    rows++;
    if (!counter(row.idx) || !counter(row.step_type) || !counter(row.status) || row.step_format !== 0) {
      nativeAgyCoverage.unsupportedSchemas++; refusedSource = true; return;
    }
    if (row.metadataLength > limits.lineBytes) {
      coverage.oversizedLines++; coverage.capped = true; refusedSource = true; return;
    }
    let parsed;
    try { parsed = parseNativeAgyMetadata(row.metadata ?? new Uint8Array()); }
    catch { nativeAgyCoverage.invalidMetadata++; coverage.invalidLines++; refusedSource = true; return; }
    if (!parsed.usage) {
      nativeAgyCoverage.rowsWithoutUsage++;
      if ([15, 23].includes(row.step_type)) { coverage.missingUsageRecords++; refusedSource = true; }
      return;
    }
    coverage.records++;
    if (![15, 23].includes(row.step_type)) { nativeAgyCoverage.unsupportedSchemas++; refusedSource = true; return; }
    if (row.step_type === 23) nativeAgyCoverage.checkpointRecords++;
    const { usage, createdAt: at, completedAt } = parsed;
    if (!usage.messageId || !usage.responseId) { coverage.missingIdentityRecords++; refusedSource = true; return; }
    if (row.status !== 3) coverage.unfinalizedRecords++;
    if (!at || !completedAt) coverage.undatedRecords++;
    if (at) {
      if (!coverage.firstObservedAt || at < coverage.firstObservedAt) coverage.firstObservedAt = at;
      if (!coverage.lastObservedAt || at > coverage.lastObservedAt) coverage.lastObservedAt = at;
    }
    const values = AGY_USAGE_FIELDS.map(field => usage[field]);
    if (values[1] !== values[4] + values[5] || (at && completedAt && at > completedAt)) coverage.fieldInconsistentRecords++;
    projections.push({ records: [{ recordKey: hash(['portos-agy-message/1', usage.messageId]),
      responseKeys: [hash(['portos-agy-response/1', usage.responseId])], values, model: usage.model, apiProvider: usage.apiProvider,
      stepType: row.step_type, at, completedAt, conflict: false, final: row.status === 3 }] });
  };
  const read = async (path, name) => {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => null);
    if (!handle) { coverage.unreadableFiles++; refusedSource = true; return; }
    let snapshot;
    let db;
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw new Error('not-file');
      coverage.files++;
      if (before.size > BigInt(MAX_DATABASE_BYTES) || before.size > BigInt(Math.max(0, limits.bytes - bytes))) {
        stop(); return;
      }
      const header = Buffer.alloc(100);
      const headerRead = await handle.read(header, 0, header.length, 0);
      if (headerRead.bytesRead !== 100 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('not-sqlite');
      if (![1, 2].includes(header[18]) || header[18] !== header[19] || await hasSidecars(path)) {
        nativeAgyCoverage.unstableDatabases++; refusedSource = true; return;
      }
      temporary ??= await mkdtemp(join(tmpdir(), 'portos-agy-usage-'));
      snapshot = join(temporary, 'snapshot.db');
      const output = await open(snapshot, 'wx', 0o600);
      try {
        const stream = handle.createReadStream({ start: 0, autoClose: false });
        for await (const chunk of stream) {
          bytes += chunk.length;
          if (bytes > limits.bytes || Date.now() >= deadline || Date.now() - started >= limits.milliseconds) { stop(); break; }
          await output.writeFile(chunk);
        }
      } finally { await output.close(); }
      if (coverage.stoppedEarly) return;
      const after = await handle.stat({ bigint: true });
      const current = await info(path);
      if (!current || current.isSymbolicLink() || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.size !== current.size || before.ino !== current.ino || before.dev !== current.dev || before.mtimeNs !== current.mtimeNs || await hasSidecars(path)) {
        nativeAgyCoverage.unstableDatabases++; refusedSource = true; return;
      }
      const snapshotUrl = pathToFileURL(snapshot);
      snapshotUrl.searchParams.set('immutable', '1');
      db = new DatabaseSync(snapshotUrl, { readOnly: true, enableExtensions: false });
      if (!schemaMatches(db)) { nativeAgyCoverage.unsupportedSchemas++; refusedSource = true; return; }
      const identities = db.prepare('SELECT cascade_id FROM trajectory_meta LIMIT 2').all();
      if (identities.length !== 1 || identities[0].cascade_id !== name.slice(0, -3)) {
        nativeAgyCoverage.unsupportedSchemas++; refusedSource = true; return;
      }
      nativeAgyCoverage.validDatabases++;
      // Size gating happens inside SQL before a potentially oversized blob is
      // materialized. No prompt, tool output, generation or credential is read.
      const query = db.prepare('SELECT idx, step_type, status, step_format, length(metadata) AS metadataLength, CASE WHEN length(metadata) <= ? THEN metadata ELSE NULL END AS metadata FROM steps ORDER BY idx');
      for (const row of query.iterate(limits.lineBytes)) {
        if (exhausted()) break;
        consume(row);
      }
    } catch { nativeAgyCoverage.invalidDatabases++; refusedSource = true; }
    finally {
      db?.close();
      await handle.close();
      if (snapshot) await rm(snapshot, { force: true });
    }
  };
  const enumerate = async (path, visit) => {
    const dir = await opendir(path).catch(() => null);
    if (!dir) { coverage.unreadableFiles++; refusedSource = true; return; }
    for await (const entry of dir) {
      entries++;
      if (exhausted()) break;
      if (entry.isSymbolicLink()) { coverage.skippedLinks++; refusedSource = true; continue; }
      await visit(entry);
    }
  };
  try {
    for (const [root, field, explicitRoot] of [['antigravity', 'unverifiedAppFiles', appConversationsRoot], ['antigravity-ide', 'unverifiedIdeFiles', ideConversationsRoot]]) {
      const path = await directory(['.gemini', root, 'conversations'], explicitRoot);
      if (path) await enumerate(path, entry => { if (entry.isFile()) nativeAgyCoverage[field]++; });
    }
    const path = await directory(['.gemini', 'antigravity-cli', 'conversations'], cliConversationsRoot);
    coverage.missingSource = !path;
    if (path) await enumerate(path, async entry => {
      if (entry.isFile() && entry.name.endsWith('.db')) await read(join(path, entry.name), entry.name);
      else if (entry.isFile() && !/\.(db-(?:wal|shm|journal))$/.test(entry.name)) { findings.add('unsupported-native-container'); refusedSource = true; }
    });
    if (!coverage.files && await directory(['.gemini', 'antigravity-cli', 'brain'], legacyBrainRoot)) nativeAgyCoverage.legacyOnlySources++;
  } catch { coverage.unreadableFiles++; refusedSource = true; }
  finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  const union = unionNativeAgyRecords(projections);
  coverage.measuredRecords = union.coverage.measuredRecords;
  coverage.duplicateRecords = union.coverage.duplicateRecords;
  coverage.conflictingRecords = union.coverage.excluded['conflicting-records'] ?? 0;
  for (const code of union.findings) findings.add(code);
  if (nativeAgyCoverage.unverifiedAppFiles || nativeAgyCoverage.unverifiedIdeFiles) findings.add('app-ide-history-unverified');
  if (nativeAgyCoverage.unsupportedSchemas) findings.add('native-schema-unverified');
  if (nativeAgyCoverage.unstableDatabases) findings.add('native-snapshot-unstable');
  if (nativeAgyCoverage.invalidDatabases || nativeAgyCoverage.invalidMetadata) findings.add('native-source-invalid');
  if (nativeAgyCoverage.legacyOnlySources) findings.add('legacy-history-not-projected');
  if (coverage.missingSource) findings.add('source-missing');
  const truncated = coverage.capped || refusedSource || union.projectedRecords.length > AGY_USAGE_RECORD_LIMIT
    || union.projectedRecords.some(record => record.responseKeys.length > 100);
  return {
    status: coverage.records ? 'partial' : 'unavailable', source: 'agy:cli-sqlite-metadata', validator: 'agy-cli-sqlite-v1/1',
    summary: union.totals, coverage, nativeAgyCoverage, findings: [...findings].sort(),
    recordProjection: { version: 1, identityScheme: 'sha256-agy-message-response/1', truncated,
      records: union.projectedRecords.slice(0, AGY_USAGE_RECORD_LIMIT).map(record => ({ ...record, responseKeys: record.responseKeys.slice(0, 100) })) },
  };
}
