import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toPgJson } from '../lib/pgJson.js';
vi.mock('../lib/db.js', async (io) => { const db = await io(); return { ...db, query: vi.fn(db.query) }; });
const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const { listPrimitiveUsages } = await import('./catalogPrimitiveUsage.js');
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/catalogPrimitiveUsage.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const key = `usage-${randomUUID()}`;
const ids = Object.fromEntries(['universe', 'character', 'object', 'story', 'voice', 'series', 'issue'].map(kind => [kind, `${key}-${kind}`]));
const character = (i) => ({ id: `${key}-canon-${i}`, name: `Example Courier ${i}`, aliases: [], ingredientId: ids.character });
const object = { id: `${key}-object-canon`, name: 'Example Relic', ingredientId: ids.object };
beforeAll(async () => {
  if (!ready) return;
  await query("INSERT INTO catalog_ingredients (id, type, name) VALUES ($1, 'character', 'Example Courier'), ($2, 'object', 'Example Relic')", [ids.character, ids.object]);
  await query('INSERT INTO universes (id, name, data) VALUES ($1, $2, $3::jsonb)', [ids.universe, 'Example world', toPgJson({ characters: [character(0)], objects: [object] })]);
  await query('INSERT INTO fableloom_stories (id, name, universe_id, data) VALUES ($1, $2, $3, $4::jsonb)', [ids.story, 'Example story', ids.universe,
    toPgJson({ episodes: [{ nodes: [{ visualCanon: { characterAppearances: [{ characterId: character(0).id }], objectIds: [object.id] } }] }], session: { config: 'execution-fixture' } })]);
  await query("INSERT INTO voice_profiles (id, universe_id, character_id, approval_status, data) VALUES ($1, $2, $3, 'approved', $4::jsonb)", [ids.voice, ids.universe, character(0).id, toPgJson({ name: 'Example voice', providerId: 'execution-fixture' })]);
  await query('INSERT INTO pipeline_series (id, name, universe_id) VALUES ($1, $2, $3)', [ids.series, 'Example series', ids.universe]);
  await query('INSERT INTO pipeline_issues (id, series_id, data) VALUES ($1, $2, $3::jsonb)', [ids.issue, ids.series,
    toPgJson({ title: 'Example issue', stages: { prose: { output: 'Example Courier 0 holds the Example Relic.' }, unrelated: { runHistory: ['execution-fixture'] } } })]);
});
afterAll(async () => {
  if (!ready) return;
  for (const [table, id] of [['voice_profiles', ids.voice], ['fableloom_stories', ids.story], ['pipeline_issues', ids.issue], ['pipeline_series', ids.series], ['universes', ids.universe]])
    await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [[ids.character, ids.object]]);
  await close();
});
describe.skipIf(!ready)('batched creative primitive usage SQL', () => {
  it.each([1, 10, 50])('keeps five issued SQL calls with %s matching canon entries and preserves exact/prose uses', async (size) => {
    await query('UPDATE universes SET data = $2::jsonb WHERE id = $1', [ids.universe, toPgJson({ characters: Array.from({ length: size }, (_, i) => character(i)), objects: [object] })]);
    query.mockClear();
    const uses = await listPrimitiveUsages(ids.character, [{ refKind: 'universe', refId: ids.universe }]);
    expect(query).toHaveBeenCalledTimes(5);
    expect(uses.map(use => [use.refKind, use.refId])).toEqual([
      ['fableloom', ids.story], ['voice-profile', ids.voice], ['series', ids.series], ['issue', ids.issue],
    ]);
    expect(JSON.stringify(uses)).not.toContain('execution-fixture');
    console.log(`📊 Hosted PostgreSQL usage calls: entries=${size}, issuedStatements=${query.mock.calls.length}`);
  });
  it('finds exact FableLoom objectIds without inheriting character voice bindings', async () => {
    const uses = await listPrimitiveUsages(ids.object, [{ refKind: 'universe', refId: ids.universe }]);
    expect(uses.map(use => use.refKind)).toEqual(['fableloom', 'series', 'issue']);
  });
});
