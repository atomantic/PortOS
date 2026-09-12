/** Route-to-Postgres library recovery contract. Runs only against portos_test. */
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import recipeRoutes from './mindToolRecipeRoutes.js';

const health = await checkHealth().catch((error) => ({ connected: false, error: error.message }));
const ready = requireDbOrSkip('routes/mindToolRecipes.db.test', health.connected, health.error);
if (ready) await ensureSchema();
const ids = [];
afterAll(async () => {
  if (ready && ids.length) await query('DELETE FROM mind_tool_recipes WHERE id = ANY($1::uuid[])', [ids]);
  await close();
});
const app = express();
app.use(express.json());
app.use('/recipes', recipeRoutes);
app.use(errorMiddleware);
const get = (path = '') => request(app).get(`/recipes${path}`);
const post = (path, body) => request(app).post(`/recipes${path}`).send(body);
const put = (path, body) => request(app).put(`/recipes${path}`).send(body);
const definition = () => ({
  schemaVersion: 1, name: `recipe.test-${randomUUID()}`, purpose: 'Project check-in',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  steps: [{ id: 'notes', tool: 'brain.search', arguments: { query: { input: 'query' } } }, { id: 'goals', tool: 'goals.list', arguments: {} }],
  outputs: { notes: { step: 'notes', path: ['entries'] }, goals: { step: 'goals', path: [] } },
});
const create = async () => {
  const saved = await post('', { definition: definition() });
  expect(saved.status).toBe(201);
  ids.push(saved.body.id);
  return saved.body;
};

describe.skipIf(!ready)('Mind recipe library over HTTP and PostgreSQL', () => {
  it('reloads, rejects bad/forward/stale edits, archives and restores with immutable history', async () => {
    const saved = await create();
    expect(saved).toMatchObject({ activeRevision: 1, archived: false, mindCallable: false });
    expect((await get()).body.recipes).toContainEqual(expect.objectContaining({ id: saved.id }));
    const bad = structuredClone(saved.definition);
    bad.steps[0].arguments.query = { literal: 25 };
    const rejected = await put(`/${saved.id}`, { expectedRevision: 1, definition: bad });
    expect(rejected.status).toBe(400);
    expect(rejected.body.context).toMatchObject({ field: 'steps.0.arguments.query', step: 'notes' });
    bad.steps[0].arguments.query = { step: 'goals', path: ['title'] };
    expect((await put(`/${saved.id}`, { expectedRevision: 1, definition: bad })).status).toBe(400);
    expect((await get(`/${saved.id}`)).body).toMatchObject({ recipe: { activeRevision: 1, definition: saved.definition }, versions: [{ revision: 1, author: 'user' }] });
    const edited = { ...saved.definition, purpose: 'Updated project check-in' };
    expect((await put(`/${saved.id}`, { expectedRevision: 1, definition: edited })).body.activeRevision).toBe(2);
    expect((await put(`/${saved.id}`, { expectedRevision: 1, definition: saved.definition })).status).toBe(409);
    expect((await post(`/${saved.id}/archive`, { expectedRevision: 2 })).body).toMatchObject({ activeRevision: 3, archived: true, available: false });
    expect((await post(`/${saved.id}/restore`, { expectedRevision: 2, revision: 1 })).status).toBe(409);
    expect((await post(`/${saved.id}/restore`, { expectedRevision: 3, revision: 1 })).body).toMatchObject({ activeRevision: 4, archived: false, definition: saved.definition });
    const history = (await get(`/${saved.id}`)).body.versions;
    expect(history.map(({ revision }) => revision)).toEqual([4, 3, 2, 1]);
    expect(history[3].definition).toEqual(saved.definition);
    expect(history.every((entry) => Object.keys(entry).sort().join(',') === 'archived,author,createdAt,definition,revision')).toBe(true);
  });

  it('validates without persisting and preserves future definitions without granting execution', async () => {
    const value = definition();
    expect((await post('/validate', { definition: value })).body.valid).toBe(true);
    expect((await get()).body.recipes.some((item) => item.name === value.name)).toBe(false);
    const saved = await create();
    const future = { ...saved.definition, schemaVersion: 99, futureField: { preserved: true } };
    await query('UPDATE mind_tool_recipe_versions SET definition = $1 WHERE recipe_id = $2 AND revision = 1', [future, saved.id]);
    expect((await get(`/${saved.id}`)).body.recipe).toMatchObject({ available: false, mindCallable: false, definition: future });
    expect((await put(`/${saved.id}`, { expectedRevision: 1, definition: saved.definition })).status).toBe(409);
    expect((await get(`/${saved.id}`)).body.versions[0].definition).toEqual(future);
  });

  it('revalidates a restored historical definition before appending a revision', async () => {
    const saved = await create();
    const edited = { ...saved.definition, purpose: 'Current valid definition' };
    expect((await put(`/${saved.id}`, { expectedRevision: 1, definition: edited })).status).toBe(200);
    // Simulate a historical target contract retired by an upgrade.
    const retired = structuredClone(saved.definition);
    retired.steps[0].tool = 'retired.search';
    await query('UPDATE mind_tool_recipe_versions SET definition = $1 WHERE recipe_id = $2 AND revision = 1', [retired, saved.id]);
    expect((await post(`/${saved.id}/restore`, { expectedRevision: 2, revision: 1 })).status).toBe(400);
    const detail = (await get(`/${saved.id}`)).body;
    expect(detail.recipe).toMatchObject({ activeRevision: 2, definition: edited });
    expect(detail.versions).toHaveLength(2);
  });

  it('rejects malformed requests and colliding recipe names without overwriting either record', async () => {
    expect((await post('', { definition: definition(), author: 'mind' })).status).toBe(400);
    expect((await get('/not-a-uuid')).status).toBe(400);
    const saved = await create();
    expect((await post('', { definition: saved.definition })).status).toBe(409);
    expect((await put(`/${saved.id}`, { definition: saved.definition })).status).toBe(400);
    expect((await get(`/${saved.id}`)).body.recipe.activeRevision).toBe(1);
  });
});
