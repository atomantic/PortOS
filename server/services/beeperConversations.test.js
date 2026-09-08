/**
 * Boundary tests for the Beeper chat-surface read model and the two wired rail
 * controls (#35). Postgres is mocked at `query()` and inspected as SQL text +
 * bind parameters, because the behaviour under test IS the query shape: which
 * filter reaches the WHERE clause, whether a keyset cursor is applied, and
 * whether the PATCH to Beeper happens before the mirror is touched.
 *
 * Every fixture value is invented (placeholder ids, `Example` names) per root
 * AGENTS.md Sensitive Data & Privacy — no value here came from a running
 * instance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// `withTransaction` hands its callback a pg client; the fake records the
// statements the purge issues inside the transaction, which is exactly what the
// cursor-deletion contract below is about. `ensureSchema` is only needed below
// for the cross-module parity test, which imports the REAL `beeperTribe.js` to
// prove its shaper agrees with this file's own — `beeperTribe.js`'s
// `getParticipant` calls it before every query.
vi.mock('../lib/db.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  ensureSchema: vi.fn(async () => {}),
}));
vi.mock('./beeperClient.js', () => ({ updateChat: vi.fn() }));
// `beeperTribe.js` imports `./tribe.js` at the top level for its own
// touchpoint/roster logic, unrelated to the parity test below — stubbed so
// importing it here doesn't drag in tribe.js's own real (and much heavier)
// dependency chain.
vi.mock('./tribe.js', () => ({ listPeople: vi.fn(async () => []) }));

import { query, withTransaction } from '../lib/db.js';
import { updateChat } from './beeperClient.js';
import * as beeperTribe from './beeperTribe.js';
import {
  listConversations,
  getConversation,
  listMessages,
  listNetworks,
  markConversationSeen,
  purgeConversation,
  setConversationArchived,
  setConversationLowPriority,
  encodeCursor,
  decodeCursor,
} from './beeperConversations.js';

const CONV_A = '11111111-1111-4111-8111-111111111111';
const CONV_B = '22222222-2222-4222-8222-222222222222';

const conversationRow = (overrides = {}) => ({
  id: CONV_A,
  account_id: 'acct-example-1',
  network: 'examplenet',
  source_chat_id: 'chat-example-1',
  title: 'Example Conversation',
  type: 'single',
  is_group: false,
  is_pinned: false,
  is_archived: false,
  is_low_priority: false,
  is_muted: false,
  last_activity: '2026-09-01T10:00:00.000Z',
  created_at: '2026-08-01T10:00:00.000Z',
  unread_count: 2,
  // LOCAL "seen in PortOS" watermark (#83) — `null` by default (never opened
  // in PortOS), so the default fixture reads as unread exactly like it did
  // before the column existed.
  seen_at: null,
  ordering_ts: '2026-09-01T10:00:00.000Z',
  preview_id: null,
  ...overrides,
});

const flat = (sql) => sql.replace(/\s+/g, ' ').trim();
const callFor = (fragment) => vi.mocked(query).mock.calls.find(([sql]) => flat(sql).includes(fragment));

beforeEach(() => vi.clearAllMocks());

describe('listConversations — filters are tri-state by omission', () => {
  it('applies no archived/low-priority predicate when the caller omits them', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({});
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).not.toContain('is_archived =');
    expect(flat(sql)).not.toContain('is_low_priority =');
    // The only bind is the page-size probe (limit + 1).
    expect(params).toEqual([51]);
  });

  it('applies `archived: false` as a real predicate, not as "no filter"', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ archived: false, lowPriority: false });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('c.is_archived = $1');
    expect(flat(sql)).toContain('c.is_low_priority = $2');
    expect(params).toEqual([false, false, 51]);
  });

  it('scopes to one network and to unread rows, honouring the local seen watermark (#83)', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ network: 'examplenet', unreadOnly: true });
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('c.network = $1');
    // A conversation Beeper still reports unread does not count as
    // `unreadOnly` once its local `seen_at` catches up to its own activity.
    expect(flat(sql)).toContain(
      'c.unread_count > 0 AND (c.seen_at IS NULL OR c.seen_at < COALESCE(c.last_activity, c.created_at))',
    );
    expect(params).toEqual(['examplenet', 51]);
  });
});

describe('listConversations — keyset pagination', () => {
  it('returns a nextCursor only when a further page exists, and resumes from it', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => conversationRow({
      id: `3333333${i}-3333-4333-8333-333333333333`,
      last_activity: `2026-09-0${i + 1}T10:00:00.000Z`,
      ordering_ts: `2026-09-0${i + 1}T10:00:00.000Z`,
    }));
    // Page query, then the batched preview query, then attachParticipants —
    // three calls per listConversations() invocation since the preview LATERAL
    // was split out of the page query (audit cluster 06).
    vi.mocked(query)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const page = await listConversations({ limit: 2 });
    expect(page.conversations).toHaveLength(2);
    expect(page.nextCursor).toBe(encodeCursor(rows[1].ordering_ts, rows[1].id));

    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ limit: 2, cursor: page.nextCursor });
    const [sql, params] = vi.mocked(query).mock.calls[3];
    // #81: the epoch sentinel, not `c.created_at` — see the dedicated
    // ordering describe block below for why.
    expect(flat(sql)).toContain("(COALESCE(c.last_activity, 'epoch'::timestamptz), c.id) <");
    expect(params[0]).toBe(rows[1].ordering_ts);
    expect(params[1]).toBe(rows[1].id);
  });

  it('has no next page when the result is short', async () => {
    // Page query, then the batched preview query, then attachParticipants.
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const page = await listConversations({ limit: 2 });
    expect(page.nextCursor).toBeNull();
  });

  it('restarts the page on an unparseable cursor instead of throwing', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ cursor: 'not-a-cursor' });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).not.toContain('c.id) <');
    expect(decodeCursor('not-a-cursor')).toBeNull();
  });

  // A hand-edited (or truncated) cursor can decode cleanly — valid base64url,
  // a real timestamp, a non-empty id half — while that id half is not a uuid.
  // `c.id` is bound as `::uuid`, so this used to reach Postgres and 500 on the
  // cast, contradicting decodeCursor's own contract of returning null for
  // anything malformed. This is a shape a hand rolled cursor can produce even
  // though `encodeCursor` itself never emits one — no PortOS conversation id
  // is ever a non-uuid string.
  it('restarts the page rather than 500ing on a well-formed cursor whose id is not a uuid', async () => {
    const garbled = encodeCursor('2026-09-01T10:00:00.000Z', 'not-a-uuid');
    vi.mocked(query).mockResolvedValue({ rows: [] });

    await expect(listConversations({ cursor: garbled })).resolves.toMatchObject({ conversations: [] });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).not.toContain('c.id) <');
    // decodeCursor is the shape-check boundary: with the uuid pattern the
    // conversation route applies, this decodes to null just like a garbled one.
    expect(decodeCursor(garbled, { idPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i })).toBeNull();
    // Without a pattern (the shape `listMessages` uses — Beeper message ids are
    // arbitrary bridge strings, never uuids) the same cursor still decodes.
    expect(decodeCursor(garbled)).toEqual({ ts: '2026-09-01T10:00:00.000Z', id: 'not-a-uuid' });
  });
});

// #81: `COALESCE(c.last_activity, c.created_at)` fell back to the mirror
// row's mint time for a chat with no real Beeper activity, not to "this chat
// has no activity" — so a batch of chats swept (and left activity-less) in
// the same pass shared a recent `created_at` and sorted at the TOP of the
// Inbox, above populated threads with older real activity. This is what the
// read-only live-instance investigation on fork issue #81 (counts only)
// found driving the reported symptom for the observed population — the
// retry fix does not touch chats Beeper itself never reports activity for.
describe('listConversations — activity-less chats sort last, not by mint time', () => {
  it('sorts on the epoch sentinel, never on created_at, in the page query and ORDER BY', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({});
    const [sql] = vi.mocked(query).mock.calls[0];
    const flatSql = flat(sql);
    expect(flatSql).toContain("COALESCE(c.last_activity, 'epoch'::timestamptz) AS ordering_ts");
    expect(flatSql).toContain("ORDER BY COALESCE(c.last_activity, 'epoch'::timestamptz) DESC, c.id DESC");
    expect(flatSql).not.toContain('c.created_at');
  });

  it('sorts on the same epoch sentinel in the keyset predicate', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listConversations({ cursor: encodeCursor('2026-09-01T10:00:00.000Z', CONV_A) });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain("(COALESCE(c.last_activity, 'epoch'::timestamptz), c.id) <");
  });
});

describe('listConversations — row shaping', () => {
  it('caps the participant subset and says so, because a Beeper roster is always a possible subset', async () => {
    const participants = Array.from({ length: 10 }, (_, i) => ({
      conversation_id: CONV_A,
      source_user_id: `user-${i}`,
      display_name: `Example Person ${i}`,
      handle: `+15550100${i}`,
      tribe_person_id: null,
      observed_via: 'participant-list',
      tribe_person_name: null,
    }));
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] }) // page
      .mockResolvedValueOnce({ rows: [] }) // preview
      .mockResolvedValueOnce({ rows: participants }); // participants

    const { conversations } = await listConversations({});
    expect(conversations[0].participants).toHaveLength(8);
    expect(conversations[0].hasMoreParticipants).toBe(true);
    expect(conversations[0].participants[0]).toMatchObject({ tribePersonId: null, observedVia: 'participant-list' });
  });

  it('withholds the body of a tombstoned preview while keeping the row', async () => {
    // The preview now comes back from a SEPARATE, page-scoped query — keyed
    // on `conversation_id`, matched to the page row by id (audit cluster 06).
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] }) // page
      .mockResolvedValueOnce({
        rows: [{
          conversation_id: CONV_A,
          preview_id: 'msg-example-1',
          preview_body: 'placeholder body that must not ship',
          preview_sender_id: 'user-1',
          preview_sent_at: '2026-09-01T09:59:00.000Z',
          preview_unsent_at: '2026-09-01T10:00:00.000Z',
        }],
      }) // preview
      .mockResolvedValueOnce({ rows: [] }); // participants

    const { conversations } = await listConversations({});
    expect(conversations[0].lastMessage).toMatchObject({ id: 'msg-example-1', body: '', isUnsent: true });
  });

  it('carries the preview\'s direction, so the row can show its leading state chip', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] }) // page
      .mockResolvedValueOnce({
        rows: [{
          conversation_id: CONV_A,
          preview_id: 'msg-example-1',
          preview_body: 'placeholder body',
          preview_sender_id: 'user-me',
          preview_sent_at: '2026-09-01T09:59:00.000Z',
          preview_is_sender: true,
        }],
      }) // preview
      .mockResolvedValueOnce({ rows: [] }); // participants
    const { conversations } = await listConversations({});
    expect(conversations[0].lastMessage.isSender).toBe(true);
  });

  it('reports a conversation with no mirrored message as lastMessage: null, not as an empty string', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] }) // page
      .mockResolvedValueOnce({ rows: [] }) // preview
      .mockResolvedValueOnce({ rows: [] }); // participants
    const { conversations } = await listConversations({});
    expect(conversations[0].lastMessage).toBeNull();
  });

  // #81: the client's row preview falls back to "Syncing…" for a recent
  // `lastActivity` with no mirrored message, and to the honest "No messages
  // mirrored yet" otherwise (`BeeperChatSurface.jsx`'s `isRecentActivity`).
  // That fallback has nothing else to key on, so `lastActivity` must keep
  // passing through untouched — not coerced to the conversation's
  // `created_at`, not dropped — even while `lastMessage` stays `null`.
  it('still reports the conversation-level lastActivity alongside a null lastMessage, so the client can tell "still syncing" from "no history"', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow({ last_activity: '2026-09-02T09:00:00.000Z' })] }) // page
      .mockResolvedValueOnce({ rows: [] }) // preview
      .mockResolvedValueOnce({ rows: [] }); // participants
    const { conversations } = await listConversations({});
    expect(conversations[0]).toMatchObject({ lastMessage: null, lastActivity: '2026-09-02T09:00:00.000Z' });
  });

  // The LOCAL "seen in PortOS" watermark (#83) — `shapeConversation`'s own
  // logic, exercised through `listConversations` since the shaper is not
  // itself exported. Beeper's mirrored `unread_count` is deliberately left
  // non-zero on every row below: the watermark hides the badge at the READ
  // boundary, never by mutating what the sweep wrote.
  describe('the local "seen" watermark hides/shows the badge (#83)', () => {
    it('hides the badge when seen_at is at or after the conversation\'s last activity', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [conversationRow({ unread_count: 5, last_activity: '2026-09-01T10:00:00.000Z', seen_at: '2026-09-01T10:00:00.000Z' })],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const { conversations } = await listConversations({});
      expect(conversations[0].unreadCount).toBe(0);
    });

    it('shows the badge again once new activity lands after the watermark', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({
          rows: [conversationRow({ unread_count: 3, last_activity: '2026-09-01T12:00:00.000Z', seen_at: '2026-09-01T10:00:00.000Z' })],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const { conversations } = await listConversations({});
      expect(conversations[0].unreadCount).toBe(3);
    });

    it('reads a conversation never opened in PortOS (seen_at NULL) as whatever Beeper says', async () => {
      vi.mocked(query)
        .mockResolvedValueOnce({ rows: [conversationRow({ unread_count: 7, seen_at: null })] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });
      const { conversations } = await listConversations({});
      expect(conversations[0].unreadCount).toBe(7);
    });
  });
});

describe('getConversation', () => {
  it('returns null for an unknown id so a stale deep link degrades to not-found', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    expect(await getConversation(CONV_B)).toBeNull();
  });

  it('returns the full participant set with no cap', async () => {
    const participants = Array.from({ length: 12 }, (_, i) => ({
      conversation_id: CONV_A,
      source_user_id: `user-${i}`,
      display_name: `Example Person ${i}`,
      handle: '',
      tribe_person_id: null,
      observed_via: 'message-sender',
      tribe_person_name: null,
    }));
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({ rows: participants });
    const conversation = await getConversation(CONV_A);
    expect(conversation.participants).toHaveLength(12);
    expect(conversation.hasMoreParticipants).toBe(false);
  });

  it('reads a soft-deleted Tribe link as fully unlinked — null id, no name, so the re-link control returns', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [conversationRow()] })
      .mockResolvedValueOnce({
        rows: [{
          conversation_id: CONV_A,
          source_user_id: 'user-1',
          display_name: 'Sam Example',
          handle: '+15550100',
          tribe_person_id: 'deleted-person-1',
          observed_via: 'participant-list',
          tribe_person_name: 'Deleted Person',
          tribe_person_deleted: true,
        }],
      });
    const conversation = await getConversation(CONV_A);
    expect(conversation.participants[0]).toMatchObject({ tribePersonId: null, tribePersonName: null });
  });
});

// The audit's soft-deleted-link finding: `beeperConversations.js`'s own
// participant shaper used to leak `tribePersonId`/`tribePersonName` for a
// soft-deleted Tribe person while `beeperTribe.js`'s shaper already nulled the
// cached id. Both now call the SAME extracted predicate
// (`resolveLinkedPersonId` in `lib/tribeMatch.js`), and this test drives BOTH
// real code paths off the identical underlying row so a future edit that
// re-duplicates the logic in only one of them fails here first.
describe('parity: a soft-deleted Tribe link reads as unlinked from every shaper', () => {
  const DELETED_PERSON = 'deleted-person-1';

  const softDeletedConversationParticipantsRow = {
    conversation_id: CONV_A,
    source_user_id: 'user-1',
    display_name: 'Sam Example',
    handle: '+15550100',
    tribe_person_id: DELETED_PERSON,
    observed_via: 'participant-list',
    tribe_person_name: 'Deleted Person',
    tribe_person_deleted: true,
  };

  const softDeletedTribeParticipantRow = {
    conversation_id: CONV_A,
    source_user_id: 'user-1',
    display_name: 'Sam Example',
    handle: '+15550100',
    tribe_person_id: DELETED_PERSON,
    observed_via: 'participant-list',
    network: 'examplenet',
    tribe_person_deleted: true,
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-01T10:00:00.000Z',
  };

  it('agrees with beeperTribe.getParticipant: both null tribePersonId (and this file also nulls tribePersonName)', async () => {
    vi.mocked(query).mockImplementation(async (sql) => {
      const text = flat(sql);
      // beeperTribe.js's own participant shaper — the "list/preview path"
      // the audit found already correct.
      if (text.startsWith('SELECT p.*, c.network')) {
        return { rows: [softDeletedTribeParticipantRow] };
      }
      // This file's conversation/list participant shaper — the audit's
      // "conversation payload shaper" finding.
      if (text.includes('p.observed_via, tp.name AS tribe_person_name')) {
        return { rows: [softDeletedConversationParticipantsRow] };
      }
      if (text.startsWith('SELECT c.*') && text.includes('WHERE c.id = $1')) {
        return { rows: [conversationRow()] };
      }
      return { rows: [] };
    });

    const conversation = await getConversation(CONV_A);
    expect(conversation.participants[0]).toMatchObject({ tribePersonId: null, tribePersonName: null });

    const participant = await beeperTribe.getParticipant(CONV_A, 'user-1');
    expect(participant.tribePersonId).toBeNull();
    // The row's own network identity survives — re-linking still targets the
    // same participant rather than a dead end.
    expect(participant.sourceUserId).toBe('user-1');
    expect(participant.handle).toBe('+15550100');
  });
});

describe('listMessages', () => {
  it('pages newest-first with a keyset cursor and attaches attachment references', async () => {
    const rows = [
      { id: 'm2', conversation_id: CONV_A, sender_id: 'user-1', body: 'second', sent_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', ordering_ts: '2026-09-01T10:00:00.000Z' },
      { id: 'm1', conversation_id: CONV_A, sender_id: 'user-2', body: 'first', sent_at: '2026-09-01T09:00:00.000Z', created_at: '2026-09-01T09:00:00.000Z', ordering_ts: '2026-09-01T09:00:00.000Z' },
    ];
    vi.mocked(query)
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ message_id: 'm2', idx: 0, mxc_id: 'mxc://example/abc', mime_type: 'image/png', byte_length: '1024', file_name: 'example.png', width: 10, height: 10 }] });

    const page = await listMessages(CONV_A, { limit: 5 });
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('ORDER BY COALESCE(m.sent_at, m.created_at) DESC, m.id DESC');
    expect(page.messages.map((m) => m.id)).toEqual(['m2', 'm1']);
    // Shaped by `beeperAttachments.shapeAttachment`, so the thread sees the
    // mirror state (`stored` / `overCap` / `unavailable` / `keep`) on the same
    // payload the attachment routes return, not a second metadata-only shape.
    expect(page.messages[0].attachments).toMatchObject([
      {
        messageId: 'm2', idx: 0, mxcId: 'mxc://example/abc', mimeType: 'image/png',
        byteLength: 1024, fileName: 'example.png', width: 10, height: 10,
        stored: false, overCap: false, unavailable: false, keep: false,
      },
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it('withholds a tombstoned body but keeps the message and its unsentAt', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [{ id: 'm9', conversation_id: CONV_A, sender_id: 'user-1', body: 'placeholder body', sent_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', unsent_at: '2026-09-01T11:00:00.000Z', ordering_ts: '2026-09-01T10:00:00.000Z' }],
    }).mockResolvedValueOnce({ rows: [] });
    const page = await listMessages(CONV_A, {});
    expect(page.messages[0]).toMatchObject({ id: 'm9', body: '', unsentAt: '2026-09-01T11:00:00.000Z' });
  });

  it('carries the mirrored direction through, and reads a missing column as inbound', async () => {
    vi.mocked(query).mockResolvedValueOnce({
      rows: [
        { id: 'm2', conversation_id: CONV_A, sender_id: 'user-me', body: 'placeholder', sent_at: '2026-09-01T10:00:00.000Z', created_at: '2026-09-01T10:00:00.000Z', is_sender: true, ordering_ts: '2026-09-01T10:00:00.000Z' },
        { id: 'm1', conversation_id: CONV_A, sender_id: 'user-1', body: 'placeholder', sent_at: '2026-09-01T09:00:00.000Z', created_at: '2026-09-01T09:00:00.000Z', ordering_ts: '2026-09-01T09:00:00.000Z' },
      ],
    }).mockResolvedValueOnce({ rows: [] });
    const page = await listMessages(CONV_A, {});
    expect(page.messages.map((m) => m.isSender)).toEqual([true, false]);
  });

  it('answers an empty page rather than an error — an empty thread is often correct', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });
    await expect(listMessages(CONV_A, {})).resolves.toEqual({ messages: [], nextCursor: null });
  });
});

describe('listNetworks', () => {
  it('derives the rail scopes from the mirror and excludes archived rows from unread', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{ network: 'examplenet', conversation_count: 3, unread_count: 4, unread_conversations: 2, account_ids: ['acct-example-1'], last_activity: '2026-09-01T10:00:00.000Z' }],
    });
    const networks = await listNetworks();
    const [sql] = vi.mocked(query).mock.calls[0];
    expect(flat(sql)).toContain('FILTER (WHERE c.is_archived = FALSE AND (c.seen_at IS NULL OR c.seen_at < COALESCE(c.last_activity, c.created_at)))');
    expect(networks).toEqual([{
      network: 'examplenet',
      conversationCount: 3,
      unreadCount: 4,
      unreadConversations: 2,
      accountIds: ['acct-example-1'],
      lastActivity: '2026-09-01T10:00:00.000Z',
    }]);
  });

  // #81: a network holding only activity-less chats used to report
  // `lastActivity` as "just now" (the fallback to created_at), not honestly
  // having none. Unlike listConversations' keyset walk, this is a plain MAX
  // over the group — MAX ignores NULLs and yields NULL when every row is
  // NULL, which is already the honest value, so no epoch sentinel is needed.
  it('aggregates the last-activity as a plain MAX, never falling back to created_at or an epoch sentinel', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listNetworks();
    const [sql] = vi.mocked(query).mock.calls[0];
    const flatSql = flat(sql);
    expect(flatSql).toContain('MAX(c.last_activity) AS last_activity');
    // Narrowed to the `last_activity` aggregate expression itself (#83): the
    // seen watermark's `UNSEEN_SQL` guard legitimately references
    // `c.created_at` elsewhere in this same query, as the activity floor for
    // the two UNREAD aggregates — a blanket "the whole SQL never mentions
    // created_at" no longer holds, so this checks only the MAX(...) that
    // produces `last_activity`.
    const lastActivityExpr = /MAX\(([^)]*)\) AS last_activity/.exec(flatSql)?.[1];
    expect(lastActivityExpr).toBe('c.last_activity');
    expect(lastActivityExpr).not.toContain('COALESCE');
    expect(lastActivityExpr).not.toContain('epoch');
  });

  // The LOCAL "seen" watermark (#83) must gate BOTH aggregates the rail reads
  // — the summed `unread_count` and the `unread_conversations` count — not
  // just one of them, or a network chip and its own conversation count would
  // disagree about whether a just-opened thread is still unread.
  it('gates both the summed unread_count and the unread_conversations count on the watermark', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await listNetworks();
    const [sql] = vi.mocked(query).mock.calls[0];
    const text = flat(sql);
    expect(text).toContain(
      'SUM(c.unread_count) FILTER (WHERE c.is_archived = FALSE AND (c.seen_at IS NULL OR c.seen_at < COALESCE(c.last_activity, c.created_at)))',
    );
    expect(text).toContain(
      'COUNT(*) FILTER (WHERE c.unread_count > 0 AND c.is_archived = FALSE AND (c.seen_at IS NULL OR c.seen_at < COALESCE(c.last_activity, c.created_at)))',
    );
  });
});

describe('the two wired rail controls', () => {
  it('PATCHes Beeper BEFORE the mirror, and mirrors the value Beeper actually returned', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversationRow({ is_archived: true })] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(updateChat).mockResolvedValue({ id: 'chat-example-1', isArchived: true });

    const conversation = await setConversationArchived(CONV_A, true);
    expect(updateChat).toHaveBeenCalledWith('chat-example-1', { isArchived: true });
    const update = callFor('UPDATE beeper_conversations SET is_archived');
    expect(update[1]).toEqual([CONV_A, true]);
    expect(conversation.isArchived).toBe(true);
  });

  it('leaves the mirror untouched when the PATCH fails — no optimistic local state', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] });
    vi.mocked(updateChat).mockRejectedValue(Object.assign(new Error('Beeper request failed'), { code: 'NETWORK_ERROR' }));

    await expect(setConversationArchived(CONV_A, true)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(updateChat).toHaveBeenCalledTimes(1);
    expect(callFor('UPDATE beeper_conversations')).toBeUndefined();
  });

  it('falls back to the requested value when the bridge answers without the flag, rather than blanking it', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: CONV_A, source_chat_id: 'chat-example-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [conversationRow({ is_low_priority: true })] })
      .mockResolvedValueOnce({ rows: [] });
    vi.mocked(updateChat).mockResolvedValue({ id: 'chat-example-1' });

    await setConversationLowPriority(CONV_A, true);
    expect(callFor('UPDATE beeper_conversations SET is_low_priority')[1]).toEqual([CONV_A, true]);
  });

  it('404s on an unknown conversation without calling Beeper at all', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });
    await expect(setConversationArchived(CONV_B, true)).rejects.toMatchObject({ status: 404 });
    expect(updateChat).not.toHaveBeenCalled();
  });
});

// `markConversationSeen` (#83) — the LOCAL "seen in PortOS" watermark write.
// Unlike the two wired rail controls above, this never calls Beeper at all:
// there is no PATCH to assert an order against, only that an unknown id 404s
// before any UPDATE, and that a known one is stamped and re-read.
describe('markConversationSeen — the local watermark write, never a Beeper call', () => {
  it('stamps seen_at and returns the freshly-read conversation', async () => {
    vi.mocked(query)
      .mockResolvedValueOnce({ rows: [{ id: CONV_A }] }) // existence check
      .mockResolvedValueOnce({ rows: [] }) // the UPDATE
      .mockResolvedValueOnce({ rows: [conversationRow({ seen_at: '2026-09-01T10:00:00.000Z' })] }) // getConversation
      .mockResolvedValueOnce({ rows: [] }); // participants

    const conversation = await markConversationSeen(CONV_A);
    const update = callFor('UPDATE beeper_conversations SET seen_at = NOW()');
    expect(update[1]).toEqual([CONV_A]);
    expect(conversation.id).toBe(CONV_A);
    expect(updateChat).not.toHaveBeenCalled();
  });

  it('404s on an unknown conversation without writing anything', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] });
    await expect(markConversationSeen(CONV_B)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(callFor('UPDATE beeper_conversations')).toBeUndefined();
    expect(updateChat).not.toHaveBeenCalled();
  });
});

// The purge is the one destructive path over the mirror, and the sentence the
// user reads before confirming it promises the chat comes back on the next
// sync. That promise is only true if the sync cursor goes with the rows.
describe('purgeConversation', () => {
  const purgeQueries = () => vi.mocked(query).mock.calls.map(([sql]) => flat(sql));

  const stubPurgeReads = (row) => {
    vi.mocked(query).mockImplementation(async (sql) => {
      const text = flat(sql);
      if (text.includes('SELECT id, title, account_id, source_chat_id')) return { rows: [row] };
      if (text.includes('COUNT(*)::int AS count FROM beeper_messages')) return { rows: [{ count: 7 }] };
      return { rows: [] };
    });
  };

  it('deletes the conversation AND its sync cursor, in one transaction, keyed on Beeper\'s own ids', async () => {
    stubPurgeReads({ id: CONV_A, title: 'Example Conversation', account_id: 'acct-example-1', source_chat_id: 'chat-example-1' });
    const statements = [];
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn({
      query: async (sql, params) => { statements.push([flat(sql), params]); return { rows: [] }; },
    }));

    const result = await purgeConversation(CONV_A);

    expect(statements.map(([sql]) => sql)).toEqual([
      'DELETE FROM beeper_conversations WHERE id = $1',
      'DELETE FROM beeper_sync_cursors WHERE account_id = $1 AND chat_id = $2',
    ]);
    // The cursor is keyed on the ACCOUNT id and the SOURCE chat id, never the
    // synthetic conversation uuid — its FK reaches beeper_accounts only, so the
    // conversation cascade cannot take it.
    expect(statements[1][1]).toEqual(['acct-example-1', 'chat-example-1']);
    expect(result).toMatchObject({ purged: true, conversationId: CONV_A, messagesRemoved: 7 });
    // Never a DELETE outside the transaction.
    expect(purgeQueries().some((sql) => sql.startsWith('DELETE'))).toBe(false);
  });

  it('404s an unknown id without deleting anything', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await expect(purgeConversation(CONV_B)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(vi.mocked(withTransaction)).not.toHaveBeenCalled();
  });
});
