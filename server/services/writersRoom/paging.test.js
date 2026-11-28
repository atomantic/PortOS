import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../../lib/db.js';
import { listOrderedWorkIds, listWorkSummaries } from './db.js';

describe('Postgres library paging', () => {
  it('captures ordered IDs without hydrating data and restricts draft reads to the selected live page', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(await listOrderedWorkIds()).toEqual(['a', 'b', 'c']);
    expect(query.mock.calls[0][0]).toMatch(/SELECT id .*deleted = FALSE ORDER BY updated_at DESC, id ASC/);
    query.mockResolvedValueOnce({ rows: [{ summary: { id: 'b', title: 'Example' }, draft_count: 2, word_count: 34 }] });
    expect(await listWorkSummaries(['b', 'c'])).toEqual([
      expect.objectContaining({ id: 'b', title: 'Example', draftCount: 2, wordCount: 34 }),
    ]);
    expect(query.mock.calls[1][0]).toContain('w.id = ANY($2::text[])');
    expect(query.mock.calls[1][1][1]).toEqual(['b', 'c']);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
