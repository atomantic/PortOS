import {
  describe, it, expect, vi, beforeEach, afterEach,
} from 'vitest';

// The ingestion sweep (#32). Postgres is mocked (the row shapes themselves are
// pinned by beeperSync.db.test.js, which needs a real portos_test); `fetch` is
// mocked but the REAL beeperClient runs on top of it, so these tests also prove
// what actually reaches the wire — `accountIDs`, `cursor`, `direction` — rather
// than what the sweep merely intended to ask for.

const dbCalls = [];
const txCalls = [];
// Same statements as `txCalls`, with their params — `txCalls` is asserted as an
// ordered list of SQL strings all over this file, so the values ride alongside
// rather than inside it.
const txWrites = [];
let storedCursorRows = [];
let txFailPattern = null;

const queryMock = vi.fn(async (text, params) => {
  dbCalls.push({ text, params });
  if (/FROM beeper_sync_cursors/.test(text)) return { rows: storedCursorRows };
  if (/INSERT INTO beeper_conversations/.test(text)) return { rows: [{ id: `conv-${params[2]}` }] };
  return { rows: [] };
});

// Mirrors db.js's withTransaction contract: BEGIN, run, COMMIT — or ROLLBACK
// and rethrow. Recording the statements in order is what lets the tests below
// assert WHERE the cursor write sits relative to the rows it describes.
const withTransactionMock = vi.fn(async (fn) => {
  txCalls.push('BEGIN');
  const client = {
    query: async (text, params) => {
      txCalls.push(text.trim().split('\n')[0].trim());
      txWrites.push({ text, params });
      if (txFailPattern && txFailPattern.test(text)) throw new Error('simulated write failure');
      return { rows: [] };
    },
  };
  try {
    const result = await fn(client);
    txCalls.push('COMMIT');
    return result;
  } catch (err) {
    txCalls.push('ROLLBACK');
    throw err;
  }
});

vi.mock('../lib/db.js', () => ({
  query: (...args) => queryMock(...args),
  withTransaction: (...args) => withTransactionMock(...args),
}));

const getSettingsMock = vi.fn(async () => ({
  beeper: { token: 'test-token', baseUrl: 'http://127.0.0.1:23373', enabled: true, intervalMinutes: 5 },
}));
vi.mock('./settings.js', () => ({ getSettings: (...args) => getSettingsMock(...args) }));

const isInstanceFeatureEnabledMock = vi.fn(async () => true);
vi.mock('./instanceFeatures.js', () => ({
  isInstanceFeatureEnabled: (...args) => isInstanceFeatureEnabledMock(...args),
}));

const upsertParticipantMock = vi.fn(async () => ({}));
const logSenderTouchpointsMock = vi.fn(async () => ({ created: 0, matched: 0 }));
// A stand-in roster index — its shape only matters to `buildPersonMatchIndex`
// consumers, and `upsertParticipant` itself is mocked above, so an empty index
// is enough to prove it is loaded once per sweep and threaded through.
const loadRosterIndexMock = vi.fn(async () => ({ byIdentifier: new Map(), byPhone: new Map(), byName: new Map() }));
vi.mock('./beeperTribe.js', () => ({
  upsertParticipant: (...args) => upsertParticipantMock(...args),
  logSenderTouchpoints: (...args) => logSenderTouchpointsMock(...args),
  loadRosterIndex: (...args) => loadRosterIndexMock(...args),
}));

const {
  runBeeperSweep, isBeeperIngestionArmed, getBeeperSyncConfig, chatNeedsSweep,
  normalizeAccountRow, normalizeMessageRow, normalizeAttachmentRows, DEFAULT_INTERVAL_MINUTES,
} = await import('./beeperSync.js');
const { getBeeperSweepProgress, __resetBeeperSweepProgressForTests } = await import('./beeperSweepProgress.js');
const { beeperSocketEvents } = await import('./beeperSocketEvents.js');

// ---------------------------------------------------------------------------
// Fetch routing
// ---------------------------------------------------------------------------

const fetchedUrls = [];

function jsonResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

const ACCOUNTS = [{ accountID: 'acct-a', network: 'Example Net', user: { id: 'u-self', fullName: 'Example Owner' } }];
const BRIDGES = { items: [{ id: 'bridge-1', network: 'examplenet', status: 'connected', accounts: [{ accountID: 'acct-a' }] }] };

function installFetch({ chatPages = [], messagePages = {} } = {}) {
  let chatPageIndex = 0;
  const fetchMock = vi.fn(async (url) => {
    fetchedUrls.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
    if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
    if (parsed.pathname === '/v1/chats') {
      const page = chatPages[Math.min(chatPageIndex, chatPages.length - 1)] || { items: [], hasMore: false };
      chatPageIndex++;
      return jsonResponse(page);
    }
    const messageMatch = parsed.pathname.match(/^\/v1\/chats\/([^/]+)\/messages$/);
    if (messageMatch) {
      const chatId = decodeURIComponent(messageMatch[1]);
      return jsonResponse(messagePages[chatId] || { items: [], hasMore: false });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const chatsRequests = () => fetchedUrls.filter((url) => new URL(url).pathname === '/v1/chats');
const messageRequests = () => fetchedUrls.filter((url) => /\/messages$/.test(new URL(url).pathname));

/** The `(cursor, last_activity)` pair the last cursor upsert actually carried. */
const committedCursorRow = () => txWrites
  .filter(({ text }) => text.includes('INSERT INTO beeper_sync_cursors'))
  .map(({ params }) => ({ cursor: params[2], lastActivity: params[3] }))
  .at(-1);

beforeEach(() => {
  dbCalls.length = 0;
  txCalls.length = 0;
  txWrites.length = 0;
  fetchedUrls.length = 0;
  storedCursorRows = [];
  txFailPattern = null;
  queryMock.mockClear();
  withTransactionMock.mockClear();
  upsertParticipantMock.mockClear();
  logSenderTouchpointsMock.mockClear();
  loadRosterIndexMock.mockClear();
  isInstanceFeatureEnabledMock.mockResolvedValue(true);
  getSettingsMock.mockResolvedValue({
    beeper: { token: 'test-token', baseUrl: 'http://127.0.0.1:23373', enabled: true, intervalMinutes: 5 },
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  __resetBeeperSweepProgressForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Arming gate (#32 acceptance: feature off or no token → nothing happens)
// ---------------------------------------------------------------------------

describe('isBeeperIngestionArmed', () => {
  it('is false with the instance feature off, and never reads the credential', async () => {
    isInstanceFeatureEnabledMock.mockResolvedValue(false);
    expect(await isBeeperIngestionArmed()).toBe(false);
    expect(getSettingsMock).not.toHaveBeenCalled();
  });

  it('is false with the feature on but no token configured', async () => {
    getSettingsMock.mockResolvedValue({ beeper: { baseUrl: 'http://127.0.0.1:23373' } });
    expect(await isBeeperIngestionArmed()).toBe(false);
  });

  it('is true only with both the feature on and a token present', async () => {
    expect(await isBeeperIngestionArmed()).toBe(true);
  });

  it('never gates on Beeper app.state — a live instance reported "initializing" for 105s while healthy', async () => {
    // Deliberately no /v1/app or /v1/info call at all: the gate must not be
    // able to consult app.state even indirectly (#12 decision 2).
    installFetch();
    await isBeeperIngestionArmed();
    expect(fetchedUrls).toEqual([]);
  });
});

describe('getBeeperSyncConfig', () => {
  it('defaults the interval to 5 minutes and treats a missing enabled flag as off', async () => {
    getSettingsMock.mockResolvedValue({});
    expect(await getBeeperSyncConfig()).toEqual({ enabled: false, intervalMinutes: DEFAULT_INTERVAL_MINUTES });
  });

  it('reads the user-configured interval', async () => {
    getSettingsMock.mockResolvedValue({ beeper: { enabled: true, intervalMinutes: 15 } });
    expect(await getBeeperSyncConfig()).toEqual({ enabled: true, intervalMinutes: 15 });
  });
});

describe('runBeeperSweep without a token', () => {
  it('throws a typed NOT_CONFIGURED error instead of sweeping', async () => {
    getSettingsMock.mockResolvedValue({ beeper: {} });
    installFetch();
    await expect(runBeeperSweep({ reason: 'manual' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(fetchedUrls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sweep progress + invalidation frames (#80) — this fails on the old code,
// which never touched `beeperSweepProgress.js` or `beeperSocketEvents` at all.
// ---------------------------------------------------------------------------

describe('sweep progress', () => {
  it('is idle before any sweep has run', () => {
    expect(getBeeperSweepProgress()).toMatchObject({
      running: false, startedAt: null, finishedAt: null, accountsTotal: null, accountsDone: 0, chats: 0, messages: 0,
    });
  });

  it('flips back to idle with the final counts once a sweep completes', async () => {
    installFetch({ chatPages: [{ items: [], hasMore: false }] });

    const result = await runBeeperSweep({ reason: 'manual' });

    const progress = getBeeperSweepProgress();
    expect(progress.running).toBe(false);
    expect(progress.startedAt).toEqual(expect.any(String));
    expect(progress.finishedAt).toEqual(expect.any(String));
    // ACCOUNTS fixture carries exactly one account.
    expect(progress.accountsTotal).toBe(1);
    expect(progress.accountsDone).toBe(1);
    expect(progress.chats).toBe(result.chats);
    expect(progress.messages).toBe(result.messages);
  });

  it('still flips running back to false when the sweep throws before it can start (no token)', async () => {
    getSettingsMock.mockResolvedValue({ beeper: {} });
    installFetch();

    await expect(runBeeperSweep({ reason: 'manual' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });

    const progress = getBeeperSweepProgress();
    expect(progress.running).toBe(false);
    expect(progress.finishedAt).toEqual(expect.any(String));
  });

  it('still flips running back to false when every account fails (SWEEP_FAILED)', async () => {
    const fetchMock = vi.fn(async (url) => {
      fetchedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (parsed.pathname === '/v1/chats') return { ok: false, status: 502, text: async () => '{"error":"down"}' };
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runBeeperSweep({ reason: 'manual' })).rejects.toMatchObject({ code: 'SWEEP_FAILED' });

    const progress = getBeeperSweepProgress();
    expect(progress.running).toBe(false);
    // The account was attempted (and failed) before the whole-sweep throw.
    expect(progress.accountsDone).toBe(1);
    expect(progress.finishedAt).toEqual(expect.any(String));
  });

  it('emits one invalidation frame per account, plus one when the total is known and one on completion', async () => {
    installFetch({ chatPages: [{ items: [], hasMore: false }] });
    const frames = [];
    const onInvalidate = (frame) => frames.push(frame);
    beeperSocketEvents.on('invalidate', onInvalidate);

    try {
      await runBeeperSweep({ reason: 'manual' });
    } finally {
      beeperSocketEvents.off('invalidate', onInvalidate);
    }

    // One account: the "accountsTotal known" frame, one per-account frame, and
    // the finish frame in the `finally` — three, in order.
    expect(frames).toHaveLength(3);
    expect(frames.every((frame) => frame.kind === 'beeper-sweep' && frame.chatID === null)).toBe(true);
    expect(frames.every((frame) => typeof frame.ts === 'string')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Watermark bounding
// ---------------------------------------------------------------------------

describe('watermark-bounded sweep', () => {
  const CHAT_PAGE = {
    items: [
      {
        id: 'chat-1',
        accountID: 'acct-a',
        network: 'Example Net',
        title: 'Example Chat',
        type: 'single',
        unreadCount: 1,
        lastActivity: '2026-09-02T10:00:00.000Z',
        participants: { hasMore: false, total: 1, items: [{ id: 'user-1', fullName: 'Alice Example', phoneNumber: '+15550100001' }] },
      },
      {
        id: 'chat-2',
        accountID: 'acct-a',
        network: 'Example Net',
        title: 'Older Chat',
        type: 'group',
        unreadCount: 0,
        lastActivity: '2026-08-01T00:00:00.000Z',
        participants: { hasMore: true, total: 42, items: [] },
      },
      {
        id: 'chat-3',
        accountID: 'acct-a',
        network: 'Example Net',
        title: 'Oldest Chat',
        type: 'single',
        unreadCount: 0,
        lastActivity: '2026-07-01T00:00:00.000Z',
        participants: { hasMore: false, total: 0, items: [] },
      },
    ],
    hasMore: true,
    oldestCursor: 'chats-page-2',
  };

  it('pages only the chats that are newer than their watermark', async () => {
    storedCursorRows = [
      { chat_id: 'chat-1', cursor: 'cur-chat-1', last_activity: '2026-09-01T00:00:00.000Z' },
      { chat_id: 'chat-2', cursor: 'cur-chat-2', last_activity: '2026-08-01T00:00:00.000Z' },
      { chat_id: 'chat-3', cursor: 'cur-chat-3', last_activity: '2026-07-01T00:00:00.000Z' },
    ];
    installFetch({
      chatPages: [CHAT_PAGE, { items: [], hasMore: false }],
      messagePages: {
        'chat-1': {
          items: [{
            id: 'msg-1', chatID: 'chat-1', accountID: 'acct-a', senderID: 'user-1', senderName: 'Alice Example',
            timestamp: '2026-09-02T10:00:00.000Z', sortKey: '0001', text: 'hello',
          }],
          hasMore: false,
          newestCursor: 'cur-chat-1-next',
        },
      },
    });

    const result = await runBeeperSweep({ reason: 'manual' });

    // chat-2 and chat-3 both sit exactly on their watermarks, so neither is
    // paged for messages — but neither ends the walk, and the sweep stops on
    // the next page instead, which asks for nothing at all.
    expect(result).toMatchObject({ skipped: false, accounts: 1, chats: 1, messages: 1, failedAccounts: 0 });
    expect(messageRequests()).toHaveLength(1);
    expect(new URL(messageRequests()[0]).pathname).toBe('/v1/chats/chat-1/messages');
    expect(chatsRequests()).toHaveLength(2);
  });

  // The truncation contract (`sweepChat` withholding the watermark) and the old
  // "stop at the first caught-up chat" rule cancelled each other out: the list
  // is ordered by last activity, not by eligibility, so in the steady state a
  // truncated chat sat below chats that were caught up and was never reached
  // again. Its backlog was stranded until unrelated activity moved it back to
  // the top of the list.
  it('walks past a caught-up chat to a truncated one below it, then stops on a page that needs nothing', async () => {
    const chatRow = (id, lastActivity) => ({
      id,
      accountID: 'acct-a',
      network: 'Example Net',
      title: `Example Chat ${id}`,
      type: 'single',
      lastActivity,
      participants: { hasMore: false, total: 0, items: [] },
    });
    storedCursorRows = [
      // Caught up: its watermark equals its current activity.
      { chat_id: 'chat-caught-up', cursor: 'cur-caught-up', last_activity: '2026-09-02T10:00:00.000Z' },
      // Truncated on an earlier pass: the cursor advanced, the watermark did
      // not, so it is still eligible — and it sorts BELOW the caught-up chat.
      { chat_id: 'chat-truncated', cursor: 'cur-truncated', last_activity: '2026-08-01T00:00:00.000Z' },
      { chat_id: 'chat-quiet', cursor: 'cur-quiet', last_activity: '2026-07-01T00:00:00.000Z' },
    ];
    installFetch({
      chatPages: [
        {
          items: [chatRow('chat-caught-up', '2026-09-02T10:00:00.000Z'), chatRow('chat-truncated', '2026-09-01T00:00:00.000Z')],
          hasMore: true,
          oldestCursor: 'chats-page-2',
        },
        { items: [chatRow('chat-quiet', '2026-07-01T00:00:00.000Z')], hasMore: true, oldestCursor: 'chats-page-3' },
      ],
      messagePages: {
        'chat-truncated': {
          items: [{ id: 'msg-b', senderID: 'user-1', text: 'Example message', timestamp: '2026-09-01T00:00:00.000Z' }],
          hasMore: false,
          newestCursor: 'cur-truncated-next',
        },
      },
    });

    const result = await runBeeperSweep({ reason: 'manual' });

    expect(result).toMatchObject({ skipped: false, chats: 1, messages: 1, failedChats: 0 });
    expect(messageRequests()).toHaveLength(1);
    expect(new URL(messageRequests()[0]).pathname).toBe('/v1/chats/chat-truncated/messages');
    // Page two asked for nothing, so the walk ends there rather than running
    // out the 20-page budget — the page is the terminator, not the chat.
    expect(chatsRequests()).toHaveLength(2);
  });

  it('sends accountIDs, and resumes each chat forward from its stored opaque cursor', async () => {
    storedCursorRows = [{ chat_id: 'chat-1', cursor: 'cur-chat-1', last_activity: '2026-09-01T00:00:00.000Z' }];
    installFetch({
      chatPages: [{ ...CHAT_PAGE, items: [CHAT_PAGE.items[0]], hasMore: false }],
      messagePages: { 'chat-1': { items: [], hasMore: false } },
    });

    await runBeeperSweep({ reason: 'manual' });

    const chatParams = new URL(chatsRequests()[0]).searchParams;
    expect(chatParams.getAll('accountIDs')).toEqual(['acct-a']);
    expect(chatParams.get('direction')).toBe('before');

    const messageParams = new URL(messageRequests()[0]).searchParams;
    expect(messageParams.get('cursor')).toBe('cur-chat-1');
    expect(messageParams.get('direction')).toBe('after');
  });

  it('takes only the newest page for a chat it has never swept — a first sweep is not a history backfill', async () => {
    installFetch({
      chatPages: [{ items: [CHAT_PAGE.items[0]], hasMore: false }],
      messagePages: {
        'chat-1': {
          items: [{ id: 'msg-1', senderID: 'user-1', timestamp: '2026-09-02T10:00:00.000Z', sortKey: '0001', text: 'hi' }],
          hasMore: true,
          oldestCursor: 'older-page',
          newestCursor: 'cur-newest',
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    // hasMore is true and there IS an older page, but a never-swept chat takes
    // exactly one page and anchors its cursor at the newest message.
    expect(messageRequests()).toHaveLength(1);
    const params = new URL(messageRequests()[0]).searchParams;
    expect(params.get('cursor')).toBeNull();
    expect(params.get('direction')).toBe('before');
  });

  it('relates senders and participants through beeperTribe rather than writing identity rows itself', async () => {
    installFetch({
      chatPages: [{ items: [CHAT_PAGE.items[0]], hasMore: false }],
      messagePages: {
        'chat-1': {
          items: [
            { id: 'msg-1', senderID: 'user-1', senderName: 'Alice Example', timestamp: '2026-09-02T10:00:00.000Z', sortKey: '1', text: 'hi' },
            { id: 'msg-2', senderID: 'u-self', isSender: true, timestamp: '2026-09-02T10:01:00.000Z', sortKey: '2', text: 'hey' },
          ],
          hasMore: false,
          newestCursor: 'cur-newest',
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    expect(upsertParticipantMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceUserId: 'user-1', handle: '+15550100001', observedVia: 'participant-list',
    }));
    expect(upsertParticipantMock).toHaveBeenCalledWith(expect.objectContaining({
      sourceUserId: 'u-self', observedVia: 'message-sender',
    }));
    // A message the user SENT is not contact from anyone, so it never becomes a
    // touchpoint candidate.
    const [candidates] = logSenderTouchpointsMock.mock.calls[0];
    expect(candidates.map((c) => c.senderId)).toEqual(['user-1']);
  });
});

// ---------------------------------------------------------------------------
// The transaction boundary — the point of the module
// ---------------------------------------------------------------------------

describe('cursor transactionality', () => {
  const ONE_CHAT = {
    items: [{
      id: 'chat-1',
      accountID: 'acct-a',
      network: 'Example Net',
      title: 'Example Chat',
      type: 'single',
      unreadCount: 0,
      lastActivity: '2026-09-02T10:00:00.000Z',
      participants: { hasMore: false, total: 0, items: [] },
    }],
    hasMore: false,
  };
  const ONE_MESSAGE = {
    'chat-1': {
      items: [{ id: 'msg-1', senderID: 'user-1', timestamp: '2026-09-02T10:00:00.000Z', sortKey: '1', text: 'hello' }],
      hasMore: false,
      newestCursor: 'cur-advanced',
    },
  };

  it('commits message rows, attachment rows and the cursor in one transaction, cursor last', async () => {
    installFetch({
      chatPages: [ONE_CHAT],
      messagePages: {
        'chat-1': {
          ...ONE_MESSAGE['chat-1'],
          items: [{
            ...ONE_MESSAGE['chat-1'].items[0],
            attachments: [{
              type: 'img',
              id: 'mxc://example.invalid/abc',
              srcURL: '/tmp/should-never-be-persisted.png',
              mimeType: 'image/png',
              fileName: 'photo.png',
              fileSize: 2048,
              size: { width: 800, height: 600 },
            }],
          }],
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    expect(txCalls[0]).toBe('BEGIN');
    expect(txCalls.at(-1)).toBe('COMMIT');
    const messageIndex = txCalls.findIndex((sql) => sql.includes('INSERT INTO beeper_messages'));
    const attachmentIndex = txCalls.findIndex((sql) => sql.includes('INSERT INTO beeper_attachments'));
    const cursorIndex = txCalls.findIndex((sql) => sql.includes('INSERT INTO beeper_sync_cursors'));
    expect(messageIndex).toBeGreaterThan(0);
    expect(attachmentIndex).toBeGreaterThan(messageIndex);
    expect(cursorIndex).toBeGreaterThan(attachmentIndex);
  });

  it('persists isSender on the message row, and never downgrades a stored TRUE', async () => {
    installFetch({
      chatPages: [ONE_CHAT],
      messagePages: {
        'chat-1': {
          ...ONE_MESSAGE['chat-1'],
          items: [{ ...ONE_MESSAGE['chat-1'].items[0], isSender: true }],
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    const insert = txWrites.find(({ text }) => text.includes('INSERT INTO beeper_messages'));
    expect(insert).toBeTruthy();
    expect(insert.params.at(-1)).toBe(true);
    // A later page may omit the optional field; the upsert must not flip a
    // message the user actually sent onto the other side of the thread. This is
    // the guard's SHAPE against a mocked client — the row-level proof that a
    // stored TRUE survives a second sweep lives in `beeperSync.db.test.js`.
    expect(insert.text).toContain('is_sender = beeper_messages.is_sender OR EXCLUDED.is_sender');
  });

  it('leaves the cursor unmoved when a row write throws before the commit', async () => {
    txFailPattern = /INSERT INTO beeper_messages/;
    installFetch({ chatPages: [ONE_CHAT], messagePages: ONE_MESSAGE });

    const result = await runBeeperSweep({ reason: 'manual' });

    expect(txCalls).toContain('BEGIN');
    expect(txCalls).toContain('ROLLBACK');
    expect(txCalls).not.toContain('COMMIT');
    // The whole point: nothing ever tried to move the cursor, so the next sweep
    // refetches exactly the same window.
    expect(txCalls.some((sql) => sql.includes('beeper_sync_cursors'))).toBe(false);
    expect(dbCalls.some(({ text }) => /UPDATE beeper_sync_cursors|INSERT INTO beeper_sync_cursors/.test(text))).toBe(false);
    // One broken chat is isolated to itself: the account keeps its pass and the
    // sweep still resolves, with the failure surfaced as `failedChats`.
    expect(result).toMatchObject({
      skipped: false, failedAccounts: 0, failedChats: 1, messages: 0,
    });
  });

  it('rolls the rows back too when the cursor write itself throws', async () => {
    txFailPattern = /beeper_sync_cursors/;
    installFetch({ chatPages: [ONE_CHAT], messagePages: ONE_MESSAGE });

    await runBeeperSweep({ reason: 'manual' });

    expect(txCalls).toContain('ROLLBACK');
    expect(txCalls).not.toContain('COMMIT');
  });

  it('never persists an attachment srcURL — only durable reference metadata', async () => {
    const rows = normalizeAttachmentRows({
      attachments: [{
        type: 'img',
        id: 'mxc://example.invalid/abc',
        srcURL: '/tmp/decays.png',
        posterImg: '/tmp/poster.png',
        mimeType: 'image/png',
        fileName: 'photo.png',
        fileSize: 2048,
        size: { width: 800, height: 600 },
      }],
    });
    expect(rows).toEqual([{
      idx: 0, mxcId: 'mxc://example.invalid/abc', mimeType: 'image/png',
      byteLength: 2048, fileName: 'photo.png', width: 800, height: 600,
    }]);
  });
});

// ---------------------------------------------------------------------------
// Truncated forward walk — the watermark must not outrun the fetch
// ---------------------------------------------------------------------------

// A chat further behind than MAX_MESSAGE_PAGES_PER_CHAT is the one case where
// the cursor advances but the chat is NOT caught up. Committing its current
// `lastActivity` as the watermark would make the two timestamps equal, so
// `chatNeedsSweep` would return false, `sweepAccount` would treat that as
// "watermark reached", and the un-fetched newest messages would never arrive
// until unrelated activity moved the chat again — the mirror showing a stale
// last message indefinitely. The watermark therefore stays put (null into the
// COALESCE) while the cursor moves, so the next pass resumes mid-backlog.
describe('a chat with more new messages than the page cap', () => {
  const CHAT_ID = 'chat-backlog';
  const CHAT_ACTIVITY = '2026-09-02T10:00:00.000Z';
  const STORED_WATERMARK = '2026-09-01T00:00:00.000Z';

  const chatPage = () => ({
    items: [{
      id: CHAT_ID,
      accountID: 'acct-a',
      network: 'Example Net',
      title: 'Example Backlog Chat',
      type: 'single',
      lastActivity: CHAT_ACTIVITY,
      participants: { hasMore: false, total: 1, items: [{ id: 'user-1', fullName: 'Alice Example' }] },
    }],
    hasMore: false,
  });

  // Every message page reports `hasMore: true` and a fresh `newestCursor`, so
  // the forward walk can only ever stop by running out of page budget.
  function installEndlessBacklogFetch() {
    let messagePageIndex = 0;
    const fetchMock = vi.fn(async (url) => {
      fetchedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (parsed.pathname === '/v1/chats') return jsonResponse(chatPage());
      if (/\/messages$/.test(parsed.pathname)) {
        messagePageIndex++;
        return jsonResponse({
          items: [{
            id: `msg-${messagePageIndex}`,
            senderID: 'user-1',
            text: 'Example message',
            timestamp: '2026-09-02T09:00:00.000Z',
            sortKey: `${messagePageIndex}`,
          }],
          hasMore: true,
          newestCursor: `cursor-${messagePageIndex}`,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('leaves last_activity unchanged on the first pass and resumes from the advanced cursor on the second', async () => {
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: 'cursor-0', last_activity: STORED_WATERMARK }];
    installEndlessBacklogFetch();

    const first = await runBeeperSweep({ reason: 'manual' });

    // Pass one stopped at the cap, so it walked exactly MAX_MESSAGE_PAGES_PER_CHAT
    // message pages and wrote a row per page.
    expect(messageRequests()).toHaveLength(10);
    expect(first).toMatchObject({ skipped: false, chats: 1, messages: 10 });
    // The cursor moved; the watermark did NOT. A null here is what makes the
    // existing `COALESCE(EXCLUDED.last_activity, beeper_sync_cursors.last_activity)`
    // keep the stored value instead of jumping to the chat's current activity.
    const committed = committedCursorRow();
    expect(committed.cursor).toBe('cursor-10');
    expect(committed.lastActivity).toBeNull();
    expect(committed.lastActivity).not.toBe(CHAT_ACTIVITY);

    // Now play the database's part: the cursor took EXCLUDED, the watermark
    // kept its old value through the COALESCE.
    fetchedUrls.length = 0;
    txWrites.length = 0;
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: committed.cursor, last_activity: STORED_WATERMARK }];

    const second = await runBeeperSweep({ reason: 'manual' });

    // The chat is still newer than its watermark, so pass two sweeps it again
    // rather than deciding the account walk had reached the watermark.
    expect(second).toMatchObject({ skipped: false, chats: 1, messages: 10 });
    const firstMessageRequest = new URL(messageRequests()[0]);
    expect(firstMessageRequest.searchParams.get('cursor')).toBe('cursor-10');
    expect(firstMessageRequest.searchParams.get('direction')).toBe('after');
  });

  it('does commit the watermark once the walk actually reaches the end', async () => {
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: 'cursor-0', last_activity: STORED_WATERMARK }];
    installFetch({
      chatPages: [chatPage()],
      messagePages: {
        [CHAT_ID]: {
          items: [{ id: 'msg-1', senderID: 'user-1', text: 'Example message', timestamp: '2026-09-02T09:00:00.000Z' }],
          hasMore: false,
          newestCursor: 'cursor-final',
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    expect(committedCursorRow()).toEqual({ cursor: 'cursor-final', lastActivity: CHAT_ACTIVITY });
  });
});

// ---------------------------------------------------------------------------
// A forward walk that stalls is truncated too, not finished
// ---------------------------------------------------------------------------

// The page budget is not the only way a forward walk can end short of the
// newest message. A server that answers `hasMore: true` and then hands back no
// usable cursor — a null one, or the very cursor it was just given — leaves
// exactly the same state: messages exist that this pass never fetched. Reading
// that as a clean end committed the chat's current activity as its watermark,
// so `chatNeedsSweep` marked the chat caught up and everything past the stall
// was lost.
describe('a forward walk the server stalls with hasMore but no usable cursor', () => {
  const CHAT_ID = 'chat-stalled';
  const CHAT_ACTIVITY = '2026-09-02T10:00:00.000Z';
  const STORED_CURSOR = 'cur-stored';
  const STORED_WATERMARK = '2026-09-01T00:00:00.000Z';

  const chatPage = () => ({
    items: [{
      id: CHAT_ID,
      accountID: 'acct-a',
      network: 'Example Net',
      title: 'Example Stalled Chat',
      type: 'single',
      lastActivity: CHAT_ACTIVITY,
      participants: { hasMore: false, total: 0, items: [] },
    }],
    hasMore: false,
  });

  const messagePage = (newestCursor) => ({
    items: [{ id: 'msg-1', senderID: 'user-1', text: 'Example message', timestamp: '2026-09-02T09:00:00.000Z', sortKey: '1' }],
    hasMore: true,
    newestCursor,
  });

  it.each([
    ['a null newestCursor', null],
    ['the cursor it was handed', STORED_CURSOR],
  ])('holds the watermark back when the page answers hasMore with %s', async (_label, newestCursor) => {
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: STORED_CURSOR, last_activity: STORED_WATERMARK }];
    installFetch({ chatPages: [chatPage()], messagePages: { [CHAT_ID]: messagePage(newestCursor) } });

    await runBeeperSweep({ reason: 'manual' });

    // The walk asked once, could not continue, and did NOT reach the newest
    // message — so a null watermark rides into the COALESCE and the stored one
    // survives.
    expect(messageRequests()).toHaveLength(1);
    expect(committedCursorRow().lastActivity).toBeNull();
    expect(committedCursorRow().lastActivity).not.toBe(CHAT_ACTIVITY);

    // Which is what keeps the chat eligible: the database kept the old
    // watermark, so the next pass still sees the chat as moved.
    expect(chatNeedsSweep({ lastActivity: CHAT_ACTIVITY }, { lastActivity: STORED_WATERMARK })).toBe(true);
  });

  it('still commits the watermark when the stall is on a first-sweep anchor walk', async () => {
    // A chat with no stored cursor takes the newest page ONLY and is never
    // trying to reach the end, so its `hasMore: true` is expected rather than a
    // truncation — the anchor is exactly what it went to fetch.
    installFetch({ chatPages: [chatPage()], messagePages: { [CHAT_ID]: messagePage(null) } });

    await runBeeperSweep({ reason: 'manual' });

    expect(committedCursorRow().lastActivity).toBe(CHAT_ACTIVITY);
  });
});

// ---------------------------------------------------------------------------
// #81: a first-page anchor fetch that comes back empty is retried once, not
// silently marked done — not a message-kind filter (there is none in
// `beeperClient.js`) and not the sweep/page budget (it only bounds the
// forward `'after'` catch-up walk on a chat that already has a cursor). The
// old code simply committed `normalized.lastActivity` on ANY first-page
// result, empty or not, so a chat that got nothing back on its one shot never
// got a second look. This retry covers a chat whose activity IS real but
// whose first page still came back empty (a transient fetch hiccup, or a
// history-less chat gaining its first-ever activity right as it enters the
// mirror) — NOT the population the read-only live-instance investigation on
// fork issue #81 actually observed empty (chats Beeper itself never reports
// activity for at all, so `chatNeedsSweep` never re-selects them regardless
// of this retry). That population's reported symptom — empty rows sorting
// above recent threads — is fixed by the sort fallback in
// `beeperConversations.js`, not by this retry.
// ---------------------------------------------------------------------------

describe('#81 — first page comes back with zero messages', () => {
  const CHAT_ID = 'chat-empty-first-page';
  const CHAT_ACTIVITY = '2026-09-02T10:00:00.000Z';

  const chatPage = () => ({
    items: [{
      id: CHAT_ID,
      accountID: 'acct-a',
      network: 'Example Net',
      title: 'Example Chat',
      type: 'single',
      lastActivity: CHAT_ACTIVITY,
      participants: { hasMore: false, total: 0, items: [] },
    }],
    hasMore: false,
  });

  it('withholds the cursor and watermark on a never-swept chat whose first page returns nothing, instead of marking it done', async () => {
    storedCursorRows = [];
    installFetch({
      chatPages: [chatPage()],
      messagePages: { [CHAT_ID]: { items: [], hasMore: false } },
    });

    const result = await runBeeperSweep({ reason: 'manual' });

    expect(messageRequests()).toHaveLength(1);
    expect(result).toMatchObject({ skipped: false, chats: 1, messages: 0 });
    // Both withheld — the OLD code committed `normalized.lastActivity`
    // unconditionally here, which is exactly what marked the chat
    // permanently done on one empty page.
    expect(committedCursorRow()).toEqual({ cursor: null, lastActivity: null });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('retries a chat left in the withheld state and commits normally once messages actually come back', async () => {
    // The state a withheld first pass leaves behind: a cursor row that exists
    // but carries neither a cursor nor a watermark — the storage-free "already
    // retried once" marker `sweepChat` reads back.
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: null, last_activity: null }];
    installFetch({
      chatPages: [chatPage()],
      messagePages: {
        [CHAT_ID]: {
          items: [{
            id: 'msg-1', senderID: 'user-1', text: 'Example message',
            timestamp: '2026-09-02T09:59:00.000Z', sortKey: '1',
          }],
          hasMore: false,
          newestCursor: 'cursor-retry',
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    // Retried the SAME first-page fetch (no stored cursor to walk forward
    // from), and this time it worked — commits like any other first sweep.
    const firstMessageRequest = new URL(messageRequests()[0]);
    expect(firstMessageRequest.searchParams.get('direction')).toBe('before');
    expect(committedCursorRow()).toEqual({ cursor: 'cursor-retry', lastActivity: CHAT_ACTIVITY });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('gives up and logs once when the retry is ALSO empty, so the chat is not re-swept forever', async () => {
    storedCursorRows = [{ chat_id: CHAT_ID, cursor: null, last_activity: null }];
    installFetch({
      chatPages: [chatPage()],
      messagePages: { [CHAT_ID]: { items: [], hasMore: false } },
    });

    await runBeeperSweep({ reason: 'manual' });

    // The real (non-null) watermark commits this time, so `chatNeedsSweep`
    // reaches the same steady state a genuinely history-less chat already
    // does — no more retries — and exactly one warn line names the chat
    // (id only, never content).
    expect(committedCursorRow()).toEqual({ cursor: null, lastActivity: CHAT_ACTIVITY });
    expect(chatNeedsSweep({ lastActivity: CHAT_ACTIVITY }, { lastActivity: CHAT_ACTIVITY })).toBe(false);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(CHAT_ID));
  });

  it('does not withhold when the first page returns a message, even with hasMore/newestCursor absent', async () => {
    // Guards the boundary: `emptyFirstPage` must key on `messages.length`, not
    // on the presence of a cursor — a first page can legitimately answer
    // `hasMore: false` with no `newestCursor` at all once it has content.
    storedCursorRows = [];
    installFetch({
      chatPages: [chatPage()],
      messagePages: {
        [CHAT_ID]: {
          items: [{ id: 'msg-1', senderID: 'user-1', text: 'hi', timestamp: '2026-09-02T09:59:00.000Z', sortKey: '1' }],
          hasMore: false,
        },
      },
    });

    await runBeeperSweep({ reason: 'manual' });

    expect(committedCursorRow()).toEqual({ cursor: null, lastActivity: CHAT_ACTIVITY });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Failure isolation
// ---------------------------------------------------------------------------

describe('failure isolation', () => {
  const chatRow = (id, lastActivity) => ({
    id,
    accountID: 'acct-a',
    network: 'Example Net',
    title: `Example Chat ${id}`,
    type: 'single',
    lastActivity,
    participants: { hasMore: false, total: 0, items: [] },
  });

  it('keeps walking an account after one chat throws, so a broken chat cannot starve the ones below it', async () => {
    const fetchMock = vi.fn(async (url) => {
      fetchedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (parsed.pathname === '/v1/chats') {
        return jsonResponse({
          items: [chatRow('chat-broken', '2026-09-02T10:00:00.000Z'), chatRow('chat-ok', '2026-09-02T09:00:00.000Z')],
          hasMore: false,
        });
      }
      const match = parsed.pathname.match(/^\/v1\/chats\/([^/]+)\/messages$/);
      if (match && decodeURIComponent(match[1]) === 'chat-broken') {
        return { ok: false, status: 502, text: async () => '{"error":"bridge down"}' };
      }
      if (match) {
        return jsonResponse({
          items: [{ id: 'msg-ok', senderID: 'user-9', text: 'Example message', timestamp: '2026-09-02T09:00:00.000Z' }],
          hasMore: false,
          newestCursor: 'cursor-ok',
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await runBeeperSweep({ reason: 'manual' });

    expect(result).toMatchObject({
      skipped: false, failedAccounts: 0, failedChats: 1, chats: 1, messages: 1,
    });
    expect(messageRequests().some((url) => url.includes('chat-ok'))).toBe(true);
  });

  it('throws when every account fails, so the scheduler records a failed run instead of a green one', async () => {
    const fetchMock = vi.fn(async (url) => {
      fetchedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse(ACCOUNTS);
      if (parsed.pathname === '/v1/bridges') return jsonResponse(BRIDGES);
      if (parsed.pathname === '/v1/chats') return { ok: false, status: 502, text: async () => '{"error":"down"}' };
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runBeeperSweep({ reason: 'scheduler' })).rejects.toMatchObject({ code: 'SWEEP_FAILED' });
  });

  it('still resolves when there are no accounts at all', async () => {
    const fetchMock = vi.fn(async (url) => {
      fetchedUrls.push(url);
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/accounts') return jsonResponse([]);
      if (parsed.pathname === '/v1/bridges') return jsonResponse({ items: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(runBeeperSweep({ reason: 'manual' }))
      .resolves.toMatchObject({ skipped: false, accounts: 0, failedAccounts: 0 });
  });
});

describe('re-entrancy', () => {
  it('refuses to start a second sweep while one is in flight', async () => {
    installFetch({ chatPages: [{ items: [], hasMore: false }] });

    const first = runBeeperSweep({ reason: 'scheduler' });
    const second = await runBeeperSweep({ reason: 'socket-reconnect' });
    const firstResult = await first;

    expect(second).toMatchObject({ skipped: true, reason: 'socket-reconnect' });
    expect(firstResult.skipped).toBe(false);
  });

  it('releases the guard after a failing sweep so the next one can run', async () => {
    getSettingsMock.mockResolvedValue({ beeper: {} });
    installFetch();
    await expect(runBeeperSweep({ reason: 'manual' })).rejects.toThrow();

    getSettingsMock.mockResolvedValue({ beeper: { token: 'test-token' } });
    installFetch({ chatPages: [{ items: [], hasMore: false }] });
    await expect(runBeeperSweep({ reason: 'manual' })).resolves.toMatchObject({ skipped: false });
  });
});

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

describe('normalizers', () => {
  it('never carries loginID into an account row', () => {
    const row = normalizeAccountRow({
      accountID: 'acct-a',
      loginID: '+15550100001',
      network: 'Example Net',
      status: 'connected',
      bridgeId: 'bridge-1',
      user: { fullName: 'Example Owner' },
    });
    expect(row).toEqual({
      accountId: 'acct-a', network: 'Example Net', displayName: 'Example Owner',
      status: 'connected', bridgeId: 'bridge-1',
    });
    expect(JSON.stringify(row)).not.toContain('5550100001');
  });

  // Live /v1/accounts items carry `bridge` as an OBJECT { id, type, provider
  // }, never a string, and an account absent from every /v1/bridges
  // items[].accounts[] entry leaves the join's `bridgeId` null — the object
  // must be narrowed to `.id`, not coerced whole (String() on an object
  // produces the literal text "[object Object]").
  it('reads bridgeId off the raw bridge object when the bridge join has no match', () => {
    const row = normalizeAccountRow({
      accountID: 'acct-b',
      network: 'Example Net',
      status: 'connected',
      bridgeId: null,
      bridge: { id: 'bridge-2', type: 'example', provider: 'exampleprovider' },
      user: { fullName: 'Example Owner' },
    });
    expect(row.bridgeId).toBe('bridge-2');
  });

  it('records an unsend as an observation-time tombstone, never as a removal', () => {
    const row = normalizeMessageRow(
      { id: 'msg-1', senderID: 'user-1', isDeleted: true, text: '', timestamp: '2026-09-01T00:00:00.000Z', sortKey: '1' },
      '2026-09-02T12:00:00.000Z',
    );
    expect(row.unsentAt).toBe('2026-09-02T12:00:00.000Z');
    expect(row.id).toBe('msg-1');
  });

  // Direction is the ONLY thing a chat surface cannot reconstruct from the rest
  // of the row: `accounts[].user.id` differs from `senderID` on every network
  // (#2), so there is nothing to compare a sender against. It has to be
  // mirrored from the API's own `isSender`.
  it('mirrors isSender, and reads an omitted field as inbound rather than undefined', () => {
    const sent = normalizeMessageRow(
      { id: 'msg-1', senderID: 'user-me', text: 'placeholder', isSender: true },
      '2026-09-02T12:00:00.000Z',
    );
    const received = normalizeMessageRow(
      { id: 'msg-2', senderID: 'user-1', text: 'placeholder' },
      '2026-09-02T12:00:00.000Z',
    );
    expect(sent.isSender).toBe(true);
    expect(received.isSender).toBe(false);
  });

  it('reads an edit off editedTimestamp and leaves unsentAt null', () => {
    const row = normalizeMessageRow(
      { id: 'msg-1', text: 'fixed', editedTimestamp: '2026-09-02T09:00:00.000Z', timestamp: '2026-09-01T00:00:00.000Z' },
      '2026-09-02T12:00:00.000Z',
    );
    expect(row.editedAt).toBe('2026-09-02T09:00:00.000Z');
    expect(row.unsentAt).toBeNull();
  });

  // Case-insensitivity (RFC 2045) means a bridge is free to send `Image/JPEG`
  // or `IMAGE/jpeg` — the stored value has to be lowercased so it matches what
  // `beeperAttachmentPaths.MIRRORED_MIME_TYPES` and the client's `isImage()`
  // check both compare against.
  it('lowercases a mixed-case declared mimeType before it is stored', () => {
    const rows = normalizeAttachmentRows({
      attachments: [{
        type: 'img', id: 'mxc://example.invalid/mixed-case', mimeType: 'Image/JPEG', fileName: 'photo.jpg',
      }],
    });
    expect(rows[0].mimeType).toBe('image/jpeg');
  });

  it('chatNeedsSweep keeps "never swept", "swept but silent" and "moved" apart', () => {
    expect(chatNeedsSweep({ lastActivity: null }, undefined)).toBe(true);
    expect(chatNeedsSweep({ lastActivity: null }, { lastActivity: null })).toBe(false);
    expect(chatNeedsSweep({ lastActivity: '2026-09-02T00:00:00.000Z' }, { lastActivity: null })).toBe(true);
    expect(chatNeedsSweep({ lastActivity: '2026-09-02T00:00:00.000Z' }, { lastActivity: '2026-09-01T00:00:00.000Z' })).toBe(true);
    expect(chatNeedsSweep({ lastActivity: '2026-09-01T00:00:00.000Z' }, { lastActivity: '2026-09-01T00:00:00.000Z' })).toBe(false);
  });
});
