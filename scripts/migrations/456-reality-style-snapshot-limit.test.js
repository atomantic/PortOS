import { beforeEach, expect, it, vi } from 'vitest';
import { assembleUniverseStyleText } from '../../server/lib/universeVisualStyle.js';
import { naturalUniverseVisualProfile } from '../../server/lib/universeVisualProfile.js';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../server/lib/db.js', () => ({ withTransaction: fn => fn({ query }) }));
import migration from './456-reality-style-snapshot-limit.js';

beforeEach(() => query.mockReset());

it('trims Reality style notes when assembled style exceeds limit and updates under a row lock', async () => {
  const data = {
    id: 'universe-reality',
    name: 'Reality',
    factual: true,
    styleNotes: 'Do not impose a permanent gloomy palette, flattering beauty key or polished cinematic rim light. Analog images should resemble actual film capture, without decorative borders, fake scratches or light-leak overlays. ' + 'x'.repeat(3200),
    influences: { embrace: ['embrace '.repeat(60)], avoid: ['avoid '.repeat(30)] },
    visualProfile: naturalUniverseVisualProfile(),
  };
  const originalLength = assembleUniverseStyleText(data).length;
  expect(originalLength).toBeGreaterThan(4000);

  query.mockResolvedValueOnce({ rows: [{ data, deleted: false }] }).mockResolvedValueOnce({});
  await migration.up();

  expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  expect(query.mock.calls[1][0]).toContain('UPDATE universes SET');
  const updated = JSON.parse(query.mock.calls[1][1][1]);
  expect(assembleUniverseStyleText(updated).length).toBeLessThanOrEqual(4000);
});

it.each([
  { deleted: true },
  { name: 'Other' },
  { styleNotes: 'Short notes' },
])('preserves universes that do not need shortening or are deleted: %j', async (patch) => {
  const data = { id: 'universe-reality', name: 'Reality', factual: true, styleNotes: 'Brief', ...patch };
  query.mockResolvedValue({ rows: [{ data, deleted: !!patch.deleted }] });
  await migration.up();
  expect(query).toHaveBeenCalledTimes(1);
});
