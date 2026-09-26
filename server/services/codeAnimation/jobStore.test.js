import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/db.js', () => ({ query: vi.fn() }));

import { query } from '../../lib/db.js';
import { listCodeAnimationJobPage } from './jobStore.js';

beforeEach(() => vi.clearAllMocks());

describe('Code Animation persisted history', () => {
  it('uses the text-id keyset index and reads only one compact lookahead page', async () => {
    query.mockResolvedValue({ rows: [] });
    await listCodeAnimationJobPage({ limit: 50, cursor: {
      createdAt: '2026-01-01T00:00:00.000Z', id: '00000000-0000-4000-8000-000000000001',
    } });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('(created_at, id) < ($1::timestamptz, $2::text)');
    expect(sql).toContain("LEFT(concept, 120)");
    expect(params).toEqual(['2026-01-01T00:00:00.000Z', '00000000-0000-4000-8000-000000000001', 51]);
  });
});
