import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { chmodSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';
const mocks = vi.hoisted(() => ({ root: '', listConversations: vi.fn(), deleteEvents: vi.fn(), deleteAutoTouchpoints: vi.fn(), query: vi.fn() }));
vi.mock('../lib/fileUtils.js', async (original) => ({ ...await original(), dataPath: (...parts) => join(mocks.root, ...parts) }));
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), withTransaction: async (work) => work({ query: mocks.query }) }));
vi.mock('./humanActivity.js', () => ({ listConversations: mocks.listConversations, deleteEvents: mocks.deleteEvents }));
vi.mock('./tribe.js', () => ({ deleteAutoTouchpoints: mocks.deleteAutoTouchpoints }));
import { listConversations, setBlocklist, blockConversation, purgeConversation, readBlocklist, addBlockedHandles } from './signalManage.js';
beforeEach(() => {
  mocks.root = createTempDataRoot('signal-manage-');
  mocks.query.mockReset();
  mocks.deleteEvents.mockResolvedValue({ deleted: 2 });
  mocks.deleteAutoTouchpoints.mockResolvedValue({ touchpoints: 1, auditRows: 1 });
});
afterEach(() => { rmSync(mocks.root, { recursive: true, force: true }); vi.clearAllMocks(); });
it('lists distinct identifiers with normalized blocklist state, and saves handle/conversation exclusions', async () => {
  await setBlocklist({ handles: ['+1 (555) 123-4567'], conversationIds: ['group'] });
  mocks.listConversations.mockResolvedValue([
    { chatGuid: 'private', handle: '+15551234567' }, { chatGuid: 'group', handle: null }, { chatGuid: 'other' },
  ]);
  expect(await listConversations({ q: 'test' })).toMatchObject([
    { conversationId: 'private', blocked: true }, { conversationId: 'group', blocked: true }, { conversationId: 'other', blocked: false },
  ]);
  expect(mocks.listConversations).toHaveBeenCalledWith({ q: 'test', source: 'signal' });
});
it('blocks and purges both stores for the exact opaque identifier, including repeat purge requests', async () => {
  const conversationId = 'group:%_nested:chat';
  await blockConversation(conversationId, { purgeExisting: true });
  expect((await readBlocklist()).conversationIds).toEqual([conversationId]);
  expect(mocks.deleteEvents).toHaveBeenCalledWith({ source: 'signal', conversationId, client: { query: mocks.query } });
  expect(mocks.deleteAutoTouchpoints).toHaveBeenCalledWith({ signalConversationId: conversationId, client: { query: mocks.query } });
  await expect(purgeConversation(conversationId)).resolves.toMatchObject({ deleted: 2, touchpoints: 1 });
});

it('refuses to overwrite an unreadable blocklist or start a handle purge', async () => {
  const file = join(mocks.root, 'signal-blocklist.json');
  writeFileSync(file, '{truncated');
  const refused = { code: 'UNREADABLE_STORE' };
  await expect(setBlocklist({ handles: [], conversationIds: [] })).rejects.toMatchObject(refused);
  await expect(addBlockedHandles(['blocked@example.com'], { purgeExisting: true })).rejects.toMatchObject(refused);
  expect(readFileSync(file, 'utf8')).toBe('{truncated');
  expect(mocks.query).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('creates an owner-only blocklist and tightens existing permissions on updates', async () => {
  const file = join(mocks.root, 'signal-blocklist.json');
  await setBlocklist({ handles: ['blocked@example.com'], conversationIds: [] });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  chmodSync(file, 0o644);
  await addBlockedHandles('other@example.com');
  expect(statSync(file).mode & 0o777).toBe(0o600);
});

it('purges incoming and outgoing matches for an already-blocked handle and cleans up only emptied conversations', async () => {
  await setBlocklist({ handles: ['+15551234567'], conversationIds: ['excluded-group'] });
  const privateChat = 'private:%_:chat';
  mocks.query.mockResolvedValueOnce({ rows: [
    { id: 'received', conversation_id: privateChat, handle: '+1 (555) 123-4567', participants: [] },
    { id: 'sent', conversation_id: privateChat, handle: null, participants: [{ phone: '+15551234567' }] },
    { id: 'group-match', conversation_id: 'group', handle: '+15551234567', participants: [] },
    { id: 'group-other', conversation_id: 'group', handle: null, participants: [{ phone: '+15551234568' }] },
  ] }).mockResolvedValueOnce({ rows: [{ conversation_id: 'group' }] });
  mocks.deleteEvents.mockResolvedValueOnce({ deleted: 3 });

  const result = await addBlockedHandles(['+1 555 123 4567', '+15551234567'], { purgeExisting: true });
  expect(result).toMatchObject({ handles: ['+15551234567'], conversationIds: ['excluded-group'], added: [], purged: 3, touchpoints: 1 });
  expect(mocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining('WHERE source = $1'), ['signal']);
  expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining('WHERE source = $1'), ['signal', [privateChat, 'group']]);
  expect(mocks.deleteEvents).toHaveBeenCalledExactlyOnceWith({
    source: 'signal', ids: ['received', 'sent', 'group-match'], client: { query: mocks.query },
  });
  expect(mocks.deleteAutoTouchpoints).toHaveBeenCalledExactlyOnceWith({
    signalConversationId: privateChat, client: { query: mocks.query },
  });
});

it('adds normalized handles without touching the database when purge is omitted', async () => {
  await blockConversation('excluded-group');
  await expect(addBlockedHandles([' Blocked@Example.com ', 'blocked@example.com'])).resolves.toMatchObject({
    handles: ['blocked@example.com'], added: ['blocked@example.com'], conversationIds: ['excluded-group'], purged: 0, touchpoints: 0,
  });
  expect(mocks.query).not.toHaveBeenCalled();
});
