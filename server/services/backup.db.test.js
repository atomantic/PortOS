/** Real clean-dump restore regressions. Only guarded test databases. */
import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { checkHealth, ensureSchema, query, close, getServerMajorVersion, POOL_CONFIG } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { ownTestBodies } from '../lib/mockPathsDataRoot.js';
import { resolvePgDumpBinary } from '../lib/pgTools.js';
import { runDbMigrations } from '../scripts/run-db-migrations.js';
import { listFolders } from './writersRoom/db.js';
import { syncFeedTables, syncFeedSequenceName } from '../lib/db/schema/syncFeed.js';

// The real rewind rewrites this install's data/instances_sync_cursors.json.
const rewindPostgresSyncCursors = vi.hoisted(() => vi.fn(async () => 0));
vi.mock('./syncOrchestrator.js', () => ({ rewindPostgresSyncCursors }));
// The restore recovery journal (#9725) lives in data/ and fences the pool; keep
// it in a disposable data root, never the install's live tree.
const dataRoot = vi.hoisted(() => ({ path: null }));
vi.mock('../lib/paths.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir: osTmp } = await import('node:os');
  dataRoot.path = mkdtempSync(join(osTmp(), 'portos-restore-db-data-'));
  return { ...actual, PATHS: { ...actual.PATHS, data: dataRoot.path } };
});
const runDbMigrationsFault = vi.hoisted(() => ({ next: null }));
vi.mock('../scripts/run-db-migrations.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runDbMigrations: async (...args) => {
      const fault = runDbMigrationsFault.next;
      runDbMigrationsFault.next = null;
      if (fault) throw fault;
      return actual.runDbMigrations(...args);
    },
  };
});

// Load the service before timing restore assertions, as other integration
// suites do. A cold module graph is setup, not database replay time.
const { restorePostgres } = await import('./backup.js');
// Vitest's timeout settles a case while its body keeps running: it can still be
// between queries and start its next restore (or arm the migration fault)
// after the following case began. Own each WHOLE body, not just its restore
// promises, so case boundaries and teardown wait for every continuation (#10272).
const owned = ownTestBodies(vitestIt);
const it = owned.it;
let fixtureSetup;

const feedSequenceValues = async () => Object.fromEntries((await query(
  'SELECT sequencename, last_value::text AS v FROM pg_sequences WHERE sequencename = ANY($1::text[])',
  [syncFeedTables.map(syncFeedSequenceName)],
)).rows.map(({ sequencename, v }) => [sequencename, v]));

const health = await checkHealth();
const ready = requireDbOrSkip('services/backup.db.test',
  health.connected && spawnSync('psql', ['--version']).status === 0,
  'test database or PostgreSQL client tools unavailable');
let dest;
let dumpPath;
const folderId = 'restore-schema-folder-probe';
const issueId = 'restore-schema-issue-probe';
const personId = '00000000-0000-4000-8000-000000000862';
const executionHostId = randomUUID();
const pendingMigration = '007-storyboard-scene-durable-ids.js';
const connectionArgs = ['-h', POOL_CONFIG.host, '-p', String(POOL_CONFIG.port), '-U', POOL_CONFIG.user, '-d', POOL_CONFIG.database];
const childEnv = { ...process.env, PGPASSWORD: POOL_CONFIG.password };
const DUMP_COMPLETE = '\n--\n-- PostgreSQL database dump complete';

afterAll(async () => {
  // Vitest timing out a case or hook does not cancel its real restore or
  // queries. Drain them before cleanup queries, which otherwise race the
  // restore's maintenance fence; a late body failure is rethrown afterwards.
  await Promise.allSettled([fixtureSetup]);
  const drained = owned.drain();
  await drained.catch(() => {});
  runDbMigrationsFault.next = null;
  try {
    if (ready) {
      await query('DROP SCHEMA IF EXISTS restore_external CASCADE');
      await query('DROP TABLE IF EXISTS public.unexpected_restore_record');
      await ensureSchema({ force: true });
      await query('DELETE FROM peer_execution_operations WHERE host_instance_id = $1', [executionHostId]);
      await query('DELETE FROM peer_execution_generation_floors WHERE host_instance_id = $1', [executionHostId]);
      await query('DELETE FROM writers_room_folders WHERE id = $1', [folderId]);
      await query('DELETE FROM pipeline_issues WHERE id = $1', [issueId]);
      await query("DELETE FROM tribe_people WHERE id = $1 OR id = '00000000-0000-4000-8000-000000000863'", [personId]);
      await query("DELETE FROM app_quality_measurements WHERE app_id = 'restore-probe'");
      await runDbMigrations();
    }
  } finally {
    // Resource release must survive an earlier replay/repair/cleanup failure.
    await Promise.all([
      close(),
      dest && rm(dest, { recursive: true, force: true }),
      dataRoot.path && rm(dataRoot.path, { recursive: true, force: true }),
    ]);
  }
  await drained;
});

function restore(dryRun = false, snapshotId = 'old-schema') {
  return restorePostgres(dest, snapshotId, { source: 'fixture-source', dryRun });
}

describe.skipIf(!ready)('restore older database schema', () => {
  let appliedBefore;
  let feedBefore;
  const folder = { id: folderId, name: 'Recovered folder' };

  // A timed-out test keeps running. Gate every following case on the previous
  // body's full settlement before it can query the shared database or arm the
  // fault; a failed or timed-out drain hook skips that case's body, and a body
  // that failed after its timeout is reported here rather than dropped.
  beforeEach(async () => {
    try {
      await owned.drain();
    } finally {
      runDbMigrationsFault.next = null;
    }
  });

  // Prepare the shared snapshot in a hook so setup failures stop dependent
  // cases and the first test's budget measures restore and its assertions.
  // Teardown drains it too: a timed-out hook keeps running like a case does.
  beforeAll(() => (fixtureSetup = prepareFixture()));

  async function prepareFixture() {
    await ensureSchema({ force: true });
    await runDbMigrations();
    appliedBefore = await query('SELECT id, applied_at FROM schema_migrations WHERE id <> $1 ORDER BY id', [pendingMigration]);
    await query('INSERT INTO writers_room_folders (id, name, data) VALUES ($1, $2, $3)', [folderId, folder.name, folder]);
    await query("INSERT INTO pipeline_issues (id, series_id, data) VALUES ($1, 'restore-schema-series', $2)", [
      issueId, { stages: { storyboards: { scenes: [{ description: 'Synthetic scene' }] } } },
    ]);
    await query("INSERT INTO tribe_people (id, name) VALUES ($1, 'Snapshot person')", [personId]);
    // The snapshot predates this table and its inbound FK to tribe_people.
    await query('DROP TABLE beeper_participants, app_quality_measurements');
    await query('ALTER TABLE writers_room_folders DROP COLUMN deleted, DROP COLUMN deleted_at');
    await query('DELETE FROM schema_migrations WHERE id = $1', [pendingMigration]);
    dest = await mkdtemp(join(tmpdir(), 'portos-restore-schema-'));
    const snapshotDir = join(dest, 'snapshots', 'fixture-source', 'old-schema');
    await mkdir(snapshotDir, { recursive: true });
    dumpPath = join(snapshotDir, 'portos-db.sql');
    const { binary } = await resolvePgDumpBinary(await getServerMajorVersion());
    const dump = spawnSync(binary, [...connectionArgs, '--no-owner', '--no-acl', '--clean', '--if-exists',
      '--exclude-table=peer_execution_operations', '--exclude-table=peer_execution_generation_floors', '-f', dumpPath], { env: childEnv, encoding: 'utf8' });
    expect(dump.status, dump.stderr).toBe(0);
    expect(await readFile(dumpPath, 'utf8')).toContain('COMMENT ON EXTENSION');

    // Boot current schema, including its new inbound foreign key. An empty
    // newer table is sufficient to break the old direct-replay implementation.
    await ensureSchema({ force: true });
    await runDbMigrations();
    await query("UPDATE tribe_people SET name = 'After backup' WHERE id = $1", [personId]);
    await query("INSERT INTO tribe_people (id, name) VALUES ('00000000-0000-4000-8000-000000000863', 'Post-snapshot person')");
    // A simpler approved additive table holds post-snapshot rows to prove a
    // full replacement, independently of Beeper's account/conversation graph.
    await query("INSERT INTO app_quality_measurements VALUES ('restore-probe', 'test', 'agent', NOW(), '{}')");
    // Feed positions handed out after the dump must never be reissued (#8710).
    await query("SELECT nextval('memories_sync_feed_seq') FROM generate_series(1, 5)");
    feedBefore = await feedSequenceValues();
  }

  it('restores a real pre-FK dump, discards newer rows, and runs schema repair and ordered migrations', async () => {
    expect(await restore()).toMatchObject({ status: 'ok', dryRun: false });
    expect(rewindPostgresSyncCursors).toHaveBeenCalledOnce();
    const feedAfter = await feedSequenceValues();
    for (const [name, value] of Object.entries(feedBefore)) {
      if (value !== null) expect(BigInt(feedAfter[name])).toBeGreaterThanOrEqual(BigInt(value));
    }
    const next = (await query("SELECT nextval('memories_sync_feed_seq')::text AS v")).rows[0].v;
    expect(BigInt(next)).toBeGreaterThan(BigInt(feedBefore.memories_sync_feed_seq));
    expect(await listFolders()).toContainEqual(folder);
    expect((await query('SELECT name FROM tribe_people WHERE id = $1', [personId])).rows).toEqual([{ name: 'Snapshot person' }]);
    expect((await query("SELECT id FROM tribe_people WHERE id = '00000000-0000-4000-8000-000000000863'")).rowCount).toBe(0);
    expect((await query("SELECT * FROM app_quality_measurements WHERE app_id = 'restore-probe'")).rowCount).toBe(0);
    expect((await query('SELECT * FROM beeper_participants')).rowCount).toBe(0);
    expect((await query("SELECT 1 FROM pg_constraint WHERE conrelid = 'beeper_participants'::regclass AND confrelid = 'tribe_people'::regclass")).rowCount).toBe(1);
    const issue = await query('SELECT data FROM pipeline_issues WHERE id = $1', [issueId]);
    expect(issue.rows[0].data.stages.storyboards.scenes[0].id).toBeTruthy();
    expect((await query('SELECT id, applied_at FROM schema_migrations WHERE id <> $1 ORDER BY id', [pendingMigration])).rows).toEqual(appliedBefore.rows);
    expect(await runDbMigrations()).toBe(0);
  });

  // #9925: replay a complete real dump with the exact newer-client header
  // against the guarded test target. On PG16 this previously rolled back.
  it('restores a newer-client transaction_timeout header without changing its source or receipt identity', async () => {
    const dir = join(dest, 'snapshots', 'fixture-source', 'newer-client');
    await mkdir(dir);
    const original = await readFile(dumpPath, 'utf8');
    const sql = original.includes('SET transaction_timeout = 0;')
      ? original : original.replace('SET statement_timeout = 0;', 'SET statement_timeout = 0;\nSET transaction_timeout = 0;');
    const path = join(dir, 'portos-db.sql');
    await writeFile(path, sql);
    await query("UPDATE tribe_people SET name = 'Changed after newer-client backup' WHERE id = $1", [personId]);
    expect(await restore(true, 'newer-client')).toMatchObject({ status: 'ok', dryRun: true });
    expect(await restore(false, 'newer-client')).toMatchObject({ status: 'ok', dryRun: false });
    expect((await query('SELECT name FROM tribe_people WHERE id = $1', [personId])).rows).toEqual([{ name: 'Snapshot person' }]);
    expect(await readFile(path, 'utf8')).toBe(sql);
  });

  it('preserves execution consumption and generation floors through a real dump without ledger tables', async () => {
    const { createPeerExecutionLedger } = await import('./peerExecutionLedger.js');
    const { withTransaction } = await import('../lib/db.js');
    const ledger = createPeerExecutionLedger({ db: { query, withTransaction }, dataDir: dataRoot.path });
    const epoch = (await ledger.initialize()).epoch;
    const input = { hostInstanceId: executionHostId, peerInstanceId: randomUUID(), requestId: randomUUID(), grantId: randomUUID(),
      grantGeneration: 1, scope: 'execution-v1', pairBinding: 'a'.repeat(64), intent: { action: 'portos.restart' },
      receiverVersion: 'fixture-1.0', evidenceDigest: 'b'.repeat(64), executionEpoch: epoch };
    const saved = (await ledger.consume(input)).operation;
    await ledger.advanceGenerationFloor({ hostInstanceId: executionHostId, peerInstanceId: input.peerInstanceId,
      action: input.intent.action, generation: 3, executionEpoch: epoch });
    expect(await restore()).toMatchObject({ status: 'ok', dryRun: false });
    expect(await ledger.read(saved.operationId)).toMatchObject({ state: 'uncertain', fingerprint: saved.fingerprint });
    const current = ledger.authority.read();
    expect(current.epoch).not.toBe(epoch);
    await expect(ledger.consume(input)).rejects.toMatchObject({ code: 'PEER_EXECUTION_AUTHORITY_UNAVAILABLE' });
    await expect(ledger.consume({ ...input, executionEpoch: current.epoch })).rejects.toMatchObject({ code: 'PEER_EXECUTION_REPLAY_CONFLICT' });
    const { rows: [floor] } = await query('SELECT generation FROM peer_execution_generation_floors WHERE host_instance_id = $1', [executionHostId]);
    expect(Number(floor.generation)).toBe(3);
  });

  // #9725: a committed replay whose repair fails keeps ordinary work fenced
  // with its receipt and ORIGINAL floors, and recovery repairs without replay.
  it('fences a committed replay whose migrations fail, then recovers from the receipt and original floors', async () => {
    const { resumeDatabaseRestore } = await import('./backupRestoreRecovery.js');
    const { databaseRestoreRecovery } = await import('../lib/db.js');
    await query("SELECT nextval('memories_sync_feed_seq') FROM generate_series(1, 3)");
    const floorBefore = BigInt((await feedSequenceValues()).memories_sync_feed_seq);
    runDbMigrationsFault.next = new Error('injected migration fault');
    const failed = await restore();
    expect(failed).toMatchObject({ status: 'failed', reason: 'restore_schema_reconciliation', recovery: { stage: 'repairing' } });
    const journal = databaseRestoreRecovery.read();
    expect(journal.id).toBe(failed.recovery.id);
    expect(BigInt(journal.feedPositions.find(p => p.sequencename === 'memories_sync_feed_seq').last_value)).toBe(floorBefore);
    await expect(query('SELECT 1')).rejects.toMatchObject({ code: 'DATABASE_RESTORE_RECOVERY' });
    expect(await restore(true)).toMatchObject({ status: 'failed', reason: 'restore_recovery_pending' });

    // Recovery owns the same maintenance fence and pool as replay. If this
    // assertion times out, later cases and teardown drain it with the body.
    expect(await resumeDatabaseRestore(journal.id)).toMatchObject({ status: 'ok', outcome: 'repaired' });
    expect(databaseRestoreRecovery.read()).toBeNull();
    // The receipt committed with the replay, inside its transaction.
    expect((await query('SELECT dump_sha256 FROM restore_receipts WHERE operation_id = $1', [journal.id])).rows)
      .toEqual([{ dump_sha256: journal.dumpSha256 }]);
    const next = (await query("SELECT nextval('memories_sync_feed_seq')::text AS v")).rows[0].v;
    expect(BigInt(next)).toBeGreaterThan(floorBefore);
  });

  it('rolls back the reset and preserves rows and constraints when replay fails', async () => {
    const invalidDir = join(dest, 'snapshots', 'fixture-source', 'invalid-sql');
    await mkdir(invalidDir);
    // Inside the complete envelope, so admission passes and psql itself fails.
    const dumpSql = await readFile(dumpPath, 'utf8');
    const trailerAt = dumpSql.lastIndexOf(DUMP_COMPLETE);
    await writeFile(join(invalidDir, 'portos-db.sql'), `${dumpSql.slice(0, trailerAt)}\nTHIS IS INVALID SQL;\n${dumpSql.slice(trailerAt)}`);
    await query("UPDATE tribe_people SET name = 'Must survive failure' WHERE id = $1", [personId]);
    const before = (await query("SELECT oid FROM pg_constraint WHERE conrelid = 'beeper_participants'::regclass ORDER BY oid")).rows;
    const rewindsBefore = rewindPostgresSyncCursors.mock.calls.length;
    expect(await restore(false, 'invalid-sql')).toMatchObject({ status: 'failed', reason: 'restore_error' });
    expect(rewindPostgresSyncCursors).toHaveBeenCalledTimes(rewindsBefore);
    expect((await query('SELECT name FROM tribe_people WHERE id = $1', [personId])).rows).toEqual([{ name: 'Must survive failure' }]);
    expect((await query("SELECT oid FROM pg_constraint WHERE conrelid = 'beeper_participants'::regclass ORDER BY oid")).rows).toEqual(before);
    // The maintenance gate must have released on the replay error.
    await query("UPDATE tribe_people SET name = 'After failed restore' WHERE id = $1", [personId]);
  });

  // #8782: a legacy dump without a checksum that parses cleanly but stops early
  // must be refused before the full reset, or it commits an empty database.
  for (const [name, truncate] of [
    ['header-only', sql => sql.slice(0, sql.indexOf('SET '))],
    ['truncated between complete statements', sql => sql.slice(0, sql.indexOf('\nCOPY ') + 1)],
  ]) it(`refuses a ${name} legacy dump in preview and execution and keeps existing rows`, async () => {
    const dir = join(dest, 'snapshots', 'fixture-source', `truncated-${name.split(' ')[0]}`);
    await mkdir(dir);
    await writeFile(join(dir, 'portos-db.sql'), truncate(await readFile(dumpPath, 'utf8')));
    await query("UPDATE tribe_people SET name = 'Must survive refusal' WHERE id = $1", [personId]);
    const rewindsBefore = rewindPostgresSyncCursors.mock.calls.length;
    for (const dryRun of [true, false]) {
      expect(await restore(dryRun, basename(dir))).toMatchObject({ status: 'failed', reason: 'dump_incomplete' });
    }
    expect(rewindPostgresSyncCursors).toHaveBeenCalledTimes(rewindsBefore);
    expect((await query('SELECT name FROM tribe_people WHERE id = $1', [personId])).rows).toEqual([{ name: 'Must survive refusal' }]);
    expect((await query('SELECT 1 FROM writers_room_folders WHERE id = $1', [folderId])).rowCount).toBe(1);
  });

  it('preflights unknown objects and external dependencies without mutations, including preview', async () => {
    await query('CREATE TABLE public.unexpected_restore_record (id integer PRIMARY KEY)');
    await query('INSERT INTO public.unexpected_restore_record VALUES (42)');
    expect(await restore()).toMatchObject({ status: 'failed', reason: 'restore_preflight' });
    expect((await query('SELECT * FROM public.unexpected_restore_record')).rows).toEqual([{ id: 42 }]);
    await query('DROP TABLE public.unexpected_restore_record');
    await query('CREATE SCHEMA restore_external');
    await query('CREATE TABLE restore_external.link (person_id uuid REFERENCES public.tribe_people(id))');
    await query('INSERT INTO restore_external.link VALUES ($1)', [personId]);
    expect(await restore(true)).toMatchObject({ status: 'failed', reason: 'restore_preflight' });
    expect(await restore()).toMatchObject({ status: 'failed', reason: 'restore_preflight' });
    expect((await query('SELECT * FROM restore_external.link')).rows).toEqual([{ person_id: personId }]);
    await query('DROP SCHEMA restore_external CASCADE');
    const before = (await query('SELECT tableoid, xmin, name FROM tribe_people WHERE id = $1', [personId])).rows;
    expect(await restore(true)).toMatchObject({ status: 'ok', dryRun: true });
    expect((await query('SELECT tableoid, xmin, name FROM tribe_people WHERE id = $1', [personId])).rows).toEqual(before);
  });
});
