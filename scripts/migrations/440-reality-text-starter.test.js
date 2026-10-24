import { beforeEach, expect, it, vi } from 'vitest';
import { REALITY_STARTER_V1 } from '../../server/lib/realityStarterV1.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../server/lib/db.js', () => ({ withTransaction: fn => fn({ query }) }));
import migration from './440-reality-text-starter.js';
beforeEach(() => query.mockReset());

it('fills blank shipped text atomically while preserving local canon and media', async () => {
  const data = { id: 'universe-reality', name: 'Reality', starterPrompt: '', factual: true, characters: [{ id: 'local' }], styleImageRefs: ['local.jpg'] };
  query.mockResolvedValueOnce({ rows: [{ data, deleted: false }] }).mockResolvedValueOnce({});
  await migration.up();
  expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  const saved = JSON.parse(query.mock.calls[1][1][1]);
  expect(saved).toMatchObject({ ...data, ...REALITY_STARTER_V1 });
  expect(saved.updatedAt).toBe(query.mock.calls[1][1][2]);
});

it.each([
  undefined,
  { data: {}, deleted: true },
  { data: { deleted: true } },
  { data: { name: 'Personal world', factual: true } },
  { data: { name: 'Reality', factual: false } },
  { data: { premise: 'My own world' } },
  { data: { negativePrompt: 'My legacy style' } },
  { data: { influences: { embrace: ['personal style'] } } },
  { data: { locked: { premise: true } } },
])('preserves absent, deleted or customized Reality: %j', async row => {
  query.mockResolvedValue({ rows: row ? [{ ...row, data: { name: 'Reality', factual: true, ...row.data } }] : [] });
  await migration.up();
  expect(query).toHaveBeenCalledTimes(1);
});
