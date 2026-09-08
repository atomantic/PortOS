import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

/**
 * The outbound outbox (#36, decided on #8; confirmation transport on #12).
 *
 * Time is INJECTED — the confirmation fallback is a 30-second contract and the
 * breaker is a 60-second window, and proving either with a real sleep would put
 * a minute-plus of wall clock into CI for behaviour a fake clock pins exactly.
 *
 * `beeperClient` is mocked at the boundary: NOTHING in this suite reaches a
 * real Beeper Desktop, and the assertions that matter are about how many times
 * `sendMessage` is called (exactly once per entry, ever) rather than what the
 * network did with it.
 *
 * The DB is a small in-memory stand-in keyed on the same SQL this service
 * writes, so a state transition is asserted as a row state rather than as a
 * mock call. The real DDL is covered by `lib/db/schema/beeper.db.test.js`.
 */

class BeeperApiError extends Error {
  constructor(message, { status = 500, code, retryable = false, details } = {}) {
    super(message);
    this.name = 'BeeperApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

const sendMessage = vi.fn();
const getMessage = vi.fn();
const listMessagesPage = vi.fn();

vi.mock('./beeperClient.js', () => ({
  BeeperApiError,
  sendMessage: (...args) => sendMessage(...args),
  getMessage: (...args) => getMessage(...args),
  listMessagesPage: (...args) => listMessagesPage(...args),
}));

// The real normalizer is pure and covered by beeperSync's own suite; mocked
// here only to keep the ingestion stack (settings, Tribe, the pool) out of this
// module graph.
vi.mock('./beeperSync.js', () => ({
  normalizeMessageRow: (message, observedAt) => ({
    id: String(message?.id ?? ''),
    senderId: String(message?.senderID ?? ''),
    body: typeof message?.text === 'string' ? message.text : '',
    sentAt: message?.timestamp ?? null,
    editedAt: message?.editedTimestamp ?? null,
    unsentAt: message?.isDeleted === true ? observedAt : null,
    sortKey: String(message?.sortKey ?? ''),
  }),
}));

// --- in-memory stand-in for the tables this service touches -----------------
const outbox = new Map();
const conversations = new Map();
const mirrored = [];
const mirroredSql = [];
// The mirrored thread's own outbound history — separate from `mirrored`
// above, which only ever holds what THIS module's own `mirrorSentMessage`
// wrote. `isFirstContact` (#82) also has to see history a sync sweep mirrored
// from the user's phone or another client, which `seedMirroredMessage` below
// stands in for.
const mirroredMessages = [];
let nextId = 1;

/** A `beeper_messages` row synced in from Beeper, never through this outbox. */
function seedMirroredMessage(conversationId, { isSender = true } = {}) {
  mirroredMessages.push({ conversationId, isSender });
}

const entryView = (row) => ({ ...row });

const query = vi.fn(async (sql, params = []) => {
  if (/SELECT id, source_chat_id/.test(sql)) {
    const conversation = conversations.get(params[0]);
    return { rows: conversation ? [{ id: params[0], sourceChatId: conversation }] : [], rowCount: conversation ? 1 : 0 };
  }
  if (/INSERT INTO beeper_outbox/.test(sql)) {
    const row = {
      id: `outbox-${nextId++}`,
      conversationId: params[0],
      chatId: params[1],
      body: params[2],
      state: 'approved',
      pendingMessageId: null,
      messageId: null,
      errorCode: null,
      errorMessage: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      approvedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      sentAt: null,
    };
    outbox.set(row.id, row);
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/SELECT 1 FROM beeper_outbox\s+WHERE conversation_id = \$1 AND state = ANY/.test(sql)) {
    const contacted = [...outbox.values()]
      .filter((row) => row.conversationId === params[0] && params[1].includes(row.state));
    return { rows: contacted.map(() => ({ '?column?': 1 })), rowCount: contacted.length };
  }
  if (/SELECT 1 FROM beeper_messages\s+WHERE conversation_id = \$1 AND is_sender = TRUE/.test(sql)) {
    const sent = mirroredMessages
      .filter((message) => message.conversationId === params[0] && message.isSender === true);
    return { rows: sent.map(() => ({ '?column?': 1 })), rowCount: sent.length };
  }
  // The boot reconcile's two statements. Both are keyed on a STATE rather than
  // on an id, so they sit ahead of the single-row branches whose patterns they
  // would otherwise be caught by.
  if (/UPDATE beeper_outbox SET state = 'failed'[\s\S]*WHERE state = 'sending'/.test(sql)) {
    const stranded = [...outbox.values()].filter((row) => row.state === 'sending');
    for (const row of stranded) {
      row.state = 'failed';
      row.errorCode = params[0];
      row.errorMessage = params[1];
    }
    return { rows: stranded.map((row) => ({ id: row.id })), rowCount: stranded.length };
  }
  if (/FROM beeper_outbox WHERE state = 'awaiting-confirmation'/.test(sql)) {
    return { rows: [...outbox.values()].filter((row) => row.state === 'awaiting-confirmation').map(entryView) };
  }
  if (/FROM beeper_outbox\s+WHERE conversation_id = \$1 ORDER BY/.test(sql)) {
    return { rows: [...outbox.values()].filter((row) => row.conversationId === params[0]).map(entryView) };
  }
  if (/^SELECT[\s\S]*FROM beeper_outbox WHERE id = \$1/.test(sql)) {
    const row = outbox.get(params[0]);
    return { rows: row ? [entryView(row)] : [], rowCount: row ? 1 : 0 };
  }
  if (/UPDATE beeper_outbox SET state = 'sending'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'approved') return { rows: [], rowCount: 0 };
    row.state = 'sending';
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'awaiting-confirmation'/.test(sql)) {
    const row = outbox.get(params[0]);
    row.state = 'awaiting-confirmation';
    row.pendingMessageId = params[1];
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'failed'/.test(sql)) {
    const row = outbox.get(params[0]);
    row.state = 'failed';
    row.errorCode = params[1];
    row.errorMessage = params[2];
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET state = 'sent'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'awaiting-confirmation') return { rows: [], rowCount: 0 };
    row.state = 'sent';
    row.messageId = params[1];
    row.sentAt = params[2] ?? '2026-09-01T00:00:05.000Z';
    row.errorCode = null;
    row.errorMessage = null;
    return { rows: [entryView(row)], rowCount: 1 };
  }
  if (/UPDATE beeper_outbox SET error_code = 'CONFIRMATION_UNRESOLVED'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'awaiting-confirmation') return { rows: [], rowCount: 0 };
    row.errorCode = 'CONFIRMATION_UNRESOLVED';
    row.errorMessage = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/DELETE FROM beeper_outbox WHERE id = \$1 AND state = 'approved'/.test(sql)) {
    const row = outbox.get(params[0]);
    if (!row || row.state !== 'approved') return { rows: [], rowCount: 0 };
    outbox.delete(params[0]);
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO beeper_messages/.test(sql)) {
    mirroredSql.push(sql);
    mirrored.push(params);
    return { rows: [], rowCount: 1 };
  }
  throw new Error(`unexpected SQL in test: ${sql.slice(0, 60)}`);
});

vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));

const {
  BREAKER_MAX_CONSECUTIVE_FAILURES, BREAKER_MAX_SENDS_IN_WINDOW, BREAKER_WINDOW_MS,
  CONFIRMATION_TIMEOUT_MS, SEND_INTERRUPTED_MESSAGE,
  cancelPendingConfirmations, clearOutboxBreaker, configureOutboxRuntime, createOutboxEntry,
  discardOutboxEntry, getOutboxBreakerState, getOutboxStatus, isFirstContact, listOutboxEntries,
  reconcileOutboxOnBoot, resetOutboxRuntime, sendOutboxEntry,
} = await import('./beeperOutbox.js');
const { beeperSocketEvents } = await import('./beeperSocketEvents.js');

// Timers are recorded rather than run, so a test fires exactly the one it cares
// about — the same controllable-clock shape `beeperSocket.test.js` uses.
function makeClock() {
  const timers = new Map();
  let nextTimerId = 1;
  let current = 0;
  return {
    now: () => current,
    advance: (ms) => { current += ms; },
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    runTimersWithDelay: (ms) => {
      const due = [...timers.entries()].filter(([, timer]) => timer.ms === ms);
      for (const [id, timer] of due) { timers.delete(id); timer.fn(); }
      return due.length;
    },
    pending: () => timers.size,
  };
}

let clock;
const flush = () => new Promise((resolve) => setImmediate(resolve));

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const CHAT_ID = 'example-chat-1';

const sentMessage = (overrides = {}) => ({
  id: 'msg-final-1',
  chatID: CHAT_ID,
  senderID: 'user-self',
  text: 'hello there',
  timestamp: '2026-09-01T00:00:05.000Z',
  sortKey: '900',
  isSender: true,
  ...overrides,
});

async function approvedEntry(body = 'hello there', conversationId = CONVERSATION_ID) {
  return createOutboxEntry({ conversationId, body });
}

/** A conversation PortOS has already sent to, so first contact is not in play. */
function markPriorSend(conversationId = CONVERSATION_ID) {
  const row = {
    id: `outbox-prior-${nextId++}`,
    conversationId,
    chatId: CHAT_ID,
    body: 'an earlier message',
    state: 'sent',
    pendingMessageId: null,
    messageId: 'msg-earlier',
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-08-31T00:00:00.000Z',
    approvedAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:01.000Z',
    sentAt: '2026-08-31T00:00:01.000Z',
  };
  outbox.set(row.id, row);
}

/**
 * A row the PREVIOUS process left behind: persisted mid-flight, with nothing
 * armed in memory for it, which is exactly the state a restart produces.
 */
function strandedRow(state, overrides = {}) {
  const row = {
    id: `outbox-stranded-${nextId++}`,
    conversationId: CONVERSATION_ID,
    chatId: CHAT_ID,
    body: 'hello there',
    state,
    pendingMessageId: state === 'awaiting-confirmation' ? 'pending-1' : null,
    messageId: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-09-01T00:00:00.000Z',
    approvedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:01.000Z',
    sentAt: null,
    ...overrides,
  };
  outbox.set(row.id, row);
  return row;
}

beforeEach(() => {
  outbox.clear();
  conversations.clear();
  mirrored.length = 0;
  mirroredSql.length = 0;
  mirroredMessages.length = 0;
  nextId = 1;
  conversations.set(CONVERSATION_ID, CHAT_ID);
  conversations.set(OTHER_CONVERSATION_ID, 'example-chat-2');
  sendMessage.mockReset();
  getMessage.mockReset();
  listMessagesPage.mockReset();
  query.mockClear();
  sendMessage.mockResolvedValue({ chatID: CHAT_ID, pendingMessageID: 'pending-1' });
  getMessage.mockResolvedValue(sentMessage());
  listMessagesPage.mockResolvedValue({ items: [] });
  clock = makeClock();
  configureOutboxRuntime({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  clearOutboxBreaker();
});

afterEach(() => {
  cancelPendingConfirmations();
  clearOutboxBreaker();
  resetOutboxRuntime();
});

describe('createOutboxEntry — step one, the durable row', () => {
  it('writes an approved row carrying the source chat id, before anything is sent', async () => {
    const entry = await approvedEntry();
    expect(entry.state).toBe('approved');
    expect(entry.chatId).toBe(CHAT_ID);
    expect(entry.body).toBe('hello there');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('refuses an empty body and an unknown conversation', async () => {
    await expect(createOutboxEntry({ conversationId: CONVERSATION_ID, body: '   ' }))
      .rejects.toMatchObject({ code: 'OUTBOX_EMPTY_BODY', status: 400 });
    await expect(createOutboxEntry({ conversationId: '33333333-3333-4333-8333-333333333333', body: 'hi' }))
      .rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND', status: 404 });
  });

  it('lists entries for one conversation, failed ones included', async () => {
    const first = await approvedEntry('one');
    await approvedEntry('two');
    await approvedEntry('other', OTHER_CONVERSATION_ID);
    outbox.get(first.id).state = 'failed';
    const entries = await listOutboxEntries({ conversationId: CONVERSATION_ID });
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.state).sort()).toEqual(['approved', 'failed']);
  });
});

// The reviewer's blocker on #53: cancelling the first-contact confirmation
// left the row `approved` forever, with no way to remove it — a phantom
// pending send the client rendered as a permanent "Sending…" bubble. This is
// the discard the "Cancel" action now calls.
describe('discardOutboxEntry — the "Cancel" path', () => {
  it('removes an approved row that was never sent', async () => {
    const entry = await approvedEntry();
    await discardOutboxEntry(entry.id);
    expect(outbox.has(entry.id)).toBe(false);
    expect(await listOutboxEntries({ conversationId: CONVERSATION_ID })).toHaveLength(0);
  });

  it('404s an unknown entry', async () => {
    await expect(discardOutboxEntry('outbox-missing')).rejects.toMatchObject({
      code: 'OUTBOX_ENTRY_NOT_FOUND', status: 404,
    });
  });

  it('refuses to discard a row that already left "approved" — sent, failed, or in flight', async () => {
    const sending = await approvedEntry();
    outbox.get(sending.id).state = 'sending';
    await expect(discardOutboxEntry(sending.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    const sent = await approvedEntry();
    outbox.get(sent.id).state = 'sent';
    await expect(discardOutboxEntry(sent.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    const failed = await approvedEntry();
    outbox.get(failed.id).state = 'failed';
    await expect(discardOutboxEntry(failed.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });

    // None of those rows were touched.
    expect(outbox.has(sending.id)).toBe(true);
    expect(outbox.has(sent.id)).toBe(true);
    expect(outbox.has(failed.id)).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe('sendOutboxEntry — the human gates', () => {
  it('refuses the first message to a conversation without an explicit confirmation, and sends nothing', async () => {
    const entry = await approvedEntry();
    expect(await isFirstContact(CONVERSATION_ID)).toBe(true);
    await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({
      code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', status: 409,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(outbox.get(entry.id).state).toBe('approved');
  });

  it('sends once the first contact is confirmed, and asks no confirmation on the next message', async () => {
    const first = await approvedEntry();
    await sendOutboxEntry(first.id, { confirmFirstContact: true });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(CHAT_ID, { text: 'hello there' });
    expect(outbox.get(first.id).state).toBe('awaiting-confirmation');

    // Resolve it so the conversation has a completed send on record.
    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: CHAT_ID, ids: ['msg-final-1'] });
    await flush();
    expect(outbox.get(first.id).state).toBe('sent');

    const second = await approvedEntry('a reply');
    await expect(sendOutboxEntry(second.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
  });

  it('refuses to send an entry that is not approved, and never re-sends a failed one', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    outbox.get(entry.id).state = 'failed';
    await expect(sendOutboxEntry(entry.id, { confirmFirstContact: true }))
      .rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('404s an unknown entry', async () => {
    await expect(sendOutboxEntry('outbox-missing')).rejects.toMatchObject({ code: 'OUTBOX_ENTRY_NOT_FOUND', status: 404 });
  });
});

// The first-contact prompt has to fire exactly once per conversation, or the
// user learns to click through it. Counting only `sent` rows re-asked it after
// a send that left the machine but never confirmed — which is the NORMAL
// resting state of an unresolved send, since that case deliberately stays
// `awaiting-confirmation` rather than being marked failed.
//
// Fork issue #82: a contact is known when EITHER source has outbound history
// — a mirrored `is_sender` message (any client, not just this install) OR a
// prior PortOS outbox send — scoped to the one conversation being sent to.
// The confirmation is reserved for a chat neither source has ever addressed.
describe('isFirstContact — has PortOS addressed this conversation before', () => {
  it.each(['sent', 'awaiting-confirmation', 'sending'])(
    'treats a prior %s row as contact already made, so no confirmation is asked',
    async (state) => {
      const prior = await approvedEntry('an earlier message');
      outbox.get(prior.id).state = state;

      expect(await isFirstContact(CONVERSATION_ID)).toBe(false);

      const next = await approvedEntry('a reply');
      await expect(sendOutboxEntry(next.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
    },
  );

  it('treats a mirrored isSender message alone as contact already made, with no PortOS send on record', async () => {
    seedMirroredMessage(CONVERSATION_ID, { isSender: true });

    expect(await isFirstContact(CONVERSATION_ID)).toBe(false);

    const entry = await approvedEntry('a reply');
    await expect(sendOutboxEntry(entry.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
  });

  it('still asks when nothing PortOS composed ever reached Beeper and the mirror holds no outbound message', async () => {
    const failed = await approvedEntry('never left');
    outbox.get(failed.id).state = 'failed';
    await approvedEntry('still queued');

    expect(await isFirstContact(CONVERSATION_ID)).toBe(true);
    expect(await isFirstContact(OTHER_CONVERSATION_ID)).toBe(true);
  });

  it('still asks first contact when the mirrored thread holds only inbound messages', async () => {
    seedMirroredMessage(CONVERSATION_ID, { isSender: false });
    seedMirroredMessage(CONVERSATION_ID, { isSender: false });

    expect(await isFirstContact(CONVERSATION_ID)).toBe(true);

    const entry = await approvedEntry();
    await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({
      code: 'FIRST_CONTACT_CONFIRMATION_REQUIRED', status: 409,
    });
  });

  it('scopes the mirrored-message check to the conversation being sent to', async () => {
    seedMirroredMessage(OTHER_CONVERSATION_ID, { isSender: true });

    expect(await isFirstContact(CONVERSATION_ID)).toBe(true);
    expect(await isFirstContact(OTHER_CONVERSATION_ID)).toBe(false);
  });
});

describe('sendOutboxEntry — transport failure', () => {
  it('leaves exactly one failed row with the error, and posts nothing a second time', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    sendMessage.mockRejectedValueOnce(new BeeperApiError('Beeper request failed: connection refused', {
      status: 0, code: 'NETWORK_ERROR', retryable: false,
    }));

    await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({ code: 'NETWORK_ERROR', retryable: false });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const rows = [...outbox.values()].filter((row) => row.state === 'failed');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entry.id);
    expect(rows[0].errorCode).toBe('NETWORK_ERROR');
    expect(rows[0].errorMessage).toContain('connection refused');
    // No confirmation was armed for a send that never left.
    expect(clock.pending()).toBe(0);
  });
});

describe('confirmation — socket first, 30s GET fallback', () => {
  it('confirms on a message.upserted invalidation, mirrors the message and re-broadcasts an id-only frame', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);

    const frames = [];
    const listener = (frame) => frames.push(frame);
    beeperSocketEvents.on('invalidate', listener);
    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: CHAT_ID, ids: ['msg-final-1'] });
    await flush();
    beeperSocketEvents.off('invalidate', listener);

    expect(outbox.get(entry.id).state).toBe('sent');
    expect(outbox.get(entry.id).messageId).toBe('msg-final-1');
    expect(mirrored).toHaveLength(1);
    expect(mirrored[0][0]).toBe('msg-final-1');
    expect(mirrored[0][1]).toBe(CONVERSATION_ID);
    // The mirrored row is OUTBOUND. `is_sender` is written as a literal TRUE
    // rather than read off the confirming payload — the field is optional on
    // the API's own Message, and PortOS knows it sent this one — and the
    // conflict arm keeps the sweep's never-downgrade rule so a later inbound
    // page that omits the field cannot flip it back to the other side.
    expect(mirroredSql[0]).toMatch(/INSERT INTO beeper_messages \([^)]*, is_sender\)/);
    expect(mirroredSql[0]).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, TRUE\)/);
    expect(mirroredSql[0]).toMatch(/is_sender = beeper_messages\.is_sender OR EXCLUDED\.is_sender/);
    // The frame this service emits carries ids only — never the body.
    const emitted = frames.find((frame) => frame.ids?.includes('msg-final-1') && frame.ts);
    expect(emitted).toBeTruthy();
    expect(JSON.stringify(emitted)).not.toContain('hello there');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('resolves through the GET fallback when message.upserted never arrives, and does not send twice', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);

    // No socket frame at all. The fallback fires at exactly 30s.
    expect(outbox.get(entry.id).state).toBe('awaiting-confirmation');
    clock.advance(CONFIRMATION_TIMEOUT_MS);
    expect(clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS)).toBe(1);
    await flush();

    expect(getMessage).toHaveBeenCalledWith(CHAT_ID, 'pending-1');
    expect(outbox.get(entry.id).state).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('falls back to a chat + body + isSender match when the pending id no longer resolves', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockRejectedValue(new BeeperApiError('not found', { status: 404, code: 'NOT_FOUND' }));
    listMessagesPage.mockResolvedValue({
      items: [
        { id: 'msg-someone-else', text: 'hello there', isSender: false, timestamp: '2026-09-01T00:00:06.000Z' },
        sentMessage({ id: 'msg-final-2' }),
      ],
    });

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    expect(outbox.get(entry.id).messageId).toBe('msg-final-2');
    expect(outbox.get(entry.id).state).toBe('sent');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves an unresolvable send in flight with a reason rather than marking it failed', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockResolvedValue(null);
    listMessagesPage.mockResolvedValue({ items: [] });

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    const row = outbox.get(entry.id);
    // Not `failed`: a failed row invites a re-send, and the message may well
    // have been delivered.
    expect(row.state).toBe('awaiting-confirmation');
    expect(row.errorCode).toBe('CONFIRMATION_UNRESOLVED');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('marks the row failed when Beeper reports a failed send status, and never retries it', async () => {
    markPriorSend();
    const entry = await approvedEntry();
    await sendOutboxEntry(entry.id);
    getMessage.mockResolvedValue(sentMessage({
      sendStatus: { status: 'FAIL_PERMANENT', timestamp: '2026-09-01T00:00:06.000Z', message: 'Recipient unreachable' },
    }));

    clock.advance(CONFIRMATION_TIMEOUT_MS);
    clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS);
    await flush();

    expect(outbox.get(entry.id).state).toBe('failed');
    expect(outbox.get(entry.id).errorCode).toBe('SEND_FAIL_PERMANENT');
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

// `sending` and `awaiting-confirmation` are exit-only through in-memory state,
// so a restart mid-flight used to leave a row nothing could ever move: the
// client rendered it as a spinner with no Retry and no Dismiss, permanently.
describe('reconcileOutboxOnBoot — the durable half of the confirmation state', () => {
  it('fails every row stranded in "sending" with SEND_INTERRUPTED, and posts nothing', async () => {
    const stranded = strandedRow('sending');
    const settled = strandedRow('sent', { messageId: 'msg-earlier', sentAt: '2026-09-01T00:00:02.000Z' });
    const failed = strandedRow('failed', { errorCode: 'NETWORK_ERROR', errorMessage: 'connection refused' });

    const result = await reconcileOutboxOnBoot();

    expect(result.interrupted).toBe(1);
    expect(outbox.get(stranded.id)).toMatchObject({ state: 'failed', errorCode: 'SEND_INTERRUPTED' });
    // The exact sentence the client renders off the code, asserted literally on
    // both sides so the two bundles cannot drift apart.
    expect(outbox.get(stranded.id).errorMessage)
      .toBe('Delivery unconfirmed: PortOS restarted mid-send. Check the chat before retrying.');
    expect(SEND_INTERRUPTED_MESSAGE).toBe(outbox.get(stranded.id).errorMessage);
    // Terminal rows are left exactly as they were.
    expect(outbox.get(settled.id)).toMatchObject({ state: 'sent', messageId: 'msg-earlier', errorCode: null });
    expect(outbox.get(failed.id)).toMatchObject({ state: 'failed', errorCode: 'NETWORK_ERROR' });
    // The whole point: a crash never resends. Nothing on this path POSTs.
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('re-arms an "awaiting-confirmation" row from its persisted fields and resolves it without sending', async () => {
    const stranded = strandedRow('awaiting-confirmation');
    expect(getOutboxStatus().awaitingConfirmation).toBe(0);

    const result = await reconcileOutboxOnBoot();

    expect(result).toEqual({ interrupted: 0, rearmed: 1 });
    expect(getOutboxStatus().awaitingConfirmation).toBe(1);

    // The re-armed row now resolves through the same socket path a live send
    // uses — a lookup, never a second POST.
    beeperSocketEvents.emit('invalidate', { kind: 'message.upserted', chatID: CHAT_ID, ids: ['msg-final-1'] });
    await flush();

    expect(getMessage).toHaveBeenCalledWith(CHAT_ID, 'pending-1');
    expect(outbox.get(stranded.id)).toMatchObject({ state: 'sent', messageId: 'msg-final-1' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('re-arms a row already recorded unresolved, and still never sends on the fallback path', async () => {
    const stranded = strandedRow('awaiting-confirmation', {
      errorCode: 'CONFIRMATION_UNRESOLVED', errorMessage: 'Beeper reported no matching message within 30s',
    });
    getMessage.mockResolvedValue(null);
    listMessagesPage.mockResolvedValue({ items: [sentMessage({ id: 'msg-final-3' })] });

    await reconcileOutboxOnBoot();
    clock.advance(CONFIRMATION_TIMEOUT_MS);
    expect(clock.runTimersWithDelay(CONFIRMATION_TIMEOUT_MS)).toBe(1);
    await flush();

    // The body match is floored on the row's PERSISTED send moment, not on boot
    // time — dating it to now would reject the very message it is looking for.
    expect(outbox.get(stranded.id)).toMatchObject({ state: 'sent', messageId: 'msg-final-3' });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is idempotent across two calls — nothing double-fails and nothing double-arms', async () => {
    const stranded = strandedRow('sending');
    strandedRow('awaiting-confirmation');

    const first = await reconcileOutboxOnBoot();
    const second = await reconcileOutboxOnBoot();

    expect(first).toEqual({ interrupted: 1, rearmed: 1 });
    expect(second).toEqual({ interrupted: 0, rearmed: 0 });
    expect(getOutboxStatus().awaitingConfirmation).toBe(1);
    // One armed fallback timer, not two.
    expect(clock.pending()).toBe(1);
    expect(outbox.get(stranded.id).errorCode).toBe('SEND_INTERRUPTED');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('leaves an interrupted row re-sendable only as a NEW row, exactly like any other failure', async () => {
    markPriorSend();
    const stranded = strandedRow('sending');
    await reconcileOutboxOnBoot();

    // The failed row itself refuses to send in place…
    await expect(sendOutboxEntry(stranded.id)).rejects.toMatchObject({ code: 'OUTBOX_INVALID_STATE', status: 409 });
    expect(sendMessage).not.toHaveBeenCalled();

    // …and the recovery is a fresh, human-composed entry.
    const composed = await approvedEntry('hello there');
    await sendOutboxEntry(composed.id);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('runaway breaker', () => {
  it('trips on a synthetic send loop and blocks every further send until a human clears it', async () => {
    markPriorSend();
    const entries = [];
    for (let i = 0; i < BREAKER_MAX_SENDS_IN_WINDOW + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- the loop under test is sequential
      entries.push(await approvedEntry(`message ${i}`));
    }

    for (let i = 0; i < BREAKER_MAX_SENDS_IN_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered sends inside the same window
      await sendOutboxEntry(entries[i].id);
    }
    expect(getOutboxBreakerState().tripped).toBe(false);

    const overflow = entries[BREAKER_MAX_SENDS_IN_WINDOW];
    await expect(sendOutboxEntry(overflow.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN', status: 429 });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_SENDS_IN_WINDOW);
    expect(getOutboxBreakerState().tripped).toBe(true);
    expect(getOutboxStatus().breaker.tripped).toBe(true);

    // Still blocked, and time alone does not reopen it.
    clock.advance(60 * 60 * 1000);
    await expect(sendOutboxEntry(overflow.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN' });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_SENDS_IN_WINDOW);

    expect(clearOutboxBreaker().tripped).toBe(false);
    await expect(sendOutboxEntry(overflow.id)).resolves.toMatchObject({ state: 'awaiting-confirmation' });
  });

  it('trips on consecutive transport failures', async () => {
    markPriorSend();
    sendMessage.mockRejectedValue(new BeeperApiError('Beeper request failed', { status: 0, code: 'NETWORK_ERROR' }));
    for (let i = 0; i < BREAKER_MAX_CONSECUTIVE_FAILURES; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered failures
      const entry = await approvedEntry(`attempt ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    }
    expect(getOutboxBreakerState()).toMatchObject({
      tripped: true, consecutiveFailures: BREAKER_MAX_CONSECUTIVE_FAILURES,
    });
    const next = await approvedEntry('one more');
    await expect(sendOutboxEntry(next.id)).rejects.toMatchObject({ code: 'OUTBOX_BREAKER_OPEN' });
    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_CONSECUTIVE_FAILURES);
  });

  // The window is ROLLING, and that is the whole difference between a runaway
  // breaker and a rate quota: the same count of sends spread over an afternoon
  // is a person using the app, and must never be treated as a loop.
  it('stays closed when the same count of sends is spread beyond the window', async () => {
    markPriorSend();
    for (let i = 0; i <= BREAKER_MAX_SENDS_IN_WINDOW; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- ordered sends, one per window
      const entry = await approvedEntry(`message ${i}`);
      // eslint-disable-next-line no-await-in-loop
      await sendOutboxEntry(entry.id);
      clock.advance(BREAKER_WINDOW_MS + 1);
    }

    expect(sendMessage).toHaveBeenCalledTimes(BREAKER_MAX_SENDS_IN_WINDOW + 1);
    expect(getOutboxBreakerState()).toMatchObject({ tripped: false, sendsInWindow: 0 });
  });

  // The consecutive arm counts a RUN, not a total. Two failures either side of
  // a success are two runs of one, so a flaky connection cannot accumulate its
  // way into a breaker only a human can clear.
  it('resets the consecutive-failure count on a successful send', async () => {
    markPriorSend();
    const failOnce = async (label) => {
      sendMessage.mockRejectedValueOnce(new BeeperApiError('Beeper request failed', { status: 0, code: 'NETWORK_ERROR' }));
      const entry = await approvedEntry(label);
      await expect(sendOutboxEntry(entry.id)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    };

    await failOnce('one');
    await failOnce('two');
    expect(getOutboxBreakerState()).toMatchObject({ tripped: false, consecutiveFailures: 2 });

    const recovered = await approvedEntry('three');
    await sendOutboxEntry(recovered.id);
    expect(getOutboxBreakerState().consecutiveFailures).toBe(0);

    // Two more failures are now a run of two, not the fourth and fifth of five.
    await failOnce('four');
    await failOnce('five');
    expect(getOutboxBreakerState()).toMatchObject({ tripped: false, consecutiveFailures: 2 });
  });
});
