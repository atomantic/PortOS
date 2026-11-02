import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../lib/db.js';
import { deleteEvents, listConversations, sourceStats } from './humanActivity.js';
beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }); });
it('groups and counts Signal conversations by the stored conversation identifier', async () => {
  query.mockResolvedValueOnce({ rows: [{ chat_guid: 'first', event_count: 2 }, { chat_guid: 'second', event_count: 1 }] });
  expect(await listConversations({ source: 'signal' })).toMatchObject([{ chatGuid: 'first' }, { chatGuid: 'second' }]);
  const grouping = "COALESCE(NULLIF(metadata->>'chatGuid', ''), metadata->>'conversationId', '')";
  expect(query.mock.calls[0][0]).toContain(`GROUP BY ${grouping}`);
  await sourceStats('signal');
  expect(query.mock.calls[1][0]).toContain(`COUNT(DISTINCT ${grouping})`);
});
it('deletes only exact source-scoped conversation IDs and refuses an unscoped conversation delete', async () => {
  await deleteEvents({ conversationId: 'opaque:%_id' });
  expect(query).not.toHaveBeenCalled();
  query.mockResolvedValueOnce({ rowCount: 2 });
  expect(await deleteEvents({ source: 'signal', conversationId: 'opaque:%_id' })).toEqual({ deleted: 2 });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("source = $1 AND metadata->>'conversationId' = $2"), ['signal', 'opaque:%_id']);
});
