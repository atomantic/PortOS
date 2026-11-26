/**
 * Beeper ↔ Tribe identity linking (#34, decided on #10, built on the schema
 * from #27/PR42). Relates a `beeper_participants` row to a `tribe_people`
 * row via the split-by-durability design:
 *
 *   - A durable handle (a phone, ~81% of one-to-one counterparties, or a
 *     network username, ~6%) resolves through `tribe_identities` — see
 *     `server/services/tribeIdentities.js` — PLUS, for a phone specifically,
 *     the existing Tribe phone matcher (`tribeMatch.js`/`tribe.listPeople()`),
 *     since a WhatsApp/Signal/Google-Messages phone is very plausibly already
 *     on a Tribe person from calendar/iMessage/Contacts. Resolution never
 *     creates a person — only matches an existing one — so the auto path can
 *     never produce a duplicate.
 *   - No durable handle at all (~13%) has nothing HANDLE-shaped to resolve
 *     against, so every EXPLICIT link (`linkParticipant` /
 *     `createPersonAndLinkParticipant`) also claims a `kind='beeper-user'`
 *     identity keyed on the participant's own account and Beeper user id (see
 *     `beeperUserScopeFor`), and `beeper_participants.tribe_person_id` drops
 *     to being a pure cache for that case too.
 *
 * `kind='beeper-user'` OVERLOADS the existing `UNIQUE (kind, network, handle)`
 * index rather than adding a column (#96): `network` carries the participant's
 * `beeper_conversations.account_id` and `handle` carries its raw
 * `source_user_id`. That pair is Beeper's own per-account `User.id`, stable
 * across resweeps, where the mirror's `conversation_id` is a PortOS UUID
 * re-minted by every purge — so the claim survives a purge + resweep by
 * construction (`tribe_identities` has no FK onto anything Beeper-side).
 * The ACCOUNT, not the network, is the scope: two bridge accounts on the same
 * network mint their own independent user-id space. The overload is documented
 * on the table itself in `server/lib/db/schema/tribe.js`; a `source_user_id`
 * is an opaque id, so it is stored RAW and never routed through
 * `classifyNetworkHandle` (which exists for phones/usernames only).
 *
 * `upsertParticipant` is the participant-row writer the ingestion sweep (#32)
 * calls on every sync pass — its ON CONFLICT clause deliberately never
 * touches `tribe_person_id`, so a manual link on the 13%-no-handle case
 * survives every re-sync (#34 acceptance); its post-insert auto-resolve is
 * what re-fills the cache from the `beeper-user` claim after a purge (#96).
 *
 * Touchpoints: `logSenderTouchpoints` relates a GROUP conversation by message
 * SENDER only — Beeper's participant roster truncates (20/100, no cursor) so
 * it is never a complete membership list; iterating it to log touchpoints for
 * everyone "in" a group would silently invent contact with people who never
 * actually messaged. A message's `senderID` is always a real, present
 * participant, so deriving touchpoints from messages (never from the roster)
 * is correct for a 1:1 chat too, not just a group.
 */
import { ensureSchema, query, withTransaction } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  classifyNetworkHandle, buildPersonMatchIndex, matchPerson, resolveLinkedPersonId,
} from '../../lib/tribeMatch.js';
import * as tribe from '../tribe.js';
import * as tribeIdentities from '../tribeIdentities.js';

let schemaReady;
function ensureReady() {
  schemaReady ??= ensureSchema().catch((error) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

function rowToParticipant(row) {
  if (!row) return null;
  return {
    conversationId: row.conversation_id,
    sourceUserId: row.source_user_id,
    displayName: row.display_name || '',
    handle: row.handle || '',
    // Deliberately NULLed when the cached link points at a soft-deleted Tribe
    // person (`tp.deleted`, joined below) — `tribe.deletePerson` never fires
    // the FK's ON DELETE CASCADE (it's a soft delete), so the raw column can
    // point at a person who no longer counts as one. Callers (below, and
    // upsertParticipant's "still empty" check) then correctly treat this
    // participant as unlinked rather than resolving onto a deleted person.
    // `resolveLinkedPersonId` (`lib/tribeMatch.js`) is the SAME predicate
    // `beeperConversations.js`'s conversation/list shaper applies to this same
    // column, so the two cannot drift onto different answers again.
    tribePersonId: resolveLinkedPersonId(row.tribe_person_id, row.tribe_person_deleted),
    // The Beeper NETWORK this participant's conversation belongs to — joined
    // from beeper_conversations.network, never client-supplied (#34 review:
    // a caller-supplied network let a username-shaped handle be linked under
    // the wrong scope, or with none at all). Authoritative scope for a
    // kind='handle' tribe_identities claim.
    network: row.network || '',
    // The Beeper ACCOUNT this participant's conversation belongs to, joined
    // from beeper_conversations.account_id — likewise never client-supplied.
    // Authoritative scope for the kind='beeper-user' claim (#96): a
    // `source_user_id` is only unique within one bridge account, and the
    // account survives a purge + resweep where the conversation id does not.
    accountId: row.account_id || '',
    observedVia: row.observed_via,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  };
}

export async function getParticipant(conversationId, sourceUserId, { client, forUpdate = false } = {}) {
  if (!client) await ensureReady();
  const result = await (client ?? { query }).query(
    `SELECT p.*, c.network, c.account_id, tp.deleted AS tribe_person_deleted
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     LEFT JOIN tribe_people tp ON tp.id = p.tribe_person_id
     WHERE p.conversation_id = $1 AND p.source_user_id = $2${forUpdate ? ' FOR UPDATE OF p' : ''}`,
    [conversationId, sourceUserId],
  );
  return rowToParticipant(result.rows[0]);
}

/**
 * The `tribe_identities` scope a participant's handle claims, or `null` when
 * the handle is absent/unclassifiable or (for a username) its conversation
 * carries no network — a `kind='handle'` row is meaningless without one, and
 * `tribeIdentities` refuses to write or resolve it. Shared by
 * `resolveParticipantPerson` and `linkParticipant` so the read and the write
 * agree on exactly which participants have a DURABLE identity.
 */
function identityScopeFor(participant) {
  if (!participant?.handle) return null;
  const classified = classifyNetworkHandle(participant.handle);
  if (!classified) return null;
  const network = classified.kind === 'phone' ? '' : (participant.network || '');
  if (classified.kind === 'handle' && !network) return null;
  return { kind: classified.kind, network, handle: classified.handle };
}

/** The `tribe_identities` kind that carries a Beeper `User.id` claim (#96). */
export const BEEPER_USER_KIND = 'beeper-user';

/**
 * The `tribe_identities` scope a participant's BEEPER USER ID claims — the
 * durable key every participant has, handle or not (#96). Overloads the
 * existing `UNIQUE (kind, network, handle)` index: `network` is the
 * participant's own `beeper_conversations.account_id` and `handle` is its raw
 * `source_user_id` (an opaque id — never normalized, never classified).
 *
 * Keyed on the ACCOUNT rather than the network because a `source_user_id` is
 * only unique within one bridge account, and joined server-side from the
 * participant's own conversation, never caller-supplied — the same rule
 * `identityScopeFor` follows for `network`. Returns `null` when either half is
 * missing (an account-less conversation cannot exist through the FK, but an
 * unscoped claim is the inert-row hazard `linkIdentity` refuses, so this
 * never manufactures one). Shared by `resolveParticipantPerson` and
 * `linkParticipant` so the read and the write agree on the key.
 */
function beeperUserScopeFor(participant) {
  const network = participant?.accountId || '';
  const handle = participant?.sourceUserId || '';
  if (!network || !handle) return null;
  return { kind: BEEPER_USER_KIND, network, handle };
}

/**
 * Resolve a participant to a Tribe person WITHOUT writing anything. Never
 * creates a person.
 *
 * Order — CLASSIFY FIRST, and let a durable handle's `tribe_identities` claim
 * outrank the cache column (#34 review): `beeper_participants.tribe_person_id`
 * is a CACHE, authoritative **only** where no durable handle exists (the ~13%
 * with neither a phone nor a username). Reading it first made it authoritative
 * for 100% and froze the truth table out of every already-cached row — a cache
 * auto-filled from the legacy `tribe_people.phones[]` axis would permanently
 * outrank a later explicit claim on the same phone, and after `linkParticipant`
 * moves ownership of a handle, every OTHER participant row carrying it would
 * keep resolving to the displaced person. So:
 *
 *   1. `tribe_identities` — the user's OWN explicit Beeper link, the truth for
 *      any handle that classifies into a resolvable scope.
 *   2. the `kind='beeper-user'` claim on this participant's own
 *      (account, `source_user_id`) — the same explicit link recorded durably
 *      for a participant with NO classifiable handle (#96). Below the handle
 *      claim because a handle can be re-pointed at a different person on its
 *      own axis, and above the cache for the same reason the handle claim is:
 *      the claim is the record of an explicit user action, the column is a
 *      cache that a purge deletes and a resweep re-mints empty.
 *   3. the cache column — still the next-best answer for a durable handle
 *      nobody has claimed yet, and for a row auto-resolved but never claimed
 *      (it is a manual link, so it outranks the legacy array below). Null'd
 *      when it points at a soft-deleted person — see `rowToParticipant`.
 *   4. for a phone specifically, the existing Tribe phone matcher — a
 *      WhatsApp/Signal counterpart's phone is plausibly already on a Tribe
 *      person from iMessage/Contacts with no Beeper claim recorded yet.
 *
 * Returns `null` when nothing matches.
 *
 * `personIndex` is an optional pre-built `buildPersonMatchIndex(...)` result
 * — pass one when resolving many participants in a batch (`logSenderTouchpoints`
 * below) so the phone fallback doesn't reload and reindex every Tribe person
 * once per participant.
 */
/**
 * Resolve an already-loaded participant row (from `getParticipant` or the
 * batched conversation SELECT) without re-querying `beeper_participants`.
 * When `resolvedIdentities` is omitted, combines the handle and `beeper-user`
 * `tribe_identities` lookups into a single query.
 */
async function resolveLoadedParticipant(participant, personIndex = null, resolvedIdentities = null) {
  if (!participant) return null;

  const scope = identityScopeFor(participant);
  const beeperUserScope = beeperUserScopeFor(participant);
  let identities = resolvedIdentities;
  if (!identities) {
    const scopes = [scope, beeperUserScope].filter(Boolean);
    identities = scopes.length > 0
      ? await tribeIdentities.resolvePeopleByIdentities(scopes)
      : new Map();
  }

  if (scope) {
    const via = identities.get(tribeIdentities.identityLookupKey(scope));
    if (via) return via;
  }

  if (beeperUserScope) {
    const viaBeeperUser = identities.get(tribeIdentities.identityLookupKey(beeperUserScope));
    if (viaBeeperUser) return viaBeeperUser;
  }

  if (participant.tribePersonId) return participant.tribePersonId;

  if (scope?.kind === 'phone') {
    const index = personIndex || buildPersonMatchIndex(await tribe.listPeople());
    const viaTribePhone = matchPerson({ phone: scope.handle }, index);
    if (viaTribePhone) return viaTribePhone;
  }

  return null;
}

export async function resolveParticipantPerson({ conversationId, sourceUserId }, personIndex = null) {
  const participant = await getParticipant(conversationId, sourceUserId);
  return resolveLoadedParticipant(participant, personIndex);
}

/**
 * Load and index the Tribe roster ONCE, for a caller (a sweep pass in
 * `beeperSync.js`) about to resolve MANY participants and wants to hand the
 * same `personIndex` to participant upserts and touchpoint batches rather than
 * let each reload and reindex every Tribe person for itself.
 */
export async function loadRosterIndex() {
  return buildPersonMatchIndex(await tribe.listPeople());
}

const PARTICIPANT_UPSERT_CONFLICT_SQL = `ON CONFLICT (conversation_id, source_user_id)
DO UPDATE SET display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), beeper_participants.display_name),
  handle = COALESCE(NULLIF(EXCLUDED.handle, ''), beeper_participants.handle),
  observed_via = EXCLUDED.observed_via, updated_at = NOW()`;

function validateParticipantInput({ sourceUserId, observedVia }) {
  if (!sourceUserId) {
    throw new ServerError('conversationId and sourceUserId are required', { status: 400, code: 'BAD_REQUEST' });
  }
  if (observedVia !== 'participant-list' && observedVia !== 'message-sender') {
    throw new ServerError("observedVia must be 'participant-list' or 'message-sender'", { status: 400, code: 'BAD_REQUEST' });
  }
}

function applyUpdatedCacheRow(participant, updatedRow) {
  return {
    ...participant,
    tribePersonId: updatedRow.tribe_person_id,
    updatedAt: updatedRow.updated_at?.toISOString?.() ?? updatedRow.updated_at ?? participant.updatedAt,
  };
}

/**
 * Insert-or-refresh a participant row. The `ON CONFLICT` update list
 * deliberately EXCLUDES `tribe_person_id` — a re-sync must never clobber a
 * manual link (#34 acceptance: "a counterparty with no durable identifier
 * links by hand and survives a re-sync"). After the write, opportunistically
 * auto-resolves and fills the cache ONLY when it is still empty — never
 * overrides an existing link, manual or previously auto-resolved.
 *
 * `handle` is COALESCE-guarded rather than overwritten (#34 review): a later
 * sweep that observes the same counterparty WITHOUT a handle (Beeper omits
 * `phoneNumber`/`username` on a truncated roster entry, and a participant-list
 * observation carries less than a message-sender one) must not wipe a durable
 * handle — that handle IS the `tribe_identities` axis, so erasing it would
 * silently demote the participant to the no-durable-identifier case and strand
 * the identity claim. A genuinely new, non-empty handle still replaces it.
 *
 * `personIndex` is the SAME optional pre-built `buildPersonMatchIndex(...)`
 * result `resolveParticipantPerson` and `logSenderTouchpoints` accept — pass
 * one (via `loadRosterIndex` below) when a caller will call this once per
 * participant in a sweep pass, so the phone fallback doesn't reload and
 * reindex the whole Tribe roster on every single participant. `null` falls
 * back to `resolveLoadedParticipant`'s own per-call load, unchanged.
 */
export async function upsertParticipant({
  conversationId, sourceUserId, displayName = '', handle = '', observedVia, personIndex = null,
}) {
  if (!conversationId) {
    throw new ServerError('conversationId and sourceUserId are required', { status: 400, code: 'BAD_REQUEST' });
  }
  validateParticipantInput({ sourceUserId, observedVia });
  await ensureReady();
  await query(
    `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, observed_via)
     VALUES ($1, $2, $3, $4, $5)
     ${PARTICIPANT_UPSERT_CONFLICT_SQL}`,
    [conversationId, sourceUserId, displayName, handle, observedVia],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Conversation not found', { status: 404 });
    throw err;
  });

  const participant = await getParticipant(conversationId, sourceUserId);
  // Gated on the cache being empty only: with the `kind='beeper-user'` claim a handle-less participant is resolvable, so a
  // hand-linked one re-fills after a purge + resweep. Cost is one combined `tribe_identities` lookup; the phone matcher
  // (the expensive leg) still only runs for a phone-shaped handle.
  // A soft-deleted owner is unlinked in the read model even while its raw FK
  // remains. Apply the same rule to the write, preserving only live links.
  if (!participant.tribePersonId) {
    const resolved = await resolveLoadedParticipant(participant, personIndex);
    if (resolved) {
      const updated = await query(
        `UPDATE beeper_participants SET tribe_person_id = $3, updated_at = NOW()
         WHERE conversation_id = $1 AND source_user_id = $2
           AND (tribe_person_id IS NULL OR EXISTS (
             SELECT 1 FROM tribe_people tp
             WHERE tp.id = beeper_participants.tribe_person_id AND tp.deleted = TRUE
           ))
         RETURNING tribe_person_id, updated_at`,
        [conversationId, sourceUserId, resolved],
      );
      if (updated.rows[0]) return applyUpdatedCacheRow(participant, updated.rows[0]);
      return getParticipant(conversationId, sourceUserId);
    }
  }
  return participant;
}

/**
 * Batch-upsert and auto-resolve all participants for one conversation in at most
 * four queries: one UNNEST upsert, one participant SELECT, one batched
 * `tribe_identities` lookup, and one batched cache UPDATE. Preserves
 * handle-COALESCE, soft-delete, and `tribe_identities` precedence semantics and
 * returns `{ participants, resolvedPersonIds }` so callers (`sweepChat`) can
 * pass `resolvedPersonIds` (`Map<sourceUserId, personId | null>`) straight into
 * `logSenderTouchpoints` without re-querying.
 */
export async function upsertConversationParticipants(conversationId, participants = [], { personIndex = null } = {}) {
  if (!conversationId) {
    throw new ServerError('conversationId and sourceUserId are required', { status: 400, code: 'BAD_REQUEST' });
  }
  if (!Array.isArray(participants) || participants.length === 0) {
    return { participants: [], resolvedPersonIds: new Map() };
  }

  // Deduplicate by sourceUserId so ON CONFLICT DO UPDATE never affects one row twice.
  const deduped = new Map();
  for (const entry of participants) {
    validateParticipantInput(entry || {});
    const existing = deduped.get(entry.sourceUserId);
    const displayName = String(entry.displayName ?? '');
    const handle = String(entry.handle ?? '');
    deduped.set(entry.sourceUserId, {
      sourceUserId: entry.sourceUserId,
      displayName: displayName || existing?.displayName || '',
      handle: handle || existing?.handle || '',
      observedVia: entry.observedVia,
    });
  }

  const batch = [...deduped.values()];
  const sourceUserIds = batch.map((p) => p.sourceUserId);

  await ensureReady();
  await query(
    `INSERT INTO beeper_participants (conversation_id, source_user_id, display_name, handle, observed_via)
     SELECT $1::uuid, t.source_user_id, t.display_name, t.handle, t.observed_via
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
         AS t(source_user_id, display_name, handle, observed_via)
     ${PARTICIPANT_UPSERT_CONFLICT_SQL}`,
    [
      conversationId,
      sourceUserIds,
      batch.map((p) => p.displayName),
      batch.map((p) => p.handle),
      batch.map((p) => p.observedVia),
    ],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Conversation not found', { status: 404 });
    throw err;
  });

  const loadedResult = await query(
    `SELECT p.*, c.network, c.account_id, tp.deleted AS tribe_person_deleted
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     LEFT JOIN tribe_people tp ON tp.id = p.tribe_person_id
     WHERE p.conversation_id = $1 AND p.source_user_id = ANY($2::text[])`,
    [conversationId, sourceUserIds],
  );
  const loadedById = new Map(
    loadedResult.rows.map((row) => {
      const shaped = rowToParticipant(row);
      return [shaped.sourceUserId, shaped];
    }),
  );
  const loaded = sourceUserIds.map((id) => loadedById.get(id)).filter(Boolean);

  const scopes = [];
  for (const participant of loaded) {
    const scope = identityScopeFor(participant);
    if (scope) scopes.push(scope);
    const beeperUserScope = beeperUserScopeFor(participant);
    if (beeperUserScope) scopes.push(beeperUserScope);
  }
  const resolvedIdentities = await tribeIdentities.resolvePeopleByIdentities(scopes);

  let batchPersonIndex = personIndex;
  if (!batchPersonIndex) {
    const needsPhoneFallback = loaded.some((participant) => {
      if (participant.tribePersonId) return false;
      const scope = identityScopeFor(participant);
      if (scope?.kind !== 'phone') return false;
      if (resolvedIdentities.has(tribeIdentities.identityLookupKey(scope))) return false;
      const beeperUserScope = beeperUserScopeFor(participant);
      if (beeperUserScope && resolvedIdentities.has(tribeIdentities.identityLookupKey(beeperUserScope))) return false;
      return true;
    });
    if (needsPhoneFallback) batchPersonIndex = await loadRosterIndex();
  }

  const resolvedPersonIds = new Map();
  const cacheUpdates = [];
  for (const participant of loaded) {
    const resolved = await resolveLoadedParticipant(participant, batchPersonIndex, resolvedIdentities);
    resolvedPersonIds.set(participant.sourceUserId, resolved);
    if (!participant.tribePersonId && resolved) {
      cacheUpdates.push({ sourceUserId: participant.sourceUserId, personId: resolved });
    }
  }

  if (cacheUpdates.length > 0) {
    const updated = await query(
      `UPDATE beeper_participants p
          SET tribe_person_id = u.tribe_person_id, updated_at = NOW()
         FROM unnest($2::text[], $3::uuid[]) AS u(source_user_id, tribe_person_id)
        WHERE p.conversation_id = $1
          AND p.source_user_id = u.source_user_id
          AND (p.tribe_person_id IS NULL OR EXISTS (
            SELECT 1 FROM tribe_people tp
            WHERE tp.id = p.tribe_person_id AND tp.deleted = TRUE
          ))
       RETURNING p.source_user_id, p.tribe_person_id, p.updated_at`,
      [
        conversationId,
        cacheUpdates.map((u) => u.sourceUserId),
        cacheUpdates.map((u) => u.personId),
      ],
    );
    const updatedById = new Map(updated.rows.map((row) => [row.source_user_id, row]));
    for (const { sourceUserId } of cacheUpdates) {
      const row = updatedById.get(sourceUserId);
      const participant = loadedById.get(sourceUserId);
      if (row && participant) {
        Object.assign(participant, applyUpdatedCacheRow(participant, row));
      }
    }
  }

  return { participants: loaded, resolvedPersonIds };
}

/**
 * After `tribeIdentities.linkIdentity` MOVES a durable identity from one
 * person to another, null the now-stale `beeper_participants.tribe_person_id`
 * cache on every OTHER row that presents the same identity and still points
 * at the displaced person (#34 review). Without this the displaced person
 * keeps owning those rows: the read path no longer resolves through them
 * (`resolveParticipantPerson` consults `tribe_identities` first), but the
 * column is what a participant listing renders and what the "still empty"
 * gate in `upsertParticipant` reads, so a stale cache would show — and
 * re-assert — the wrong person with no unlink UI to correct it.
 *
 * Candidates are filtered in JS rather than SQL because the stored `handle`
 * is RAW (`+1 (555) 010-0001`, `@Example_Handle`) while the identity is
 * normalized; `classifyNetworkHandle` is the only correct comparator, and the
 * candidate set is just the displaced person's own linked rows.
 */
async function clearDisplacedParticipantCaches(displacedPersonId, scope, client) {
  const { rows } = await client.query(
    `SELECT p.conversation_id, p.source_user_id, p.handle, c.network
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     WHERE p.tribe_person_id = $1 AND p.handle <> ''`,
    [displacedPersonId],
  );
  const stale = rows.filter((row) => {
    const rowScope = identityScopeFor({ handle: row.handle, network: row.network || '' });
    return rowScope
      && rowScope.kind === scope.kind
      && rowScope.network === scope.network
      && rowScope.handle === scope.handle;
  });
  for (const row of stale) {
    // one displaced person's own rows carrying one handle; a handful at most
    await client.query(
      `UPDATE beeper_participants SET tribe_person_id = NULL, updated_at = NOW()
       WHERE conversation_id = $1 AND source_user_id = $2 AND tribe_person_id = $3`,
      [row.conversation_id, row.source_user_id, displacedPersonId],
    );
  }
  return stale.length;
}

/**
 * The `kind='beeper-user'` counterpart of `clearDisplacedParticipantCaches`
 * (#96): after a re-link MOVES a (account, `source_user_id`) claim to another
 * person, null the now-stale cache on every OTHER conversation's row for the
 * SAME Beeper user under the SAME account that still points at the displaced
 * person. Same rationale as the handle version — the read path stops
 * resolving through those rows, but the column is what a participant listing
 * renders and what `upsertParticipant`'s "still empty" gate reads.
 *
 * One statement rather than the handle version's filter-in-JS pass: the match
 * here is an exact column comparison (a `source_user_id` is opaque and stored
 * raw), so no normalizing comparator is needed.
 */
async function clearDisplacedBeeperUserCaches(displacedPersonId, scope, client) {
  const result = await client.query(
    `UPDATE beeper_participants p SET tribe_person_id = NULL, updated_at = NOW()
     FROM beeper_conversations c
     WHERE c.id = p.conversation_id
       AND p.tribe_person_id = $1 AND c.account_id = $2 AND p.source_user_id = $3`,
    [displacedPersonId, scope.network, scope.handle],
  );
  return result.rowCount ?? 0;
}

async function clearIdentityCaches(personId, scope, client) {
  if (scope.kind === BEEPER_USER_KIND) {
    return clearDisplacedBeeperUserCaches(personId, scope, client);
  }
  return clearDisplacedParticipantCaches(personId, scope, client);
}

async function withParticipantLinkTransaction(operation) {
  await ensureReady();
  return withTransaction(async (client) => {
    // A handle can be shared across conversations and accounts. Serialize
    // explicit link edits before locking any rows so they cannot lock each
    // other's cache rows or both report a fresh claim on the same identity.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['portos:beeper-tribe-links']);
    return operation(client);
  });
}

async function lockParticipant(conversationId, sourceUserId, client) {
  const participant = await getParticipant(conversationId, sourceUserId, { client, forUpdate: true });
  if (!participant) throw new ServerError('Participant not found', { status: 404 });
  return participant;
}

/**
 * Explicit link — the inline thread-participant action (#10 decision 4).
 * ALWAYS claims a `kind='beeper-user'` identity on the participant's own
 * (account, `source_user_id`) so the link survives a purge + resweep (#96),
 * and when the participant carries a durable handle ALSO claims that in
 * `tribe_identities` so the next participant (in this or another
 * conversation) presenting the same handle auto-resolves without another
 * manual click. `network` is never accepted as an argument — a `kind='handle'`
 * claim is scoped to the participant's OWN conversation's
 * `beeper_conversations.network`, joined server-side by `getParticipant`,
 * never a caller-supplied value (#34 review — a client-supplied network let a
 * handle be linked under the wrong scope, or with none at all).
 *
 * Refuses to link a soft-deleted `personId` (`tribeIdentities.assertPersonLinkable`)
 * before writing any claims or cache, including participants linked through
 * the cache alone. Returns
 * `{ ...participant, displacedPersonId }`: when the handle was already
 * claimed by a DIFFERENT person, that person's id, so the ownership move
 * (silent at the DB/audit-trigger level — see `tribeIdentities.linkIdentity`)
 * is surfaced to the caller instead.
 *
 * A username-bearing participant whose conversation carries NO network
 * (`beeper_conversations.network` is `NOT NULL DEFAULT ''`) falls through to
 * the cache-only write rather than throwing (#34 review): `linkIdentity`
 * rightly refuses an unscoped `kind='handle'` row, but propagating that 400
 * made such a participant WHOLLY unlinkable, when the no-durable-handle path
 * handles the very same situation fine by writing only the cache. Nothing
 * durable can be recorded, so the cache is the truth here — exactly the role
 * `resolveParticipantPerson` reserves for it.
 */
export async function linkParticipant({
  conversationId, sourceUserId, personId, source = 'user',
}) {
  if (!personId) throw new ServerError('personId is required', { status: 400, code: 'BAD_REQUEST' });
  return withParticipantLinkTransaction(async (client) => {
    await tribeIdentities.assertPersonLinkable(personId, { client });
    const participant = await lockParticipant(conversationId, sourceUserId, client);
    return linkLockedParticipant(client, participant, { personId, source });
  });
}

async function linkLockedParticipant(client, participant, { personId, source }) {
  const { conversationId, sourceUserId } = participant;
  let displacedPersonId = null;
  const scope = identityScopeFor(participant);
  if (scope) {
    const identity = await tribeIdentities.linkIdentity({ personId, ...scope, source }, { client });
    displacedPersonId = identity.displacedPersonId;
    if (displacedPersonId) await clearDisplacedParticipantCaches(displacedPersonId, scope, client);
  }

  // ALWAYS claim the beeper-user identity too (#96) — this is the half that
  // makes a manual link durable for a participant with no classifiable
  // handle, and it costs nothing for one that has both. Idempotent: re-linking
  // the same participant to the same person re-writes the same row and
  // displaces nobody. A handle-claim displacement is reported in preference to
  // this one when the two disagree, because the handle axis is the one a
  // second participant elsewhere can also present.
  const beeperUserScope = beeperUserScopeFor(participant);
  if (beeperUserScope) {
    const identity = await tribeIdentities.linkIdentity({ personId, ...beeperUserScope, source }, { client });
    if (identity.displacedPersonId) {
      await clearDisplacedBeeperUserCaches(identity.displacedPersonId, beeperUserScope, client);
      displacedPersonId = displacedPersonId || identity.displacedPersonId;
    }
  }

  const result = await client.query(
    `UPDATE beeper_participants SET tribe_person_id = $3, updated_at = NOW()
     WHERE conversation_id = $1 AND source_user_id = $2
     RETURNING *`,
    [conversationId, sourceUserId, personId],
  ).catch((err) => {
    if (err?.code === '23503') throw new ServerError('Person not found', { status: 404 });
    throw err;
  });
  if (result.rowCount === 0) throw new ServerError('Participant not found', { status: 404 });
  return { ...rowToParticipant(result.rows[0]), displacedPersonId };
}

/**
 * Release a participant's link to whichever Tribe person currently owns it
 * (#97 part B) — the unlink half `linkParticipant` has never had a
 * counterpart for. Deletes every `tribe_identities` claim THAT PERSON holds
 * for this participant: the handle claim from `identityScopeFor`, when the
 * handle classifies, and the `kind='beeper-user'` claim from
 * `beeperUserScopeFor`, which almost every participant carries regardless of
 * handle. Each DELETE is filtered on `person_id = <that person>`, so a claim
 * someone ELSE now holds on the same handle or beeper-user pair — moved
 * there by a later link elsewhere — is never touched.
 *
 * Nulls the participant's own cache column and, via the same
 * `clearDisplacedParticipantCaches`/`clearDisplacedBeeperUserCaches` helpers
 * a displaced-owner re-link already uses, every OTHER participant row those
 * claims were backing — the unlinked person simply stands in as the
 * "displaced" one here. A trailing explicit UPDATE guarantees THIS row ends
 * up NULL regardless of whether either reuse call happened to cover it (it
 * only fires when its own DELETE actually removed a claim) — a stale cache
 * with no backing identity claim at all must still clear.
 *
 * Idempotent: a participant with no `tribePersonId` is a 200 no-op —
 * `{ participant, unlinkedPersonId: null, removedClaims: 0 }` — rather than
 * an error, matching `linkParticipant`'s own "last explicit action wins"
 * posture. Throws 404 only when the participant row itself does not exist.
 */
export async function unlinkParticipant({ conversationId, sourceUserId }) {
  return withParticipantLinkTransaction(async (client) => {
    const participant = await lockParticipant(conversationId, sourceUserId, client);
    const personId = participant.tribePersonId;
    if (!personId) {
      return { participant, unlinkedPersonId: null, removedClaims: 0 };
    }

    let removedClaims = 0;
    const scope = identityScopeFor(participant);
    const beeperUserScope = beeperUserScopeFor(participant);
    for (const claim of [scope, beeperUserScope]) {
      if (!claim) continue;
      const result = await client.query(
        `DELETE FROM tribe_identities WHERE person_id = $1 AND kind = $2 AND network = $3 AND handle = $4`,
        [personId, claim.kind, claim.network, claim.handle],
      );
      removedClaims += result.rowCount;
      if (result.rowCount > 0) await clearIdentityCaches(personId, claim, client);
    }

    // Clear the locked target even if it had no backing claim.
    const result = await client.query(
      `UPDATE beeper_participants SET tribe_person_id = NULL, updated_at = NOW()
       WHERE conversation_id = $1 AND source_user_id = $2`,
      [conversationId, sourceUserId],
    );
    if (result.rowCount === 0) throw new ServerError('Participant not found', { status: 404 });

    const updated = await getParticipant(conversationId, sourceUserId, { client });
    return { participant: updated, unlinkedPersonId: personId, removedClaims };
  });
}

/**
 * Create a new Tribe person from a participant's own display name and link
 * it as one explicit user action (#10 decision 4).
 *
 * Uses the same link write as `linkParticipant`, so the new person gets the
 * same durable `kind='beeper-user'` claim any hand-link does (#96).
 */
export async function createPersonAndLinkParticipant({
  conversationId, sourceUserId, name, ring = 'tribe', relationship = '', source = 'user',
}) {
  return withParticipantLinkTransaction(async (client) => {
    const participant = await lockParticipant(conversationId, sourceUserId, client);
    const personName = String(name || participant.displayName || '').trim();
    if (!personName) throw new ServerError('name is required', { status: 400, code: 'BAD_REQUEST' });

    const person = await tribe.createPerson({
      name: personName,
      ring,
      relationship,
      // The person form's "Linked on Beeper" block shows the current network.
      notes: 'Imported from Beeper',
      channel: 'Beeper',
    }, { client });
    const { displacedPersonId, ...linked } = await linkLockedParticipant(client, participant, { personId: person.id, source });
    return {
      person, participant: linked, created: true, displacedPersonId,
    };
  });
}

/**
 * Relate a batch of Beeper messages to Tribe by SENDER only — never by
 * iterating `beeper_participants` (which can be a truncated roster). Each
 * candidate is `{ conversationId, senderId, sentAt, network, channel }`.
 * Dedupe key is `beeper:<YYYY-MM-DD>`, matching #10 decision "daily Tribe
 * touchpoints are written; there is no per-message activity event."
 * Accepts an optional sweep-scoped `personIndex` and optional
 * `resolvedPersonIds` (`Map<senderId, personId | null>` from
 * `upsertConversationParticipants`) so callers don't re-query already-resolved
 * senders; standalone calls load a roster index once when needed. Returns
 * `{ created, matched }` (mirrors `tribe.autoLogTouchpoints`'s shape).
 */
export async function logSenderTouchpoints(candidates = [], { personIndex = null, resolvedPersonIds = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { created: 0, matched: 0 };
  await ensureReady();

  // Reuse the sweep snapshot, or load once on the first unresolved sender.
  // Identity resolution still runs against current authoritative records.
  let index = personIndex;

  // Memoize the participant -> person resolution per (conversationId,
  // senderId) within this batch, so a burst of messages from the same sender
  // resolves once, not per message. Completed person/day attempts are also
  // reused within this batch; the database unique index remains authoritative
  // across batches and concurrent syncs.
  const personCache = new Map();
  const completedTouchpoints = new Set();
  let created = 0;
  let matched = 0;
  for (const c of candidates) {
    if (!c?.conversationId || !c?.senderId || !c?.sentAt) continue;
    const cacheKey = `${c.conversationId} ${c.senderId}`;
    if (!personCache.has(cacheKey)) {
      if (resolvedPersonIds?.has(c.senderId)) {
        personCache.set(cacheKey, resolvedPersonIds.get(c.senderId) || null);
      } else {
        index ??= await loadRosterIndex();
        // resolving one sender at a time when not pre-resolved by the batch upserter
        personCache.set(cacheKey, await resolveParticipantPerson(
          { conversationId: c.conversationId, sourceUserId: c.senderId },
          index,
        ));
      }
    }
    const personId = personCache.get(cacheKey);
    if (!personId) continue;
    matched++;
    // Normalize to an ISO date first: String() of a Date object gives its toString() form, whose first 10 characters
    // are not a date and would break the `beeper:<day>` dedupe key. Falls back to the raw slice for an unparseable value.
    const parsedSentAt = new Date(c.sentAt);
    const day = Number.isNaN(parsedSentAt.getTime())
      ? String(c.sentAt).slice(0, 10)
      : parsedSentAt.toISOString().slice(0, 10);
    const dedupeKey = `beeper:${day}`;
    const touchpointKey = JSON.stringify([personId, dedupeKey]);
    if (completedTouchpoints.has(touchpointKey)) continue;
    // same reason as above
    const touchpoint = await tribe.autoCreateTouchpoint(personId, {
      happenedAt: c.sentAt,
      channel: c.channel || (c.network ? `Beeper (${c.network})` : 'Beeper'),
      summary: '',
      source: 'message',
      dedupeKey,
      metadata: { network: c.network || '', conversationId: c.conversationId },
    });
    completedTouchpoints.add(touchpointKey);
    if (touchpoint) created++;
  }
  return { created, matched };
}

/** Shape one `beeper_participants` row (joined to its conversation) into the
 * conversation reference the Tribe person read model exposes per identity
 * (#99): the PortOS conversation id `/messages/beeper/<conversationId>`
 * expects, the conversation's network + title, its account, and this
 * participant's own display name so the client can render "network ·
 * handle-or-display-name" without a second round trip. */
function rowToConversationRef(row) {
  return {
    conversationId: row.conversation_id,
    network: row.network || '',
    title: row.title || '',
    accountId: row.account_id || '',
    displayName: row.display_name || '',
  };
}

/**
 * The Beeper conversations one `tribe_identities` claim appears in (#99).
 *
 * A `kind='beeper-user'` claim joins `beeper_participants` on
 * `source_user_id = handle` through `beeper_conversations` on
 * `account_id = network` — `beeperUserScopeFor`'s own key, the durable pair
 * that survives a purge + resweep, so it finds every conversation for that
 * Beeper user even one synced after the claim was made.
 *
 * A `kind='handle'`/`'phone'` claim instead reads the resolved participant
 * CACHE (`beeper_participants.tribe_person_id = personId`) rather than
 * re-deriving the handle scope per participant row with `identityScopeFor`:
 * the ingestion sweep's `upsertParticipant` already keeps that column in
 * sync with `tribe_identities` for every synced participant, so the cache is
 * already the correct, much simpler answer to "which conversations is this
 * identity seen in" (#99 decision — documented here rather than mirroring
 * `clearDisplacedParticipantCaches`'s per-row reclassification). A `phone`
 * claim is network-less by design, so it reads the cache unscoped by
 * network; a `handle` claim additionally filters to its own network, since
 * the same cached person can hold claims on more than one network.
 *
 * A purged conversation or a participant row nulled by a later re-link
 * simply produces no row here — no special-casing needed.
 */
async function conversationsForIdentity(personId, identity) {
  if (identity.kind === BEEPER_USER_KIND) {
    const { rows } = await query(
      `SELECT p.conversation_id, p.display_name, c.network, c.title, c.account_id
       FROM beeper_participants p
       JOIN beeper_conversations c ON c.id = p.conversation_id
       WHERE c.account_id = $1 AND p.source_user_id = $2
       ORDER BY c.last_activity DESC NULLS LAST`,
      [identity.network, identity.handle],
    );
    return rows.map(rowToConversationRef);
  }

  const params = [personId];
  let networkFilter = '';
  if (identity.kind === 'handle' && identity.network) {
    networkFilter = 'AND c.network = $2';
    params.push(identity.network);
  }
  const { rows } = await query(
    `SELECT p.conversation_id, p.display_name, c.network, c.title, c.account_id
     FROM beeper_participants p
     JOIN beeper_conversations c ON c.id = p.conversation_id
     WHERE p.tribe_person_id = $1 ${networkFilter}
     ORDER BY c.last_activity DESC NULLS LAST`,
    params,
  );
  return rows.map(rowToConversationRef);
}

/**
 * The Tribe person form's "Linked on Beeper" block (#99): every durable
 * identity claim for a person, each carrying the Beeper conversations that
 * identity appears in (see `conversationsForIdentity`). Lives here rather
 * than in `tribe.js` so the generic person read model stays Beeper-agnostic
 * — `tribe.js` is already imported BY this module, so the reverse would be
 * circular — and is called from the route only, on the single-person read.
 * `tribe.listPeople` (the roster) never pays this join's cost; it has no
 * reason to render per-person identity chips.
 *
 * Returns `[]` for a person with no claims.
 */
export async function listPersonIdentitiesWithConversations(personId) {
  await ensureReady();
  const identities = await tribeIdentities.listIdentitiesForPerson(personId);
  if (identities.length === 0) return [];
  const results = [];
  for (const identity of identities) {
    // one person's own identities, a handful at most
    const conversations = await conversationsForIdentity(personId, identity);
    results.push({ ...identity, conversations });
  }
  return results;
}

/**
 * Unlink (delete) one identity claim (#99) — the Tribe person form's
 * per-identity "Unlink" action. Deletes the durable row via
 * `tribeIdentities.unlinkIdentity`, then reuses the SAME displaced-cache
 * clearers a re-link uses (`clearDisplacedParticipantCaches` /
 * `clearDisplacedBeeperUserCaches`) to null `beeper_participants.tribe_person_id`
 * on every participant row that claim was backing — passing the just-deleted
 * claim's OWN `personId` as the "displaced" person, since removing a claim
 * displaces it from everyone who was resolving through it.
 *
 * Returns the deleted identity, or `null` when `id` is unknown (the route
 * turns that into a 404).
 */
export async function unlinkIdentity(id) {
  return withParticipantLinkTransaction(async (client) => {
    const identity = await tribeIdentities.unlinkIdentity(id, { client });
    if (!identity) return null;
    await clearIdentityCaches(identity.personId, identity, client);
    return identity;
  });
}
