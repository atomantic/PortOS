import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createTempDataRoot } from '../lib/mockPathsDataRoot.js';
const mocks = vi.hoisted(() => ({ root: '', listConversations: vi.fn(), deleteEvents: vi.fn(), deleteAutoTouchpoints: vi.fn() }));
vi.mock('../lib/fileUtils.js', async (original) => ({ ...await original(), dataPath: (...parts) => join(mocks.root, ...parts) }));
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), withTransaction: async (work) => work({ query: 'transaction-client' }) }));
vi.mock('./humanActivity.js', () => ({ listConversations: mocks.listConversations, deleteEvents: mocks.deleteEvents }));
vi.mock('./tribe.js', () => ({ deleteAutoTouchpoints: mocks.deleteAutoTouchpoints }));
import { listConversations, setBlocklist, blockConversation, purgeConversation, readBlocklist } from './signalManage.js';
beforeEach(() => {
  mocks.root = createTempDataRoot('signal-manage-');
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
  expect(mocks.deleteEvents).toHaveBeenCalledWith({ source: 'signal', conversationId, client: { query: 'transaction-client' } });
  expect(mocks.deleteAutoTouchpoints).toHaveBeenCalledWith({ signalConversationId: conversationId, client: { query: 'transaction-client' } });
  await expect(purgeConversation(conversationId)).resolves.toMatchObject({ deleted: 2, touchpoints: 1 });
});
