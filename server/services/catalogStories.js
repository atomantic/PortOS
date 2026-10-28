/**
 * Stories within a universe, for the Casting / Environments / Objects filters.
 *
 * A story is a project that holds cast: a storyboard, a music video or a
 * Pipeline series. Its members are the catalog records linked to it (a
 * `storyboard` / `music-video` / `series` ref) and, for a storyboard, the
 * records its panels use. A story sits in its own universe; a storyboard with
 * none sits in the universes its members belong to.
 *
 * Joining a story links the record to it. A music video's cast is its subjects
 * (catalogLinks.js keeps those refs in step with them), so a record joins a
 * video as a subject: it links the unlinked subject named for it, or is added
 * as a new one (musicVideo/catalogCast.js).
 *
 * `draftStoryMember` sends the user's prompt with the story's context to the
 * provider › model › effort they pick and answers with a preview; it runs only
 * on the user's tap.
 */

import { query } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { promptAddition } from '../lib/modelInput.js';
import { CREATIVE_LATITUDE_ADDITION, withCreativeLatitude } from '../lib/creativeLatitude.js';
import { catalogReferenceRole, getRelationKind } from '../lib/catalogTypes.js';
import { parseStoryDraft, storyDraftInstructions, storyDraftPrompt } from '../lib/catalogStoryDraft.js';
import { CANONICAL_REFS_CTE, STORYBOARD_PANEL_MEMBERS_SQL } from './catalogDB/shared.js';
import { getIngredient, listIngredients } from './catalogDB/ingredients.js';
import { linkIngredientToRef } from './catalogDB/refs.js';

export const STORY_KINDS = Object.freeze(['storyboard', 'music-video', 'series']);
export const JOINABLE_STORY_KINDS = Object.freeze(['storyboard', 'music-video', 'series']);
const STORY_KINDS_SQL = STORY_KINDS.map((kind) => `'${kind}'`).join(', ');
const MEMBER_CONTEXT_LIMIT = 60;

// Overridable for tests (the provider runner is a process singleton).
const deps = {
  resolveProvider: async (args) => (await import('./promptRunner.js')).resolveProviderAndModel(args),
  runPrompt: async (args) => (await import('./promptRunner.js')).runPromptThroughProvider(args),
};
export const __setStoryDepsForTests = (overrides) => Object.assign(deps, overrides);

const refuse = (message, code, status = 400) => new ServerError(message, { status, code });

// Live stories as `{ kind, id, name, universeId, updatedAt }`, plus the story text a draft reads.
const STORIES_SQL = `SELECT 'storyboard'::text AS kind, s.id, s.name, s.universe_id, s.updated_at,
         NULLIF(s.data->>'logline', '') AS logline, NULLIF(s.data->>'plot', '') AS summary
    FROM storyboards s WHERE s.deleted = false
  UNION ALL
  SELECT 'music-video', m.id, COALESCE(NULLIF(m.data->>'name', ''), m.id), NULLIF(m.data#>>'{concept,universeId}', ''), m.updated_at,
         NULL, NULLIF(m.data#>>'{concept,prompt}', '')
    FROM music_video_projects m WHERE m.deleted = false
  UNION ALL
  SELECT 'series', p.id, p.name, p.universe_id, p.updated_at,
         NULLIF(p.data->>'logline', ''), NULLIF(p.data->>'premise', '')
    FROM pipeline_series p WHERE p.deleted = false`;

/**
 * Every live story with its member count for `type`, newest first.
 * `universeIds` is the story's own universe, or for a storyboard with none,
 * the universes its members belong to.
 */
export async function listCatalogStories({ type }) {
  const { rows } = await query(`WITH ${CANONICAL_REFS_CTE},
    members AS (
      SELECT r.ref_kind AS kind, r.ref_id AS id, r.cid FROM canonical_refs r WHERE r.ref_kind IN (${STORY_KINDS_SQL})
      UNION SELECT 'storyboard', pm.board_id, pm.cid FROM (${STORYBOARD_PANEL_MEMBERS_SQL}) pm),
    live AS (
      SELECT m.kind, m.id, i.id AS cid, i.type FROM members m
        JOIN catalog_ingredients i ON i.id = m.cid AND i.deleted = false)
    SELECT st.kind, st.id, st.name, st.universe_id, st.updated_at,
      (SELECT COUNT(DISTINCT l.cid)::int FROM live l WHERE l.kind = st.kind AND l.id = st.id AND l.type = $1) AS count,
      CASE WHEN st.universe_id IS NULL AND st.kind = 'storyboard' THEN (
        SELECT COALESCE(array_agg(DISTINCT u.id ORDER BY u.id), '{}') FROM live l
          JOIN canonical_refs r ON r.cid = l.cid AND r.ref_kind = 'universe'
          JOIN universes u ON u.id = r.ref_id AND u.deleted = false
         WHERE l.kind = st.kind AND l.id = st.id) END AS member_universes
    FROM (${STORIES_SQL}) st
    ORDER BY st.updated_at DESC NULLS LAST, st.name`, [type]);
  return rows.map((row) => ({
    kind: row.kind,
    id: row.id,
    name: row.name || row.id,
    universeIds: row.universe_id ? [row.universe_id] : (row.member_universes || []),
    count: row.count,
    joinable: JOINABLE_STORY_KINDS.includes(row.kind),
  }));
}

async function getStory(kind, id) {
  const { rows } = await query(`SELECT * FROM (${STORIES_SQL}) st WHERE st.kind = $1 AND st.id = $2`, [kind, id]);
  return rows[0] || null;
}

/** Link a catalog record to a story, in the role its type plays there (a video casts it as a subject). */
export async function joinStory(kind, id, ingredientId) {
  if (kind === 'music-video') {
    const { addCatalogRecordToVideo } = await import('./musicVideo/catalogCast.js');
    const { added, linked } = await addCatalogRecordToVideo(id, ingredientId);
    return { ingredientId, refKind: kind, refId: id, added, linked };
  }
  if (!JOINABLE_STORY_KINDS.includes(kind)) throw refuse(`Unknown story kind "${kind}".`, 'STORY_KIND_UNKNOWN');
  const [story, ingredient] = await Promise.all([getStory(kind, id), getIngredient(ingredientId)]);
  if (!story) throw refuse('That story no longer exists.', 'NOT_FOUND', 404);
  if (!ingredient || ingredient.deleted) throw refuse('That catalog record no longer exists.', 'NOT_FOUND', 404);
  const role = catalogReferenceRole(ingredient.type, kind);
  await linkIngredientToRef(ingredient.id, kind, id, role);
  console.log(`🎭 Catalog ${ingredient.id.slice(0, 12)} joined ${kind} ${id.slice(0, 12)} as ${role}`);
  return { ingredientId: ingredient.id, refKind: kind, refId: id, role };
}

const memberLine = (item) => {
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const detail = [payload.physicalDescription, payload.description, payload.summary].find((v) => typeof v === 'string' && v.trim());
  return `- ${item.name} (${item.type})${detail ? `: ${detail.trim()}` : ''}`;
};

/**
 * Draft one new member for a story from the user's prompt. Answers with the
 * draft as a preview plus the exact prompt sent and each block PortOS added.
 */
export async function draftStoryMember({ type, universeId = '', storyKind = '', storyId = '', prompt, providerId = '', model = '', effort = '', relations = [] }) {
  const request = String(prompt || '').trim();
  if (!request) throw refuse('Describe who or what to create first.', 'STORY_DRAFT_EMPTY');

  const [universe, story] = await Promise.all([
    universeId ? query(`SELECT name, NULLIF(data->>'logline', '') AS logline, NULLIF(data->>'premise', '') AS premise
      FROM universes WHERE id = $1 AND deleted = false`, [universeId]).then(({ rows }) => rows[0] || null) : null,
    storyKind && storyId ? getStory(storyKind, storyId) : null,
  ]);
  if (universeId && !universe) throw refuse('That universe no longer exists.', 'NOT_FOUND', 404);
  if (storyKind && storyId && !story) throw refuse('That story no longer exists.', 'NOT_FOUND', 404);
  const members = story
    ? (await listIngredients({ refKind: storyKind, refId: storyId, limit: MEMBER_CONTEXT_LIMIT })).items
    : [];
  const relatives = await Promise.all(relations.map(async (relation) => ({ relation, record: await getIngredient(relation.toId) })));
  if (relatives.some(({ record }) => !record || record.deleted)) throw refuse('A related record no longer exists.', 'NOT_FOUND', 404);

  const { provider, selectedModel } = await deps.resolveProvider({ providerId: providerId || null, model: model || null });
  if (!provider) throw refuse('No AI provider is set up; pick one first.', 'NO_PROVIDER', 503);
  if (provider.enabled === false) throw refuse(`Provider "${provider.name || provider.id}" is disabled; enable it in Settings › Providers first.`, 'PROVIDER_DISABLED');

  const instructions = storyDraftInstructions(type);
  const universeText = universe && [`Name: ${universe.name}`, universe.logline && `Logline: ${universe.logline}`, universe.premise && `Premise: ${universe.premise}`].filter(Boolean).join('\n');
  const storyText = story && [`Name: ${story.name}`, story.logline && `Logline: ${story.logline}`, story.summary && `Summary: ${story.summary}`].filter(Boolean).join('\n');
  const membersText = members.map(memberLine).join('\n');
  // "The new record is the mother of Nora: <Nora's description>".
  const familyText = relatives.map(({ relation, record }) => {
    const kind = getRelationKind(relation.kind);
    const link = kind?.term ? `the ${kind.term} of` : (kind?.label || relation.kind).toLowerCase();
    return `- The new ${type} is ${link} ${memberLine(record).slice(2)}`;
  }).join('\n');
  const blocks = [
    promptAddition('universe', 'Universe', universeText),
    promptAddition('story', 'Story', storyText),
    promptAddition('story-members', 'Already in the story', membersText),
    promptAddition('family', 'Family', familyText),
  ];
  const sentPrompt = withCreativeLatitude(storyDraftPrompt(instructions, blocks, request));
  const promptAdditions = [CREATIVE_LATITUDE_ADDITION, promptAddition('story-draft-instructions', 'Draft instructions', instructions), ...blocks].filter(Boolean);
  const result = await deps.runPrompt({
    provider, model: selectedModel, effort: effort || undefined, prompt: sentPrompt, source: 'catalog-story-draft',
  });
  let draft;
  try {
    draft = parseStoryDraft(result?.text);
  } catch (err) {
    throw refuse(`${err.message} Try again, or pick another model.`, 'STORY_DRAFT_UNREADABLE', 422);
  }
  console.log(`📝 Story draft (${type}) for ${story ? `${storyKind} ${storyId.slice(0, 12)}` : 'no story'} via ${provider.id}`);
  return { draft, sentPrompt, promptAdditions, providerId: provider.id, model: selectedModel || '' };
}
