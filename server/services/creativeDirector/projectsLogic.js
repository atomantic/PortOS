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
import { creativeDirectorTreatmentSchema, creativeDirectorPlanSchema } from '../../lib/validation.js';
import { PROJECT_STATUSES, PLAN_STEP_TERMINAL_SUCCESS } from '../../lib/creativeDirectorPresets.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';
import { localImageFilename } from '../../lib/localImageFilename.js';

const isStr = (v) => typeof v === 'string';

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
    cast = [], generateFirstPass = false, directive = null,
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
    // Catalog ingredients seeded into this project via the Catalog "Remix into
    // → Creative Director" handoff (#1808). Structured casting context the
    // treatment agent grounds the prompt + per-scene casting on; the same
    // ingredients are also linked durably in catalog_ingredient_refs. Empty for
    // a bare project. Each member: { ingredientId, name, type, role, summary? }.
    cast: Array.isArray(cast) ? cast : [],
    disableAudio,
    autoAcceptScenes,
    // Server-managed intent flag (#1867) — set on the project by the
    // auto-cast route when a user opts into both `compose` and
    // `generateFirstPass`, since the actual scene-frame seeding can only run
    // once the treatment lands (asynchronously, after this record is
    // created). Not part of the public create/update schema; see
    // creativeDirector.js's `/:id/auto-cast` and `/:id/treatment` handlers.
    generateFirstPass,
    // Optional back-pointer to the pipeline issue that spawned this project.
    // The stitch step uses it to look up `stages.audio.music` and mix it into
    // the final cut. Bare CD projects leave this null and skip the audio-mux.
    sourceIssueId,
    collectionId,
    timelineProjectId: null,
    finalVideoId: null,
    // First-pass music bed (#1928) — populated by the durable
    // creativeDirectorMusicBedHook once an opt-in background render completes;
    // null on a bare project. Shape: { filename, durationSec, engine, modelId,
    // generatedAt }. Additive — the whole record round-trips through the JSONB
    // column verbatim (sanitizeProjectForSync / mergeProjectRecord), so this
    // needs no schema-version bump.
    musicBed: null,
    treatment: null,
    // Production directive + plan (CDO Phase 2, #2184). A directive-driven
    // project turns `directive` into `plan.steps[]` via the planner agent, then
    // the generalized advance loop executes them through the gated tool
    // registry. Both null on a legacy video project — the treatment/scene flow
    // never touches them, so `plan === null` is the back-compat discriminator
    // the advance loop keys on (schema-version gated for federation; see
    // schemaVersions.js creativeDirectorProjects v2 + migration 175). Additive —
    // the whole record round-trips through the JSONB column verbatim.
    directive: directive && typeof directive === 'object' ? directive : null,
    plan: null,
    runs: [],
    // Soft-delete / LWW tombstone trio (#1564) — projects federate across peers
    // via the per-record push pipeline (record kind `creativeDirectorProject`,
    // sync category `creativeDirectorProjects`), so a delete is a tombstone the
    // merge can keep an out-of-date peer from resurrecting.
    deleted: false,
    deletedAt: null,
  };
}

/**
 * Resolve a project's `startingImageFile` to the bare gallery-image filename
 * under `data/images/` so the peer-sync asset pipeline can hash + transfer it.
 * Thin wrapper over the shared `localImageFilename` helper. Scene video renders
 * are NOT covered here: they live in the project's linked media collection,
 * which federates as its own record (so its bytes ride that collection's
 * manifest). This covers only the project's direct image input.
 */
export function startingImageFilename(startingImageFile) {
  return localImageFilename(startingImageFile);
}

/**
 * Normalize a raw project record into the canonical stored shape for a sync
 * round-trip. Returns null for a non-object or a record without a usable id
 * (mirrors the other sanitizers' "drop on the floor" contract so a malformed
 * peer payload can't land). The project body (treatment/scenes/runs/scalars) is
 * passed through verbatim — it is all app-authored data — while the LWW key
 * (`updatedAt`) and the soft-delete trio are normalized so the wire/hash shape
 * is stable regardless of on-disk key position.
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
 * LWW merge decision for one incoming project record against the local copy —
 * mirrors `mergeAuthorRecord` (services/authors/logic.js):
 *   - remote sanitized here (drop-on-floor on a malformed payload → `next: null`).
 *   - No local counterpart → insert the remote verbatim (`inserted: true`).
 *   - Both present → newer `updatedAt` wins (`compareNewerWins`: epoch-ms,
 *     unparseable-loses, tie → local). Tombstones ride the same path.
 * Returns `{ next, inserted, remoteWins, changed }`; `changed` is false when the
 * winner is byte-identical to local. The whole record is LWW-overwritten (no
 * field-union like mediaCollection items), so it is hashed in full by
 * `contentHashForRecord` — no scalar-narrowing branch.
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
 * Validate + apply a production plan to a project (CDO Phase 2, #2184). Returns
 * the next record. Normalizes each step's runtime fields (status→pending unless
 * the agent supplied one, retryCount→0, result→null) and, on a RE-PLAN (a plan
 * already exists), PRESERVES the status/result/retryCount of any incoming step
 * whose `stepId` matches an already terminal-SUCCESS local step — so the bounded
 * re-planner can revise remaining steps without re-running work already done.
 * `plan.replanRounds` counts how many times a plan has been (re)written: 0 for
 * the first plan, +1 each subsequent one — the advance loop's MAX_REPLAN_ROUNDS
 * gate reads it. Flips a draft/planning project to `rendering` so the advance
 * loop starts executing; preserves paused/failed (a human parked it).
 */
export function applyPlan(project, planInput) {
  const parsed = creativeDirectorPlanSchema.safeParse(planInput);
  if (!parsed.success) {
    throw new ServerError(
      `Plan validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  const prevSteps = Array.isArray(project.plan?.steps) ? project.plan.steps : [];
  const prevById = new Map(prevSteps.map((s) => [s.stepId, s]));
  const steps = parsed.data.steps.map((s) => {
    const prior = prevById.get(s.stepId);
    // Preserve a step the prior plan already finished successfully — a re-plan
    // must not re-run a completed render or re-issue a created record.
    if (prior && PLAN_STEP_TERMINAL_SUCCESS.has(prior.status)) {
      return {
        ...s,
        status: prior.status,
        result: prior.result ?? null,
        retryCount: prior.retryCount ?? 0,
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      };
    }
    return {
      ...s,
      status: s.status || 'pending',
      retryCount: s.retryCount ?? 0,
      result: s.result ?? null,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
    };
  });
  const replanRounds = project.plan ? (project.plan.replanRounds || 0) + 1 : 0;
  const nextStatus = (project.status === 'paused' || project.status === 'failed')
    ? project.status
    : 'rendering';
  return {
    ...project,
    plan: { steps, replanRounds, updatedAt: new Date().toISOString() },
    status: nextStatus,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Patch a single plan step. Returns `{ project, updated }`; `updated` is null
 * (and `project` unchanged) when the project has no plan or the stepId is
 * unknown — mirrors applyRunUpdate's "return null, don't throw" contract so the
 * advance loop's fire-and-forget writes never 500 on a raced delete/replan.
 */
export function applyPlanStepUpdate(project, stepId, patch) {
  const steps = Array.isArray(project.plan?.steps) ? project.plan.steps : null;
  if (!steps) return { project, updated: null };
  const idx = steps.findIndex((s) => s.stepId === stepId);
  if (idx < 0) return { project, updated: null };
  const updated = { ...steps[idx], ...patch };
  const nextSteps = steps.slice();
  nextSteps[idx] = updated;
  const next = {
    ...project,
    plan: { ...project.plan, steps: nextSteps, updatedAt: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  };
  return { project: next, updated };
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
