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
 * Peer-sync federation (#1770): the sanitize + LWW-merge decision helpers the CD
 * store carries now live here too (`sanitizeProjectForSync`, `mergeProjectRecord`),
 * shared by both backends so the merge can't drift. The soft-delete fields were
 * already on the record, so federation was purely additive (no record migration).
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import {
  MUSIC_VIDEO_STATUSES,
  musicVideoAudioAnalysisSchema,
  musicVideoSceneCreateSchema,
  musicVideoSceneUpdateSchema,
} from '../../lib/validation.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';

// Re-exported for the PG backend's typed mirror columns (mirrors the CD store).
export { mirrorTimestamp } from '../../lib/pgTimestamp.js';

const isStr = (v) => typeof v === 'string';

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
  // Changing the audio source invalidates the cached beat/tempo analysis —
  // it was computed from the OLD track. AI Plan / Auto-arrange / BeatTimeline
  // gate on `audioAnalysis` truthiness, and the render's beat-snap step reads
  // its `beats` array; a stale analysis would silently apply the previous
  // song's beat grid to the new audio (#1945 — both the manual "Change
  // track" picker and the YouTube-import attach PATCH through here). Any
  // scene already marked `beatAligned` also stops being true — its saved
  // startSec/endSec were snapped to the OLD song's beat positions, and
  // `beatSnapClips` honors a beat-aligned scene's saved bounds outright
  // (skipping re-derivation against the new, absent beat grid), so leaving
  // the flag set would render the old song's cut points against new audio.
  const trackChanged = ('trackId' in patch && patch.trackId !== project.trackId)
    || ('uploadedAudioFilename' in patch && patch.uploadedAudioFilename !== project.uploadedAudioFilename);
  if (!trackChanged) return touch(project, patch);
  const scenes = (project.scenes || []).map((s) => (s.beatAligned ? { ...s, beatAligned: false } : s));
  // Clearing audioAnalysis means the project must be re-analyzed before it can be
  // planned/arranged/rendered, so a status that implies analysis existed
  // (`analyzed`/`ready`/`rendering`/`complete`) is now stale. Regress it to `draft` —
  // the inverse of setAudioAnalysis's draft→analyzed flip — unless the caller set an
  // explicit status in this same patch. `draft`/`failed` already imply no usable
  // analysis, so leave those untouched.
  const regressStatus = !patch.status && !['draft', 'failed'].includes(project.status);
  const statusPatch = regressStatus ? { status: 'draft' } : {};
  return touch(project, { ...patch, ...statusPatch, audioAnalysis: null, scenes });
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
 * next order index. Returns `{ project, scene }`. A thin single-item wrapper
 * over `addScenes` so the validate/build/order logic lives in exactly one
 * place.
 */
export function addScene(project, sceneInput) {
  const { project: next, scenes } = addScenes(project, [sceneInput]);
  return { project: next, scene: scenes[0] };
}

/**
 * Append several scenes to the board in one pass (the autonomous planner,
 * #1855) — a single `touch`/persist instead of N sequential addScene calls, so
 * a 10-section plan is one write (and one peer-sync emit) instead of ten.
 * Returns `{ project, scenes }` (the newly-created scenes, in input order).
 */
export function addScenes(project, sceneInputs) {
  const list = Array.isArray(sceneInputs) ? sceneInputs : [];
  const existing = project.scenes || [];
  const added = [];
  let order = existing.length;
  for (const input of list) {
    const data = parseSceneOrThrow(musicVideoSceneCreateSchema, input);
    added.push(buildScene(data, { order }));
    order += 1;
  }
  const next = touch(project, { scenes: [...existing, ...added] });
  return { project: next, scenes: added };
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

// ---- peer-sync federation (#1770) -----------------------------------------
// Mirrors the Creative Director store (creativeDirector/projectsLogic.js): a
// project is a whole-record LWW kind (no item-union, no ephemeral flag), so the
// wire form is the record with normalized soft-delete fields and the merge is a
// straight `updatedAt` newest-wins decision. Both backends call through here so
// the file and PG paths can't diverge.

/**
 * Wire-safe / merge-safe projection of a peer-supplied project record. Rejects a
 * non-object or one missing an id (the receiver could never apply it), and
 * normalizes the timestamps + soft-delete pair so a legacy/hand-edited payload
 * converges byte-for-byte with a freshly-written one. Returns null when unusable.
 */
export function sanitizeProjectForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return { ...raw, createdAt, updatedAt, deleted, deletedAt };
}

/**
 * LWW merge decision for one incoming peer record against the local copy.
 * Returns `{ next, inserted, remoteWins, changed }`:
 *   - malformed remote → `{ next: null, ... }` (caller drops it)
 *   - no local copy → insert the remote
 *   - otherwise newest-`updatedAt`-wins; `changed` is false when the winner is
 *     byte-identical to local (a same-`updatedAt` re-push no-ops, no churn).
 * Tombstone-aware purely via `updatedAt`: deleteProject stamps a fresh
 * `updatedAt`, so a tombstone beats an older live copy and can't be resurrected.
 */
export function mergeProjectRecord(local, remoteRaw) {
  const remote = sanitizeProjectForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}
