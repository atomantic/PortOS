import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toPgJson } from '../lib/pgJson.js';

const { checkHealth, ensureSchema, close, query } = await import('../lib/db.js');
const { requireDbOrSkip } = await import('../lib/dbTestGate.js');
const { listIngredients } = await import('./catalogDB/ingredients.js');
const { listCatalogStories, joinStory, draftStoryMember, __setStoryDepsForTests } = await import('./catalogStories.js');
const catalogDB = await import('./catalogDB.js');
const { listVideoSubjectLinks, linkVideoSubjects, addCatalogRecordToVideo } = await import('./musicVideo/catalogCast.js');
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
    ($1, 'character', 'Example Lead', '{"physicalDescription":"Tall, red jacket.","forms":[{"id":"teen","label":"Teen","age":"17","description":"Seventeen, braids."},{"id":"kid","label":"Kid","age":"7"}]}'::jsonb),
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
      ['music-video', 'Example Video', 0, [ids.universe], true],
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

  it('refuses a missing story', async () => {
    await expect(joinStory('storyboard', `${ids.board}-gone`, ids.friend)).rejects.toMatchObject({ status: 404 });
  });

  // A video's subjects live in its project record; the catalog side is real.
  const videoDeps = (subjects) => {
    let project = { id: ids.video, name: 'Example Video', concept: { universeId: ids.universe, subjects } };
    return {
      catalogDB,
      get project() { return project; },
      getProject: async () => project,
      mutateProjectRecord: async (_id, transform) => { project = (await transform(project)).project; return { project }; },
      queueProjectCatalogLinkSync: vi.fn(async () => null),
    };
  };

  it('suggests the same-named record and the age form a subject names, then links it', async () => {
    const d = videoDeps([
      { id: 'mvc-a', kind: 'character', name: 'Example Lead (17)' },
      { id: 'mvc-b', kind: 'character', name: 'Example Lead' },
      { id: 'mvc-c', kind: 'character', name: 'Nobody Known' },
      { id: 'mvc-d', kind: 'place', name: 'Example Rink' },
    ]);
    const { subjects } = await listVideoSubjectLinks(ids.video, { type: 'character' }, d);
    expect(subjects.map((s) => [s.id, s.suggestion?.ingredientId ?? null, s.suggestion?.formId ?? null])).toEqual([
      ['mvc-a', ids.lead, 'teen'], ['mvc-b', ids.lead, null], ['mvc-c', null, null],
    ]);
    const res = await linkVideoSubjects(ids.video, [{ subjectId: 'mvc-a', ingredientId: ids.lead, formId: 'teen' }, { subjectId: 'mvc-b', ingredientId: ids.lead }], d);
    expect(res).toMatchObject({ linked: 2, unlinked: 0 });
    expect(d.project.concept.subjects[0]).toMatchObject({ name: 'Example Lead (17)', ingredientId: ids.lead, castForm: { id: 'teen', label: 'Teen', age: 17 } });
    expect(d.project.concept.subjects[1].castForm).toBeUndefined();
    expect(d.queueProjectCatalogLinkSync).toHaveBeenCalledWith(ids.video);
    const after = await listVideoSubjectLinks(ids.video, {}, d);
    expect(after.subjects[0].linked).toMatchObject({ id: ids.lead, forms: [{ id: 'teen', label: 'Teen' }, { id: 'kid', label: 'Kid' }] });

    await linkVideoSubjects(ids.video, [{ subjectId: 'mvc-a', ingredientId: null }], d);
    expect(d.project.concept.subjects[0]).not.toHaveProperty('ingredientId');
    expect(d.project.concept.subjects[0]).not.toHaveProperty('castForm');
  });

  // Uniquely catches a linked subject keeping its stale description with no way to take the catalog's.
  it('shows the linked age\'s catalog description and can take it, refusing one that would not fit', async () => {
    const d = videoDeps([
      { id: 'mvc-a', kind: 'character', name: 'Example Lead (17)', description: 'Short hair.', ingredientId: ids.lead, castForm: { id: 'teen', label: 'Teen', age: 17 } },
      { id: 'mvc-b', kind: 'place', name: 'Example Rink', description: 'Old.', ingredientId: ids.rink },
    ]);
    const { subjects } = await listVideoSubjectLinks(ids.video, {}, d);
    expect(subjects[0].linked.appearance).toEqual({ field: 'form', formId: 'teen', text: 'Seventeen, braids.' });
    expect(subjects[1].linked.appearance).toEqual({ field: 'record', text: '' });
    await linkVideoSubjects(ids.video, [{ subjectId: 'mvc-a', ingredientId: ids.lead, formId: 'teen', useCatalogText: true }], d);
    expect(d.project.concept.subjects[0]).toMatchObject({ description: 'Seventeen, braids.', castForm: { id: 'teen' } });

    await query(`UPDATE catalog_ingredients SET payload = payload || jsonb_build_object('description', repeat('x', 1001)) WHERE id = $1`, [ids.rink]);
    await expect(linkVideoSubjects(ids.video, [{ subjectId: 'mvc-b', ingredientId: ids.rink, useCatalogText: true }], d))
      .rejects.toMatchObject({ status: 400, code: 'DESCRIPTION_TOO_LONG' });
    expect(d.project.concept.subjects[1].description).toBe('Old.');
    await query(`UPDATE catalog_ingredients SET payload = payload - 'description' WHERE id = $1`, [ids.rink]);
  });

  it('refuses a record of another kind or an age it does not have', async () => {
    const d = videoDeps([{ id: 'mvc-a', kind: 'character', name: 'Example Lead' }]);
    await expect(linkVideoSubjects(ids.video, [{ subjectId: 'mvc-a', ingredientId: ids.rink }], d)).rejects.toMatchObject({ status: 400, code: 'SUBJECT_KIND_MISMATCH' });
    await expect(linkVideoSubjects(ids.video, [{ subjectId: 'mvc-a', ingredientId: ids.lead, formId: 'elder' }], d)).rejects.toMatchObject({ status: 400, code: 'FORM_NOT_FOUND' });
  });

  it('casts a record from the catalog side: links the subject named for it, else adds one', async () => {
    const d = videoDeps([{ id: 'mvc-a', kind: 'character', name: 'Example Lead (adult)' }]);
    await expect(addCatalogRecordToVideo(ids.video, ids.lead, d)).resolves.toMatchObject({ added: false, linked: 1 });
    expect(d.project.concept.subjects).toHaveLength(1);
    await expect(addCatalogRecordToVideo(ids.video, ids.lead, d)).resolves.toMatchObject({ added: false, linked: 0 });
    await expect(addCatalogRecordToVideo(ids.video, ids.friend, d)).resolves.toMatchObject({ added: true });
    expect(d.project.concept.subjects[1]).toMatchObject({ kind: 'character', name: 'Example Friend', role: 'supporting', ingredientId: ids.friend });
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
