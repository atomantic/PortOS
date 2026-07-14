import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// Mock fs/promises before importing the module
vi.mock('fs/promises', () => ({
  writeFile: vi.fn(),
  readdir: vi.fn(),
  unlink: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn(),
  atomicWrite: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn(),
  PATHS: { messages: '/mock/data/messages' },
  safeJSONParse: vi.fn((content, fallback) => {
    if (!content) return fallback;
    const parsed = JSON.parse(content);
    return parsed;
  }),
  UUID_RE: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  safeDate: (d) => { const t = new Date(d).getTime(); return Number.isNaN(t) ? 0 : t; },
  filterBySearch: (items, search, fields) => {
    if (!search) return items;
    const q = search.toLowerCase();
    return items.filter(item =>
      fields.some(field => {
        const val = field.includes('.') ? field.split('.').reduce((o, k) => o?.[k], item) : item[field];
        return val?.toLowerCase?.().includes(q);
      })
    );
  }
}));

vi.mock('./messageAccounts.js', () => ({
  getAccount: vi.fn(),
  updateSyncStatus: vi.fn()
}));

vi.mock('./messageGmailSync.js', () => ({
  syncGmail: vi.fn()
}));

vi.mock('./messagePlaywrightSync.js', () => ({
  syncPlaywright: vi.fn(),
  refreshMessageDetail: vi.fn()
}));

// tribe.js is loaded dynamically by logMessageTouchpoints; mock it so the
// producer test asserts the candidates without a live Postgres.
vi.mock('./tribe.js', () => ({
  autoLogTouchpoints: vi.fn().mockResolvedValue({ created: 0, matched: 0 }),
}));

// The dedupe day is derived in the user's LOCAL timezone. Mock the tz module
// self-contained (getUserTimezone → mockTimezone, default UTC so the existing
// UTC-day assertions hold; getLocalParts is a faithful Intl-based re-impl of the
// real one) — importActual would load the real module against the mocked
// fileUtils and fail on its settings read.
let mockTimezone = 'UTC';
vi.mock('../lib/timezone.js', () => ({
  getUserTimezone: vi.fn(async () => mockTimezone),
  getLocalParts: (utcDate, timezone) => {
    const parts = {};
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    for (const { type, value } of fmt.formatToParts(utcDate)) parts[type] = value;
    return {
      year: parseInt(parts.year), month: parseInt(parts.month), day: parseInt(parts.day),
      hour: parts.hour === '24' ? 0 : parseInt(parts.hour), minute: parseInt(parts.minute),
    };
  },
}));

import { readdir, unlink } from 'fs/promises';
import { tryReadFile as readFile, atomicWrite } from '../lib/fileUtils.js';
import { getMessages, getMessage, syncAccount, deleteCache, getSyncStatus, refreshMessage, updateMessageEvaluations, logMessageTouchpoints } from './messageSync.js';
import { autoLogTouchpoints } from './tribe.js';
import { getAccount, updateSyncStatus } from './messageAccounts.js';
import { syncGmail } from './messageGmailSync.js';
import { syncPlaywright, refreshMessageDetail } from './messagePlaywrightSync.js';

const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cache file not found — tryReadFile returns null on read error
  readFile.mockResolvedValue(null);
});

// ─── Cache I/O: getMessages ───

describe('getMessages', () => {
  it('should return empty messages when cache file does not exist', async () => {
    const result = await getMessages({ accountId: VALID_UUID });
    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('should load and return messages from cache for a specific account', async () => {
    const cache = {
      syncCursor: 'cur-1',
      messages: [
        { id: 'msg-1', subject: 'Hello', date: '2026-01-02T00:00:00Z', externalId: 'ext-1' },
        { id: 'msg-2', subject: 'World', date: '2026-01-01T00:00:00Z', externalId: 'ext-2' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID });

    expect(result.messages).toHaveLength(2);
    expect(result.total).toBe(2);
    // Should be sorted newest first
    expect(result.messages[0].subject).toBe('Hello');
    expect(result.messages[1].subject).toBe('World');
  });

  it('should stamp accountId onto messages', async () => {
    const cache = { messages: [{ id: 'msg-1', subject: 'Test' }] };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID });
    expect(result.messages[0].accountId).toBe(VALID_UUID);
  });

  it('should apply search filter', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', subject: 'Meeting Notes', date: '2026-01-01' },
        { id: 'msg-2', subject: 'Invoice', date: '2026-01-01' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID, search: 'meeting' });
    expect(result.messages).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('should filter by from.name', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', from: { name: 'Alice' }, date: '2026-01-01' },
        { id: 'msg-2', from: { name: 'Bob' }, date: '2026-01-01' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID, search: 'alice' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-1');
  });

  it('should filter by from.email', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', from: { email: 'alice@test.com' }, date: '2026-01-01' },
        { id: 'msg-2', from: { email: 'bob@test.com' }, date: '2026-01-01' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID, search: 'alice@' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-1');
  });

  it('should filter by bodyText', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', bodyText: 'Hello world', date: '2026-01-01' },
        { id: 'msg-2', bodyText: 'Goodbye', date: '2026-01-01' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID, search: 'hello' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-1');
  });

  it('should handle search with missing fields gracefully', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', date: '2026-01-01' },
        { id: 'msg-2', subject: 'Test', date: '2026-01-01' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID, search: 'test' });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].id).toBe('msg-2');
  });

  it('should sort messages with invalid dates to the end', async () => {
    const cache = {
      messages: [
        { id: 'msg-bad', subject: 'Bad Date', date: 'not-a-date' },
        { id: 'msg-good', subject: 'Good Date', date: '2026-01-15T10:00:00Z' },
        { id: 'msg-null', subject: 'Null Date' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessages({ accountId: VALID_UUID });
    expect(result.messages).toHaveLength(3);
    // Valid date should come first (newest first), invalid dates sort to end (timestamp 0)
    expect(result.messages[0].id).toBe('msg-good');
  });

  it('should apply offset and limit', async () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `msg-${i}`, subject: `Msg ${i}`, date: `2026-01-${String(i + 1).padStart(2, '0')}`
    }));
    readFile.mockResolvedValue(JSON.stringify({ messages: msgs }));

    const result = await getMessages({ accountId: VALID_UUID, limit: 3, offset: 2 });
    expect(result.messages).toHaveLength(3);
    expect(result.total).toBe(10);
  });

  it('should aggregate across all account caches when no accountId', async () => {
    readdir.mockResolvedValue([`${VALID_UUID}.json`, `${VALID_UUID_2}.json`, 'not-uuid.json']);
    readFile.mockImplementation((filePath) => {
      if (filePath.includes(VALID_UUID_2)) {
        return Promise.resolve(JSON.stringify({
          messages: [{ id: 'msg-b', subject: 'From B', date: '2026-01-02' }]
        }));
      }
      return Promise.resolve(JSON.stringify({
        messages: [{ id: 'msg-a', subject: 'From A', date: '2026-01-01' }]
      }));
    });

    const result = await getMessages({});
    expect(result.total).toBe(2);
    // Newest first
    expect(result.messages[0].id).toBe('msg-b');
  });

  it('should return empty when readdir fails (no cache dir)', async () => {
    readdir.mockRejectedValue(new Error('ENOENT'));

    const result = await getMessages({});
    expect(result.messages).toEqual([]);
    expect(result.total).toBe(0);
  });
});

// ─── getMessage ───

describe('getMessage', () => {
  it('should return a specific message by id', async () => {
    const cache = {
      messages: [
        { id: 'msg-1', subject: 'Hello' },
        { id: 'msg-2', subject: 'World' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(cache));

    const result = await getMessage(VALID_UUID, 'msg-2');
    expect(result.subject).toBe('World');
    expect(result.accountId).toBe(VALID_UUID);
  });

  it('should return null when message not found', async () => {
    readFile.mockResolvedValue(JSON.stringify({ messages: [] }));
    const result = await getMessage(VALID_UUID, 'nonexistent');
    expect(result).toBeNull();
  });
});

// ─── deleteCache ───

describe('deleteCache', () => {
  it('should call unlink for valid accountId', async () => {
    unlink.mockResolvedValue();
    await deleteCache(VALID_UUID);
    expect(unlink).toHaveBeenCalledWith(expect.stringContaining(`${VALID_UUID}.json`));
  });

  it('should silently skip invalid accountId', async () => {
    await deleteCache('not-a-uuid');
    expect(unlink).not.toHaveBeenCalled();
  });
});

// ─── syncAccount ───

describe('syncAccount', () => {
  const mockIo = { emit: vi.fn() };

  beforeEach(() => {
    mockIo.emit.mockClear();
  });

  it('should return 400 when account is disabled', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Test', type: 'gmail', enabled: false });

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result).toEqual({ error: 'Account is disabled', status: 400 });
    expect(mockIo.emit).not.toHaveBeenCalled();
  });

  it('should return error when account not found', async () => {
    getAccount.mockResolvedValue(null);

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result).toEqual({ error: 'Account not found' });
  });

  it('should call syncGmail for gmail accounts and save cache', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ syncCursor: null, messages: [] }));
    syncGmail.mockResolvedValue([{ id: 'msg-1', externalId: 'ext-1', date: '2026-01-01' }]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(syncGmail).toHaveBeenCalled();
    expect(atomicWrite).toHaveBeenCalled();
    expect(result.newMessages).toBe(1);
    expect(result.total).toBe(1);
    expect(result.status).toBe('success');
    expect(updateSyncStatus).toHaveBeenCalledWith(VALID_UUID, 'success');
    expect(mockIo.emit).toHaveBeenCalledWith('messages:sync:started', { accountId: VALID_UUID, mode: 'unread' });
    expect(mockIo.emit).toHaveBeenCalledWith('messages:sync:completed', expect.objectContaining({ accountId: VALID_UUID, newMessages: 1 }));
    expect(mockIo.emit).toHaveBeenCalledWith('messages:changed', {});
  });

  it('should call syncPlaywright for outlook accounts with mode', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Outlook', type: 'outlook', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ syncCursor: null, messages: [] }));
    syncPlaywright.mockResolvedValue([]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo, { mode: 'full' });

    expect(syncPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'outlook' }),
      expect.any(Object),
      mockIo,
      { mode: 'full' }
    );
    expect(result.newMessages).toBe(0);
  });

  it('should call syncPlaywright for teams accounts', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Teams', type: 'teams', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ syncCursor: null, messages: [] }));
    syncPlaywright.mockResolvedValue([]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(syncPlaywright).toHaveBeenCalled();
  });

  it('should deduplicate by externalId during sync', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    const existingCache = {
      syncCursor: 'cur-1',
      messages: [{ id: 'msg-1', externalId: 'ext-1', date: '2026-01-01' }]
    };
    readFile.mockResolvedValue(JSON.stringify(existingCache));
    // Provider returns one duplicate and one new
    syncGmail.mockResolvedValue([
      { id: 'msg-1-dup', externalId: 'ext-1', date: '2026-01-01' },
      { id: 'msg-2', externalId: 'ext-2', date: '2026-01-02' }
    ]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result.newMessages).toBe(1);
    expect(result.total).toBe(2); // 1 existing + 1 new
    // Verify saved cache has 2 messages
    const savedData = atomicWrite.mock.calls[0][1];
    expect(savedData.messages).toHaveLength(2);
  });

  it('should keep messages without externalId (no dedup for those)', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ messages: [{ id: 'msg-1' }] }));
    syncGmail.mockResolvedValue([{ id: 'msg-2' }]); // no externalId
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result.newMessages).toBe(1);
    expect(result.total).toBe(2);
  });

  it('should trim messages when exceeding maxMessages', async () => {
    getAccount.mockResolvedValue({
      id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true,
      syncConfig: { maxMessages: 2 }
    });
    const existingCache = {
      messages: [
        { id: 'msg-old', externalId: 'ext-old', date: '2026-01-01' },
        { id: 'msg-mid', externalId: 'ext-mid', date: '2026-01-02' }
      ]
    };
    readFile.mockResolvedValue(JSON.stringify(existingCache));
    syncGmail.mockResolvedValue([
      { id: 'msg-new', externalId: 'ext-new', date: '2026-01-03' }
    ]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result.total).toBe(2); // trimmed from 3 to 2
    const savedData = atomicWrite.mock.calls[0][1];
    expect(savedData.messages).toHaveLength(2);
    // Oldest message should have been trimmed
    const ids = savedData.messages.map(m => m.id);
    expect(ids).toContain('msg-new');
    expect(ids).toContain('msg-mid');
    expect(ids).not.toContain('msg-old');
  });

  it('should handle structured provider result with status', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ messages: [] }));
    syncGmail.mockResolvedValue({ messages: [{ id: 'msg-1', externalId: 'ext-1' }], status: 'partial' });
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result.status).toBe('partial');
    expect(result.newMessages).toBe(1);
    expect(updateSyncStatus).toHaveBeenCalledWith(VALID_UUID, 'partial');
    // Should NOT emit messages:changed for non-success status
    expect(mockIo.emit).not.toHaveBeenCalledWith('messages:changed', {});
    expect(mockIo.emit).toHaveBeenCalledWith('messages:sync:completed', expect.objectContaining({ status: 'partial' }));
  });

  it('should return 409 when sync is already in progress (lock)', async () => {
    // Use a deferred promise to keep loadCache hanging so the lock stays held
    let resolveReadFile;
    getAccount.mockResolvedValue({ id: VALID_UUID_2, name: 'Gmail', type: 'gmail', enabled: true });
    // First readFile call (loadCache inside providerSync) hangs; subsequent calls resolve
    let callCount = 0;
    readFile.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise(resolve => { resolveReadFile = resolve; });
      }
      return Promise.resolve(JSON.stringify({ messages: [] }));
    });
    updateSyncStatus.mockResolvedValue();

    // Start first sync (don't await — it will hang on loadCache)
    const firstSync = syncAccount(VALID_UUID_2, mockIo);
    // Yield to let the first sync reach the lock point
    await new Promise(r => setImmediate(r));

    // Second sync should be rejected with 409
    const secondResult = await syncAccount(VALID_UUID_2, mockIo);
    expect(secondResult).toEqual({ error: 'Sync already in progress', status: 409 });

    // Clean up: resolve the hanging readFile so firstSync completes
    resolveReadFile(JSON.stringify({ messages: [] }));
    await firstSync;
  });

  it('should release lock after sync completes', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ messages: [] }));
    syncGmail.mockResolvedValue([]);
    updateSyncStatus.mockResolvedValue();

    await syncAccount(VALID_UUID, mockIo);
    // Second sync should work (lock released)
    const result = await syncAccount(VALID_UUID, mockIo);
    expect(result).not.toHaveProperty('status', 409);
  });

  it('should release lock and emit failed on provider error', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Err', type: 'badtype', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ messages: [] }));
    updateSyncStatus.mockResolvedValue();

    // 'badtype' triggers throw new Error('Unsupported account type: badtype')
    const result = await syncAccount(VALID_UUID, mockIo);

    expect(result).toEqual({ error: 'Unsupported account type: badtype', status: 502 });
    expect(updateSyncStatus).toHaveBeenCalledWith(VALID_UUID, 'error');
    expect(mockIo.emit).toHaveBeenCalledWith('messages:sync:failed', {
      accountId: VALID_UUID,
      error: 'Unsupported account type: badtype'
    });

    // Lock should be released — next sync should not get 409
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    const result2 = await syncAccount(VALID_UUID, mockIo);
    expect(result2).not.toHaveProperty('status', 409);
  });

  it('should work when io is null/undefined', async () => {
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    readFile.mockResolvedValue(JSON.stringify({ messages: [] }));
    syncGmail.mockResolvedValue([]);
    updateSyncStatus.mockResolvedValue();

    const result = await syncAccount(VALID_UUID, null);
    expect(result.newMessages).toBe(0);
  });
});

// ─── getSyncStatus ───

describe('getSyncStatus', () => {
  it('should return sync status for existing account', async () => {
    getAccount.mockResolvedValue({
      id: VALID_UUID, lastSyncAt: '2026-01-01T00:00:00Z', lastSyncStatus: 'success'
    });

    const result = await getSyncStatus(VALID_UUID);

    expect(result).toEqual({
      accountId: VALID_UUID,
      lastSyncAt: '2026-01-01T00:00:00Z',
      lastSyncStatus: 'success'
    });
  });

  it('should return null for nonexistent account', async () => {
    getAccount.mockResolvedValue(null);
    expect(await getSyncStatus(VALID_UUID)).toBeNull();
  });
});

// ─── refreshMessage (absent-vs-cleared body merge, #1826) ───

describe('refreshMessage', () => {
  // Mirror makeExternalId() in messageSync.js so a crafted detail entry matches
  // an existing cached message by externalId (exercising the in-place merge path).
  const makeExternalId = (date, sender, subject) =>
    'pw-' + createHash('md5').update(`${date}|${sender}|${subject}`).digest('hex').slice(0, 12);

  it('overwrites cached body with an empty extracted body (clear), not the stale text', async () => {
    const extId = makeExternalId('2026-01-01', 'Alice', 'Hi');
    readFile.mockResolvedValue(JSON.stringify({
      syncCursor: null,
      messages: [{ id: 'msg-1', externalId: extId, bodyText: 'stale body', from: { name: 'Alice' }, subject: 'Hi', date: '2026-01-01' }]
    }));
    getAccount.mockResolvedValue({ id: VALID_UUID, type: 'outlook' });
    refreshMessageDetail.mockResolvedValue([{ from: 'Alice', date: '2026-01-01', body: '' }]);

    const result = await refreshMessage(VALID_UUID, 'msg-1');

    const merged = result.find(m => m.externalId === extId);
    expect(merged.bodyText).toBe('');
    expect(merged.bodyFull).toBe(true);
  });

  it('keeps the cached body when the extracted body is absent (null/undefined)', async () => {
    const extId = makeExternalId('2026-01-01', 'Alice', 'Hi');
    readFile.mockResolvedValue(JSON.stringify({
      syncCursor: null,
      messages: [{ id: 'msg-1', externalId: extId, bodyText: 'keep me', from: { name: 'Alice' }, subject: 'Hi', date: '2026-01-01' }]
    }));
    getAccount.mockResolvedValue({ id: VALID_UUID, type: 'outlook' });
    refreshMessageDetail.mockResolvedValue([{ from: 'Alice', date: '2026-01-01' }]); // no body key

    const result = await refreshMessage(VALID_UUID, 'msg-1');

    const merged = result.find(m => m.externalId === extId);
    expect(merged.bodyText).toBe('keep me');
  });

  it('clears the original message body when the extracted body is empty (fallback path)', async () => {
    // No externalId on the cached message → it is not matched in the loop and
    // falls through to the original-message update (line ~284).
    readFile.mockResolvedValue(JSON.stringify({
      syncCursor: null,
      messages: [{ id: 'msg-1', bodyText: 'stale original', from: { name: 'Bob' }, subject: 'Re: x', date: '2026-02-01' }]
    }));
    getAccount.mockResolvedValue({ id: VALID_UUID, type: 'outlook' });
    refreshMessageDetail.mockResolvedValue([{ from: 'Carol', date: '2026-03-01', body: '' }]);

    const result = await refreshMessage(VALID_UUID, 'msg-1');

    const original = result.find(m => m.id === 'msg-1');
    expect(original.bodyText).toBe('');
  });
});

// ─── Per-account write-tail serialization (#2537) ───
// These prove the cache mutators (`updateMessageEvaluations`, `refreshMessage`)
// serialize against each other on the same account so two concurrent load→save
// regions can't clobber each other. The mock is stateful — reads see the last
// write — and each op takes a tick, so an UNSERIALIZED implementation would load
// stale state and lose the other op's update, failing these assertions.

describe('cache mutator serialization (#2537)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  // Wire readFile/atomicWrite to a shared in-memory cache so interleaved
  // load→save regions race exactly as they would on disk.
  function statefulCache(initial) {
    let stored = initial;
    readFile.mockImplementation(async () => {
      await tick();
      return JSON.stringify(stored);
    });
    atomicWrite.mockImplementation(async (_path, data) => {
      await tick();
      stored = data;
    });
    return () => stored;
  }

  it('serializes syncAccount against refreshMessage (both writes survive)', async () => {
    const getStored = statefulCache({
      messages: [{ id: 'msg-1', externalId: 'ext-1', from: { name: 'Ada' }, subject: 'Hi', date: '2026-01-01', bodyText: 'old' }],
    });
    getAccount.mockResolvedValue({ id: VALID_UUID, name: 'Gmail', type: 'gmail', enabled: true });
    updateSyncStatus.mockResolvedValue();
    // Sync appends a brand-new message (ext-2); refresh rewrites msg-1's body.
    syncGmail.mockResolvedValue([{ id: 'srv-2', externalId: 'ext-2', subject: 'New', date: '2026-01-02', from: { name: 'Bob' } }]);
    refreshMessageDetail.mockResolvedValue([{ from: 'Ada', date: '2026-01-01', body: 'refreshed body' }]);

    await Promise.all([
      syncAccount(VALID_UUID, null),
      refreshMessage(VALID_UUID, 'msg-1'),
    ]);

    const messages = getStored().messages;
    // Serialization preserves BOTH: the synced message AND the refreshed body.
    // An unserialized interleave drops whichever saved first.
    expect(messages.find((m) => m.externalId === 'ext-2')).toBeTruthy();
    expect(messages.find((m) => m.id === 'msg-1').bodyText).toBe('refreshed body');
  });

  it('serializes refreshMessage against updateMessageEvaluations (both writes survive)', async () => {
    const getStored = statefulCache({
      messages: [{ id: 'msg-1', from: { name: 'Ada' }, subject: 'Hi', date: '2026-01-01', bodyText: 'old' }],
    });
    readdir.mockImplementation(async () => [`${VALID_UUID}.json`]);
    getAccount.mockResolvedValue({ id: VALID_UUID, type: 'outlook' });
    refreshMessageDetail.mockResolvedValue([{ from: 'Ada', date: '2026-01-01', body: 'refreshed body' }]);

    // Body refresh and evaluation update both mutate msg-1 concurrently.
    await Promise.all([
      refreshMessage(VALID_UUID, 'msg-1'),
      updateMessageEvaluations({ 'msg-1': { score: 9 } }),
    ]);

    const msg1 = getStored().messages.find((m) => m.id === 'msg-1');
    // Serialization preserves BOTH writes; a clobber would drop one of them.
    expect(msg1.bodyText).toBe('refreshed body');
    expect(msg1.evaluation).toEqual({ score: 9 });
  });
});

describe('logMessageTouchpoints — candidate building (#2033)', () => {
  const account = { id: VALID_UUID, type: 'gmail', email: 'me@work.com' };

  beforeEach(() => {
    autoLogTouchpoints.mockClear();
    autoLogTouchpoints.mockResolvedValue({ created: 1, matched: 1 });
    mockTimezone = 'UTC';
  });

  it('builds a message candidate keyed per thread + day, excluding the account owner', async () => {
    await logMessageTouchpoints(account, [{
      id: 'm1',
      threadId: 'thread-9',
      subject: 'Lunch?',
      date: '2026-06-01T12:00:00Z',
      from: { name: 'Ada', email: 'ada@work.com' },
      to: ['me@work.com', 'grace@x.io'],
      cc: [],
    }]);

    expect(autoLogTouchpoints).toHaveBeenCalledTimes(1);
    const [candidates] = autoLogTouchpoints.mock.calls[0];
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      source: 'message',
      dedupeKey: `msg:${VALID_UUID}:thread-9:2026-06-01`,
      summary: 'Lunch?',
    });
    // Own address excluded; sender + other recipient remain.
    const emails = candidates[0].identities.map((i) => i.email).sort();
    expect(emails).toEqual(['ada@work.com', 'grace@x.io']);
  });

  it('falls back to the message id when there is no threadId', async () => {
    await logMessageTouchpoints(account, [{
      id: 'm2', subject: 'Hi', date: '2026-06-02T00:00:00Z',
      from: { name: 'Grace', email: 'grace@x.io' }, to: [], cc: [],
    }]);
    const [candidates] = autoLogTouchpoints.mock.calls[0];
    expect(candidates[0].dedupeKey).toBe(`msg:${VALID_UUID}:m2:2026-06-02`);
  });

  it('keeps a name-only participant so the matcher unique-name fallback applies', async () => {
    await logMessageTouchpoints(account, [{
      id: 'm4', subject: 'Hi', date: '2026-06-01T00:00:00Z',
      from: { name: 'Ada Lovelace', email: '' }, to: [], cc: [],
    }]);
    const [candidates] = autoLogTouchpoints.mock.calls[0];
    expect(candidates[0].identities).toEqual([{ email: '', name: 'Ada Lovelace' }]);
  });

  it('skips a message with no counterpart beyond the account owner', async () => {
    await logMessageTouchpoints(account, [{
      id: 'm3', date: '2026-06-01T00:00:00Z',
      from: { name: 'Me', email: 'me@work.com' }, to: ['me@work.com'], cc: [],
    }]);
    expect(autoLogTouchpoints).not.toHaveBeenCalled();
  });

  it('derives the dedupe day in the user local timezone, not UTC', async () => {
    // 03:00Z on Jun 2 is still Jun 1 (20:00) in America/Los_Angeles. The dedupe
    // day must be the LOCAL day (2026-06-01) so a same-local-evening thread that
    // straddles UTC midnight collapses to one touchpoint, matching cadence math.
    mockTimezone = 'America/Los_Angeles';
    await logMessageTouchpoints(account, [{
      id: 'm5', threadId: 'thread-tz', subject: 'Evening',
      date: '2026-06-02T03:00:00Z',
      from: { name: 'Ada', email: 'ada@work.com' }, to: [], cc: [],
    }]);
    const [candidates] = autoLogTouchpoints.mock.calls[0];
    expect(candidates[0].dedupeKey).toBe(`msg:${VALID_UUID}:thread-tz:2026-06-01`);
  });
});
