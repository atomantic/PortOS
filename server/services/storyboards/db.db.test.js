import { afterAll, describe, expect, it, vi } from 'vitest';
import * as database from '../../lib/db.js';
import { checkHealth, close, ensureSchema, query, withTransaction } from '../../lib/db.js';
import { requireDbOrSkip } from '../../lib/dbTestGate.js';
import { toPgJson } from '../../lib/pgJson.js';
import { sanitizeStoryboard } from '../../lib/storyboardRecord.js';
import { up as backfillStoryboardSummaries } from '../../scripts/db-migrations/037-storyboard-list-summaries.js';
import { listSummaries, listSummaryPage, writeRaw } from './db.js';

const health = await checkHealth();
const runDb = requireDbOrSkip('storyboards/db.db.test', health.connected, health.error);
if (runDb) await ensureSchema();
afterAll(close);

describe.skipIf(!runDb)('PostgreSQL storyboard list', () => {
  it('projects a current write and a backfilled board, and reads the latest data after a legacy write', async () => {
    const createdAt = '2026-01-01T00:00:00.000Z';
    const legacy = {
      id: 'sb-list-legacy',
      name: 'Legacy board',
      createdAt,
      updatedAt: '2999-01-01T00:00:00.000Z',
      beats: [{ id: 'beat-legacy', panels: [{
        id: 'panel-legacy', seconds: 2.456, takes: [{ id: 'take-legacy', source: 'sketch', sketchKey: 'sketch:example-key' }],
      }] }],
    };
    const current = sanitizeStoryboard({ id: 'sb-list-current', name: 'Current board', createdAt, updatedAt: legacy.updatedAt });
    const deleted = sanitizeStoryboard({ ...legacy, id: 'sb-list-tombstoned', deleted: true, deletedAt: legacy.updatedAt });
    const ids = [legacy.id, current.id, deleted.id];
    await query('DELETE FROM storyboards WHERE id = ANY($1)', [ids]);
    const read = vi.spyOn(database, 'query');
    try {
      await query('INSERT INTO storyboards (id, name, data, updated_at) VALUES ($1, $2, $3::jsonb, $4)',
        [legacy.id, legacy.name, toPgJson(legacy), legacy.updatedAt]);
      await withTransaction(backfillStoryboardSummaries);
      await writeRaw(current.id, current);
      await writeRaw(deleted.id, deleted);

      read.mockClear();
      const first = await listSummaryPage({ limit: 2, offset: 0 });
      expect(first.items).toEqual([
        { id: current.id, name: current.name, logline: '', aspectRatio: '16:9', source: null,
          beatCount: 0, panelCount: 0, runtimeSec: 0, cover: null, updatedAt: current.updatedAt },
        { id: legacy.id, name: legacy.name, logline: '', aspectRatio: '16:9', source: null,
          beatCount: 1, panelCount: 1, runtimeSec: 2.46, cover: { image: null, sketchKey: 'sketch:example-key' }, updatedAt: legacy.updatedAt },
      ]);
      expect(await read.mock.results[0].value).toMatchObject({ rows: [
        { list_summary: first.items[0], legacy_data: null },
        { list_summary: first.items[1], legacy_data: null },
      ] });

      expect((await listSummaries()).slice(0, 2)).toEqual(first.items);
      expect(await listSummaryPage({ limit: 1, offset: 1 })).toEqual({ items: [first.items[1]], total: first.total });

      await query('UPDATE storyboards SET data = $2::jsonb WHERE id = $1',
        [current.id, toPgJson({ ...current, name: 'Renamed by earlier build' })]);
      expect(await listSummaryPage({ limit: 1, offset: 0 })).toEqual({
        items: [{ ...first.items[0], name: 'Renamed by earlier build' }], total: first.total,
      });

      await writeRaw(current.id, { ...current, name: 'Renamed by current build' });
      expect(await listSummaryPage({ limit: 1, offset: 0 })).toEqual({
        items: [{ ...first.items[0], name: 'Renamed by current build' }], total: first.total,
      });
    } finally {
      read.mockRestore();
      await query('DELETE FROM storyboards WHERE id = ANY($1)', [ids]);
    }
  });
});
