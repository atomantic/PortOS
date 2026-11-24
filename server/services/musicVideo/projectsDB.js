/**
 * Music Video PostgreSQL project store.
 *
 * Storage: `db-primary` — federates through the `musicVideoProjects` sync
 * category, schema-gated so an older peer cannot drop newer fields (shot action
 * contracts, dependency provenance, narrative events, reactive sections), which
 * are versioned fields on this record with no separate store, seed or backfill.
 * Install-local pointers (`devArtifacts`, `composition.document`, `blender`) are
 * wire-local: `stripMusicVideoLocalRenderPins` strips them and
 * `mergeProjectRecord` restores them over a newer remote.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../../lib/db.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createProjectDbStore } from '../projectDbStore.js';
import * as logic from './projectsLogic.js';
import * as takes from './takes.js';

const store = createProjectDbStore({
  table: 'music_video_projects',
  kind: 'musicVideoProject',
  idPrefix: 'mv',
  logEmoji: '🎞️',
  logLabel: 'Music Video',
  logic,
  // Keep the manual override's inputs available before the page is selected.
  pageHeaderFields: ['completion', 'renderHistoryId'],
});

const { withLockedProject, rowToProject } = store;

export const {
  persist, listProjects, listProjectPage, getProject, getProjectsByIds, listProjectIds, listProjectNames,
} = store;

export async function listMidiSourceRows() {
  // Keep the listProjects order: the first candidate wins a timestamp tie
  // and fixes the track's position even if a later candidate replaces it.
  const { rows } = await query(`
    SELECT id, data->'id' AS "projectId", (data->'name')::text AS name,
           data->'trackId' AS "trackId", data#>'{midiTranscription,filename}' AS filename,
           (data#>'{midiTranscription,model}')::text AS model,
           (data#>'{midiTranscription,createdAt}')::text AS "createdAt"
      FROM music_video_projects
      WHERE deleted = FALSE
        AND data->'trackId' IS NOT NULL
        AND data#>'{midiTranscription,filename}' IS NOT NULL
      ORDER BY created_at ASC`);
  // JSON text preserves explicit JSON null separately from an absent key (SQL NULL).
  const optionalJson = value => value === null ? undefined : JSON.parse(value);
  return rows.map(({ id, projectId, name, trackId, filename, model, createdAt }) => ({
    id: projectId || id, name: optionalJson(name), trackId,
    midiTranscription: { filename, model: optionalJson(model), createdAt: optionalJson(createdAt) },
  }));
}

// Project links live in concept.subjects, including aliases kept by older records.
// Read IDs first so an unrelated catalog write never pulls any project bodies.
export async function listCompletionCandidateIds(ingredientIds) {
  const { rows } = await query(
    `WITH members AS MATERIALIZED (
       SELECT id FROM unnest($1::text[]) AS input(id)
       UNION SELECT unnest(catalog_identity_member_ids(id)) FROM unnest($1::text[]) AS input(id)
     )
     SELECT id FROM music_video_projects p
      WHERE deleted = false AND data->>'status' = 'complete'
        AND ((NULLIF(data->>'renderHistoryId', '') IS NOT NULL AND jsonb_typeof(data->'renderDependencies') = 'object')
          OR data#>>'{composition,mode}' = 'blender')
        AND ($1 IS NULL OR (
          data#>>'{castAndSets,source}' = 'catalog'
          AND data#>'{renderDependencies,references}' @> '[{"role":"clipReferences"}]'::jsonb
          AND EXISTS (SELECT 1 FROM members WHERE p.data#>'{concept,subjects}' @>
            jsonb_build_array(jsonb_build_object('ingredientId', members.id)))
        ))`,
    [ingredientIds ?? null],
  );
  return rows.map(({ id }) => id);
}

async function cloneProjectUnqueued(id, options = {}) {
  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT id, data FROM music_video_projects WHERE id = $1 FOR SHARE`,
      [id],
    );
    const source = rowToProject(selected.rows[0]);
    if (!source || source.deleted) {
      throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
    }
    const clone = logic.cloneProjectRecord(source, {
      ...options,
      // The service names the id when it already placed files under it (a Blender film's scripts).
      id: options.id || `mv-${randomUUID()}`,
      now: new Date().toISOString(),
    });
    await persist(client.query.bind(client), clone);
    return clone;
  });
}

async function setProjectAnalysisUnqueued(id, analysis, sourceProject) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.setAudioAnalysis(current, analysis, sourceProject) }));
  return project;
}

async function addProjectSceneUnqueued(id, sceneInput) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, scene } = logic.addScene(current, sceneInput);
    return { project, result: scene };
  });
  return result;
}

async function addProjectScenesUnqueued(id, sceneInputs) {
  const { project, result: scenes } = await withLockedProject(id, (current) => {
    const outcome = logic.addScenes(current, sceneInputs);
    return { project: outcome.project, result: outcome.scenes };
  });
  return { project, scenes };
}

async function updateSceneUnqueued(id, sceneId, patch) {
  const { result } = await withLockedProject(id, (current) => {
    const { project, updated } = logic.applySceneUpdate(current, sceneId, patch);
    return { project, result: updated };
  });
  return result;
}

async function deleteSceneUnqueued(id, sceneId) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.removeScene(current, sceneId) }));
  return project;
}

async function reorderProjectScenesUnqueued(id, orderedIds) {
  const { project } = await withLockedProject(id, (current) => ({ project: logic.reorderScenes(current, orderedIds) }));
  return project;
}

// ---- scene takes (#8965) — each operation runs under the project row lock,
// so a job completion and a director's select/reject can't interleave. -------
async function mutateLocked(id, transform) {
  const { result } = await withLockedProject(id, async (current) => {
    const outcome = await transform(current);
    return { project: outcome.project, result: outcome };
  });
  return result;
}

// Generic pure-transform mutation under the row lock (#8980 treatment ops):
// `transform(project)` returns `{ project, ...result }`; resolves to that
// outcome with `project` replaced by the persisted record.
async function mutateProjectRecordUnqueued(id, transform) {
  const { project, result } = await withLockedProject(id, async (current, client) => {
    const outcome = await transform(current, { client });
    return { project: outcome.project, result: outcome, skipPersist: outcome.skipPersist === true };
  });
  return { ...result, project };
}

async function appendSceneTakesUnqueued(id, sceneId, inputs) {
  const { scene, appended } = await mutateLocked(id, (p) => takes.appendSceneTakes(p, sceneId, inputs));
  return { scene, appended };
}

async function appendTakesAcrossScenesUnqueued(id, items) {
  return mutateLocked(id, (p) => takes.appendTakesAcrossScenes(p, items));
}

async function selectSceneTakeUnqueued(id, sceneId, takeId) {
  const { scene } = await mutateLocked(id, (p) => takes.selectSceneTake(p, sceneId, takeId));
  return scene;
}

async function reviewSceneTakeUnqueued(id, sceneId, takeId, review) {
  const { scene } = await mutateLocked(id, (p) => takes.reviewSceneTake(p, sceneId, takeId, review));
  return scene;
}

// One same-install admission precedes row locks, including inserts and sync.
// Pool deletion needs a stable all-project selection scan through file removal.
// Row locks still protect the persisted read/modify/write transaction.
const queueWrite = createFileWriteQueue();
const serialized = (fn) => (...args) => queueWrite(() => fn(...args));
export const createProject = serialized(store.createProject);
export const updateProject = serialized(store.updateProject);
export const deleteProject = serialized(store.deleteProject);
export const mergeProjectsFromSync = serialized(store.mergeProjectsFromSync);
export const pruneTombstonedProjects = serialized(store.pruneTombstonedProjects);
export const cloneProject = serialized(cloneProjectUnqueued);
export const setProjectAnalysis = serialized(setProjectAnalysisUnqueued);
export const addProjectScene = serialized(addProjectSceneUnqueued);
export const addProjectScenes = serialized(addProjectScenesUnqueued);
export const updateScene = serialized(updateSceneUnqueued);
export const deleteScene = serialized(deleteSceneUnqueued);
export const reorderProjectScenes = serialized(reorderProjectScenesUnqueued);
export const mutateProjectRecord = serialized(mutateProjectRecordUnqueued);
export const appendSceneTakes = serialized(appendSceneTakesUnqueued);
export const appendTakesAcrossScenes = serialized(appendTakesAcrossScenesUnqueued);
export const selectSceneTake = serialized(selectSceneTakeUnqueued);
export const reviewSceneTake = serialized(reviewSceneTakeUnqueued);

export function withProjectMutation(work) {
  return queueWrite(() => work({ mutateProjectRecord: mutateProjectRecordUnqueued }));
}
