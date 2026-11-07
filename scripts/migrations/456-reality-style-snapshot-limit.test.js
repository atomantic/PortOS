import { beforeEach, expect, it, vi } from 'vitest';
import { assembleUniverseStyleText } from '../../server/lib/universeVisualStyle.js';
import { REALITY_STARTER_V1 } from '../../server/lib/realityStarterV1.js';
import { REALITY_STARTER_V2 } from '../../server/lib/realityStarterV2.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../server/lib/db.js', () => ({ withTransaction: fn => fn({ query }) }));
import migration from './456-reality-style-snapshot-limit.js';

beforeEach(() => query.mockReset());

it('preserves oversized customized Reality style notes during upgrade', async () => {
  const data = {
    id: 'universe-reality',
    name: 'Reality',
    factual: true,
    styleNotes: 'Do not impose a permanent gloomy palette, flattering beauty key or polished cinematic rim light. Analog images should resemble actual film capture, without decorative borders, fake scratches or light-leak overlays. ' + 'x'.repeat(3200),
    influences: { embrace: ['embrace '.repeat(60)], avoid: ['avoid '.repeat(30)] },
    visualProfile: structuredClone(REALITY_STARTER_V2.visualProfile),
  };
  const originalLength = assembleUniverseStyleText(data).length;
  expect(originalLength).toBeGreaterThan(4000);

  query.mockResolvedValueOnce({ rows: [{ data, deleted: false }] }).mockResolvedValueOnce({});
  await migration.up();

  expect(query.mock.calls.some(([sql]) => /UPDATE|DELETE|INSERT/.test(sql))).toBe(false);
  expect(assembleUniverseStyleText(data).length).toBe(originalLength);
});

it.each([REALITY_STARTER_V1, REALITY_STARTER_V2])('shipped Reality defaults already fit without shortening', starter => {
  expect(assembleUniverseStyleText({ name: 'Reality', ...starter }).length).toBeLessThanOrEqual(4000);
});
