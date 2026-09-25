/**
 * Postgres-backed proof that deleting a Tribe person eventually erases them
 * (#8459): the real FK cascade, the real `record_audit` trigger (which writes a
 * snapshot for every cascaded row mid-transaction), and the retention window.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js). Every assertion is scoped to this run's
 * own ids so concurrent suites sharing the test DB are unaffected. Fixtures use
 * placeholder names and handles only.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as tribe from './tribe.js';
import * as tribeIdentities from './tribeIdentities.js';
import { runTribePurge } from './tribePurge.js';

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    dbReady = true;
  }
}
const runDb = requireDbOrSkip('services/tribePurge.db.test', dbReady, skipReason);

const nonce = `tribepurge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createdPersonIds = [];
const createdMemoryIds = [];
const creativeAuditIds = [];

afterAll(async () => {
  if (!dbReady) return;
  if (createdPersonIds.length) {
    await query('DELETE FROM tribe_people WHERE id = ANY($1::uuid[])', [createdPersonIds]).catch(() => {});
    await query(
      `DELETE FROM record_audit
       WHERE (table_name = 'tribe_people' AND record_id = ANY($1::text[]))
          OR (table_name IN ('tribe_touchpoints', 'tribe_identities') AND row_snapshot->>'person_id' = ANY($1::text[]))`,
      [createdPersonIds],
    ).catch(() => {});
  }
  if (createdMemoryIds.length) {
    await query('DELETE FROM memories WHERE id = ANY($1::uuid[])', [createdMemoryIds]).catch(() => {});
  }
  if (creativeAuditIds.length) {
    await query('DELETE FROM record_audit WHERE id = ANY($1::bigint[])', [creativeAuditIds]).catch(() => {});
  }
  await close();
});

// A person with one of everything the purge must erase: a touchpoint (whose
// summary is conversation content), an identity (a handle), and a memory link.
async function makePersonWithHistory(label) {
  const person = await tribe.createPerson({
    name: `Example Person ${label}`,
    emails: [`${label}-${nonce}@example.com`],
    phones: ['+15550100000'],
    notes: 'Example private note',
  });
  createdPersonIds.push(person.id);
  const touchpoint = await tribe.createTouchpoint(person.id, { channel: 'call', summary: 'Example conversation summary' });
  const identity = await tribeIdentities.linkIdentity({
    personId: person.id, kind: 'email', handle: `handle-${label}-${nonce}@example.com`,
  });
  const { rows } = await query(
    `INSERT INTO memories (type, content) VALUES ('observation', $1) RETURNING id`,
    [`Example memory ${nonce}`],
  );
  createdMemoryIds.push(rows[0].id);
  await tribe.linkMemory(person.id, rows[0].id, 'example link');
  return { personId: person.id, touchpointId: touchpoint.id, identityId: identity.id, memoryId: rows[0].id };
}

async function deleteAndBackdate(personId, days) {
  expect(await tribe.deletePerson(personId)).toBe(true);
  await query(
    `UPDATE tribe_people SET deleted_at = NOW() - make_interval(days => $2::int) WHERE id = $1`,
    [personId, days],
  );
}

const count = async (sql, params) => Number((await query(sql, params)).rows[0].n);

const personRows = (fx) => Promise.all([
  count('SELECT COUNT(*) AS n FROM tribe_people WHERE id = $1', [fx.personId]),
  count('SELECT COUNT(*) AS n FROM tribe_touchpoints WHERE id = $1', [fx.touchpointId]),
  count('SELECT COUNT(*) AS n FROM tribe_identities WHERE id = $1', [fx.identityId]),
  count('SELECT COUNT(*) AS n FROM tribe_memory_links WHERE person_id = $1', [fx.personId]),
]);

const personAuditRows = (personId) => count(
  `SELECT COUNT(*) AS n FROM record_audit
   WHERE (table_name = 'tribe_people' AND record_id = $1)
      OR (table_name IN ('tribe_touchpoints', 'tribe_identities') AND row_snapshot->>'person_id' = $1)`,
  [personId],
);

describe.skipIf(!runDb)('Tribe erasure sweep (#8459)', () => {
  it('erases people past the window with their history and snapshots, keeps recent deletes, and leaves creative audit rows alone', async () => {
    const expired = await makePersonWithHistory('expired');
    const recent = await makePersonWithHistory('recent');
    await deleteAndBackdate(expired.personId, 31);
    await deleteAndBackdate(recent.personId, 5);

    // A creative-table snapshot older than the window must survive: there the
    // audit log is the data-loss recovery source.
    const { rows: creative } = await query(
      `INSERT INTO record_audit (table_name, record_id, record_name, action, row_snapshot, occurred_at)
       VALUES ('universes', $1, 'Example Universe', 'tombstone', '{}'::jsonb, NOW() - INTERVAL '90 days')
       RETURNING id`,
      [`universe-${nonce}`],
    );
    creativeAuditIds.push(creative[0].id);

    // A tribe snapshot older than the window for a person who still exists
    // (restored after an earlier delete) expires on retention alone.
    const { rows: staleTribe } = await query(
      `INSERT INTO record_audit (table_name, record_id, record_name, action, row_snapshot, occurred_at)
       VALUES ('tribe_people', $1, 'Example Person stale', 'untombstone', '{}'::jsonb, NOW() - INTERVAL '45 days')
       RETURNING id`,
      [`stale-${nonce}`],
    );

    expect(await personAuditRows(expired.personId)).toBeGreaterThan(0);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runTribePurge();
    const lines = log.mock.calls.map((args) => args.join(' ')).filter((line) => line.includes('Tribe purge'));
    log.mockRestore();

    // Expired person: every row and every audit snapshot is gone, including
    // the hard_delete snapshots the cascade wrote during the purge itself.
    expect(await personRows(expired)).toEqual([0, 0, 0, 0]);
    expect(await personAuditRows(expired.personId)).toBe(0);

    // Recently deleted person: untouched, including their tombstone snapshot.
    expect(await personRows(recent)).toEqual([1, 1, 1, 1]);
    expect(await count(
      `SELECT COUNT(*) AS n FROM record_audit WHERE table_name = 'tribe_people' AND record_id = $1 AND action = 'tombstone'`,
      [recent.personId],
    )).toBe(1);

    expect(await count('SELECT COUNT(*) AS n FROM record_audit WHERE id = $1', [creative[0].id])).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM record_audit WHERE id = $1', [staleTribe[0].id])).toBe(0);

    // The log line carries counts only — no name, email or handle.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/erased \d+ deleted people, \d+ audit snapshots/);
    expect(lines[0]).not.toMatch(/Example|example\.com|\+1555/);
  });
});
