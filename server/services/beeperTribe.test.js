/**
 * Mocked-Postgres unit tests for the Beeper ↔ Tribe RESOLUTION ORDER (#34
 * review). The behavioral acceptance criteria live in `beeperTribe.db.test.js`
 * against a real database; this file exists because that suite runs only under
 * `npm run test:db`, so the ordering regression it guards — a cached
 * `beeper_participants.tribe_person_id` outranking an explicit
 * `tribe_identities` claim — would otherwise not be caught by the default
 * `npm --prefix server test` runner at all.
 *
 * The design contract being pinned (#10, "both stores, split by durability"):
 * `tribe_identities` is the truth for any DURABLE handle; the participant
 * cache column is authoritative ONLY where no durable handle exists.
 *
 * Postgres is mocked with in-memory maps that interpret the exact SQL shapes
 * `beeperTribe.js` / `tribeIdentities.js` issue, so the tests fail if either
 * the order OR the SQL changes. Every fixture uses placeholder handles and
 * 555-01xx numbers per root AGENTS.md Sensitive Data & Privacy.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  people: new Map(),        // id -> { deleted }
  conversations: new Map(), // id -> { network, accountId }
  participants: new Map(),  // `${conversationId}|${sourceUserId}` -> row
  identities: new Map(),    // `${kind}|${network}|${handle}` -> person_id
};
const seenSql = [];

const pKey = (c, s) => `${c}|${s}`;
const iKey = (k, n, h) => `${k}|${n}|${h}`;
// The conversation columns beeperTribe joins server-side: `network` scopes a
// kind='handle' claim, `account_id` scopes the kind='beeper-user' one (#96).
const convo = (id) => db.conversations.get(id) ?? { network: '', accountId: '' };

function participantRow(row) {
  const c = convo(row.conversation_id);
  return {
    ...row,
    network: c.network,
    account_id: c.accountId,
    tribe_person_deleted: row.tribe_person_id ? !!db.people.get(row.tribe_person_id)?.deleted : null,
  };
}

vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn(async () => {}),
  query: vi.fn(async (sql, params = []) => {
    seenSql.push(sql);
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^SELECT p\.\*, c\.network, c\.account_id, tp\.deleted/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      return { rows: row ? [participantRow(row)] : [] };
    }
    if (/^SELECT ti\.person_id FROM tribe_identities/.test(s)) {
      const personId = db.identities.get(iKey(params[0], params[1], params[2]));
      const alive = personId && !db.people.get(personId)?.deleted;
      return { rows: alive ? [{ person_id: personId }] : [] };
    }
    if (/^SELECT person_id FROM tribe_identities WHERE kind/.test(s)) {
      const personId = db.identities.get(iKey(params[0], params[1], params[2]));
      return { rows: personId ? [{ person_id: personId }] : [] };
    }
    if (/^SELECT deleted FROM tribe_people WHERE id/.test(s)) {
      const person = db.people.get(params[0]);
      return { rows: person ? [{ deleted: person.deleted }] : [] };
    }
    if (/^SELECT p\.conversation_id, p\.source_user_id, p\.handle, c\.network/.test(s)) {
      const rows = [...db.participants.values()]
        .filter((r) => r.tribe_person_id === params[0] && r.handle !== '')
        .map((r) => ({
          conversation_id: r.conversation_id,
          source_user_id: r.source_user_id,
          handle: r.handle,
          network: convo(r.conversation_id).network,
        }));
      return { rows };
    }
    if (/^INSERT INTO tribe_identities/.test(s)) {
      const [personId, kind, network, handle, source] = params;
      db.identities.set(iKey(kind, network, handle), personId);
      return {
        rows: [{
          id: `identity-${kind}-${network}-${handle}`,
          person_id: personId,
          kind,
          network,
          handle,
          source,
          linked_at: '2026-01-01T00:00:00.000Z',
          created_at: '2026-01-01T00:00:00.000Z',
        }],
      };
    }
    if (/^INSERT INTO beeper_participants/.test(s)) {
      const [conversationId, sourceUserId, displayName, handle, observedVia] = params;
      const key = pKey(conversationId, sourceUserId);
      const existing = db.participants.get(key);
      if (existing) {
        // Honor the REAL ON CONFLICT clause: a durable handle survives an
        // empty re-observation only while the COALESCE guard is in the SQL.
        const guarded = /COALESCE\(NULLIF\(EXCLUDED\.handle, ''\), beeper_participants\.handle\)/.test(s);
        db.participants.set(key, {
          ...existing,
          display_name: displayName,
          handle: guarded ? (handle || existing.handle) : handle,
          observed_via: observedVia,
        });
      } else {
        db.participants.set(key, {
          conversation_id: conversationId,
          source_user_id: sourceUserId,
          display_name: displayName,
          handle,
          observed_via: observedVia,
          tribe_person_id: null,
        });
      }
      return { rows: [] };
    }
    // The kind='beeper-user' displaced-cache clear (#96) — matches on the
    // conversation's ACCOUNT plus the raw source_user_id, in one statement.
    if (/^UPDATE beeper_participants p SET tribe_person_id = NULL/.test(s)) {
      const [displacedPersonId, accountId, sourceUserId] = params;
      let rowCount = 0;
      for (const row of db.participants.values()) {
        if (row.tribe_person_id !== displacedPersonId) continue;
        if (row.source_user_id !== sourceUserId) continue;
        if (convo(row.conversation_id).accountId !== accountId) continue;
        row.tribe_person_id = null;
        rowCount++;
      }
      return { rows: [], rowCount };
    }
    if (/^UPDATE beeper_participants SET tribe_person_id = NULL/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      if (row && row.tribe_person_id === params[2]) row.tribe_person_id = null;
      return { rows: [] };
    }
    if (/^UPDATE beeper_participants SET tribe_person_id = \$3/.test(s)) {
      const row = db.participants.get(pKey(params[0], params[1]));
      if (!row) return { rows: [] };
      if (/tribe_person_id IS NULL OR EXISTS/.test(s)
          && row.tribe_person_id && !db.people.get(row.tribe_person_id)?.deleted) return { rows: [] };
      row.tribe_person_id = params[2];
      return { rows: [participantRow(row)] };
    }
    // unlinkParticipant's claim releases (#97 part B) — deletes ONLY when the
    // claim is still owned by the given person, mirroring the real SQL's own
    // `person_id = $1` filter; a claim someone else now holds returns rowCount 0.
    if (/^DELETE FROM tribe_identities WHERE person_id/.test(s)) {
      const [personId, kind, network, handle] = params;
      const key = iKey(kind, network, handle);
      if (db.identities.get(key) !== personId) return { rows: [], rowCount: 0 };
      db.identities.delete(key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unmocked SQL: ${s.slice(0, 120)}`);
  }),
}));

const listPeople = vi.fn(async () => []);
vi.mock('./tribe.js', () => ({
  listPeople: (...args) => listPeople(...args),
  createPerson: vi.fn(),
  autoCreateTouchpoint: vi.fn(),
}));

const { query, ensureSchema } = await import('../lib/db.js');
const beeperTribe = await import('./beeperTribe.js');
const tribeService = await import('./tribe.js');

const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const OTHER_CONVERSATION = '00000000-0000-4000-8000-000000000002';
const CACHED_PERSON = '11111111-1111-4111-8111-111111111111';
const CLAIMING_PERSON = '22222222-2222-4222-8222-222222222222';
const LEGACY_PHONE_PERSON = '33333333-3333-4333-8333-333333333333';
const PHONE_RAW = '+1 (555) 010-0001';
const PHONE_NORMALIZED = '+15550100001';
const ACCOUNT_ID = 'example-account-1';

function seedPerson(id) {
  db.people.set(id, { deleted: false });
  return id;
}

function seedConversation(conversationId, network = 'discord', accountId = ACCOUNT_ID) {
  db.conversations.set(conversationId, { network, accountId });
}

function seedParticipant({
  conversationId = CONVERSATION, sourceUserId = 'user-1', handle = '', tribePersonId = null,
  network = 'discord', accountId = ACCOUNT_ID, displayName = 'Example Person', observedVia = 'message-sender',
} = {}) {
  seedConversation(conversationId, network, accountId);
  db.participants.set(pKey(conversationId, sourceUserId), {
    conversation_id: conversationId,
    source_user_id: sourceUserId,
    display_name: displayName,
    handle,
    observed_via: observedVia,
    tribe_person_id: tribePersonId,
  });
}

beforeEach(() => {
  db.people.clear();
  db.conversations.clear();
  db.participants.clear();
  db.identities.clear();
  seenSql.length = 0;
  listPeople.mockClear();
  listPeople.mockResolvedValue([]);
  query.mockClear();
  seedPerson(CACHED_PERSON);
  seedPerson(CLAIMING_PERSON);
  seedPerson(LEGACY_PHONE_PERSON);
});

describe('resolveParticipantPerson resolution order (#34 review)', () => {
  it('reuses initialized schema across repeated participant ingestion', async () => {
    seedConversation(CONVERSATION, 'whatsapp');
    const input = {
      conversationId: CONVERSATION, sourceUserId: 'schema-user',
      handle: PHONE_RAW, observedVia: 'message-sender',
    };
    await beeperTribe.upsertParticipant(input);
    const initializations = ensureSchema.mock.calls.length;
    await beeperTribe.upsertParticipant(input);
    await beeperTribe.resolveParticipantPerson(input);
    expect(ensureSchema).toHaveBeenCalledTimes(initializations);
  });

  it('lets an explicit tribe_identities claim beat a stale cached tribe_person_id (phone)', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: CACHED_PERSON, network: 'whatsapp' });
    db.identities.set(iKey('phone', '', PHONE_NORMALIZED), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('lets an explicit tribe_identities claim beat a stale cached tribe_person_id (network username)', async () => {
    seedParticipant({ handle: '@Example_Handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('keeps the cache authoritative when NO durable handle exists (the ~13% case)', async () => {
    seedParticipant({ handle: '', tribePersonId: CACHED_PERSON });

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('keeps the cache authoritative for a username on a network-less conversation (nothing durable to claim)', async () => {
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: '' });
    // A same-named claim on a REAL network must not leak into the unscoped row.
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('falls back to the cache for a durable handle nobody has claimed, before the legacy phone array', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: CACHED_PERSON, network: 'whatsapp' });
    listPeople.mockResolvedValue([{ id: LEGACY_PHONE_PERSON, name: 'Example Legacy', phones: [PHONE_NORMALIZED] }]);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CACHED_PERSON);
  });

  it('falls back to the legacy Tribe phone matcher only when neither an identity nor a cache answers', async () => {
    seedParticipant({ handle: PHONE_RAW, tribePersonId: null, network: 'whatsapp' });
    listPeople.mockResolvedValue([{ id: LEGACY_PHONE_PERSON, name: 'Example Legacy', phones: [PHONE_NORMALIZED] }]);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(LEGACY_PHONE_PERSON);
  });

  // #96 — the beeper-user claim sits between the handle claim and the cache.
  it('lets a beeper-user claim beat a stale cached tribe_person_id when no handle classifies', async () => {
    seedParticipant({ handle: '', tribePersonId: CACHED_PERSON, network: 'facebook' });
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('lets the HANDLE claim outrank the beeper-user claim when the two disagree', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CACHED_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('scopes the beeper-user claim to the ACCOUNT — the same source_user_id under another account never resolves', async () => {
    seedParticipant({ handle: '', network: 'facebook', accountId: 'example-account-2' });
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    })).toBeNull();
  });

  it('returns null for an unknown participant', async () => {
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: CONVERSATION, sourceUserId: 'nobody',
    })).toBeNull();
  });
});

describe('linkParticipant', () => {
  it('nulls the displaced person\'s other participant caches on an ownership move, so they stop resolving to them', async () => {
    // Two conversations on the same network, both presenting the same handle;
    // the first is already cached onto CACHED_PERSON.
    seedParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
      handle: '@Example_Handle', tribePersonId: CACHED_PERSON, network: 'discord',
    });
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CACHED_PERSON);

    const linked = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(linked.displacedPersonId).toBe(CACHED_PERSON);

    // The OTHER conversation's row no longer points at the displaced person...
    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-elsewhere')).tribe_person_id).toBeNull();
    // ...and now resolves through the identity claim to the new owner.
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
    })).toBe(CLAIMING_PERSON);
  });

  it('leaves a displaced person\'s UNRELATED participant rows alone', async () => {
    seedParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
      handle: '@different_handle', tribePersonId: CACHED_PERSON, network: 'discord',
    });
    seedParticipant({ handle: '@example_handle', tribePersonId: CACHED_PERSON, network: 'discord' });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CACHED_PERSON);

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-elsewhere')).tribe_person_id).toBe(CACHED_PERSON);
  });

  it('writes the cache instead of throwing 400 when a username-bearing participant has no conversation network', async () => {
    seedParticipant({ handle: '@example_handle', network: '' });

    const linked = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(linked.tribePersonId).toBe(CLAIMING_PERSON);
    expect(linked.displacedPersonId).toBeNull();
    // No inert, unscoped kind='handle' row was written — the ONLY claim is the
    // account-scoped beeper-user one (#96), which needs no conversation network.
    expect([...db.identities.keys()]).toEqual([iKey('beeper-user', ACCOUNT_ID, 'user-1')]);
  });

  // #96 — the durable half for a participant with NO classifiable handle. The
  // claim is keyed on the conversation's ACCOUNT and the raw source_user_id,
  // both joined server-side, so it survives the purge that deletes the
  // participant row (and its cache column) outright.
  it('claims a beeper-user identity on the conversation account for a participant with no handle at all', async () => {
    seedParticipant({ handle: '', network: 'facebook' });

    const linked = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(linked.tribePersonId).toBe(CLAIMING_PERSON);
    expect(db.identities.get(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(CLAIMING_PERSON);
    // The account, not the network — two bridge accounts on one network mint
    // independent source_user_id spaces.
    expect(db.identities.has(iKey('beeper-user', 'facebook', 'user-1'))).toBe(false);
  });

  it('claims the beeper-user identity ALONGSIDE the handle claim when the participant has both', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord' });

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(db.identities.get(iKey('handle', 'discord', 'example_handle'))).toBe(CLAIMING_PERSON);
    expect(db.identities.get(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(CLAIMING_PERSON);
  });

  it('is a no-op when the same participant is re-linked to the same person', async () => {
    seedParticipant({ handle: '', network: 'facebook' });

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    const again = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(again.tribePersonId).toBe(CLAIMING_PERSON);
    expect(again.displacedPersonId).toBeNull();
    // One claim, not two — the UNIQUE (kind, network, handle) upsert path.
    expect([...db.identities.keys()]).toEqual([iKey('beeper-user', ACCOUNT_ID, 'user-1')]);
  });

  it('moves the beeper-user claim and clears the displaced person\'s caches on a re-link to somebody else', async () => {
    // The SAME Beeper user, under the same account, in two conversations.
    seedParticipant({ handle: '', network: 'facebook' });
    seedParticipant({ conversationId: OTHER_CONVERSATION, sourceUserId: 'user-1', handle: '', network: 'facebook' });

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CACHED_PERSON,
    });
    // The second conversation's row caches onto the same person on its next
    // observation, through the claim alone (no handle to match on).
    const second = await beeperTribe.upsertParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-1', handle: '', observedVia: 'message-sender',
    });
    expect(second.tribePersonId).toBe(CACHED_PERSON);

    const moved = await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(moved.displacedPersonId).toBe(CACHED_PERSON);
    expect(db.identities.get(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(CLAIMING_PERSON);
    // The other conversation's stale cache is cleared and re-resolves to the
    // new owner rather than permanently attributing the thread to the old one.
    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
    expect(await beeperTribe.resolveParticipantPerson({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-1',
    })).toBe(CLAIMING_PERSON);
  });

  it('still claims a phone identity on a network-less conversation (phones are network-less by design)', async () => {
    seedParticipant({ handle: PHONE_RAW, network: '' });

    await beeperTribe.linkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', personId: CLAIMING_PERSON,
    });
    expect(db.identities.get(iKey('phone', '', PHONE_NORMALIZED))).toBe(CLAIMING_PERSON);
  });
});

describe('unlinkParticipant (#97 part B)', () => {
  it('removes both claims the linked person holds for this participant and nulls its own cache', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord', tribePersonId: CLAIMING_PERSON });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    const result = await beeperTribe.unlinkParticipant({ conversationId: CONVERSATION, sourceUserId: 'user-1' });

    expect(result.unlinkedPersonId).toBe(CLAIMING_PERSON);
    expect(result.removedClaims).toBe(2);
    expect(result.participant.tribePersonId).toBeNull();
    expect(db.identities.has(iKey('handle', 'discord', 'example_handle'))).toBe(false);
    expect(db.identities.has(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(false);
    expect(db.participants.get(pKey(CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
  });

  it('nulls every other participant row the released claims were backing', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord', tribePersonId: CLAIMING_PERSON });
    seedParticipant({
      conversationId: OTHER_CONVERSATION, sourceUserId: 'user-elsewhere',
      handle: '@example_handle', tribePersonId: CLAIMING_PERSON, network: 'discord',
    });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    await beeperTribe.unlinkParticipant({ conversationId: CONVERSATION, sourceUserId: 'user-1' });

    expect(db.participants.get(pKey(OTHER_CONVERSATION, 'user-elsewhere')).tribe_person_id).toBeNull();
  });

  it('never touches another person\'s claim on the same handle', async () => {
    // The handle claim has already moved to CACHED_PERSON (a later link
    // elsewhere); this participant's own cache is stale, still pointing at
    // the old owner.
    seedParticipant({ handle: '@example_handle', network: 'discord', tribePersonId: CLAIMING_PERSON });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CACHED_PERSON);
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    const result = await beeperTribe.unlinkParticipant({ conversationId: CONVERSATION, sourceUserId: 'user-1' });

    // Only the beeper-user claim (still CLAIMING_PERSON's) was removed — the
    // handle claim, now owned by CACHED_PERSON, is untouched.
    expect(result.removedClaims).toBe(1);
    expect(db.identities.get(iKey('handle', 'discord', 'example_handle'))).toBe(CACHED_PERSON);
    expect(db.identities.has(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(false);
    // The participant's own stale cache still clears via the trailing
    // belt-and-braces UPDATE, even though the handle DELETE was a no-op.
    expect(db.participants.get(pKey(CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
  });

  it('is a 200 no-op for an already-unlinked participant, touching no claims', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord', tribePersonId: null });
    db.identities.set(iKey('handle', 'discord', 'example_handle'), CLAIMING_PERSON);

    const result = await beeperTribe.unlinkParticipant({ conversationId: CONVERSATION, sourceUserId: 'user-1' });

    expect(result.unlinkedPersonId).toBeNull();
    expect(result.removedClaims).toBe(0);
    // Someone else's still-active claim on this same handle is left alone.
    expect(db.identities.get(iKey('handle', 'discord', 'example_handle'))).toBe(CLAIMING_PERSON);
  });

  it('throws 404 for an unknown participant', async () => {
    await expect(beeperTribe.unlinkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'nobody',
    })).rejects.toMatchObject({ status: 404 });
  });

  it('unlinks a participant with no classifiable handle via the beeper-user claim alone', async () => {
    seedParticipant({ handle: '', network: 'facebook', tribePersonId: CLAIMING_PERSON });
    db.identities.set(iKey('beeper-user', ACCOUNT_ID, 'user-1'), CLAIMING_PERSON);

    const result = await beeperTribe.unlinkParticipant({ conversationId: CONVERSATION, sourceUserId: 'user-1' });

    expect(result.removedClaims).toBe(1);
    expect(db.identities.has(iKey('beeper-user', ACCOUNT_ID, 'user-1'))).toBe(false);
    expect(db.participants.get(pKey(CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
  });
});

describe('upsertParticipant handle preservation', () => {
  it('guards the ON CONFLICT handle update with COALESCE/NULLIF', async () => {
    seedConversation(CONVERSATION, 'discord');
    await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', handle: '@example_handle', observedVia: 'message-sender',
    });
    const insert = seenSql.find((sql) => /INSERT INTO beeper_participants/.test(sql));
    expect(insert.replace(/\s+/g, ' ')).toContain(
      "handle = COALESCE(NULLIF(EXCLUDED.handle, ''), beeper_participants.handle)",
    );
  });

  it('does not wipe a durable handle when the same participant is re-observed without one', async () => {
    seedParticipant({ handle: '@example_handle', network: 'discord' });

    const resynced = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION,
      sourceUserId: 'user-1',
      displayName: 'Example Person',
      handle: '',
      observedVia: 'participant-list',
    });
    expect(resynced.handle).toBe('@example_handle');
  });

  it('replaces the stored handle when a new, non-empty one is observed', async () => {
    seedParticipant({ handle: '@old_handle', network: 'discord' });

    const resynced = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION,
      sourceUserId: 'user-1',
      displayName: 'Example Person',
      handle: '@new_handle',
      observedVia: 'message-sender',
    });
    expect(resynced.handle).toBe('@new_handle');
  });
});

// The audit's roster-reload finding: `upsertParticipant`'s phone-match
// fallback used to reload and reindex the ENTIRE Tribe roster once per
// participant, so a sweep with N participants across a handful of chats made
// N (or more) identical `tribe.listPeople()` calls for the same unchanging
// roster. `personIndex` lets a caller (`beeperSync.js`'s sweep pass, via
// `loadRosterIndex`) build the index once and hand it to every
// `upsertParticipant` call.
describe('upsertParticipant — roster hoisting: personIndex loaded once, not once per participant', () => {
  const rosterPeople = () => ([
    { id: CACHED_PERSON, name: 'Example One', phones: ['+15550100011'] },
    { id: CLAIMING_PERSON, name: 'Example Two', phones: ['+15550100022'] },
    { id: LEGACY_PHONE_PERSON, name: 'Example Three', phones: ['+15550100033'] },
  ]);

  it('reuses one caller-supplied personIndex across N participants instead of reloading the roster per participant', async () => {
    seedConversation(CONVERSATION, 'whatsapp');
    listPeople.mockResolvedValue(rosterPeople());

    // The one load a whole sweep pass is meant to do, built up front —
    // mirrors `loadRosterIndex()` being called once in `beeperSync.js`.
    const personIndex = await beeperTribe.loadRosterIndex();
    expect(listPeople).toHaveBeenCalledTimes(1);

    const participants = [
      { sourceUserId: 'user-1', handle: '+1 (555) 010-0011', expected: CACHED_PERSON },
      { sourceUserId: 'user-2', handle: '+1 (555) 010-0022', expected: CLAIMING_PERSON },
      { sourceUserId: 'user-3', handle: '+1 (555) 010-0033', expected: LEGACY_PHONE_PERSON },
    ];

    for (const p of participants) {
      // eslint-disable-next-line no-await-in-loop -- sequential upserts mirroring the sweep's own per-chat loop
      const result = await beeperTribe.upsertParticipant({
        conversationId: CONVERSATION,
        sourceUserId: p.sourceUserId,
        handle: p.handle,
        observedVia: 'message-sender',
        personIndex,
      });
      // The linking result is UNCHANGED: every participant still resolves to
      // the right person through the shared index.
      expect(result.tribePersonId).toBe(p.expected);
    }

    // The roster was loaded ONCE, up front — never again across all 3 upserts.
    expect(listPeople).toHaveBeenCalledTimes(1);
  });

  it('falls back to one reload per call with no personIndex supplied — the old, unchanged default', async () => {
    seedConversation(CONVERSATION, 'whatsapp');
    listPeople.mockResolvedValue(rosterPeople());

    const first = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', handle: '+1 (555) 010-0011', observedVia: 'message-sender',
    });
    const second = await beeperTribe.upsertParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-2', handle: '+1 (555) 010-0022', observedVia: 'message-sender',
    });

    expect(first.tribePersonId).toBe(CACHED_PERSON);
    expect(second.tribePersonId).toBe(CLAIMING_PERSON);
    expect(listPeople).toHaveBeenCalledTimes(2);
  });
});

describe('createPersonAndLinkParticipant notes text (#99)', () => {
  it('no longer bakes the network into the Notes string', async () => {
    seedParticipant({ network: 'discord', displayName: 'Example Person', handle: '' });
    tribeService.createPerson.mockResolvedValue({ id: CLAIMING_PERSON, name: 'Example Person' });

    await beeperTribe.createPersonAndLinkParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1',
    });

    expect(tribeService.createPerson).toHaveBeenCalledWith(expect.objectContaining({
      notes: 'Imported from Beeper',
      channel: 'Beeper',
    }));
  });
});

describe('listPersonIdentitiesWithConversations (#99)', () => {
  it('returns an empty array for a person with no identity claims, without a second query', async () => {
    query.mockImplementationOnce(async (sql) => {
      expect(sql).toContain('FROM tribe_identities WHERE person_id = $1');
      return { rows: [] };
    });

    const result = await beeperTribe.listPersonIdentitiesWithConversations(CLAIMING_PERSON);

    expect(result).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('attaches conversations to a beeper-user claim via the account/source-user join', async () => {
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: 'identity-1', person_id: CLAIMING_PERSON, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'user-1',
        source: 'user', linked_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }],
    }));
    query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toContain('c.account_id = $1 AND p.source_user_id = $2');
      expect(params).toEqual([ACCOUNT_ID, 'user-1']);
      return {
        rows: [{
          conversation_id: CONVERSATION, display_name: 'Example Person', network: 'whatsapp',
          title: 'Example Thread', account_id: ACCOUNT_ID,
        }],
      };
    });

    const result = await beeperTribe.listPersonIdentitiesWithConversations(CLAIMING_PERSON);

    expect(result).toEqual([{
      id: 'identity-1', personId: CLAIMING_PERSON, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'user-1',
      source: 'user', linkedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
      conversations: [{
        conversationId: CONVERSATION, network: 'whatsapp', title: 'Example Thread',
        accountId: ACCOUNT_ID, displayName: 'Example Person',
      }],
    }]);
  });

  it('attaches conversations to a handle claim via the resolved participant cache, scoped by network', async () => {
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: 'identity-2', person_id: CLAIMING_PERSON, kind: 'handle', network: 'whatsapp', handle: 'ada',
        source: 'user', linked_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }],
    }));
    query.mockImplementationOnce(async (sql, params) => {
      expect(sql).toContain('p.tribe_person_id = $1');
      expect(sql).toContain('c.network = $2');
      expect(params).toEqual([CLAIMING_PERSON, 'whatsapp']);
      return { rows: [] }; // a purged conversation / no cached row yet — an empty list, not an error
    });

    const result = await beeperTribe.listPersonIdentitiesWithConversations(CLAIMING_PERSON);

    expect(result[0].conversations).toEqual([]);
  });

  it('reads a phone claim un-scoped by network (phones are network-less by design)', async () => {
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: 'identity-3', person_id: CLAIMING_PERSON, kind: 'phone', network: '', handle: PHONE_NORMALIZED,
        source: 'user', linked_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }],
    }));
    query.mockImplementationOnce(async (sql, params) => {
      expect(sql).not.toContain('c.network = $2');
      expect(params).toEqual([CLAIMING_PERSON]);
      return {
        rows: [{
          conversation_id: OTHER_CONVERSATION, display_name: 'Example Person', network: 'imessage',
          title: '', account_id: '',
        }],
      };
    });

    const result = await beeperTribe.listPersonIdentitiesWithConversations(CLAIMING_PERSON);

    expect(result[0].conversations).toEqual([{
      conversationId: OTHER_CONVERSATION, network: 'imessage', title: '', accountId: '', displayName: 'Example Person',
    }]);
  });
});

describe('unlinkIdentity (#99)', () => {
  it('returns null for an unknown identity id (the route turns this into 404)', async () => {
    query.mockImplementationOnce(async (sql) => {
      expect(sql).toContain('DELETE FROM tribe_identities WHERE id = $1');
      return { rows: [] };
    });

    const result = await beeperTribe.unlinkIdentity('missing-id');

    expect(result).toBeNull();
  });

  it('deletes a beeper-user claim and nulls the cached participant rows for that account/user', async () => {
    seedParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', tribePersonId: CLAIMING_PERSON,
      network: 'whatsapp', accountId: ACCOUNT_ID,
    });
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: 'identity-1', person_id: CLAIMING_PERSON, kind: 'beeper-user', network: ACCOUNT_ID, handle: 'user-1',
        source: 'user', linked_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }],
    }));

    const result = await beeperTribe.unlinkIdentity('identity-1');

    expect(result).toMatchObject({ id: 'identity-1', personId: CLAIMING_PERSON, kind: 'beeper-user' });
    expect(db.participants.get(pKey(CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
  });

  it('deletes a handle claim and nulls the cached participant rows matching its scope', async () => {
    seedParticipant({
      conversationId: CONVERSATION, sourceUserId: 'user-1', handle: '@ada', tribePersonId: CLAIMING_PERSON,
      network: 'discord',
    });
    query.mockImplementationOnce(async () => ({
      rows: [{
        id: 'identity-2', person_id: CLAIMING_PERSON, kind: 'handle', network: 'discord', handle: 'ada',
        source: 'user', linked_at: '2026-01-01T00:00:00.000Z', created_at: '2026-01-01T00:00:00.000Z',
      }],
    }));

    const result = await beeperTribe.unlinkIdentity('identity-2');

    expect(result).toMatchObject({ id: 'identity-2', personId: CLAIMING_PERSON, kind: 'handle' });
    expect(db.participants.get(pKey(CONVERSATION, 'user-1')).tribe_person_id).toBeNull();
  });
});
