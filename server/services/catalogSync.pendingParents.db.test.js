/**
 * #8683: real FK/LWW behavior through the public sync apply boundary.
 * Only runs against the guarded test DB. Each test owns uniquely named rows.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { PORTOS_SCHEMA_VERSIONS } from '../lib/schemaVersions.js';
import { applyRemoteChanges } from './catalogSync.js';
import { getScrap, listScraps } from './catalogDB/scraps.js';
import { up as migrateInbox } from '../scripts/db-migrations/011-catalog-pending-applies.js';

const health = await checkHealth();
const ready = requireDbOrSkip('catalogSync.pendingParents', health.connected, health.error);
if (ready) await ensureSchema();
const prefix = `pending-test-${randomUUID()}`;
const clock = '2026-01-01T00:00:00.000Z';
const later = '2026-01-02T00:00:00.000Z';
const envelope = (kind, rows) => ({
  [kind]: rows, portosMeta: { schemaVersions: PORTOS_SCHEMA_VERSIONS },
});
const childRow = (kind, id, parentId, updatedAt = clock) => kind === 'tags'
  ? { id, label: id, description: 'Child description', color: '#112233', parentId, createdAt: clock, updatedAt }
  : { id, title: id, rawText: 'Example chunk text', metadata: { example: true }, chunkIndex: 1,
      parentScrapId: parentId, createdAt: clock, updatedAt };
const tableFor = (kind) => kind === 'tags' ? 'catalog_tags' : 'catalog_scraps';
const parentFor = (kind) => kind === 'tags' ? 'parent_id' : 'parent_scrap_id';
const saved = async (kind, id) => (await query(`SELECT * FROM ${tableFor(kind)} WHERE id = $1`, [id])).rows[0];
const pending = async (id) => (await query('SELECT * FROM catalog_pending_applies WHERE id = $1', [id])).rows;

afterAll(async () => {
  if (!ready) return;
  await query('DELETE FROM catalog_pending_applies WHERE id LIKE $1', [`${prefix}%`]);
  await query('DELETE FROM catalog_tags WHERE id LIKE $1', [`${prefix}%`]);
  await query('DELETE FROM catalog_scraps WHERE id LIKE $1', [`${prefix}%`]);
  await close();
});

describe.skipIf(!ready)('durable Catalog parent deferral', () => {
  it.each(['tags', 'scraps'])('reaches a later %s page after deferral and recovers in a fresh process', async (kind) => {
    const id = `${prefix}-${kind}-paged-child`;
    const parentId = `${id}-parent`;
    const child = childRow(kind, id, parentId);
    // Re-running the additive migration must not discard deferred payloads.
    const pageOne = await applyRemoteChanges(envelope(kind, [child]));
    expect(pageOne[kind]).toMatchObject({ failed: 0, deferred: 1, inserted: 0, updated: 0 });
    expect(await saved(kind, id)).toBeUndefined();
    expect((await pending(id))[0].payload).toEqual(child);
    await migrateInbox({ query });
    expect((await pending(id))[0].payload).toEqual(child);
    if (kind === 'scraps') {
      expect(await getScrap(id)).toBeNull();
      expect((await listScraps({ limit: 10000 })).items.some((row) => row.id === id)).toBe(false);
    }

    // failed=0 lets the real pull caller advance this kind's page cursor.
    // A fresh Node process has no module state from page one; it receives ONLY
    // the later parent page, with no replay or source edit of the child.
    const parent = childRow(kind, parentId, null, later);
    const code = `
      import { applyRemoteChanges } from './services/catalogSync.js';
      import { close } from './lib/db.js';
      try { await applyRemoteChanges(JSON.parse(process.argv[1])); }
      finally { await close(); }
    `;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(envelope(kind, [parent]))], {
      cwd: new URL('..', import.meta.url), timeout: 20000,
      env: { ...process.env, NODE_ENV: 'test', PGDATABASE: process.env.PGDATABASE },
    });
    const stored = await saved(kind, id);
    expect(stored[parentFor(kind)]).toBe(parentId);
    expect(stored.updated_at.toISOString()).toBe(clock);
    if (kind === 'scraps') {
      expect(stored.chunk_index).toBe(1);
      expect(stored.raw_text).toBe(child.rawText);
    } else {
      expect(stored.description).toBe(child.description);
      expect(stored.color).toBe(child.color);
    }
    expect(await pending(id)).toEqual([]);
    const replay = await applyRemoteChanges(envelope(kind, [child, parent]));
    expect(replay[kind]).toMatchObject({ failed: 0, inserted: 0, updated: 0, skipped: 2 });
    expect((await saved(kind, id))[parentFor(kind)]).toBe(parentId);
  });

  it.each(['tags', 'scraps'])('coalesces %s replays and lets a newer local edit supersede pending data', async (kind) => {
    const id = `${prefix}-${kind}-stale-child`;
    const child = childRow(kind, id, `${id}-parent`);
    await applyRemoteChanges(envelope(kind, [child, { ...child, updatedAt: later }, child]));
    expect(await pending(id)).toHaveLength(1);
    expect((await pending(id))[0].payload.updatedAt).toBe(later);

    // Simulate a local record edit before the pending parent arrives. It must
    // retain its newer content AND deliberate parent removal.
    if (kind === 'tags') {
      await query('INSERT INTO catalog_tags (id, label, updated_at) VALUES ($1, $2, $3)',
        [id, 'Newer local label', '2026-01-03T00:00:00Z']);
    } else {
      await query('INSERT INTO catalog_scraps (id, raw_text, updated_at) VALUES ($1, $2, $3)',
        [id, 'Newer local text', '2026-01-03T00:00:00Z']);
    }
    await applyRemoteChanges({});
    expect(await pending(id)).toEqual([]);
    const stored = await saved(kind, id);
    expect(stored[parentFor(kind)]).toBeNull();
    expect(kind === 'tags' ? stored.label : stored.raw_text).toBe(kind === 'tags' ? 'Newer local label' : 'Newer local text');
  });

  it('drains a multilevel hierarchy and recovers an apply committed before inbox acknowledgement', async () => {
    const ids = ['leaf', 'middle', 'root'].map((part) => `${prefix}-chain-${part}`);
    await applyRemoteChanges(envelope('tags', [childRow('tags', ids[0], ids[1]), childRow('tags', ids[1], ids[2])]));
    await applyRemoteChanges(envelope('tags', [childRow('tags', ids[2], null)]));
    expect((await saved('tags', ids[0])).parent_id).toBe(ids[1]);
    expect((await saved('tags', ids[1])).parent_id).toBe(ids[2]);
    const row = childRow('tags', ids[0], ids[1]);
    await query(
      'INSERT INTO catalog_pending_applies (kind, id, parent_id, source_updated_at, payload) VALUES ($1, $2, $3, $4, $5::jsonb)',
      ['tags', row.id, row.parentId, row.updatedAt, JSON.stringify(row)],
    );
    await applyRemoteChanges({});
    expect(await pending(row.id)).toEqual([]);
    expect((await saved('tags', row.id)).parent_id).toBe(row.parentId);
  });
});
