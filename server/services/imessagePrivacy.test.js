import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';

const mocks = vi.hoisted(() => ({
  root: '',
  deleteEvents: vi.fn(),
  deleteAutoTouchpoints: vi.fn(),
  query: vi.fn(),
  lockEntries: [],
}));
// Real serialization, plus a record of every entry so a mutation that stops
// taking the lock fails deterministically (a negative timing proof would not).
vi.mock('../lib/createKeyCachedQueue.js', async (original) => {
  const { createKeyCachedQueue } = await original();
  return {
    createKeyCachedQueue: () => {
      const queue = createKeyCachedQueue();
      return (key, work) => { mocks.lockEntries.push(key); return queue(key, work); };
    },
  };
});
vi.mock('../lib/fileUtils.js', async (original) => ({ ...await original(), dataPath: (...parts) => join(mocks.root, ...parts) }));
vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn(),
  withTransaction: async (work) => work({ query: mocks.query }),
}));
vi.mock('./humanActivity.js', () => ({ deleteEvents: mocks.deleteEvents, listConversations: vi.fn() }));
vi.mock('./tribe.js', () => ({ deleteAutoTouchpoints: mocks.deleteAutoTouchpoints }));
vi.mock('./imessageSync.js', () => ({ getStatus: vi.fn() }));

import { setBlocklist, addToBlocklist, removeFromBlocklist, readBlocklist, purgeConversation, deleteEvent, encodeChatKey } from './imessageManage.js';
import { withImessagePrivacyLock } from './imessagePrivacy.js';

const file = () => join(mocks.root, 'imessage-blocklist.json');

beforeEach(() => {
  mocks.root = createTempDataRoot('imessage-privacy-');
  mocks.lockEntries.length = 0;
  mocks.deleteEvents.mockResolvedValue({ deleted: 0 });
  mocks.deleteAutoTouchpoints.mockResolvedValue({ touchpoints: 0, auditRows: 0 });
  mocks.query.mockResolvedValue({ rows: [] });
});
afterEach(() => { rmSync(mocks.root, { recursive: true, force: true }); vi.clearAllMocks(); });

describe('unreadable blocklist fails closed on every read and mutation', () => {
  const corrupt = [
    ['malformed JSON', '{truncated'],
    ['empty file', ''],
    ['non-array handles', JSON.stringify({ handles: 'not-an-array' })],
    ['non-string handle entries', JSON.stringify({ handles: [42] })],
  ];
  for (const [label, bytes] of corrupt) {
    it(`${label}: readBlocklist and all writers refuse and leave the bytes untouched`, async () => {
      writeFileSync(file(), bytes);
      const refused = { code: 'UNREADABLE_STORE' };
      await expect(readBlocklist()).rejects.toMatchObject(refused);
      await expect(setBlocklist(['spam@example.com'])).rejects.toMatchObject(refused);
      await expect(addToBlocklist(['spam@example.com'], { purgeExisting: true })).rejects.toMatchObject(refused);
      await expect(removeFromBlocklist('spam@example.com')).rejects.toMatchObject(refused);
      expect(readFileSync(file(), 'utf8')).toBe(bytes);
      expect(mocks.query).not.toHaveBeenCalled();
    });
  }

  it('an absent file is a legitimate empty list, and a repaired file is accepted again', async () => {
    expect(await readBlocklist()).toMatchObject({ handles: [] });
    writeFileSync(file(), '{truncated');
    await expect(readBlocklist()).rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    writeFileSync(file(), JSON.stringify({ handles: ['Spam@Example.com'] }));
    expect((await readBlocklist()).handles).toEqual(['spam@example.com']);
  });
});

describe('privacy mutations serialize', () => {
  it('concurrent add/remove/set calls do not drop each other\'s updates', async () => {
    await setBlocklist(['gone@example.com']);
    await Promise.all([
      addToBlocklist(['a@example.com']),
      addToBlocklist(['+1 555 123 4567']),
      removeFromBlocklist('gone@example.com'),
      addToBlocklist(['b@example.com']),
    ]);
    expect((await readBlocklist()).handles).toEqual(['+15551234567', 'a@example.com', 'b@example.com']);
  });

  it('every blocklist/purge/delete mutation takes the shared privacy lock; plain reads do not', async () => {
    await readBlocklist();
    expect(mocks.lockEntries).toEqual([]);
    const mutations = [
      () => setBlocklist(['a@example.com']),
      () => addToBlocklist(['b@example.com']),
      () => removeFromBlocklist('b@example.com'),
      () => purgeConversation(encodeChatKey('chat-1')),
      () => deleteEvent('event-1'),
    ];
    for (const mutate of mutations) {
      mocks.lockEntries.length = 0;
      await mutate();
      expect(mocks.lockEntries).toEqual(['imessage']);
    }
  });

  it('purgeConversation runs only after an in-flight lock holder (e.g. a sync pass) finishes', async () => {
    const order = [];
    const { promise: gate, resolve: release } = Promise.withResolvers();
    mocks.deleteEvents.mockImplementation(async () => { order.push('purge'); return { deleted: 0 }; });
    const sync = withImessagePrivacyLock(async () => { await gate; order.push('sync-done'); });
    const purge = purgeConversation(encodeChatKey('chat-1'));
    release();
    await Promise.all([sync, purge]);
    expect(order).toEqual(['sync-done', 'purge']);
    expect(mocks.deleteEvents).toHaveBeenCalledWith({ source: 'imessage', chatGuid: 'chat-1', client: { query: mocks.query } });
    expect(mocks.deleteAutoTouchpoints).toHaveBeenCalledWith({ dedupePrefix: 'imsg:chat-1:', client: { query: mocks.query } });
  });
});
