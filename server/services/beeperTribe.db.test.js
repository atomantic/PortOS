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
 * `*.db.test.js` → runs ONLY via `npm run test:db` against `portos_test`
 * (registered in vitest.config.db.js's DB_TEST_INCLUDE — a `<name>.db.test.js`
 * file is not auto-globbed). Every fixture uses placeholder names/handles per
 * root AGENTS.md Sensitive Data & Privacy — no real handle, name, or phone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { checkHealth, ensureSchema, close, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import * as tribe from './tribe.js';
import * as tribeIdentities from './tribeIdentities.js';
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
      // eslint-disable-next-line no-await-in-loop -- small fixed teardown list
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
});
