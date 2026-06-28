/**
 * Music Video — pure record transforms (issue #1760, Phase 1).
 *
 * Mirrors the Creative Director store split: the file backend (projectsFile.js)
 * and the PostgreSQL backend (projectsDB.js) share the SAME mutation semantics
 * and differ only in load/persist, so all storage-agnostic logic lives here.
 * Each function takes a plain project record and returns the next record (or
 * throws a ServerError on a validation failure), leaving read/write to the
 * caller.
 *
 * Scope note: peer-sync federation (sanitize/merge/tombstone-GC helpers the CD
 * store carries) is deferred to a follow-up — see services/musicVideo/projects.js.
 * The soft-delete fields are kept on the record now so adding federation later
 * is purely additive.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import {
  MUSIC_VIDEO_STATUSES,
  musicVideoAudioAnalysisSchema,
  musicVideoSceneCreateSchema,
  musicVideoSceneUpdateSchema,
} from '../../lib/validation.js';

// Re-exported for the PG backend's typed mirror columns (mirrors the CD store).
export { mirrorTimestamp } from '../../lib/pgTimestamp.js';

const STATUS_COLUMN_MAX = 32;

/** Safe value for the `status` mirror column — bounded, never null. */
export function mirrorStatus(status) {
  return (typeof status === 'string' && status ? status : 'draft').slice(0, STATUS_COLUMN_MAX);
}

/** Return the next record with `extra` merged and `updatedAt` freshly stamped. */
function touch(record, extra) {
  return { ...record, ...extra, updatedAt: new Date().toISOString() };
}

/** safeParse a scene payload, throwing a 400 ServerError with field detail on failure. */
function parseSceneOrThrow(schema, input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new ServerError(
      `Scene validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  return parsed.data;
}

/** Build a fresh project record from validated create input. */
export function buildProjectRecord(input, { id, now }) {
  const {
    name, mode = 'director', trackId = null,
    uploadedAudioFilename = null, concept = null,
  } = input;
  return {
    id,
    name,
    status: 'draft',
    mode,
    createdAt: now,
    updatedAt: now,
    trackId,
    uploadedAudioFilename,
    concept,
    audioAnalysis: null,
    scenes: [],
    renderHistoryId: null,
    // Soft-delete tombstone trio — kept so peer-sync federation (a follow-up)
    // is additive rather than a record-shape migration.
    deleted: false,
    deletedAt: null,
  };
}

/** Merge a project metadata patch, validating status. Returns the next record. */
export function applyProjectPatch(project, patch) {
  if (patch.status && !MUSIC_VIDEO_STATUSES.includes(patch.status)) {
    throw new ServerError(`Invalid status: ${patch.status}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  return touch(project, patch);
}

/**
 * Cache the offline beat/tempo/section analysis on the project. Flips a `draft`
 * project to `analyzed`; leaves any later status untouched (re-analysis of a
 * ready/rendering project shouldn't regress its lifecycle). The analysis shape
 * is validated so a hand-edited/legacy record can't store a malformed map.
 */
export function setAudioAnalysis(project, analysis) {
  const validated = musicVideoAudioAnalysisSchema.parse(analysis);
  const status = project.status === 'draft' ? 'analyzed' : project.status;
  return touch(project, { audioAnalysis: validated, status });
}

/** Default runtime fields for a scene the director (or planner) didn't supply. */
function buildScene(input, { order }) {
  return {
    sceneId: `mvs-${randomUUID()}`,
    order,
    label: input.label ?? '',
    sectionLabel: input.sectionLabel ?? null,
    startSec: input.startSec ?? null,
    endSec: input.endSec ?? null,
    beatAligned: input.beatAligned ?? false,
    prompt: input.prompt ?? '',
    framePrompt: input.framePrompt ?? null,
    referenceImageId: null,
    videoHistoryId: null,
  };
}

/**
 * Append a scene to the board. Validates the input, assigns a sceneId and the
 * next order index. Returns `{ project, scene }`.
 */
export function addScene(project, sceneInput) {
  const data = parseSceneOrThrow(musicVideoSceneCreateSchema, sceneInput);
  const scenes = project.scenes || [];
  const scene = buildScene(data, { order: scenes.length });
  const next = touch(project, { scenes: [...scenes, scene] });
  return { project: next, scene };
}

/**
 * Apply a patch to a single scene. Returns `{ project, updated }`. Throws if the
 * scene id is unknown.
 */
export function applySceneUpdate(project, sceneId, patch) {
  const data = parseSceneOrThrow(musicVideoSceneUpdateSchema, patch);
  const scenes = project.scenes || [];
  const idx = scenes.findIndex((s) => s.sceneId === sceneId);
  if (idx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const updated = { ...scenes[idx], ...data };
  // The partial-patch schema can't enforce endSec >= startSec (the paired value
  // may be unchanged on the record), so validate the merged range here.
  if (updated.startSec != null && updated.endSec != null && updated.endSec < updated.startSec) {
    throw new ServerError('endSec must be >= startSec', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const nextScenes = scenes.slice();
  nextScenes[idx] = updated;
  const next = touch(project, { scenes: nextScenes });
  return { project: next, updated };
}

/** Remove a scene and re-sequence the remaining scenes' `order`. Returns the next record. */
export function removeScene(project, sceneId) {
  const scenes = project.scenes || [];
  if (!scenes.some((s) => s.sceneId === sceneId)) {
    throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  }
  const nextScenes = scenes
    .filter((s) => s.sceneId !== sceneId)
    .map((s, i) => ({ ...s, order: i }));
  return touch(project, { scenes: nextScenes });
}

/**
 * Reorder the board to the given sceneId order. `orderedIds` must be exactly the
 * project's current scene ids (a permutation) — a missing/extra/unknown id is a
 * 400 so a stale client can't silently drop scenes. Returns the next record.
 */
export function reorderScenes(project, orderedIds) {
  const scenes = project.scenes || [];
  const byId = new Map(scenes.map((s) => [s.sceneId, s]));
  if (orderedIds.length !== scenes.length || !orderedIds.every((id) => byId.has(id)) || new Set(orderedIds).size !== orderedIds.length) {
    throw new ServerError('Reorder must list each existing scene id exactly once', { status: 400, code: 'VALIDATION_ERROR' });
  }
  const nextScenes = orderedIds.map((id, i) => ({ ...byId.get(id), order: i }));
  return touch(project, { scenes: nextScenes });
}
