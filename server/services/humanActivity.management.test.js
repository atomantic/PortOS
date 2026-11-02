import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../lib/db.js';
import { deleteEvents, listEvents, listConversations, sourceStats } from './humanActivity.js';
beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }); });
it('groups and counts Signal conversations by the stored conversation identifier', async () => {
  query.mockResolvedValueOnce({ rows: [{ chat_guid: 'first', event_count: 2 }, { chat_guid: 'second', event_count: 1 }] });
  expect(await listConversations({ source: 'signal' })).toMatchObject([{ chatGuid: 'first' }, { chatGuid: 'second' }]);
  const grouping = "COALESCE(NULLIF(metadata->>'chatGuid', ''), NULLIF(metadata->>'conversationId', ''), CASE WHEN source = 'whatsapp' THEN COALESCE(NULLIF(metadata->>'chatScope', ''), NULLIF(metadata->>'chatTitle', '')) END, '')";
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

it('uses the same WhatsApp identity for grouping, search, counts, filtering and selective purge', async () => {
  await listConversations({ source: 'whatsapp', q: 'family' });
  const sql = query.mock.calls[0][0];
  const identity = sql.match(/GROUP BY (.+)\n/)[1];
  expect(identity).toContain("NULLIF(metadata->>'conversationId', '')");
  expect(identity).toContain("CASE WHEN source = 'whatsapp' THEN COALESCE(NULLIF(metadata->>'chatScope', ''), NULLIF(metadata->>'chatTitle', '')) END");
  expect(sql).toContain(`LOWER(${identity}) LIKE $2`);
  await sourceStats('whatsapp');
  expect(query.mock.calls[1][0]).toContain(`COUNT(DISTINCT ${identity})`);
  await listEvents({ source: 'whatsapp', conversationId: 'family:%_' });
  expect(query.mock.calls[2][0]).toContain(`${identity} = $2`);
  await listEvents({ source: 'whatsapp', chatGuid: 'family:%_' });
  expect(query.mock.calls[3][0]).toContain(`${identity} = $2`);
  query.mockResolvedValueOnce({ rowCount: 2 });
  expect(await deleteEvents({ source: 'whatsapp', conversationId: 'family:%_' })).toEqual({ deleted: 2 });
  expect(query.mock.calls[4]).toEqual([expect.stringContaining(`source = $1 AND ${identity} = $2`), ['whatsapp', 'family:%_']]);
  await deleteEvents({ source: 'whatsapp', chatGuid: 'family:%_' });
  expect(query.mock.calls[5][0]).toContain(`${identity} = $2`);
});
