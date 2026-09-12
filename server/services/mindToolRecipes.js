/** db-primary, machine-local recipe library; definitions and revisions, never private tool results. */
import { randomUUID } from 'node:crypto';
import { query, withTransaction, ensureSchema } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { MIND_TOOL_RECIPE_SCHEMA_VERSION, validateMindToolRecipe } from '../lib/mindToolRecipes.js';

const catalog = async () => {
  const { getCosToolCatalog } = await import('./cosToolRegistry.js');
  return getCosToolCatalog({ scope: 'all' }).tools;
};
export const validateRecipe = async (definition) => validateMindToolRecipe(definition, await catalog());
const project = (row) => ({
  id: row.id, name: row.name, activeRevision: row.active_revision,
  archived: row.archived, definition: row.definition,
  available: !row.archived && row.definition?.schemaVersion === MIND_TOOL_RECIPE_SCHEMA_VERSION,
  mindCallable: false,
  createdAt: row.created_at, updatedAt: row.updated_at,
});
const select = `SELECT r.*, v.definition FROM mind_tool_recipes r
  JOIN mind_tool_recipe_versions v ON v.recipe_id = r.id AND v.revision = r.active_revision`;
const notFound = () => new ServerError('Recipe not found', { status: 404, code: 'RECIPE_NOT_FOUND' });
const conflict = () => new ServerError('Recipe changed. Reload before saving or restoring.', { status: 409, code: 'RECIPE_REVISION_CONFLICT' });
const load = async (client, id) => {
  const { rows } = await client.query(`${select} WHERE r.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
};
const assertRevision = (row, expectedRevision) => {
  if (row.active_revision !== expectedRevision) throw conflict();
};
const assertEditable = (row) => {
  if (row.definition?.schemaVersion !== MIND_TOOL_RECIPE_SCHEMA_VERSION) throw new ServerError('This definition version requires a newer PortOS. It has been preserved.', { status: 409, code: 'RECIPE_VERSION_UNSUPPORTED' });
};
const assertNameFree = async (client, name, id) => {
  const { rows } = await client.query('SELECT id FROM mind_tool_recipes WHERE name = $1 AND id <> $2', [name, id]);
  if (rows.length) throw new ServerError('name: another recipe already uses this name', { status: 409, code: 'RECIPE_NAME_CONFLICT', context: { field: 'name' } });
};
const append = async (client, row, definition, archived, author = 'user') => {
  await assertNameFree(client, definition.name, row.id);
  const revision = row.active_revision + 1;
  const result = await client.query(`UPDATE mind_tool_recipes SET name = $1, active_revision = $2, archived = $3, updated_at = NOW()
    WHERE id = $4 AND active_revision = $5 RETURNING id`, [definition.name, revision, archived, row.id, row.active_revision]);
  if (!result.rowCount) throw conflict();
  await client.query(`INSERT INTO mind_tool_recipe_versions (recipe_id, revision, definition, author, archived)
    VALUES ($1, $2, $3, $4, $5)`, [row.id, revision, definition, author, archived]);
  return project(await load(client, row.id));
};

export async function listRecipes({ limit, offset = 0 } = {}) {
  await ensureSchema();
  const { rows } = await query(`${select} ORDER BY r.updated_at DESC, r.id${limit === undefined ? '' : ' LIMIT $1 OFFSET $2'}`, limit === undefined ? [] : [limit, offset]);
  return { recipes: rows.map(project) };
}

export async function getRecipe(id, { limit, offset = 0 } = {}) {
  await ensureSchema();
  const row = await load({ query }, id);
  const { rows } = await query(`SELECT revision, definition, author, archived, created_at
    FROM mind_tool_recipe_versions WHERE recipe_id = $1 ORDER BY revision DESC${limit === undefined ? '' : ' LIMIT $2 OFFSET $3'}`, limit === undefined ? [id] : [id, limit, offset]);
  return { recipe: project(row), versions: rows.map((version) => ({
    revision: version.revision, definition: version.definition, author: version.author,
    archived: version.archived, createdAt: version.created_at,
  })) };
}

export async function createRecipe(candidate, { author = 'user' } = {}) {
  const { definition } = await validateRecipe(candidate);
  await ensureSchema();
  return withTransaction(async (client) => {
    const id = randomUUID();
    await assertNameFree(client, definition.name, id);
    await client.query('INSERT INTO mind_tool_recipes (id, name, active_revision) VALUES ($1, $2, 1)', [id, definition.name]);
    await client.query(`INSERT INTO mind_tool_recipe_versions (recipe_id, revision, definition, author)
      VALUES ($1, 1, $2, $3)`, [id, definition, author]);
    return project(await load(client, id));
  });
}

export async function updateRecipe(id, { definition: candidate, expectedRevision }, { author = 'user' } = {}) {
  const { definition } = await validateRecipe(candidate);
  await ensureSchema();
  return withTransaction(async (client) => {
    const row = await load(client, id);
    assertRevision(row, expectedRevision);
    assertEditable(row);
    return append(client, row, definition, row.archived, author);
  });
}

export async function archiveRecipe(id, { expectedRevision }, { author = 'user' } = {}) {
  await ensureSchema();
  return withTransaction(async (client) => {
    const row = await load(client, id);
    assertRevision(row, expectedRevision);
    if (row.archived) return project(row);
    return append(client, row, row.definition, true, author);
  });
}

export async function restoreRecipe(id, { revision, expectedRevision }, { author = 'user' } = {}) {
  await ensureSchema();
  return withTransaction(async (client) => {
    const row = await load(client, id);
    assertRevision(row, expectedRevision);
    assertEditable(row);
    const { rows } = await client.query('SELECT definition FROM mind_tool_recipe_versions WHERE recipe_id = $1 AND revision = $2', [id, revision]);
    if (!rows[0]) throw notFound();
    const { definition } = await validateRecipe(rows[0].definition);
    return append(client, row, definition, false, author);
  });
}

export async function getRecipeByName(name) {
  await ensureSchema();
  const { rows } = await query(`${select} WHERE r.name = $1`, [name]);
  if (!rows[0]) throw notFound();
  return project(rows[0]);
}
