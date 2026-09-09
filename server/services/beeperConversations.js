/**
 * Read model + wired rail controls for the Beeper chat surface (#35, design
 * decided on #9; store shape from #7/#27).
 *
 * **The mirror is the read path.** Nothing here calls Beeper to *read*: the
 * surface renders `beeper_conversations` / `beeper_messages` /
 * `beeper_participants`, which the sweep (#32) and the socket relay (#33)
 * keep current. That is what makes "displayed" imply "persisted", keeps the
 * list correct while Beeper Desktop is closed, and keeps the socket frames
 * invalidation-only — a refetch here is a local query, not a fan-out to the
 * upstream API.
 *
 * The two rail controls that are WIRED (#9: `Archive` and `Low priority`,
 * because `isArchived` and `isLowPriority` are real fields on every chat row)
 * are the one exception: they PATCH Beeper first and mirror the result second,
 * because Beeper owns that state. `isPinned` is deliberately NOT here — the
 * pinned set is Beeper's own, mirrored (#27), and a PortOS-local pin would be
 * a second source of truth for it.
 *
 * Writes NEVER retry. `beeperRequest`'s `allowRetry` already defaults to false
 * for exactly this reason, and the route surfaces `retryable: false` so a
 * client cannot invent a retry policy on top of an API with no idempotency key.
 */

import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { resolveLinkedPersonId } from '../lib/tribeMatch.js';
import { updateChat } from './beeperClient.js';
import {
  getConversationAttachmentBytes,
  purgeConversationAttachments,
  shapeAttachment,
} from './beeperAttachments.js';

// The list endpoint returns a PARTICIPANT SUBSET, never a roster. Beeper's own
// participant lists truncate at 20 (list) / 100 (single GET) with no
// participants endpoint and no cursor (#2), so a row set is always a possible
// subset — `beeper_participants.observed_via` records which. Capping here is
// therefore honest rather than lossy: the number is a row-budget for the list
// payload, and `hasMoreParticipants` says the cell is not the whole story.
const LIST_PARTICIPANT_CAP = 8;

const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 200;
const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 200;

// ---------------------------------------------------------------------------
// Cursors
// ---------------------------------------------------------------------------

/**
 * Keyset cursors, not offsets. An offset re-reads a window that shifted under
 * an incoming message and silently drops or repeats a row; the surface refetches
 * on every invalidation frame, so that shift is the normal case rather than a
 * rare one. The cursor carries the exact ordering tuple `(orderingTs, id)` the
 * ORDER BY uses, base64url-encoded so it is opaque to the client.
 */
export function encodeCursor(orderingTs, id) {
  if (!orderingTs || !id) return null;
  return Buffer.from(`${new Date(orderingTs).toISOString()}|${id}`, 'utf8').toString('base64url');
}

// `listConversations` binds the decoded id as `::uuid` (conversation ids are
// real Postgres uuids); `listMessages` binds it as `::text` (Beeper message
// ids are arbitrary bridge-assigned strings, never uuids). A hand-edited or
// truncated cursor whose `id` half is not a uuid used to sail through here and
// 500 on the Postgres cast instead of falling back to the first page, which
// contradicts this function's own contract of returning `null` for anything
// malformed. Callers that bind the id as `::uuid` pass `idPattern` so the
// SHAPE check happens here, once, rather than after a failed query.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `null` for anything unparseable — a stale or hand-edited cursor restarts the
 * page rather than 500ing, which is the same posture the rest of the surface
 * takes toward a deleted conversation id.
 *
 * @param {string} cursor
 * @param {{ idPattern?: RegExp }} [options] - When given, `id` must match it or
 *   the cursor is treated as malformed (see `UUID_PATTERN` above).
 */
export function decodeCursor(cursor, { idPattern } = {}) {
  if (typeof cursor !== 'string' || !cursor) return null;
  const raw = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = raw.indexOf('|');
  if (separator <= 0) return null;
  const ts = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!id || Number.isNaN(new Date(ts).getTime())) return null;
  if (idPattern && !idPattern.test(id)) return null;
  return { ts: new Date(ts).toISOString(), id };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

const toIso = (value) => (value ? new Date(value).toISOString() : null);

// LOCAL "seen in PortOS" watermark (#83). `row.seen_at` is stamped by
// `markConversationSeen` when a thread is opened here, and NEVER by the sweep
// (`beeperSync.js`'s `upsertConversation` writes every other column on this
// row from Beeper's own `Chat`, but not this one). A watermark at or after the
// conversation's own last activity means nothing has landed since the user
// last opened it, even though Beeper's mirrored `unread_count` — overwritten
// wholesale on every sweep — still says otherwise; new activity after the
// watermark reads as unread again with no extra bookkeeping. `created_at` is
// the fallback activity floor for a conversation the mirror has never dated.
function isSeenLocally(row) {
  if (!row.seen_at) return false;
  const activity = row.last_activity || row.created_at;
  if (!activity) return false;
  return new Date(row.seen_at).getTime() >= new Date(activity).getTime();
}

// The SQL twin of `isSeenLocally`, for the two queries that decide "is this
// genuinely unread" inside the database rather than after shaping a row in
// JS (`listConversations`'s `unreadOnly` filter and `listNetworks`'s
// aggregates, neither of which materializes a full `beeper_conversations`
// row per conversation). Kept as one string so the two call sites cannot
// drift onto different comparisons.
const UNSEEN_SQL = '(c.seen_at IS NULL OR c.seen_at < COALESCE(c.last_activity, c.created_at))';

function shapeConversation(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    network: row.network || '',
    sourceChatId: row.source_chat_id,
    title: row.title || '',
    type: row.type || 'single',
    isGroup: row.is_group === true,
    isPinned: row.is_pinned === true,
    isArchived: row.is_archived === true,
    isLowPriority: row.is_low_priority === true,
    isMuted: row.is_muted === true,
    lastActivity: toIso(row.last_activity),
    unreadCount: isSeenLocally(row) ? 0 : (Number(row.unread_count) || 0),
    // `null` = this conversation has no mirrored message yet, which is
    // frequently CORRECT rather than pending: history depth varies enormously
    // per network (#3), so the surface says so instead of spinning.
    lastMessage: row.preview_id
      ? {
        id: row.preview_id,
        body: row.preview_unsent_at ? '' : (row.preview_body || ''),
        senderId: row.preview_sender_id || '',
        sentAt: toIso(row.preview_sent_at),
        isUnsent: Boolean(row.preview_unsent_at),
        isSender: row.preview_is_sender === true,
      }
      : null,
    participants: [],
    hasMoreParticipants: false,
  };
}

function shapeParticipant(row) {
  // `resolveLinkedPersonId` (`lib/tribeMatch.js`) is the SAME soft-delete
  // predicate `beeperTribe.js`'s own participant shaper applies to this same
  // column — extracted so the two cannot drift onto different answers again.
  // A soft-deleted Tribe person (`tribe.deletePerson` never fires the FK's ON
  // DELETE CASCADE) must read as fully unlinked here: `null` id AND no name,
  // so the thread's re-link control comes back instead of a dead
  // "Linked · <deleted person>" the user can never recover from.
  const tribePersonId = resolveLinkedPersonId(row.tribe_person_id, row.tribe_person_deleted);
  return {
    conversationId: row.conversation_id,
    sourceUserId: row.source_user_id,
    displayName: row.display_name || '',
    handle: row.handle || '',
    // The cache column from #27/#34. `null` means "not linked", never "no
    // person exists" — the inline link action on the thread is what resolves it.
    tribePersonId,
    tribePersonName: tribePersonId ? (row.tribe_person_name || null) : null,
    observedVia: row.observed_via || '',
  };
}

function shapeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id || '',
    // A tombstoned message keeps its row AND its body in the store (#7/#13);
    // the surface renders the placeholder instead, so the body is withheld
    // here rather than shipped to a client that must not display it.
    body: row.unsent_at ? '' : (row.body || ''),
    sentAt: toIso(row.sent_at),
    editedAt: toIso(row.edited_at),
    unsentAt: toIso(row.unsent_at),
    // Which side of the thread this belongs on, mirrored from the API's own
    // `Message.isSender` (#27's `is_sender`). Derived server-side and never
    // guessed from `senderId`: `accounts[].user.id` differs from `senderID` on
    // every network, so the client has nothing to compare against.
    isSender: row.is_sender === true,
    attachments: [],
  };
}

// Attachment rows are shaped by the mirror service that owns their lifecycle
// (`beeperAttachments.shapeAttachment`), not by a second copy here: the thread
// renders `stored` / `overCap` / `unavailable` / `keep` off the same payload
// the attachment routes return, and two shapers would drift the moment one
// gained a field.

const clampLimit = (value, fallback, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Attach the participant subset to a page of conversations in ONE extra query
 * rather than one per row. Ordering puts linked people first so the capped
 * subset shows the rows a Tribe link already resolved.
 */
async function attachParticipants(conversations, { cap = LIST_PARTICIPANT_CAP } = {}) {
  if (conversations.length === 0) return conversations;
  const ids = conversations.map((c) => c.id);
  const result = await query(
    `SELECT p.conversation_id, p.source_user_id, p.display_name, p.handle,
            p.tribe_person_id, p.observed_via, tp.name AS tribe_person_name,
            tp.deleted AS tribe_person_deleted
       FROM beeper_participants p
       LEFT JOIN tribe_people tp ON tp.id = p.tribe_person_id
      WHERE p.conversation_id = ANY($1::uuid[])
      ORDER BY p.conversation_id,
               (p.tribe_person_id IS NULL),
               p.display_name,
               p.source_user_id`,
    [ids],
  );
  const byConversation = new Map(ids.map((id) => [id, []]));
  for (const row of result?.rows || []) {
    byConversation.get(row.conversation_id)?.push(shapeParticipant(row));
  }
  return conversations.map((conversation) => {
    const all = byConversation.get(conversation.id) || [];
    return {
      ...conversation,
      participants: cap === null ? all : all.slice(0, cap),
      hasMoreParticipants: cap !== null && all.length > cap,
    };
  });
}

/**
 * One page of the conversation list, newest activity first.
 *
 * Every filter is TRI-STATE by omission: an absent `archived` means "do not
 * filter on archived at all", which is a different query from `archived:false`.
 * The rail's Inbox scope asks for `archived:false, lowPriority:false`; the
 * Archive and Low-priority scopes ask for the positive. Collapsing absent into
 * false would make the unified scope silently hide archived chats with no way
 * to ask for them (root AGENTS.md, absent-vs-empty).
 *
 * The page is fetched FIRST — filtered, ordered, and limited on
 * `idx_beeper_conversations_activity_epoch_keyset` alone — and the "last message"
 * preview is a SECOND query scoped to just that page's ids. Folding the
 * preview LATERAL into the same WHERE/ORDER BY/LIMIT query (the old shape) let
 * the planner evaluate it once per FILTERED conversation rather than once per
 * PAGE row; splitting the preview into its own query, batched over the page's
 * ids the way `attachParticipants` already batches participants, makes
 * "page-sized" a property of the SQL shape rather than a plan the optimizer
 * happens to choose (audit cluster 06, indexes and query plans).
 */
export async function listConversations({
  network, unreadOnly, archived, lowPriority, limit, cursor,
} = {}) {
  const pageSize = clampLimit(limit, DEFAULT_CONVERSATION_LIMIT, MAX_CONVERSATION_LIMIT);
  const params = [];
  const where = [];

  if (typeof network === 'string' && network) {
    params.push(network);
    where.push(`c.network = $${params.length}`);
  }
  // The LOCAL watermark (#83) gates `unreadOnly` the same way it gates the
  // badge: a conversation Beeper still reports as unread but that carries a
  // `seen_at` at or after its own last activity is not shown, because nothing
  // has landed here since it was opened in PortOS.
  if (unreadOnly === true) where.push(`c.unread_count > 0 AND ${UNSEEN_SQL}`);
  if (typeof archived === 'boolean') {
    params.push(archived);
    where.push(`c.is_archived = $${params.length}`);
  }
  if (typeof lowPriority === 'boolean') {
    params.push(lowPriority);
    where.push(`c.is_low_priority = $${params.length}`);
  }

  const decoded = decodeCursor(cursor, { idPattern: UUID_PATTERN });
  if (decoded) {
    params.push(decoded.ts, decoded.id);
    where.push(`(COALESCE(c.last_activity, 'epoch'::timestamptz), c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(pageSize + 1);
  const pageResult = await query(
    // #81: falling back to `c.created_at` here sorted a chat with no real
    // Beeper activity by the MIRROR ROW's mint time, not by "this chat has no
    // activity" — a batch of chats swept (and left activity-less) in the same
    // pass shared a recent `created_at` and sorted at the TOP of the Inbox,
    // exactly the reported symptom. `'epoch'::timestamptz` sorts every
    // activity-less chat LAST instead: older than any real timestamp, so it
    // ranks last under `DESC`, while keeping the row-value keyset tuple shape
    // a real `NULLS LAST` cannot (the keyset predicate above needs a value to
    // compare against, not a null). Matches
    // `idx_beeper_conversations_activity_epoch_keyset`.
    `SELECT c.*, COALESCE(c.last_activity, 'epoch'::timestamptz) AS ordering_ts
       FROM beeper_conversations c
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(c.last_activity, 'epoch'::timestamptz) DESC, c.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const rows = pageResult?.rows || [];
  const page = rows.slice(0, pageSize);
  const last = page[page.length - 1];
  // `null`, not an empty string: "there is no next page" is a different
  // answer from "here is a cursor that returns nothing".
  const nextCursor = rows.length > pageSize && last ? encodeCursor(last.ordering_ts, last.id) : null;

  if (page.length === 0) {
    return { conversations: [], nextCursor };
  }

  // Batched over the PAGE's ids, never the filtered set — this is what keeps
  // the preview lookup bounded to `pageSize` rows no matter how many
  // conversations the filters above matched.
  const previewResult = await query(
    `SELECT ids.conversation_id, lm.id AS preview_id, lm.body AS preview_body,
            lm.sender_id AS preview_sender_id, lm.sent_at AS preview_sent_at,
            lm.unsent_at AS preview_unsent_at, lm.is_sender AS preview_is_sender
       FROM unnest($1::uuid[]) AS ids(conversation_id)
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.sender_id, m.sent_at, m.unsent_at, m.is_sender
           FROM beeper_messages m
          WHERE m.conversation_id = ids.conversation_id
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
          LIMIT 1
       ) lm ON TRUE`,
    [page.map((row) => row.id)],
  );
  const previewByConversation = new Map(
    (previewResult?.rows || []).map((row) => [row.conversation_id, row]),
  );

  const conversations = await attachParticipants(
    page.map((row) => shapeConversation({ ...row, ...(previewByConversation.get(row.id) || {}) })),
  );
  return { conversations, nextCursor };
}

/** One conversation, with its FULL mirrored participant set (no list cap). */
export async function getConversation(conversationId) {
  const result = await query(
    `SELECT c.*,
            lm.id AS preview_id, lm.body AS preview_body, lm.sender_id AS preview_sender_id,
            lm.sent_at AS preview_sent_at, lm.unsent_at AS preview_unsent_at,
            lm.is_sender AS preview_is_sender
       FROM beeper_conversations c
       LEFT JOIN LATERAL (
         SELECT m.id, m.body, m.sender_id, m.sent_at, m.unsent_at, m.is_sender
           FROM beeper_messages m
          WHERE m.conversation_id = c.id
          ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
          LIMIT 1
       ) lm ON TRUE
      WHERE c.id = $1`,
    [conversationId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  const [conversation] = await attachParticipants([shapeConversation(row)], { cap: null });
  // The mirrored byte total rides on the SINGLE-conversation read only. It is
  // what the purge confirmation names ("… and 41.2 MB of mirrored
  // attachments"), and a typed confirmation that cannot state the cost is not
  // a confirmation; the list endpoint does not pay for it per row.
  const bytes = await getConversationAttachmentBytes(conversation.id);
  return { ...conversation, attachmentBytes: bytes.bytes, attachmentFiles: bytes.files };
}

/**
 * One page of a thread, NEWEST FIRST — the order a chat surface actually
 * consumes, because it renders the tail and pages backwards into history. The
 * client reverses for display; the API does not pretend the oldest message is
 * reachable in one call, because on several networks it is not.
 */
export async function listMessages(conversationId, { limit, cursor } = {}) {
  const pageSize = clampLimit(limit, DEFAULT_MESSAGE_LIMIT, MAX_MESSAGE_LIMIT);
  const params = [conversationId];
  let keyset = '';
  const decoded = decodeCursor(cursor);
  if (decoded) {
    params.push(decoded.ts, decoded.id);
    keyset = ` AND (COALESCE(m.sent_at, m.created_at), m.id) < ($2::timestamptz, $3::text)`;
  }
  params.push(pageSize + 1);

  const result = await query(
    `SELECT m.*, COALESCE(m.sent_at, m.created_at) AS ordering_ts
       FROM beeper_messages m
      WHERE m.conversation_id = $1${keyset}
      ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result?.rows || [];
  const page = rows.slice(0, pageSize);
  const messages = page.map(shapeMessage);

  if (messages.length > 0) {
    const attachments = await query(
      `SELECT *
         FROM beeper_attachments
        WHERE conversation_id = $1 AND message_id = ANY($2::text[])
        ORDER BY message_id, idx`,
      [conversationId, messages.map((m) => m.id)],
    );
    const byMessage = new Map(messages.map((m) => [m.id, m]));
    for (const row of attachments?.rows || []) {
      byMessage.get(row.message_id)?.attachments.push(shapeAttachment(row));
    }
  }

  const last = page[page.length - 1];
  return {
    messages,
    nextCursor: rows.length > pageSize && last ? encodeCursor(last.ordering_ts, last.id) : null,
  };
}

/**
 * The rail's scope list: the networks actually present in the mirror, never a
 * hardcoded roster. #9 is explicit that the development machine's nine
 * networks are an outlier (today's free tier caps a new account at five, most
 * installs have one), so anything that enumerates networks reads them from
 * data — a network PortOS has never heard of still renders.
 *
 * Unread is aggregated over NON-ARCHIVED rows only: the rail badge answers
 * "how much is waiting in my inbox", and an archived chat is by definition not.
 *
 * Both aggregates also honour the LOCAL "seen in PortOS" watermark (#83) via
 * `UNSEEN_SQL`: a conversation the user has opened here, with nothing new
 * since, contributes 0 to `unread_count` and does not count toward
 * `unread_conversations`, even though Beeper's own mirrored `unread_count`
 * still says otherwise.
 */
export async function listNetworks() {
  const result = await query(
    // #81: `COALESCE(…, c.created_at)` reported a network holding only
    // activity-less chats as "active just now" (the mirror row's mint time),
    // not honestly having none. This is a plain MAX, not the page/keyset walk
    // above — MAX ignores NULLs and itself yields NULL when every row in the
    // group is NULL, which is already the honest value, so no sentinel is
    // needed (unlike the row-value keyset tuple in listConversations, this
    // aggregate never has to compare against a null).
    `SELECT c.network,
            COUNT(*)::int AS conversation_count,
            COALESCE(SUM(c.unread_count) FILTER (WHERE c.is_archived = FALSE AND ${UNSEEN_SQL}), 0)::int AS unread_count,
            COUNT(*) FILTER (WHERE c.unread_count > 0 AND c.is_archived = FALSE AND ${UNSEEN_SQL})::int AS unread_conversations,
            ARRAY_AGG(DISTINCT c.account_id) AS account_ids,
            MAX(c.last_activity) AS last_activity
       FROM beeper_conversations c
      WHERE c.network <> ''
      GROUP BY c.network
      ORDER BY c.network`,
  );
  return (result?.rows || []).map((row) => ({
    network: row.network,
    conversationCount: Number(row.conversation_count) || 0,
    unreadCount: Number(row.unread_count) || 0,
    unreadConversations: Number(row.unread_conversations) || 0,
    accountIds: Array.isArray(row.account_ids) ? row.account_ids.filter(Boolean) : [],
    lastActivity: toIso(row.last_activity),
  }));
}

// ---------------------------------------------------------------------------
// Local "seen" watermark (#83) — NOT a Beeper write
// ---------------------------------------------------------------------------

/**
 * Stamp the LOCAL "seen in PortOS" watermark on one conversation. Called when
 * the chat surface opens a thread (`BeeperChatSurface.jsx`'s `loadThread`) and,
 * cheaply, again when a new message lands in the open thread.
 *
 * This is the opposite shape from `setConversationFlag` below: it NEVER calls
 * Beeper. The reading model this decision shipped has no side effects on the
 * source network — no read receipt, no `PATCH`, nothing that could surprise
 * someone checking Beeper Desktop on another device. `seen_at` is set to
 * `NOW()` unconditionally rather than `GREATEST(seen_at, NOW())`: wall-clock
 * time only moves forward across calls to the same row, so the two are
 * equivalent here and the plain assignment says that more plainly.
 *
 * TODO(#83): a settings toggle to also send a real read receipt through
 * Beeper's own API is the natural next wave — it would PATCH-then-mirror the
 * same way `setConversationFlag` does, gated behind that toggle and its own
 * consent step, and default OFF. Out of scope for this change.
 */
export async function markConversationSeen(conversationId) {
  const found = await query(
    'SELECT id FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  if (!found?.rows?.[0]) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  await query(
    'UPDATE beeper_conversations SET seen_at = NOW(), updated_at = NOW() WHERE id = $1',
    [conversationId],
  );
  return getConversation(conversationId);
}

// ---------------------------------------------------------------------------
// Wired rail controls (#9: Archive and Low priority)
// ---------------------------------------------------------------------------

/**
 * The one write shape this slice has. Beeper owns the flag, so the order is
 * PATCH-then-mirror: a mirror row updated before the upstream call would show a
 * state the network never accepted, and the next sweep would silently revert it.
 *
 * The PATCH does not retry (`beeperRequest`'s default), and a failure
 * propagates as a coded `BeeperApiError` with the mirror untouched.
 *
 * The response is Beeper's updated `Chat`. It is read DEFENSIVELY: a bridge
 * that answers 200 with a body missing the flag must not blank the mirror, so
 * the requested value is the fallback — present-but-false is honoured, absent
 * is not.
 */
async function setConversationFlag(conversationId, field, column, value) {
  const found = await query(
    'SELECT id, source_chat_id FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  const row = found?.rows?.[0];
  if (!row) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const chat = await updateChat(row.source_chat_id, { [field]: value });
  const applied = typeof chat?.[field] === 'boolean' ? chat[field] : value;

  await query(
    `UPDATE beeper_conversations SET ${column} = $2, updated_at = NOW() WHERE id = $1`,
    [conversationId, applied],
  );
  console.log(`🫧 Beeper ${field}=${applied} on conversation ${conversationId}`);
  return getConversation(conversationId);
}

// ---------------------------------------------------------------------------
// Purge (#37) — the ONE destructive path over the mirror
// ---------------------------------------------------------------------------

/**
 * Delete one conversation's mirror: its messages, participants, attachment
 * rows AND the mirrored bytes those rows were holding.
 *
 * This is a PortOS-local purge and nothing else. It never touches Beeper: the
 * conversation stays exactly where it is on the source network, and the next
 * sweep will mirror it again unless the user also removes it there. That is
 * deliberate — "reclaim the disk this chat is using" and "delete this chat"
 * are different intentions, and only the first one is undoable.
 *
 * Order matters. `purgeConversationAttachments` runs FIRST, while the rows it
 * reference-checks against still exist: the store is content-addressed, so a
 * photo forwarded into three other chats must survive this one being purged.
 * The conversation row goes last and the FK cascade takes messages,
 * participants and attachment rows with it.
 */
export async function purgeConversation(conversationId) {
  const found = await query(
    'SELECT id, title, account_id, source_chat_id FROM beeper_conversations WHERE id = $1',
    [conversationId],
  );
  const row = found?.rows?.[0];
  if (!row) throw new ServerError('Conversation not found', { status: 404, code: 'NOT_FOUND' });

  const bytes = await purgeConversationAttachments(conversationId);
  const messages = await query(
    'SELECT COUNT(*)::int AS count FROM beeper_messages WHERE conversation_id = $1',
    [conversationId],
  );
  // The conversation row and its SYNC CURSOR go together, in one transaction.
  //
  // `beeper_sync_cursors` is keyed on Beeper's own `(account_id, chat_id)` and
  // carries an FK onto `beeper_accounts` alone, so the conversation's cascade
  // cannot reach it. Left behind, its `last_activity` watermark still says this
  // chat has not moved: `chatNeedsSweep` skips it, and once it does move,
  // `fetchNewMessages` walks forward from the surviving cursor and mirrors only
  // what arrives next. The purged history would never come back — the opposite
  // of what the typed confirmation promises the user before they confirm an
  // irreversible delete. Deleting the cursor is also the only thing that ever
  // removes one, so it stops orphan cursor rows accumulating.
  await withTransaction(async (client) => {
    await client.query('DELETE FROM beeper_conversations WHERE id = $1', [conversationId]);
    await client.query(
      'DELETE FROM beeper_sync_cursors WHERE account_id = $1 AND chat_id = $2',
      [row.account_id, row.source_chat_id],
    );
  });
  console.log(`🫧 Beeper conversation mirror purged: ${conversationId} (${bytes.removedFiles} file(s), ${bytes.freedBytes} bytes, ${bytes.failedUnlinks} unlink failure(s))`);
  return {
    purged: true,
    conversationId,
    messagesRemoved: Number(messages?.rows?.[0]?.count) || 0,
    filesRemoved: bytes.removedFiles,
    bytesFreed: bytes.freedBytes,
  };
}

export const setConversationArchived = (conversationId, archived) =>
  setConversationFlag(conversationId, 'isArchived', 'is_archived', archived === true);

export const setConversationLowPriority = (conversationId, lowPriority) =>
  setConversationFlag(conversationId, 'isLowPriority', 'is_low_priority', lowPriority === true);
