import { beforeEach, expect, it, vi } from 'vitest';
import { REALITY_STARTER_V1 } from '../../server/lib/realityStarterV1.js';
import { REALITY_STARTER_V2 } from '../../server/lib/realityStarterV2.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../server/lib/db.js', () => ({ withTransaction: fn => fn({ query }) }));
import migration from './447-reality-analog-starter.js';
beforeEach(() => query.mockReset());

it('upgrades exact shipped V1 defaults under a row lock and preserves canon and media', async () => {
  const data = { id: 'universe-reality', name: 'Reality', factual: true, ...structuredClone(REALITY_STARTER_V1), characters: [{ id: 'example-character' }], styleImageRefs: ['example.png'] };
  data.influences = Object.fromEntries(Object.entries(data.influences).reverse());
  query.mockResolvedValueOnce({ rows: [{ data, deleted: false }] }).mockResolvedValueOnce({});
  await migration.up();
  expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  expect(JSON.parse(query.mock.calls[1][1][1])).toMatchObject({ ...data, ...REALITY_STARTER_V2 });
});

it.each([
  { deleted: true }, { styleNotes: 'My own photography' }, { locked: { influencesEmbrace: true } }, { visualProfile: { version: 1 } },
])('preserves customization, locks, explicit profiles and tombstones: %j', async patch => {
  const data = { id: 'universe-reality', name: 'Reality', factual: true, ...structuredClone(REALITY_STARTER_V1), ...patch };
  query.mockResolvedValue({ rows: [{ data, deleted: false }] });
  await migration.up();
  expect(query).toHaveBeenCalledTimes(1);
});
