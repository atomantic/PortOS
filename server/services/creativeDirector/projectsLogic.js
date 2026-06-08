/**
 * Creative Director — pure record transforms.
 *
 * The file backend (projectsFile.js) and the PostgreSQL backend (projectsDB.js)
 * share the SAME mutation semantics — they differ ONLY in how a project record
 * is loaded and persisted. This module holds the storage-agnostic logic so the
 * two backends can never drift in how a treatment is applied, a scene patched,
 * or a run appended. Each function takes a plain project record and returns the
 * next record (or throws a ServerError on a validation failure), leaving the
 * read/write to the caller.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { creativeDirectorTreatmentSchema } from '../../lib/validation.js';
import { PROJECT_STATUSES } from '../../lib/creativeDirectorPresets.js';

// TIMESTAMPTZ bind-safety helper, shared with the media asset index (#1000) and
// any other store that mirrors a hand-editable timestamp into a typed column.
// Re-exported here so the historical `import { mirrorTimestamp } from
// './projectsLogic.js'` call sites (projectsDB.js, the migration) keep working.
export { mirrorTimestamp } from '../../lib/pgTimestamp.js';

// Without a cap, runs[] grows unbounded and every load/save (≈10 per scene
// render) parses + serializes a payload whose size scales with cumulative
// renders — O(N²) wall-clock. In-flight runs are load-bearing for orphan/dedup
// detection in completionHook and the boot recovery scan, so trim only drops
// the oldest TERMINAL entries. (DB backend stores runs[] inside the project
// row's JSONB, so the same cap keeps that row from bloating too.)
export const MAX_PERSISTED_RUNS = 200;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed']);

export function trimRuns(runs) {
  if (!Array.isArray(runs)) return [];
  if (runs.length <= MAX_PERSISTED_RUNS) return runs;
  let inflightCount = 0;
  for (const r of runs) {
    if (!(r && TERMINAL_RUN_STATUSES.has(r.status))) inflightCount += 1;
  }
  const terminalBudget = Math.max(0, MAX_PERSISTED_RUNS - inflightCount);
  // Walk backwards keeping every in-flight run + the most-recent `terminalBudget`
  // terminal runs, then reverse so original chronological order is preserved
  // (recovery scans + completionHook predicates iterate runs[] and stay readable
  // when it reads chronologically).
  const kept = [];
  let terminalsKept = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i];
    const isTerminal = r && TERMINAL_RUN_STATUSES.has(r.status);
    if (!isTerminal) {
      kept.push(r);
    } else if (terminalsKept < terminalBudget) {
      kept.push(r);
      terminalsKept += 1;
    }
  }
  return kept.reverse();
}

// Postgres `status` column is VARCHAR(32) and created_at/updated_at are
// TIMESTAMPTZ. A legacy/hand-edited project with an over-long status or a
// malformed timestamp would make the INSERT throw — and because the PG backend
// inits (and imports) during boot, one bad record could block the whole backend
// from coming up. The JSONB `data` is always written verbatim (lossless); these
// helpers only sanitize the typed MIRROR columns so they can never reject a row
// the file backend would have tolerated as plain JSON.
const STATUS_COLUMN_MAX = 32;

/** Safe value for the `status` mirror column — bounded, never null. */
export function mirrorStatus(status) {
  return (typeof status === 'string' && status ? status : 'draft').slice(0, STATUS_COLUMN_MAX);
}

/**
 * Build a fresh project record. The caller supplies the already-created media
 * collection id (collection creation is a side effect both backends perform
 * the same way before calling this).
 */
export function buildProjectRecord(input, { id, now, collectionId }) {
  const {
    name, aspectRatio, quality, modelId, targetDurationSeconds,
    styleSpec = '', startingImageFile = null, userStory = null,
    disableAudio = true, autoAcceptScenes = false, sourceIssueId = null,
  } = input;
  return {
    id,
    name,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    aspectRatio,
    quality,
    modelId,
    targetDurationSeconds,
    styleSpec,
    startingImageFile,
    userStory,
    disableAudio,
    autoAcceptScenes,
    // Optional back-pointer to the pipeline issue that spawned this project.
    // The stitch step uses it to look up `stages.audio.music` and mix it into
    // the final cut. Bare CD projects leave this null and skip the audio-mux.
    sourceIssueId,
    collectionId,
    timelineProjectId: null,
    finalVideoId: null,
    treatment: null,
    runs: [],
  };
}

/** Merge a project metadata patch, validating status. Returns the next record. */
export function applyProjectPatch(project, patch) {
  if (patch.status && !PROJECT_STATUSES.includes(patch.status)) {
    throw new ServerError(`Invalid status: ${patch.status}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  return { ...project, ...patch, updatedAt: new Date().toISOString() };
}

/**
 * Validate + apply a treatment to a project. Returns the next record. Initializes
 * each scene's runtime fields if the agent didn't supply them, and preserves
 * paused/failed status (otherwise flips the project to 'rendering').
 */
export function applyTreatment(project, treatmentInput) {
  const parsed = creativeDirectorTreatmentSchema.safeParse(treatmentInput);
  if (!parsed.success) {
    throw new ServerError(
      `Treatment validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const scenes = parsed.data.scenes.map((s) => ({
    ...s,
    status: s.status || 'pending',
    retryCount: s.retryCount ?? 0,
    renderedJobId: s.renderedJobId ?? null,
    evaluation: s.evaluation ?? null,
  }));
  const nextStatus = (project.status === 'paused' || project.status === 'failed')
    ? project.status
    : 'rendering';
  return {
    ...project,
    treatment: { logline: parsed.data.logline, synopsis: parsed.data.synopsis, scenes },
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Apply a patch to a single scene. Returns `{ project, updated }` (the next
 * record + the updated scene). Throws if the project has no treatment or the
 * scene id is unknown.
 */
export function applySceneUpdate(project, sceneId, patch) {
  if (!project.treatment?.scenes?.length) {
    throw new ServerError('Project has no treatment yet', { status: 400, code: 'NO_TREATMENT' });
  }
  const sceneIdx = project.treatment.scenes.findIndex((s) => s.sceneId === sceneId);
  if (sceneIdx < 0) throw new ServerError('Scene not found', { status: 404, code: 'NOT_FOUND' });
  const updated = { ...project.treatment.scenes[sceneIdx], ...patch };
  const scenes = project.treatment.scenes.slice();
  scenes[sceneIdx] = updated;
  const next = {
    ...project,
    treatment: { ...project.treatment, scenes },
    updatedAt: new Date().toISOString(),
  };
  return { project: next, updated };
}

/** Append a run row. Returns `{ project, run }` (the next record + the new run). */
export function appendRun(project, runEntry) {
  const run = { startedAt: new Date().toISOString(), ...runEntry, runId: runEntry.runId || randomUUID() };
  const next = {
    ...project,
    runs: trimRuns([...(project.runs || []), run]),
    updatedAt: new Date().toISOString(),
  };
  return { project: next, run };
}

/**
 * Patch an existing run by runId. Returns `{ project, updated }`; `updated` is
 * null (and `project` unchanged) when the runId is unknown — mirrors the file
 * backend's "return null, don't throw" contract.
 */
export function applyRunUpdate(project, runId, patch) {
  const runs = project.runs || [];
  const runIdx = runs.findIndex((r) => r.runId === runId);
  if (runIdx < 0) return { project, updated: null };
  const updated = { ...runs[runIdx], ...patch };
  const nextRuns = runs.slice();
  nextRuns[runIdx] = updated;
  const next = {
    ...project,
    runs: trimRuns(nextRuns),
    updatedAt: new Date().toISOString(),
  };
  return { project: next, updated };
}
