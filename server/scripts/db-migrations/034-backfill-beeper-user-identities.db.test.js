import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { runDbMigrations } from '../run-db-migrations.js';
import { up } from './034-backfill-beeper-user-identities.js';

const health = await checkHealth().catch(() => ({ connected: false }));
if (health.connected) await ensureSchema();
const runDb = requireDbOrSkip('db-migrations/034-backfill-beeper-user-identities.db.test', health.connected, 'disposable PostgreSQL unavailable');

const nonce = randomUUID();
const accountId = `beeper-backfill-${nonce}`;
const migrationId = `034-backfill-beeper-user-identities-${nonce}.js`;
const clearClaims = () => query("DELETE FROM tribe_identities WHERE kind = 'beeper-user'");

async function addChat(sourceChatId) {
  const { rows: [{ id }] } = await query(
    `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type)
     VALUES ($1, 'Example Network', $2, 'Example Chat', 'single')
     RETURNING id`,
    [accountId, sourceChatId],
  );
  return id;
}

async function addPerson(label, deleted = false) {
  const { rows: [{ id }] } = await query(
    'INSERT INTO tribe_people (name, deleted) VALUES ($1, $2) RETURNING id',
    [`${accountId} ${label}`, deleted],
  );
  return id;
}

const addParticipant = (chat, sourceUserId, personId, updatedAt = null) => query(
  `INSERT INTO beeper_participants (conversation_id, source_user_id, tribe_person_id, observed_via, updated_at)
   VALUES ($1, $2, $3, 'message-sender', COALESCE($4::timestamptz, NOW()))`,
  [chat, sourceUserId, personId, updatedAt],
);

const claims = async () => (await query(
  `SELECT handle, person_id, source FROM tribe_identities
   WHERE kind = 'beeper-user' AND network = $1 ORDER BY handle`,
  [accountId],
)).rows;

describe.skipIf(!runDb)('backfill legacy Beeper user identities', () => {
  beforeEach(async () => {
    // The legacy gate is install-wide. The DB test runner holds exclusive access to portos_test.
    await clearClaims();
    await query(
      `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
       VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')`,
      [accountId],
    );
  });

  afterEach(async () => {
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [accountId]);
    await query('DELETE FROM tribe_people WHERE name LIKE $1', [`${accountId} %`]);
  });

  afterAll(async () => {
    await close();
  });

  it('promotes cached links to active people and preserves later user-owned claims', async () => {
    const chat = await addChat('legacy');
    const live = await addPerson('Live Person');
    const removed = await addPerson('Removed Person', true);
    await addParticipant(chat, 'live', live);
    await addParticipant(chat, 'removed', removed);
    await addParticipant(chat, 'unlinked', null);

    await withTransaction(up);
    expect(await claims()).toEqual([{ handle: 'live', person_id: live, source: 'backfill' }]);

    await withTransaction(up);
    expect(await claims()).toEqual([{ handle: 'live', person_id: live, source: 'backfill' }]);

    await query('UPDATE tribe_people SET deleted = FALSE WHERE id = $1', [removed]);
    await query(
      `UPDATE tribe_identities SET person_id = $1, source = 'user'
       WHERE kind = 'beeper-user' AND network = $2 AND handle = 'live'`,
      [removed, accountId],
    );
    await withTransaction(up);
    expect(await claims()).toEqual([{ handle: 'live', person_id: removed, source: 'user' }]);
  });

  it('chooses the most recently updated link when the same user has conflicting cached links', async () => {
    const newer = await addPerson('Newer Link');
    const older = await addPerson('Older Link');
    await addParticipant(await addChat('old-chat'), 'shared-user', older, '2000-01-01T00:00:00Z');
    await addParticipant(await addChat('new-chat'), 'shared-user', newer, '2000-01-02T00:00:00Z');

    await withTransaction(up);
    expect(await claims()).toEqual([{ handle: 'shared-user', person_id: newer, source: 'backfill' }]);
  });

  it('applies the migration once and leaves identities empty after unlinking and restarting', async () => {
    const chat = await addChat('restart');
    const legacy = await addPerson('Legacy Link');
    await addParticipant(chat, 'legacy-user', legacy);

    // Run the shipped migration in isolation with a distinct history ID so the
    // fixture cannot read or replace any existing migration's applied record.
    const migrationsDir = await mkdtemp(join(tmpdir(), 'beeper-backfill-'));
    try {
      await copyFile(new URL('./034-backfill-beeper-user-identities.js', import.meta.url), join(migrationsDir, migrationId));
      await ensureSchema({ force: true });
      expect(await claims()).toEqual([]);
      expect(await runDbMigrations({ migrationsDir })).toBe(1);
      expect(await claims()).toEqual([{ handle: 'legacy-user', person_id: legacy, source: 'backfill' }]);

      // Phone-matched participants can still have cached links after the last
      // durable identity is unlinked.
      const phoneMatch = await addPerson('Phone Match');
      await addParticipant(chat, 'phone-matched-user', phoneMatch);
      await clearClaims();
      await ensureSchema({ force: true });
      expect(await runDbMigrations({ migrationsDir })).toBe(0);
      expect(await claims()).toEqual([]);
    } finally {
      await query('DELETE FROM schema_migrations WHERE id = $1', [migrationId]);
      await rm(migrationsDir, { recursive: true, force: true });
    }
  });
});
