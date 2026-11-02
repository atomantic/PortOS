import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../lib/db.js', () => ({ ensureSchema: vi.fn(), query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../lib/db.js';
import { deleteEvents, listEvents, listConversations, sourceStats } from './humanActivity.js';
beforeEach(() => { query.mockReset().mockResolvedValue({ rows: [], rowCount: 0 }); });
it('groups and counts Signal conversations by the stored conversation identifier', async () => {
  query.mockResolvedValueOnce({ rows: [{ chat_guid: 'first', event_count: 2 }, { chat_guid: 'second', event_count: 1 }] });
  expect(await listConversations({ source: 'signal' })).toMatchObject([{ chatGuid: 'first' }, { chatGuid: 'second' }]);
  const grouping = query.mock.calls[0][0].split('GROUP BY ')[1].split('\n     ORDER BY')[0];

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

it('guards ambiguous raw WhatsApp deletion and uses typed management selectors', async () => {
  await deleteEvents({ source: 'whatsapp', conversationId: 'family:%_' });
  expect(query.mock.calls[0][0]).toContain('COUNT(DISTINCT CASE');
  expect(query.mock.calls[0][1]).toEqual(['whatsapp', 'family:%_']);
  await listEvents({ source: 'whatsapp', chatGuid: '["scope", "family"]' });
  expect(query.mock.calls[1][0]).toContain('jsonb_build_array(');
  expect(query.mock.calls[1][1]).toEqual(['whatsapp', '["scope", "family"]', 500]);
});

// The selector returned to the management UI must target the same records when
// viewing or purging a channel, including imports predating conversationId.
it('uses the Discord channel fallback consistently for listing, viewing and purging', async () => {
  query.mockResolvedValueOnce({ rows: [{ chat_guid: 'channel-a' }, { chat_guid: 'channel-b' }] });
  const conversations = await listConversations({ source: 'discord', q: 'channel' });
  expect(conversations.map(({ chatGuid }) => chatGuid)).toEqual(['channel-a', 'channel-b']);
  const listing = query.mock.calls[0][0];
  const selector = "COALESCE(NULLIF(metadata->>'chatGuid', ''), NULLIF(metadata->>'conversationId', ''), NULLIF(metadata->>'channelId', ''), '')";
  const grouping = listing.split('GROUP BY ')[1].split('\n     ORDER BY')[0];
  expect(grouping).toContain(`WHEN source = 'discord' THEN ${selector}`);
  expect(listing).toContain(`LOWER(${grouping})`);
  await sourceStats('discord');
  expect(query.mock.calls[1][0]).toContain(`COUNT(DISTINCT ${grouping})`);
  for (const field of ['chatGuid', 'conversationId']) {
    await listEvents({ source: 'discord', [field]: conversations[0].chatGuid });
    expect(query.mock.lastCall).toEqual([expect.stringContaining(`source = $1 AND ${selector} = $2`), ['discord', 'channel-a', 500]]);
    query.mockResolvedValueOnce({ rowCount: 2 });
    expect(await deleteEvents({ source: 'discord', [field]: conversations[0].chatGuid })).toEqual({ deleted: 2 });
    expect(query.mock.lastCall).toEqual([expect.stringContaining(`source = $1 AND ${selector} = $2`), ['discord', 'channel-a']]);
  }
  await listEvents({ source: 'signal', conversationId: 'channel-a' });
  expect(query.mock.lastCall[0]).not.toContain("metadata->>'channelId'");
});
