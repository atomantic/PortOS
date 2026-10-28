import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toPgJson } from '../lib/pgJson.js';

const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const { listIngredients } = await import('./catalogDB/ingredients.js');
const { listCatalogStories, joinStory, draftStoryMember, __setStoryDepsForTests } = await import('./catalogStories.js');
const health = await checkHealth().catch(error => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('services/catalogStories.db.test', health.connected, health.error);
if (ready) await ensureSchema();

const key = `story-${randomUUID().slice(0, 8)}`;
const ids = {
  universe: `${key}-universe`,
  lead: `cat-chr-${key}-lead`,
  friend: `cat-chr-${key}-friend`,
  rink: `cat-plc-${key}-rink`,
  board: `sb-${key}`,
  video: `mv-${key}`,
  series: `${key}-series`,
};
const board = {
  id: ids.board, name: 'Example Story', universeId: null, logline: 'Two skaters chase one last night.',
  beats: [{ id: 'beat-1', panels: [{ id: 'panel-1', castIds: [ids.lead], environmentIds: [ids.rink], objectIds: [] }] }],
};

beforeAll(async () => {
  if (!ready) return;
  await query('INSERT INTO universes (id, name, data) VALUES ($1, $2, $3::jsonb)', [ids.universe, 'Example world', toPgJson({ logline: 'A city that never sleeps.' })]);
  await query(`INSERT INTO catalog_ingredients (id, type, name, payload) VALUES
    ($1, 'character', 'Example Lead', '{"physicalDescription":"Tall, red jacket."}'::jsonb),
    ($2, 'character', 'Example Friend', '{}'::jsonb), ($3, 'place', 'Example Rink', '{}'::jsonb)`, [ids.lead, ids.friend, ids.rink]);
  await query(`INSERT INTO catalog_ingredient_refs (ingredient_id, ref_kind, ref_id, role) VALUES
    ($1, 'universe', $3, 'owner'), ($2, 'universe', $3, 'owner')`, [ids.lead, ids.friend, ids.universe]);
  await query('INSERT INTO storyboards (id, name, universe_id, data) VALUES ($1, $2, NULL, $3::jsonb)', [ids.board, board.name, toPgJson(board)]);
  await query('INSERT INTO music_video_projects (id, data) VALUES ($1, $2::jsonb)', [ids.video, toPgJson({ name: 'Example Video', concept: { universeId: ids.universe } })]);
  await query('INSERT INTO pipeline_series (id, name, universe_id) VALUES ($1, $2, $3)', [ids.series, 'Example Series', ids.universe]);
});

afterAll(async () => {
  if (!ready) return;
  await query('DELETE FROM catalog_ingredient_refs WHERE ingredient_id = ANY($1)', [[ids.lead, ids.friend, ids.rink]]);
  await query('DELETE FROM catalog_ingredients WHERE id = ANY($1)', [[ids.lead, ids.friend, ids.rink]]);
  for (const [table, id] of [['storyboards', ids.board], ['music_video_projects', ids.video], ['pipeline_series', ids.series], ['universes', ids.universe]])
    await query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  await close();
});

const ours = async (type) => (await listCatalogStories({ type })).filter((story) => story.id.includes(key));

describe.skipIf(!ready)('catalog stories', () => {
  it('lists storyboards, videos and series with per-type members, placing a universe-less board by its cast', async () => {
    const stories = await ours('character');
    expect(stories.map((s) => [s.kind, s.name, s.count, s.universeIds, s.joinable]).sort()).toEqual([
      ['music-video', 'Example Video', 0, [ids.universe], false],
      ['series', 'Example Series', 0, [ids.universe], true],
      ['storyboard', 'Example Story', 1, [ids.universe], true],
    ].sort());
    const places = await ours('place');
    expect(places.find((s) => s.kind === 'storyboard').count).toBe(1);
  });

  it('joins a record to a storyboard and lists panel cast plus joined cast under the story filter', async () => {
    await expect(joinStory('storyboard', ids.board, ids.friend)).resolves.toMatchObject({ role: 'cast' });
    const { items } = await listIngredients({ type: 'character', refKind: 'storyboard', refId: ids.board });
    expect(items.map((item) => item.name).sort()).toEqual(['Example Friend', 'Example Lead']);
    expect((await ours('character')).find((s) => s.kind === 'storyboard').count).toBe(2);
  });

  it('refuses to join a music video outside its Creative setup and a missing story', async () => {
    await expect(joinStory('music-video', ids.video, ids.friend)).rejects.toMatchObject({ status: 409, code: 'STORY_JOIN_IN_VIDEO' });
    await expect(joinStory('storyboard', `${ids.board}-gone`, ids.friend)).rejects.toMatchObject({ status: 404 });
  });

  it('drafts with the universe, story and its cast as visible additions and the request as written', async () => {
    const runPrompt = vi.fn(async () => ({ text: '```json\n{"name":"Example Newcomer","description":"Short, green cap."}\n```' }));
    __setStoryDepsForTests({ resolveProvider: async () => ({ provider: { id: 'example-api', enabled: true }, selectedModel: 'example-model' }), runPrompt });
    const res = await draftStoryMember({ type: 'character', universeId: ids.universe, storyKind: 'storyboard', storyId: ids.board, prompt: 'A rival skater.' });
    expect(res.draft).toEqual({ name: 'Example Newcomer', content: 'Short, green cap.' });
    expect(res.promptAdditions.map((a) => a.id)).toEqual(expect.arrayContaining(['story-draft-instructions', 'universe', 'story', 'story-members']));
    expect(res.promptAdditions.find((a) => a.id === 'story-members').text).toContain('Example Lead (character): Tall, red jacket.');
    expect(res.sentPrompt).toContain('Request:\nA rival skater.');
    expect(runPrompt.mock.calls[0][0]).toMatchObject({ prompt: res.sentPrompt, source: 'catalog-story-draft' });
  });

  it('drafts a relative with the picked family as a visible block', async () => {
    __setStoryDepsForTests({ resolveProvider: async () => ({ provider: { id: 'example-api', enabled: true }, selectedModel: 'example-model' }),
      runPrompt: async () => ({ text: '{"name":"Example Mother","description":"Red hair."}' }) });
    const res = await draftStoryMember({ type: 'character', universeId: ids.universe, prompt: 'Her mother.', relations: [{ toId: ids.lead, kind: 'mother-of' }] });
    const family = res.promptAdditions.find((a) => a.id === 'family');
    expect(family.text).toBe('- The new character is the mother of Example Lead (character): Tall, red jacket.');
    expect(res.sentPrompt).toContain(`Family:\n${family.text}`);
    await expect(draftStoryMember({ type: 'character', prompt: 'x', relations: [{ toId: 'cat-chr-missing', kind: 'father-of' }] }))
      .rejects.toMatchObject({ status: 404 });
  });
});
