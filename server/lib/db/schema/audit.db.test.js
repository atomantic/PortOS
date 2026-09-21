/**
 * Postgres-backed regression coverage for the generic deletion-audit trigger.
 *
 * The fixtures are synthetic tables in portos_test only. Each table name is
 * unique to this run so the shared test database remains safe for concurrent
 * worktrees and every inserted audit row is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../../db.js';
import { requireDbOrSkip } from '../../dbTestGate.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((error) => ({ connected: false, error: error?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}

const runDb = requireDbOrSkip('lib/db/schema/audit.db.test', dbReady, skipReason);
const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TABLES = {
  both: `audit_fixture_both_${nonce}`,
  timestampOnly: `audit_fixture_timestamp_${nonce}`,
  flagOnly: `audit_fixture_flag_${nonce}`,
};
const TABLE_NAMES = Object.values(TABLES);

const auditActions = async (tableName) => {
  const { rows } = await query(
    'SELECT action, record_id FROM record_audit WHERE table_name = $1 ORDER BY id',
    [tableName],
  );
  return rows;
};

beforeAll(async () => {
  if (!dbReady) return;
  await query(`
    CREATE TABLE ${TABLES.both} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ
    )
  `);
  await query(`
    CREATE TABLE ${TABLES.timestampOnly} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deleted_at TIMESTAMPTZ
    )
  `);
  await query(`
    CREATE TABLE ${TABLES.flagOnly} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      deleted BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  for (const tableName of TABLE_NAMES) {
    // eslint-disable-next-line no-await-in-loop -- each fixture needs its own trigger.
    await query(
      `CREATE TRIGGER trg_${tableName}_audit
       AFTER UPDATE OR DELETE ON ${tableName}
       FOR EACH ROW EXECUTE FUNCTION record_audit_log()`,
    );
  }
});

afterAll(async () => {
  if (!dbReady) return;
  for (const tableName of TABLE_NAMES) {
    // eslint-disable-next-line no-await-in-loop -- cleanup is ordered and isolated per fixture.
    await query(`DROP TABLE IF EXISTS ${tableName}`).catch(() => {});
  }
  await query('DELETE FROM record_audit WHERE table_name = ANY($1::text[])', [TABLE_NAMES]).catch(() => {});
  await close();
});

describe.skipIf(!runDb)('generic deletion-audit trigger', () => {
  it('treats either deletion marker as active and preserves hard-delete auditing', async () => {
    await query(`INSERT INTO ${TABLES.both} (id, name) VALUES ('both', 'Example Both')`);

    await query(`UPDATE ${TABLES.both} SET deleted_at = NOW() WHERE id = 'both'`);
    expect(await auditActions(TABLES.both)).toEqual([{ action: 'tombstone', record_id: 'both' }]);

    await query(`UPDATE ${TABLES.both} SET deleted_at = NULL WHERE id = 'both'`);
    expect(await auditActions(TABLES.both)).toEqual([
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
    ]);

    await query(`UPDATE ${TABLES.both} SET deleted = TRUE, deleted_at = NOW() WHERE id = 'both'`);
    await query(`UPDATE ${TABLES.both} SET deleted_at = NULL WHERE id = 'both'`);
    expect(await auditActions(TABLES.both)).toEqual([
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
      { action: 'tombstone', record_id: 'both' },
    ]);

    await query(`UPDATE ${TABLES.both} SET deleted = FALSE WHERE id = 'both'`);
    expect(await auditActions(TABLES.both)).toEqual([
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
    ]);

    await query(`DELETE FROM ${TABLES.both} WHERE id = 'both'`);
    expect(await auditActions(TABLES.both)).toEqual([
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
      { action: 'tombstone', record_id: 'both' },
      { action: 'untombstone', record_id: 'both' },
      { action: 'hard_delete', record_id: 'both' },
    ]);
  });

  it('supports timestamp-only and flag-only tables', async () => {
    await query(`INSERT INTO ${TABLES.timestampOnly} (id, name) VALUES ('timestamp', 'Example Timestamp')`);
    await query(`UPDATE ${TABLES.timestampOnly} SET deleted_at = NOW() WHERE id = 'timestamp'`);
    await query(`UPDATE ${TABLES.timestampOnly} SET deleted_at = NULL WHERE id = 'timestamp'`);
    expect(await auditActions(TABLES.timestampOnly)).toEqual([
      { action: 'tombstone', record_id: 'timestamp' },
      { action: 'untombstone', record_id: 'timestamp' },
    ]);

    await query(`INSERT INTO ${TABLES.flagOnly} (id, name) VALUES ('flag', 'Example Flag')`);
    await query(`UPDATE ${TABLES.flagOnly} SET deleted = TRUE WHERE id = 'flag'`);
    await query(`UPDATE ${TABLES.flagOnly} SET deleted = FALSE WHERE id = 'flag'`);
    expect(await auditActions(TABLES.flagOnly)).toEqual([
      { action: 'tombstone', record_id: 'flag' },
      { action: 'untombstone', record_id: 'flag' },
    ]);
  });
});
