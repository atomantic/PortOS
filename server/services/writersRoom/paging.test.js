import { describe, it, expect, vi } from 'vitest';
vi.mock('../../lib/db.js', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
import { query } from '../../lib/db.js';
import { listOrderedWorkIds, readWorksPage } from './db.js';

describe('Postgres library paging', () => {
  it('captures ordered IDs without hydrating data and restricts draft reads to the selected live page', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    expect(await listOrderedWorkIds()).toEqual(['a', 'b', 'c']);
    expect(query.mock.calls[0][0]).toMatch(/SELECT id .*deleted = FALSE ORDER BY updated_at DESC, id ASC/);
    query.mockResolvedValueOnce({ rows: [{ id: 'b', data: { id: 'b', title: 'Example' } }] });
    query.mockResolvedValueOnce({ rows: [{ work_id: 'b', data: { id: 'draft-b' } }] });
    expect(await readWorksPage(['b', 'c'])).toEqual([{ id: 'b', title: 'Example', drafts: [{ id: 'draft-b' }] }]);
    expect(query.mock.calls[1][0]).toContain('LIMIT $2');
    expect(query.mock.calls[1][1]).toEqual([['b', 'c'], 2]);
    expect(query.mock.calls[2][1]).toEqual([['b']]);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
