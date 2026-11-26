/**
 * Postgres-backed tests for Beeper ↔ Tribe identity linking (#34), proving the
 * issue's own Acceptance criteria against real constraints (FK cascade, the
 * `tribe_identities` UNIQUE (kind, network, handle) index, the
 * `(person_id, dedupe_key)` touchpoint dedupe) rather than mocked SQL:
 *
 *   - A counterparty with a phone links to an existing Tribe person without
 *     creating a duplicate.
 *   - A counterparty with no durable identifier links by hand and survives a
 *     re-sync.
 *   - A group conversation creates touchpoints for senders only, and never
 *     for a truncated roster.
 *
 * Plus #96's own criterion, which needs a real cascade to prove: a hand-made
 * link on a participant with NO durable handle survives a purge + resweep,
 * because it is claimed in `tribe_identities` under `kind='beeper-user'`
 * (account id + raw `source_user_id`) rather than only cached on the mirror row.
 *
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`.
 * Every fixture uses placeholder names/handles per
 * root AGENTS.md Sensitive Data & Privacy — no real handle, name, or phone.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import pg from 'pg';
import { checkHealth, ensureSchema, close, query } from '../../lib/db.js';
import * as database from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import * as tribe from '../tribe.js';
import * as tribeIdentities from '../tribeIdentities.js';
import * as beeperTribe from './beeperTribe.js';

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
const runDb = requireDbOrSkip('services/beeperTribe.db.test', dbReady, skipReason);

const nonce = `beepertribe-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ACCOUNT_ID = nonce;
const createdPersonIds = [];

afterAll(async () => {
  if (dbReady) {
    // Cascades through conversations/messages/participants/cursors.
    await query('DELETE FROM beeper_accounts WHERE account_id = $1', [ACCOUNT_ID]).catch(() => {});
    // tribe_identities cascades off tribe_people, but delete people explicitly
    // to also clean up their touchpoints.
    for (const id of createdPersonIds) {
      // small fixed teardown list
      await query('DELETE FROM tribe_people WHERE id = $1', [id]).catch(() => {});
    }
    await close();
  }
});

async function makeAccount() {
  await query(
    `INSERT INTO beeper_accounts (account_id, network, display_name, status, bridge_id)
     VALUES ($1, 'Example Network', 'Example Account', 'connected', 'example-bridge')
     ON CONFLICT (account_id) DO NOTHING`,
    [ACCOUNT_ID],
  );
}

async function makeConversation(sourceChatId, { isGroup = false, network = 'whatsapp' } = {}) {
  const { rows } = await query(
    `INSERT INTO beeper_conversations (account_id, network, source_chat_id, title, type, is_group)
     VALUES ($1, $2, $3, 'Example Chat', $4, $5)
     RETURNING id`,
    [ACCOUNT_ID, network, sourceChatId, isGroup ? 'group' : 'single', isGroup],
  );
  return rows[0].id;
}

async function makePerson(name) {
  const person = await tribe.createPerson({ name });
  createdPersonIds.push(person.id);
  return person;
}

// Fault only the selected write. PostgreSQL executes the preceding writes
// and the enclosing BEGIN/COMMIT/ROLLBACK on the real transaction client.
async function withParticipantUpdateFault(matches, replacement, operation) {
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function faultParticipantUpdate(sql, params, ...rest) {
    if (typeof sql === 'string' && matches(sql)) {
      return original.call(this, replacement(sql), params, ...rest);
    }
    return original.call(this, sql, params, ...rest);
  });
  try {
    return await operation();
  } finally {
    spy.mockRestore();
  }
}

const isLinkUpdate = (sql) => sql.startsWith('UPDATE beeper_participants SET tribe_person_id = $3')
  && sql.includes('RETURNING *');
const isBeeperUserCacheClear = (sql) => sql.startsWith('UPDATE beeper_participants p SET tribe_person_id = NULL');
const failingWrite = () => 'SELECT 1 / 0 FROM (VALUES ($1::text, $2::text, $3::text)) AS input';

describe.skipIf(!runDb)('Beeper participant link transactions (#19178)', () => {
  async function makeParticipant(sourceUserId) {
    await makeAccount();
    const conversationId = await makeConversation(sourceUserId, { network: 'discord' });
    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId, handle: `@${sourceUserId.replaceAll('-', '_')}`,
      displayName: 'Example Participant', observedVia: 'participant-list',
    });
    return { conversationId, sourceUserId };
  }

  it('rolls back a newly created person when its participant link fails', async () => {
    const participant = await makeParticipant('create-rollback');
    const name = `${nonce} Create Rollback`;
    await withParticipantUpdateFault(isLinkUpdate, failingWrite, async () => {
      await expect(beeperTribe.createPersonAndLinkParticipant({ ...participant, name }))
        .rejects.toMatchObject({ code: '22012' });
    });
    expect((await query('SELECT id FROM tribe_people WHERE name = $1', [name])).rows).toEqual([]);
    expect(await beeperTribe.getParticipant(participant.conversationId, participant.sourceUserId))
      .toMatchObject({ tribePersonId: null });
  });

  it('rejects creating a person for an absent participant without leaving a person row', async () => {
    const { conversationId } = await makeParticipant('create-absent');
    const name = `${nonce} Create Absent`;
    await expect(beeperTribe.createPersonAndLinkParticipant({ conversationId, sourceUserId: 'missing', name }))
      .rejects.toMatchObject({ status: 404, message: 'Participant not found' });
    expect((await query('SELECT id FROM tribe_people WHERE name = $1', [name])).rows).toEqual([]);
  });

  it.each([
    ['a failed update', failingWrite, { code: '22012' }],
    ['a zero-row update', (sql) => sql.replace('RETURNING *', 'AND FALSE RETURNING *'), { status: 404, message: 'Participant not found' }],
  ])('restores both displaced claims and the cache after %s', async (_case, replacement, error) => {
    const participant = await makeParticipant(`link-rollback-${error.code ?? error.status}`);
    const originalOwner = await makePerson('Example Original Owner');
    const newOwner = await makePerson('Example New Owner');
    await beeperTribe.linkParticipant({ ...participant, personId: originalOwner.id });
    const originalClaims = await tribeIdentities.listIdentitiesForPerson(originalOwner.id);
    expect(originalClaims).toHaveLength(2);

    await withParticipantUpdateFault(isLinkUpdate, replacement, async () => {
      await expect(beeperTribe.linkParticipant({ ...participant, personId: newOwner.id }))
        .rejects.toMatchObject(error);
    });

    expect(new Set(await tribeIdentities.listIdentitiesForPerson(originalOwner.id))).toEqual(new Set(originalClaims));
    expect(await tribeIdentities.listIdentitiesForPerson(newOwner.id)).toEqual([]);
    expect(await beeperTribe.getParticipant(participant.conversationId, participant.sourceUserId))
      .toMatchObject({ tribePersonId: originalOwner.id });
  });

  it('waits for a concurrent soft delete and refuses to link to the deleted person', async () => {
    const participant = await makeParticipant('link-soft-delete');
    const person = await makePerson('Example Concurrently Deleted Person');

    const { outcome } = await database.withTransaction(async (deleter) => {
      await deleter.query('UPDATE tribe_people SET deleted = TRUE WHERE id = $1', [person.id]);
      let signalLookup;
      const lookup = new Promise((resolve) => { signalLookup = resolve; });
      const original = pg.Client.prototype.query;
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function observeLookup(sql, ...args) {
        const result = original.call(this, sql, ...args);
        if (typeof sql === 'string' && sql.startsWith('SELECT deleted FROM tribe_people WHERE id')) {
          signalLookup(this.processID);
        }
        return result;
      });
      const outcome = Promise.allSettled([beeperTribe.linkParticipant({ ...participant, personId: person.id })]);
      try {
        const pid = await Promise.race([lookup, outcome.then(() => { throw new Error('Link finished before checking the person'); })]);
        await expect.poll(async () => {
          const { rows: [lock] } = await deleter.query('SELECT pg_backend_pid() = ANY(pg_blocking_pids($1)) AS blocked', [pid]);
          return lock.blocked;
        }).toBe(true);
      } finally {
        spy.mockRestore();
      }
      return { outcome };
    });

    expect(await outcome).toEqual([{ status: 'rejected', reason: expect.objectContaining({ status: 404, message: 'Person not found' }) }]);
    expect(await tribeIdentities.listIdentitiesForPerson(person.id)).toEqual([]);
    expect(await beeperTribe.getParticipant(participant.conversationId, participant.sourceUserId))
      .toMatchObject({ tribePersonId: null });
  });

  it('serializes explicit links sharing a handle and account user across conversations', async () => {
    const first = await makeParticipant('concurrent-shared-link');
    const second = {
      conversationId: await makeConversation('concurrent-shared-link-again', { network: 'discord' }),
      sourceUserId: first.sourceUserId,
    };
    const participant = await beeperTribe.getParticipant(first.conversationId, first.sourceUserId);
    await beeperTribe.upsertParticipant({
      ...second, handle: participant.handle, displayName: participant.displayName, observedVia: 'participant-list',
    });
    const firstPerson = await makePerson('Example First Link Candidate');
    const secondPerson = await makePerson('Example Second Link Candidate');

    const links = await Promise.all([
      beeperTribe.linkParticipant({ ...first, personId: firstPerson.id }),
      beeperTribe.linkParticipant({ ...second, personId: secondPerson.id }),
    ]);

    const initial = links.find((link) => link.displacedPersonId === null);
    const replacement = links.find((link) => link.displacedPersonId === initial.tribePersonId);
    expect(await tribeIdentities.listIdentitiesForPerson(initial.tribePersonId)).toEqual([]);
    expect(await tribeIdentities.listIdentitiesForPerson(replacement.tribePersonId)).toHaveLength(2);
    expect(await beeperTribe.getParticipant(initial.conversationId, initial.sourceUserId))
      .toMatchObject({ tribePersonId: null });
    expect(await beeperTribe.getParticipant(replacement.conversationId, replacement.sourceUserId))
      .toMatchObject({ tribePersonId: replacement.tribePersonId });
  });

  it.each([
    ['unlinkParticipant', (participant) => beeperTribe.unlinkParticipant(participant)],
    ['unlinkIdentity', (_participant, identity) => beeperTribe.unlinkIdentity(identity.id)],
  ])('%s restores deleted claims when a cache clear fails', async (operation, unlink) => {
    const participant = await makeParticipant(operation);
    const person = await makePerson('Example Unlink Owner');
    await beeperTribe.linkParticipant({ ...participant, personId: person.id });
    const claims = await tribeIdentities.listIdentitiesForPerson(person.id);
    expect(claims).toHaveLength(2);
    const beeperUser = claims.find((claim) => claim.kind === 'beeper-user');

    await withParticipantUpdateFault(isBeeperUserCacheClear, failingWrite, async () => {
      await expect(unlink(participant, beeperUser)).rejects.toMatchObject({ code: '22012' });
    });

    expect(new Set(await tribeIdentities.listIdentitiesForPerson(person.id))).toEqual(new Set(claims));
    expect(await beeperTribe.getParticipant(participant.conversationId, participant.sourceUserId))
      .toMatchObject({ tribePersonId: person.id });
  });
});

describe.skipIf(!runDb)('Beeper participant cache fills during explicit edits (#19236)', () => {
  it.each([
    ['single', 'unlink'], ['batch', 'unlink'],
    ['single', 'transfer'], ['batch', 'transfer'],
  ])('%s cache fill completes before a waiting %s clears the displaced cache', async (path, edit) => {
    await makeAccount();
    const sourceUserId = `race-${path}-${edit}`;
    const original = { conversationId: await makeConversation(sourceUserId), sourceUserId };
    const otherId = await makeConversation(`${sourceUserId}-sweep`);
    const input = { sourceUserId, handle: `@example_${path}_${edit}`, observedVia: 'participant-list' };
    const previous = await makePerson('Example Previous Owner');
    const next = edit === 'transfer' ? await makePerson('Example Next Owner') : null;
    await beeperTribe.upsertParticipant({ ...input, conversationId: original.conversationId });
    await beeperTribe.linkParticipant({ ...original, personId: previous.id });

    const sweep = async () => {
      if (path === 'single') return beeperTribe.upsertParticipant({ ...input, conversationId: otherId });
      const { participants } = await beeperTribe.upsertConversationParticipants(otherId, [input]);
      return participants[0];
    };
    const beforeUpdate = Promise.withResolvers();
    const resume = Promise.withResolvers();
    const pgQuery = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function pauseCacheFill(sql, params, ...rest) {
      if (params?.[0] === otherId && sql.startsWith('UPDATE beeper_participants')) {
        beforeUpdate.resolve(this.processID);
        return resume.promise.then(() => pgQuery.call(this, sql, params, ...rest));
      }
      return pgQuery.call(this, sql, params, ...rest);
    });
    const filling = sweep();
    let editing;
    try {
      const sweepPid = await Promise.race([beforeUpdate.promise, filling.then(() => { throw new Error('Sweep skipped cache fill'); })]);
      editing = next ? beeperTribe.linkParticipant({ ...original, personId: next.id }) : beeperTribe.unlinkParticipant(original);
      // Inspect the actual wait in PostgreSQL while the old owner is resolved
      // and the cache UPDATE has yet to run. A row wait on the same participant
      // would conceal the cross-conversation race.
      const committed = editing.then(() => 'committed');
      await expect.poll(async () => {
        const lock = query(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted
             AND $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [sweepPid],
        ).then(({ rows }) => rows[0].blocked ? 'blocked' : 'running');
        return Promise.race([committed, lock]);
      }).toBe('blocked');
    } finally {
      resume.resolve();
      spy.mockRestore();
      await Promise.allSettled([filling, editing]);
    }

    expect((await filling).tribePersonId).toBe(previous.id);
    await editing;
    expect(await tribeIdentities.listIdentitiesForPerson(previous.id)).toEqual([]);
    expect((await beeperTribe.getParticipant(otherId, sourceUserId)).tribePersonId).toBeNull();
    // With the edit committed first, both resolution and the next cache fill
    // see the new owner (or the absence of a claim).
    expect(await beeperTribe.resolveParticipantPerson({ conversationId: otherId, sourceUserId })).toBe(next?.id ?? null);
    expect((await sweep()).tribePersonId).toBe(next?.id ?? null);
  });
});

describe.skipIf(!runDb)('beeperTribe (#34)', () => {
  it('a counterparty with a phone links to an existing Tribe person without creating a duplicate', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-phone-chat`);
    const personName = `${nonce} Example Phone Person`;

    // Existing Tribe person already known via, say, iMessage/Contacts.
    const person = await tribe.createPerson({ name: personName, phones: ['+15550100001'] });
    createdPersonIds.push(person.id);

    // Beeper hands us a participant whose `handle` is that same phone
    // (User.phoneNumber), never having been linked through Beeper before.
    const participant = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'wa-user-1',
      displayName: personName,
      handle: '+1 (555) 010-0001',
      observedVia: 'message-sender',
    });

    // Auto-resolved on upsert — no manual link needed, and no new person made.
    expect(participant.tribePersonId).toBe(person.id);
    const peopleNamed = await query(
      `SELECT COUNT(*)::int AS n FROM tribe_people WHERE name = $1`,
      [personName],
    );
    expect(peopleNamed.rows[0].n).toBe(1);
  });

  it('a counterparty with no durable identifier links by hand and survives a re-sync', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-nohandle-chat`);
    const person = await makePerson('Example No-Handle Person');

    // First sync: no phone, no username (the ~13% case — e.g. Facebook/Slack).
    const first = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'fb-user-1',
      displayName: 'Example No-Handle Person',
      handle: '',
      observedVia: 'message-sender',
    });
    expect(first.tribePersonId).toBeNull();

    // The user links by hand.
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'fb-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);

    // A re-sync re-upserts the same participant row (same display name/handle,
    // simulating the ingestion sweep re-observing this counterparty).
    const resynced = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'fb-user-1',
      displayName: 'Example No-Handle Person',
      handle: '',
      observedVia: 'message-sender',
    });
    expect(resynced.tribePersonId).toBe(person.id);
  });

  it('a durable USERNAME handle claims a tribe_identities row scoped to its OWN conversation network, and resolves a second participant presenting it', async () => {
    await makeAccount();
    // network comes from the conversation row, never from a caller argument
    // (#34 review) — created here as 'discord' so the claim below is scoped
    // to it.
    const conversationId = await makeConversation(`${nonce}-handle-chat`, { network: 'discord' });
    const person = await makePerson('Example Handle Person');

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'dc-user-1',
      displayName: 'Example Handle Person',
      handle: '@example_handle',
      observedVia: 'message-sender',
    });
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'dc-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);
    expect(linked.displacedPersonId).toBeNull();

    const identities = await tribeIdentities.listIdentitiesForPerson(person.id);
    expect(identities).toContainEqual(expect.objectContaining({
      kind: 'handle', network: 'discord', handle: 'example_handle',
    }));

    // A second, DIFFERENT conversation's participant, ALSO on 'discord',
    // presents the identical handle — it should auto-resolve to the same
    // person without a manual link.
    const otherConversationId = await makeConversation(`${nonce}-handle-chat-2`, { network: 'discord' });
    const secondParticipant = await beeperTribe.upsertParticipant({
      conversationId: otherConversationId,
      sourceUserId: 'dc-user-1-again',
      displayName: 'Example Handle Person',
      handle: '@Example_Handle',
      observedVia: 'message-sender',
    });
    expect(secondParticipant.tribePersonId).toBe(person.id);
  });

  it('scopes a username claim to its network — the SAME username on a DIFFERENT network never collides with a different person', async () => {
    await makeAccount();
    const discordPerson = await makePerson('Example Discord Namesake');
    const slackPerson = await makePerson('Example Slack Namesake');

    const discordConversationId = await makeConversation(`${nonce}-namesake-discord`, { network: 'discord' });
    await beeperTribe.upsertParticipant({
      conversationId: discordConversationId,
      sourceUserId: 'discord-namesake-1',
      displayName: 'Example Discord Namesake',
      handle: '@example_namesake',
      observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({
      conversationId: discordConversationId, sourceUserId: 'discord-namesake-1', personId: discordPerson.id,
    });

    const slackConversationId = await makeConversation(`${nonce}-namesake-slack`, { network: 'slack' });
    const slackParticipant = await beeperTribe.upsertParticipant({
      conversationId: slackConversationId,
      sourceUserId: 'slack-namesake-1',
      displayName: 'Example Slack Namesake',
      handle: '@example_namesake',
      observedVia: 'message-sender',
    });
    // Same literal handle, different network — must NOT auto-resolve to the
    // Discord person; it must stay unlinked until claimed on its own network.
    expect(slackParticipant.tribePersonId).toBeNull();

    const linkedSlack = await beeperTribe.linkParticipant({
      conversationId: slackConversationId, sourceUserId: 'slack-namesake-1', personId: slackPerson.id,
    });
    expect(linkedSlack.tribePersonId).toBe(slackPerson.id);
    expect(linkedSlack.displacedPersonId).toBeNull();

    const discordIdentities = await tribeIdentities.listIdentitiesForPerson(discordPerson.id);
    expect(discordIdentities).toContainEqual(expect.objectContaining({
      kind: 'handle', network: 'discord', handle: 'example_namesake',
    }));
    const slackIdentities = await tribeIdentities.listIdentitiesForPerson(slackPerson.id);
    expect(slackIdentities).toContainEqual(expect.objectContaining({
      kind: 'handle', network: 'slack', handle: 'example_namesake',
    }));
  });

  it('enforces UNIQUE (kind, network, handle) semantics via linkIdentity re-link (moves ownership, no duplicate row, and reports the displaced person)', async () => {
    const personA = await makePerson('Example Identity Owner A');
    const personB = await makePerson('Example Identity Owner B');

    const firstLink = await tribeIdentities.linkIdentity({ personId: personA.id, kind: 'handle', network: 'slack', handle: 'example-owner' });
    expect(firstLink.displacedPersonId).toBeNull();
    const relinked = await tribeIdentities.linkIdentity({ personId: personB.id, kind: 'handle', network: 'slack', handle: 'example-owner' });
    expect(relinked.personId).toBe(personB.id);
    expect(relinked.displacedPersonId).toBe(personA.id);

    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM tribe_identities WHERE kind = 'handle' AND network = 'slack' AND handle = 'example-owner'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('refuses to write a kind=\'handle\' identity with no network (the inert-row hazard)', async () => {
    const person = await makePerson('Example No-Network Person');
    await expect(tribeIdentities.linkIdentity({
      personId: person.id, kind: 'handle', network: '', handle: 'example-orphan',
    })).rejects.toThrow();
  });

  it('refuses to link a soft-deleted person, and resolution/touchpoints treat them as unlinked', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-deleted-chat`, { network: 'discord' });
    const person = await makePerson('Example Deleted Person');

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'deleted-user-1',
      displayName: 'Example Deleted Person',
      handle: '@example_deleted',
      observedVia: 'message-sender',
    });
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'deleted-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);

    const deleted = await tribe.deletePerson(person.id);
    expect(deleted).toBe(true);

    // A further link attempt against the now-deleted person is refused, even
    // though the FK alone would still permit it (soft delete only).
    await expect(beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'deleted-user-1', personId: person.id,
    })).rejects.toThrow();

    // Resolution — both the cached column and a fresh tribe_identities lookup
    // — no longer returns the deleted person.
    expect(await beeperTribe.resolveParticipantPerson({ conversationId, sourceUserId: 'deleted-user-1' })).toBeNull();

    const before = await tribe.listTouchpoints(person.id);
    const result = await beeperTribe.logSenderTouchpoints([
      { conversationId, senderId: 'deleted-user-1', sentAt: new Date().toISOString(), network: 'discord' },
    ]);
    expect(result.matched).toBe(0);
    expect(result.created).toBe(0);
    const after = await tribe.listTouchpoints(person.id);
    expect(after).toHaveLength(before.length);
  });

  it('replaces a soft-deleted cached person on resync and preserves the replacement link', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-replacement-chat`);
    const phone = '+15550100077';
    const original = await tribe.createPerson({ name: 'Example Original Person', phones: [phone] });
    createdPersonIds.push(original.id);
    const input = {
      conversationId, sourceUserId: 'replacement-user', handle: phone,
      displayName: 'Example Participant', observedVia: 'message-sender',
    };
    expect((await beeperTribe.upsertParticipant(input)).tribePersonId).toBe(original.id);
    await tribe.deletePerson(original.id);

    const replacement = await tribe.createPerson({ name: 'Example Replacement Person', phones: [phone] });
    createdPersonIds.push(replacement.id);
    expect((await beeperTribe.upsertParticipant(input)).tribePersonId).toBe(replacement.id);
    expect((await beeperTribe.getParticipant(conversationId, input.sourceUserId)).tribePersonId).toBe(replacement.id);

    const other = await makePerson('Example Other Person');
    await tribeIdentities.linkIdentity({ personId: other.id, kind: 'phone', handle: phone });
    expect((await beeperTribe.upsertParticipant(input)).tribePersonId).toBe(replacement.id);
  });

  it('lets an explicit tribe_identities claim outrank a STALE cached tribe_person_id', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-stale-cache-chat`);
    const cachedPerson = await makePerson('Example Stale Cache Person');
    const claimingPerson = await makePerson('Example Claiming Person');

    // The participant's cache is auto-filled from the LEGACY tribe_people
    // phones[] axis onto the wrong person (the pre-#34 matching path).
    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'stale-cache-user-1',
      displayName: 'Example Stale Cache Person',
      handle: '+1 (555) 010-0055',
      observedVia: 'message-sender',
    });
    await query(
      `UPDATE beeper_participants SET tribe_person_id = $3
       WHERE conversation_id = $1 AND source_user_id = $2`,
      [conversationId, 'stale-cache-user-1', cachedPerson.id],
    );

    // The user then explicitly claims that phone for somebody else.
    await tribeIdentities.linkIdentity({
      personId: claimingPerson.id, kind: 'phone', network: '', handle: '+15550100055',
    });

    // tribe_identities is the truth for a DURABLE handle — the cache column is
    // authoritative only where no durable handle exists (#10), so the claim wins.
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId, sourceUserId: 'stale-cache-user-1',
    })).toBe(claimingPerson.id);
  });

  it('clears the displaced person\'s OTHER participant caches when linkParticipant moves a handle', async () => {
    await makeAccount();
    const firstConversationId = await makeConversation(`${nonce}-move-chat-1`, { network: 'discord' });
    const secondConversationId = await makeConversation(`${nonce}-move-chat-2`, { network: 'discord' });
    const originalOwner = await makePerson('Example Original Owner');
    const newOwner = await makePerson('Example New Owner');

    await beeperTribe.upsertParticipant({
      conversationId: firstConversationId,
      sourceUserId: 'move-user-1',
      displayName: 'Example Original Owner',
      handle: '@example_moved',
      observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({
      conversationId: firstConversationId, sourceUserId: 'move-user-1', personId: originalOwner.id,
    });

    // A second conversation's participant presents the same handle and
    // auto-resolves (and caches) onto the original owner.
    const second = await beeperTribe.upsertParticipant({
      conversationId: secondConversationId,
      sourceUserId: 'move-user-2',
      displayName: 'Example Original Owner',
      handle: '@Example_Moved',
      observedVia: 'message-sender',
    });
    expect(second.tribePersonId).toBe(originalOwner.id);

    // The user re-links the handle to someone else — an ownership move.
    const moved = await beeperTribe.linkParticipant({
      conversationId: firstConversationId, sourceUserId: 'move-user-1', personId: newOwner.id,
    });
    expect(moved.displacedPersonId).toBe(originalOwner.id);

    // The OTHER conversation's stale cache is cleared and now resolves to the
    // new owner instead of permanently attributing messages to the displaced one.
    const refreshed = await beeperTribe.getParticipant(secondConversationId, 'move-user-2');
    expect(refreshed.tribePersonId).toBeNull();
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: secondConversationId, sourceUserId: 'move-user-2',
    })).toBe(newOwner.id);
  });

  it('links a username-bearing participant on a network-less conversation by cache alone, instead of failing', async () => {
    await makeAccount();
    // beeper_conversations.network is NOT NULL DEFAULT '' — a conversation can
    // legitimately arrive with no network, and such a participant must not
    // become wholly unlinkable (#34 review).
    const conversationId = await makeConversation(`${nonce}-no-network-chat`, { network: '' });
    const person = await makePerson('Example No-Network Handle Person');

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'no-network-user-1',
      displayName: 'Example No-Network Handle Person',
      handle: '@example_no_network',
      observedVia: 'message-sender',
    });
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'no-network-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);

    // No inert unscoped kind='handle' row was written — the network the
    // username would need is exactly what this conversation lacks. The
    // account-scoped beeper-user claim (#96) is unaffected by that: a
    // conversation always has an account, so this link is durable anyway.
    const identities = await tribeIdentities.listIdentitiesForPerson(person.id);
    expect(identities).toEqual([expect.objectContaining({
      kind: 'beeper-user', network: ACCOUNT_ID, handle: 'no-network-user-1',
    })]);
  });

  it('does not wipe a durable handle when a later sweep re-observes the participant without one', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-handle-keep-chat`, { network: 'discord' });

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'handle-keep-user-1',
      displayName: 'Example Handle Keeper',
      handle: '@example_keeper',
      observedVia: 'message-sender',
    });
    // A truncated participant-list observation carries no phone/username.
    const resynced = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'handle-keep-user-1',
      displayName: 'Example Handle Keeper',
      handle: '',
      observedVia: 'participant-list',
    });
    expect(resynced.handle).toBe('@example_keeper');
  });

  it('does not wipe a stored display name when a message-sender upsert omits senderName', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-name-keep-chat`, { network: 'discord' });

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'name-keep-user-1',
      displayName: 'Example Named Participant',
      observedVia: 'participant-list',
    });
    const omitted = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'name-keep-user-1',
      displayName: '',
      observedVia: 'message-sender',
    });
    expect(omitted.displayName).toBe('Example Named Participant');

    const renamed = await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'name-keep-user-1',
      displayName: 'Example Renamed Participant',
      observedVia: 'message-sender',
    });
    expect(renamed.displayName).toBe('Example Renamed Participant');
  });

  // ── #96: a manual link survives a purge + resweep ────────────────────────
  // The purge is the real one (`DELETE FROM beeper_conversations`), so the
  // participant row and its `tribe_person_id` cache genuinely cascade away;
  // the resweep is modelled by re-creating the conversation under a NEW
  // PortOS UUID (a purge drops the sync cursor, so a resweep never matches
  // the old row) with the SAME account and source_user_id.
  it('re-links a hand-linked handle-less participant after a purge + resweep, on the first re-observation', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-purge-chat`, { network: 'facebook' });
    const person = await makePerson('Example Purged Person');

    await beeperTribe.upsertParticipant({
      conversationId,
      sourceUserId: 'fb-purge-user-1',
      displayName: 'Example Purged Person',
      handle: '',
      observedVia: 'message-sender',
    });
    const linked = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'fb-purge-user-1', personId: person.id,
    });
    expect(linked.tribePersonId).toBe(person.id);

    // The durable half of that link — no handle classified, so this is the
    // ONLY record of it that can outlive the row.
    const identities = await tribeIdentities.listIdentitiesForPerson(person.id);
    expect(identities).toContainEqual(expect.objectContaining({
      kind: 'beeper-user', network: ACCOUNT_ID, handle: 'fb-purge-user-1',
    }));

    await query('DELETE FROM beeper_conversations WHERE id = $1', [conversationId]);
    const gone = await query(
      'SELECT COUNT(*)::int AS n FROM beeper_participants WHERE conversation_id = $1',
      [conversationId],
    );
    expect(gone.rows[0].n).toBe(0);

    const resweptConversationId = await makeConversation(`${nonce}-purge-chat-reswept`, { network: 'facebook' });
    expect(resweptConversationId).not.toBe(conversationId);
    const reswept = await beeperTribe.upsertParticipant({
      conversationId: resweptConversationId,
      sourceUserId: 'fb-purge-user-1',
      displayName: 'Example Purged Person',
      handle: '',
      observedVia: 'message-sender',
    });
    expect(reswept.tribePersonId).toBe(person.id);
  });

  it('is a no-op when a hand-linked participant is re-linked to the SAME person', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-relink-same-chat`, { network: 'facebook' });
    const person = await makePerson('Example Relink Same Person');

    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId: 'fb-relink-user-1', displayName: 'Example Relink Same Person', handle: '', observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'fb-relink-user-1', personId: person.id,
    });
    const again = await beeperTribe.linkParticipant({
      conversationId, sourceUserId: 'fb-relink-user-1', personId: person.id,
    });
    expect(again.tribePersonId).toBe(person.id);
    expect(again.displacedPersonId).toBeNull();

    // No duplicate claim — UNIQUE (kind, network, handle) upserted in place.
    const { rows } = await query(
      `SELECT COUNT(*)::int AS n FROM tribe_identities
       WHERE kind = 'beeper-user' AND network = $1 AND handle = 'fb-relink-user-1'`,
      [ACCOUNT_ID],
    );
    expect(rows[0].n).toBe(1);
  });

  it('moves the beeper-user claim and clears the displaced caches when the same participant is re-linked to somebody else', async () => {
    await makeAccount();
    const firstConversationId = await makeConversation(`${nonce}-relink-move-1`, { network: 'facebook' });
    const secondConversationId = await makeConversation(`${nonce}-relink-move-2`, { network: 'facebook' });
    const originalOwner = await makePerson('Example Beeper-User Original Owner');
    const newOwner = await makePerson('Example Beeper-User New Owner');

    await beeperTribe.upsertParticipant({
      conversationId: firstConversationId, sourceUserId: 'fb-move-user-1', displayName: 'Example Beeper-User Original Owner', handle: '', observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({
      conversationId: firstConversationId, sourceUserId: 'fb-move-user-1', personId: originalOwner.id,
    });

    // The SAME Beeper user in a second chat on the same account auto-resolves
    // through the claim alone — there is no handle to match on.
    const second = await beeperTribe.upsertParticipant({
      conversationId: secondConversationId, sourceUserId: 'fb-move-user-1', displayName: 'Example Beeper-User Original Owner', handle: '', observedVia: 'message-sender',
    });
    expect(second.tribePersonId).toBe(originalOwner.id);

    const moved = await beeperTribe.linkParticipant({
      conversationId: firstConversationId, sourceUserId: 'fb-move-user-1', personId: newOwner.id,
    });
    expect(moved.displacedPersonId).toBe(originalOwner.id);

    const refreshed = await beeperTribe.getParticipant(secondConversationId, 'fb-move-user-1');
    expect(refreshed.tribePersonId).toBeNull();
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: secondConversationId, sourceUserId: 'fb-move-user-1',
    })).toBe(newOwner.id);

    const originalIdentities = await tribeIdentities.listIdentitiesForPerson(originalOwner.id);
    expect(originalIdentities).toHaveLength(0);
  });

  it('a group conversation creates touchpoints for senders only, never for a truncated roster', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-group-chat`, { isGroup: true });

    const sender = await makePerson('Example Group Sender');
    const rosterOnly = await makePerson('Example Roster-Only Person');

    // The sender messaged and is linked.
    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId: 'group-sender-1', displayName: 'Example Group Sender', handle: '', observedVia: 'message-sender',
    });
    await beeperTribe.linkParticipant({ conversationId, sourceUserId: 'group-sender-1', personId: sender.id });

    // A second person is on the (truncated) participant roster but NEVER sent
    // a message in this batch — logSenderTouchpoints must never touch them,
    // because it never enumerates beeper_participants at all.
    await beeperTribe.upsertParticipant({
      conversationId, sourceUserId: 'group-roster-only-1', displayName: 'Example Roster-Only Person', handle: '', observedVia: 'participant-list',
    });
    await beeperTribe.linkParticipant({ conversationId, sourceUserId: 'group-roster-only-1', personId: rosterOnly.id });

    const before = await tribe.listTouchpoints(rosterOnly.id);
    expect(before).toHaveLength(0);

    const result = await beeperTribe.logSenderTouchpoints([
      { conversationId, senderId: 'group-sender-1', sentAt: new Date().toISOString(), network: 'whatsapp' },
      { conversationId, senderId: 'group-sender-1', sentAt: new Date().toISOString(), network: 'whatsapp' }, // same sender, same day — dedupes
    ]);
    expect(result.created).toBe(1);
    expect(result.matched).toBe(2);

    const senderTouchpoints = await tribe.listTouchpoints(sender.id);
    expect(senderTouchpoints).toHaveLength(1);
    expect(senderTouchpoints[0].source).toBe('message');

    // The roster-only person, despite being linked and present in
    // beeper_participants, never sent a message — no touchpoint for them.
    const after = await tribe.listTouchpoints(rosterOnly.id);
    expect(after).toHaveLength(0);
  });

  it('uses 20 transactions for 20 chats with 25 daily messages while retaining database idempotency', async () => {
    await makeAccount();
    const person = await makePerson('Example Batch Sender');
    const batches = [];
    for (let i = 0; i < 20; i++) {
      // fixture setup before transaction counting
      const conversationId = await makeConversation(`${nonce}-batch-${i}`);
      // fixture setup
      await beeperTribe.upsertParticipant({
        conversationId, sourceUserId: 'batch-sender', handle: '', observedVia: 'message-sender',
      });
      // fixture setup
      await beeperTribe.linkParticipant({ conversationId, sourceUserId: 'batch-sender', personId: person.id });
      batches.push(Array.from({ length: 25 }, () => ({
        conversationId, senderId: 'batch-sender',
        sentAt: '2026-10-03T12:00:00.000Z', network: 'whatsapp',
      })));
    }
    const transactions = vi.spyOn(database, 'withTransaction');
    try {
      const first = await beeperTribe.logSenderTouchpoints(batches[0]);
      const contactAfterFirst = await query('SELECT last_contact_on, channel, updated_at FROM tribe_people WHERE id = $1', [person.id]);
      const remaining = await Promise.all(batches.slice(1).map((batch) => beeperTribe.logSenderTouchpoints(batch)));
      const totals = [first, ...remaining].reduce((total, result) => ({
        matched: total.matched + result.matched, created: total.created + result.created,
      }), { matched: 0, created: 0 });
      expect(totals).toEqual({ matched: 500, created: 1 });
      expect(transactions).toHaveBeenCalledTimes(20);
      expect((await query('SELECT last_contact_on, channel, updated_at FROM tribe_people WHERE id = $1', [person.id])).rows)
        .toEqual(contactAfterFirst.rows);
      const touchpoints = await tribe.listTouchpoints(person.id);
      expect(touchpoints).toHaveLength(1);
      expect(touchpoints[0]).toMatchObject({
        channel: 'Beeper (whatsapp)', source: 'message',
        metadata: { network: 'whatsapp', conversationId: batches[0][0].conversationId },
      });
    } finally {
      transactions.mockRestore();
    }
  });

  it('batches conversation participants in four data queries and one locked transaction while preserving handle-COALESCE, soft-delete, and precedence (#18162)', async () => {
    await makeAccount();
    const conversationId = await makeConversation(`${nonce}-batched-chat`, { network: 'whatsapp' });
    const deletedPerson = await makePerson('Example Deleted Cached');
    const handleOwner = await makePerson('Example Handle Owner');
    const beeperUserOwner = await makePerson('Example Beeper User Owner');
    const phoneOwner = await tribe.createPerson({ name: `${nonce} Phone Fallback Owner`, phones: ['+15550100088'] });
    createdPersonIds.push(phoneOwner.id);

    // Seed an existing row with a soft-deleted cache and durable phone handle,
    // and claim a handle + beeper-user identity to exercise precedence.
    await query(
      `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, tribe_person_id, observed_via)
       VALUES ($1, 'batch-soft-del', 'Old Name', '+1 (555) 010-0088', $2, 'participant-list')`,
      [conversationId, deletedPerson.id],
    );
    await tribe.deletePerson(deletedPerson.id);
    await tribeIdentities.linkIdentity({ personId: handleOwner.id, kind: 'handle', network: 'whatsapp', handle: 'example_handle_win' });
    await tribeIdentities.linkIdentity({ personId: beeperUserOwner.id, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'batch-both' });
    await tribeIdentities.linkIdentity({ personId: beeperUserOwner.id, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'batch-beeper-only' });

    const rosterIndex = await beeperTribe.loadRosterIndex();
    const sqlLog = [];
    const original = pg.Client.prototype.query;
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function spyQuery(...args) {
      const config = args[0];
      const text = typeof config === 'string' ? config : config?.text || '';
      if (text) sqlLog.push(text);
      return original.apply(this, args);
    });

    try {
      // Single-row upsertParticipant reduces reads: 1 participant SELECT, <=1 tribe_identities SELECT.
      const single = await beeperTribe.upsertParticipant({
        conversationId,
        sourceUserId: 'single-check-user',
        displayName: 'Single Check',
        handle: '@example_handle_win',
        observedVia: 'message-sender',
        personIndex: rosterIndex,
      });
      expect(single.tribePersonId).toBe(handleOwner.id);
      expect(sqlLog.slice(0, 2)).toEqual(['BEGIN', expect.stringContaining('pg_advisory_xact_lock_shared')]);
      expect(sqlLog.filter((s) => s.includes('FROM beeper_participants'))).toHaveLength(1);
      expect(sqlLog.filter((s) => s.includes('tribe_identities'))).toHaveLength(1);

      sqlLog.length = 0;
      const batchInput = [
        { sourceUserId: 'batch-soft-del', displayName: 'New Sender Name', handle: '', observedVia: 'message-sender' },
        { sourceUserId: 'batch-both', displayName: 'Roster Name', handle: '@example_handle_win', observedVia: 'participant-list' },
        { sourceUserId: 'batch-both', displayName: 'Sender Both', handle: '', observedVia: 'message-sender' },
        { sourceUserId: 'batch-beeper-only', displayName: 'Beeper Only', handle: '', observedVia: 'message-sender' },
        ...Array.from({ length: 16 }, (_, i) => ({
          sourceUserId: `batch-unlinked-${i}`,
          displayName: `Unlinked ${i}`,
          handle: '',
          observedVia: 'participant-list',
        })),
      ];

      const { participants, resolvedPersonIds } = await beeperTribe.upsertConversationParticipants(
        conversationId,
        batchInput,
        { personIndex: rosterIndex },
      );

      expect(participants).toHaveLength(19);
      expect(sqlLog).toHaveLength(7);
      expect(sqlLog.slice(0, 2)).toEqual(['BEGIN', expect.stringContaining('pg_advisory_xact_lock_shared')]);
      expect(sqlLog.at(-1)).toBe('COMMIT');
      const byId = new Map(participants.map((p) => [p.sourceUserId, p]));
      expect(byId.get('batch-soft-del').handle).toBe('+1 (555) 010-0088');
      expect(byId.get('batch-soft-del').tribePersonId).toBe(phoneOwner.id);
      expect(byId.get('batch-both').handle).toBe('@example_handle_win');
      expect(byId.get('batch-both').observedVia).toBe('message-sender');
      expect(byId.get('batch-both').tribePersonId).toBe(handleOwner.id);
      expect(byId.get('batch-beeper-only').tribePersonId).toBe(beeperUserOwner.id);
      expect(resolvedPersonIds.get('batch-unlinked-0')).toBeNull();

      // logSenderTouchpoints reuses resolvedPersonIds with zero participant/identity reads.
      sqlLog.length = 0;
      const tp = await beeperTribe.logSenderTouchpoints([
        { conversationId, senderId: 'batch-both', sentAt: '2026-10-04T12:00:00.000Z', network: 'whatsapp' },
        { conversationId, senderId: 'batch-unlinked-0', sentAt: '2026-10-04T12:05:00.000Z', network: 'whatsapp' },
      ], { personIndex: rosterIndex, resolvedPersonIds });
      expect(tp).toEqual({ matched: 1, created: 1 });
      expect(sqlLog.some((s) => s.includes('beeper_participants') || s.includes('tribe_identities'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

});
