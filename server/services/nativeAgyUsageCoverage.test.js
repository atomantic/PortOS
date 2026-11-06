import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { encodeMessage } from '../lib/protobufWire.js';
import { nativeAgyUsageProjectionSchema, unionNativeAgyRecords } from '../lib/nativeAgyUsageRecords.js';
import { createHash } from 'node:crypto';
import { buildNativeUsageReport, buildNativeUsageMatrix, nativeUsageCanonicalJson, nativeUsageReportSchema, formatNativeUsageMatrixSummary } from '../lib/nativeUsageContract.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { NATIVE_USAGE_CAPTURE_LIMITS } from './nativeUsageReport.js';
import { getNativeAgyUsageCoverage } from './nativeAgyUsageCoverage.js';

const timestamp = { seconds: { no: 1, type: 'varint' } };
const usageSchema = Object.fromEntries([
  ['model', 1, 'varint'], ['inputTokens', 2, 'varint'], ['outputTokens', 3, 'varint'], ['cacheWriteTokens', 4, 'varint'],
  ['cacheReadTokens', 5, 'varint'], ['apiProvider', 6, 'varint'], ['messageId', 7, 'string'], ['responseHeader', 8, 'string'],
  ['thinkingOutputTokens', 9, 'varint'], ['responseOutputTokens', 10, 'varint'], ['responseId', 11, 'string'],
].map(([name, no, type]) => [name, { no, type }]));
const metadataSchema = { created: { no: 1, type: 'message', schema: timestamp }, completed: { no: 8, type: 'message', schema: timestamp },
  usage: { no: 9, type: 'message', schema: usageSchema }, generationVersion: { no: 21, type: 'varint' }, secret: { no: 24, type: 'string' } };
const usage = id => ({ model: 342, apiProvider: 24, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100,
  thinkingOutputTokens: 3, responseOutputTokens: 2, messageId: `private-message-${id}`, responseId: `private-response-${id}` });
const metadata = value => encodeMessage(metadataSchema, { created: { seconds: 1772323200 }, completed: { seconds: 1772323201 },
  usage: value, secret: 'private transcript text', ...value?.metadataOverrides });
let home;
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'agy-native-test-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

async function database(name, rows, { version = 1, wal = false, extraColumn = false, generatedColumn = false } = {}) {
  const path = join(home, '.gemini/antigravity-cli/conversations', `${name}.db`);
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0,
    has_subtrajectory NUMERIC NOT NULL DEFAULT false, metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB,
    render_info BLOB, step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER);
    CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);
    PRAGMA user_version=${version};`);
  db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id) VALUES (?, ?)').run('synthetic-trajectory', name);
  rows.forEach((row, index) => {
    db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_format) VALUES (?, ?, ?, ?, ?)')
      .run(index, row.type ?? 15, row.status ?? 3, row.blob ?? metadata(row.usage ?? usage(index)), row.format ?? 0);
    db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)').run(index, metadata(row.usage ?? usage(index)), 1);
  });
  if (generatedColumn) db.exec('ALTER TABLE steps ADD COLUMN unknown_generated INTEGER GENERATED ALWAYS AS (42) VIRTUAL');
  if (extraColumn) db.exec('ALTER TABLE steps ADD COLUMN unknown_version TEXT');
  if (wal) db.exec('PRAGMA journal_mode=WAL');
  db.close();
  return path;
}

describe('Antigravity native SQLite retained usage', () => {
  it('reads completed planner and checkpoint metadata once, not transcripts or generation copies, without changing source files', async () => {
    const path = await database('synthetic', [{ usage: usage('planner') }, { type: 23, usage: usage('checkpoint') }], { wal: true });
    const before = await readFile(path);
    const transcript = join(home, '.gemini/antigravity-cli/brain/synthetic/.system_generated/logs/transcript.jsonl');
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(transcript, JSON.stringify({ type: 'PLANNER_RESPONSE', step_index: 0, input_tokens: 1000, output_tokens: 1000, cache_read_tokens: 1000 }));
    const result = await getNativeAgyUsageCoverage({ home });
    expect(result).toMatchObject({ status: 'partial', source: 'agy:cli-sqlite-metadata',
      summary: { totalTokens: null, tokensIn: 20, tokensOut: 10, cacheReadTokens: 200, cacheWriteTokens: 0, thinkingOutputTokens: 6, responseOutputTokens: 4 },
      nativeAgyCoverage: { validDatabases: 1, checkpointRecords: 1 }, coverage: { files: 1, records: 2, measuredRecords: 2 },
      recordProjection: { truncated: false } });
    expect(nativeAgyUsageProjectionSchema.safeParse(result.recordProjection).success).toBe(true);
    expect(await readFile(path)).toEqual(before);
    expect(await readdir(dirname(path))).toEqual(['synthetic.db']);
    expect(JSON.stringify(result)).not.toMatch(/private-|synthetic|transcript text/);
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it('deduplicates copied databases by native identities and preserves conflicts across separate captures', async () => {
    await database('one', [{ usage: usage('a') }]);
    await database('copy', [{ usage: usage('a') }]);
    const clean = await getNativeAgyUsageCoverage({ home });
    expect(clean).toMatchObject({ summary: { tokensIn: 10 }, coverage: { measuredRecords: 1, duplicateRecords: 1 } });
    await database('conflict', [{ usage: { ...usage('a'), inputTokens: 11 } }]);
    const conflicting = await getNativeAgyUsageCoverage({ home });
    expect(conflicting).toMatchObject({ summary: null, coverage: { conflictingRecords: 1 }, recordProjection: { truncated: false } });
    expect(unionNativeAgyRecords([clean.recordProjection, conflicting.recordProjection]).totals).toBeNull();
  });

  it('reports App/IDE containers and legacy-only CLI history as unverified instead of empty account history', async () => {
    for (const root of ['antigravity', 'antigravity-ide']) {
      const path = join(home, '.gemini', root, 'conversations');
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'private.pb'), 'unverified private container');
    }
    await mkdir(join(home, '.gemini/antigravity-cli/brain'), { recursive: true });
    expect(await getNativeAgyUsageCoverage({ home })).toMatchObject({ status: 'unavailable', summary: null,
      nativeAgyCoverage: { unverifiedAppFiles: 1, unverifiedIdeFiles: 1, legacyOnlySources: 1 },
      findings: expect.arrayContaining(['app-ide-history-unverified', 'legacy-history-not-projected', 'source-missing']) });
  });

  it('refuses unsupported schemas, formats, malformed metadata and missing identities as incomplete projections', async () => {
    await database('valid', [{ usage: usage('a') }]);
    await database('schema', [{ usage: usage('b') }], { version: 2 });
    await database('columns', [{ usage: usage('c') }], { extraColumn: true });
    await database('generated', [{ usage: usage('g') }], { generatedColumn: true });
    await database('format', [{ format: 1 }]);
    await database('bad', [{ blob: Buffer.from([0x4a, 0xff]) }]);
    await database('missing', [{ usage: { ...usage('d'), messageId: undefined } }]);
    expect(await getNativeAgyUsageCoverage({ home })).toMatchObject({ summary: { tokensIn: 10 }, recordProjection: { truncated: true },
      nativeAgyCoverage: { unsupportedSchemas: 4, invalidMetadata: 1 }, coverage: { missingIdentityRecords: 1 } });
  });

  it('never treats unfinished, undated, inconsistent or absent usage as a measured final response', async () => {
    await database('states', [{ status: 2, usage: usage('unfinished') }, { blob: encodeMessage(metadataSchema, { usage: usage('undated') }) },
      { usage: { ...usage('inconsistent'), outputTokens: 9 } }, { blob: metadata(undefined) }]);
    expect(await getNativeAgyUsageCoverage({ home })).toMatchObject({ summary: null, recordProjection: { truncated: true },
      coverage: { unfinalizedRecords: 1, undatedRecords: 1, fieldInconsistentRecords: 1, missingUsageRecords: 1, measuredRecords: 0 } });
  });

  it('fails closed for sidecars, symlinks and bounded reads, retaining no misleading union-ready projection', async () => {
    const path = await database('valid', [{ usage: usage('a') }, { usage: usage('b') }]);
    for (const limits of [{ bytes: 1 }, { entries: 0 }, { records: 1 }, { milliseconds: 0 }, { lineBytes: 1 }]) {
      const result = await getNativeAgyUsageCoverage({ home, limits });
      expect(result.coverage.capped).toBe(true);
      expect(result.recordProjection.truncated).toBe(true);
    }
    await writeFile(`${path}-wal`, 'not safe to snapshot');
    expect(await getNativeAgyUsageCoverage({ home })).toMatchObject({ summary: null, nativeAgyCoverage: { unstableDatabases: 1 }, recordProjection: { truncated: true } });
    await rm(`${path}-wal`);
    await symlink(path, join(dirname(path), 'link.db'));
    expect(await getNativeAgyUsageCoverage({ home })).toMatchObject({ coverage: { skippedLinks: 1 }, recordProjection: { truncated: true } });
  });
});

const stagedReport = async (instanceId, options = {}) => buildNativeUsageReport({
  instanceId, capturedAt: options.capturedAt ?? '2026-03-01T12:00:00.000Z', scanLimits: NATIVE_USAGE_CAPTURE_LIMITS,
  codexEvidence: { failureCode: 'CODEX_RUNTIME_MISSING' },
  transcripts: { agy: await getNativeAgyUsageCoverage({ home, ...options }),
    claude: await getNativeTranscriptCoverage('claude', { home }), grok: await getNativeGrokUsageCoverage({ home }) },
});
const selection = (reports, accountLabel = 'shared-account') => ({ family: 'agy', accountLabel,
  historyScope: 'operator-confirmed-retained-history', members: reports.map(report => report.participantKey) });
const agyFamily = matrix => matrix.families.find(({ family }) => family === 'agy');
const matrixFor = reports => agyFamily(buildNativeUsageMatrix({ reports, selections: [selection(reports)] }));

describe('Antigravity versioned retained-account integration', () => {
  it('unions three participants by both opaque identities and never invents a total or price', async () => {
    await database('source', [{ usage: usage('shared') }, { type: 23, usage: usage('checkpoint') }]);
    const reports = await Promise.all(['host-a', 'host-b', 'host-c'].map(id => stagedReport(id)));
    const matrix = buildNativeUsageMatrix({ reports, selections: [selection(reports)] });
    expect(reports.every(report => report.contractVersion === 4 && nativeUsageReportSchema.safeParse(report).success)).toBe(true);
    expect(agyFamily(matrix)).toMatchObject({ merge: { status: 'partial', totals: { totalTokens: null, tokensIn: 20, tokensOut: 10,
      cacheReadTokens: 200, cacheWriteTokens: 0, thinkingOutputTokens: 6, responseOutputTokens: 4 } }, accounts: [{
      coverage: { uniqueRecords: 2, measuredRecords: 2, duplicateRecords: 4 }, cost: { estimatedApiEquivalentUsd: null, actualSpendUsd: null },
      records: [expect.objectContaining({ model: 342, apiProvider: 24 }), expect.objectContaining({ model: 342, apiProvider: 24 })],
    }] });
    expect(formatNativeUsageMatrixSummary(matrix)).toContain('combined total unknown');
    expect(nativeUsageCanonicalJson(matrix)).not.toMatch(/private-message|private-response|transcript text|projectedRecords/);
    expect(nativeUsageCanonicalJson(buildNativeUsageMatrix({ reports: [...reports].reverse(), selections: [selection(reports)] })))
      .toBe(nativeUsageCanonicalJson(matrix));
  });

  it('refuses message and response alias collisions across different selected accounts', async () => {
    const path = await database('first', [{ usage: usage('shared') }]);
    const first = await stagedReport('host-a');
    await rm(path);
    await database('second', [{ usage: { ...usage('other'), responseId: usage('shared').responseId } }]);
    const second = await stagedReport('host-b');
    const matrix = buildNativeUsageMatrix({ reports: [first, second], selections: [selection([first], 'account-a'), selection([second], 'account-b')] });
    expect(agyFamily(matrix)).toMatchObject({ merge: { status: 'refused', totals: null, reasons: ['record-in-multiple-accounts'] },
      accounts: [{ totals: null, records: [] }, { totals: null, records: [] }] });
    expect(matrixFor([first, second])).toMatchObject({ merge: { status: 'refused', totals: null, reasons: ['no-verified-retained-records'] },
      accounts: [{ coverage: { excludedRecords: 2 } }] });
  });

  it('refuses partial sources and older missing projections without discarding version compatibility', async () => {
    await database('good', [{ usage: usage('a') }]);
    const good = await stagedReport('host-a');
    await database('absent', [{ blob: metadata(undefined) }]);
    const incomplete = await stagedReport('host-b');
    expect(matrixFor([good, incomplete]).merge).toMatchObject({ status: 'refused', totals: null, reasons: ['record-projection-truncated'] });
    const legacy = structuredClone(good);
    legacy.contractVersion = 3;
    legacy.providers.forEach(provider => { delete provider.nativeAgyCoverage; });
    const entry = legacy.providers.find(({ family }) => family === 'agy');
    Object.assign(entry, { source: 'agy:retained-transcripts', validator: 'agy-retained-steps/1', recordProjection: null, totals: null });
    delete entry.tokenFields.thinkingOutputTokens; delete entry.tokenFields.responseOutputTokens;
    const digest = value => createHash('sha256').update(nativeUsageCanonicalJson(value).trim()).digest('hex');
    legacy.evidenceHash = digest(legacy.providers); const { contentHash: _hash, ...body } = legacy; legacy.contentHash = digest(body);
    expect(nativeUsageReportSchema.safeParse(legacy).success).toBe(true);
    expect(matrixFor([legacy]).merge).toMatchObject({ status: 'refused', totals: null, reasons: expect.arrayContaining(['record-projection-unavailable']) });
  });

  it('recaptures changed sources rather than reusing totals and preserves conflict evidence', async () => {
    await database('source', [{ usage: usage('a') }]);
    const first = await stagedReport('host-a');
    await database('additional', [{ type: 23, usage: usage('b') }]);
    const later = await stagedReport('host-a', { capturedAt: '2026-03-02T12:00:00.000Z' });
    expect(later.evidenceHash).not.toBe(first.evidenceHash);
    const matrix = buildNativeUsageMatrix({ reports: [first, later], selections: [selection([later])] });
    expect(agyFamily(matrix).merge).toMatchObject({ status: 'partial', totals: { tokensIn: 20, totalTokens: null } });
    await database('conflict', [{ usage: { ...usage('a'), inputTokens: 99 } }]);
    const conflict = await stagedReport('host-b');
    expect(matrixFor([first, conflict])).toMatchObject({ merge: { totals: { tokensIn: 10 } }, accounts: [{ coverage: { excludedRecords: 1 } }] });
  });
});
