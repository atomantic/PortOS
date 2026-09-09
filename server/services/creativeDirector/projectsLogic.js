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

import { videoSceneInputs, retainVideoCuts } from '../../lib/creativeDirectorVideoReview.js';
import { compileVideoArtifact, validateVideoShot } from '../../lib/creativeDirectorVideoCompiler.js';

import { randomUUID } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { EFFORT_LEVELS } from '../../lib/providerModels.js';
import { ServerError } from '../../lib/errorHandler.js';
import { creativeDirectorVideoDraftSchema } from '../../lib/creativeDirectorValidation.js';
import { creativeDirectorTreatmentSchema, creativeDirectorPlanSchema } from '../../lib/validation.js';
import { PROJECT_STATUSES, PLAN_STEP_TERMINAL_SUCCESS } from '../../lib/creativeDirectorPresets.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { pickLlmRoutePinLayer } from '../../lib/llmRoutePin.js';
import { localImageFilename } from '../../lib/localImageFilename.js';
import { sanitizeProjectForSync } from '../../lib/projectStoreKit.js';

// Preserve the existing validation export for callers on the project-store surface.
export { validateVideoShot } from '../../lib/creativeDirectorVideoCompiler.js';

export { sanitizeProjectForSync } from '../../lib/projectStoreKit.js';

const isStr = (v) => typeof v === 'string';

// Per-project AI model override (per-project CD provider/model pins). Stored on
// the project record as `modelOverrides.{treatment,plan,evaluation}` — each an
// optional `{ providerId, model, effort }`. Only stages that name a `providerId` are
// kept, so the stored object never carries empty stubs (a blank stage means
// "inherit the global AI Assignment"). Additive: the whole record round-trips
// through the JSONB `data` column verbatim in sanitizeProjectForSync, so this
// needs no schema-version bump.
export const MODEL_OVERRIDE_STAGES = ['treatment', 'plan', 'evaluation'];

export function normalizeModelOverrides(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const stage of MODEL_OVERRIDE_STAGES) {
    const v = raw[stage];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const providerId = isStr(v.providerId) ? v.providerId.trim() : '';
    const model = isStr(v.model) ? v.model.trim() : '';
    // A model without a provider can't be resolved (the runtime keys on the
    // provider first), so drop a model-only stage — it would inherit anyway.
    const effort = stage !== 'evaluation' && EFFORT_LEVELS.includes(v.effort) ? v.effort : null;
    if (providerId) out[stage] = { providerId, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
  }
  return out;
}

// Per-project RENDER-backend pin (#3135) — `renderBackend.{image,video}`, each an
// optional `{ mode, modelId }`. Distinct from `modelOverrides` above: that pins the
// LLM that THINKS, this pins the backend that RENDERS. Only kinds that name a
// non-empty `mode` are kept, and the whole field normalizes to `null` when nothing
// is pinned — so an unpinned project stores exactly what it stored pre-#3135 and
// the enqueue-time forcing step has one falsy check instead of three.
export const RENDER_BACKEND_KINDS = ['image', 'video'];

export function normalizeRenderBackend(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const kind of RENDER_BACKEND_KINDS) {
    const v = raw[kind];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const mode = isStr(v.mode) ? v.mode.trim() : '';
    const modelId = isStr(v.modelId) ? v.modelId.trim() : '';
    // A modelId with no mode can't be dispatched (the queue routes on mode
    // first), so drop a mode-less pin — it would resolve to the default anyway.
    if (mode) out[kind] = { mode, ...(modelId ? { modelId } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Resolve the effective provider/model pin for one CD cognitive stage. The
 * per-project override wins when it names a providerId; otherwise the global
 * `settings.creativeDirector.<stage>` assignment applies (which itself may be
 * empty → the caller falls back to the system default / auto-resolution).
 * Shared by agentBridge (treatment/plan CoS-task pins) and sceneEvaluator
 * (evaluation vision-call pin) so the two resolution paths can never drift.
 *
 * The layer precedence is `pickLlmRoutePinLayer`'s — the winning layer is taken
 * WHOLE, so a project that names a provider but no model gets that provider's
 * default model rather than inheriting the global assignment's (which was picked
 * for whatever provider the assignment names). See `lib/llmRoutePin.js` for why
 * that differs from the per-field `resolveLlmRoutePin`.
 *
 * Returns `{ providerId, model, effort? }` with STRING values ('' when unset), not the
 * shared lib's `null`s: `getStageAssignment` and `resolveVisionEvalTarget` both
 * branch on plain falsiness and spread the result into task metadata, so keeping
 * the route dimensions as strings is this resolver's own contract. Effort is
 * additive and omitted when cleared, invalid, or evaluating through vision.
 * Legacy provider-only records keep provider defaults; both storage adapters
 * round-trip this optional JSON field without a migration.
 */
export function resolveStagePin(stage, project, settings) {
  const chosen = pickLlmRoutePinLayer(
    project?.modelOverrides?.[stage],
    settings?.creativeDirector?.[stage],
  );
  return {
    providerId: isStr(chosen?.providerId) ? chosen.providerId : '',
    model: isStr(chosen?.model) ? chosen.model : '',
    ...(stage !== 'evaluation' && EFFORT_LEVELS.includes(chosen?.effort) ? { effort: chosen.effort } : {}),
  };
}

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

/** Normalize a project at either storage backend's write chokepoint. */
export function beforeSave(project) {
  if (!Array.isArray(project?.runs)) return project;
  return { ...project, runs: trimRuns(project.runs) };
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
    disableAudio = true, autoAcceptScenes = false, sourceIssueId = null, commissionId = null,
    cast = [], generateFirstPass = false, directive = null,
    modelOverrides = {}, renderBackend = null,
  } = input;
  const videoDraft = input.workspace === 'video'
    ? creativeDirectorVideoDraftSchema.parse(input.videoDraft || {
      durationRange: { min: targetDurationSeconds, max: targetDurationSeconds },
    }) : null;
  return {
    id,
    name,
    ...(input.workspace === 'video' ? {
      workspace: 'video',
      videoDraft,
      videoOwnerInstanceId: input.videoOwnerInstanceId || null,
      videoReplica: false,
    } : {}),
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    aspectRatio,
    quality,
    modelId,
    targetDurationSeconds: videoDraft
      ? Math.min(videoDraft.durationRange.max, Math.max(videoDraft.durationRange.min, targetDurationSeconds))
      : targetDurationSeconds,
    styleSpec,
    startingImageFile,
    userStory,
    // Catalog ingredients seeded into this project via the Catalog "Remix into
    // → Creative Director" handoff (#1808). Structured casting context the
    // treatment agent grounds the prompt + per-scene casting on; the same
    // ingredients are also linked durably in catalog_ingredient_refs. Empty for
    // a bare project. Each member: { ingredientId, name, type, role, summary? }.
    cast: Array.isArray(cast) ? cast : [],
    // Video drafts use videoDraft.audio; keep the legacy top-level flag off on
    // new Video records so old consumers cannot mistake a native draft for a
    // request to strip clip audio. Legacy CD records retain their historical
    // default and UI contract.
    disableAudio: input.workspace === 'video' ? false : disableAudio,
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
    // Optional back-pointer to the Creative Commission whose fire minted this
    // project. Load-bearing, not decorative: it is how a commission finds the
    // work it spawned in order to STOP it (pause/delete) and how agentBridge
    // resolves the commission's CURRENT provider pin at dispatch instead of a
    // snapshot frozen at fire time. The run ledger cannot serve that role — it is
    // capped at MAX_PERSISTED_RUNS, so a long-wedged project falls out of it, and
    // a project a plan step spawns INDIRECTLY (bridgeFromIssue) never enters it.
    // SERVER-MANAGED — deliberately NOT in the public create/update schema (same
    // rule as `generateFirstPass` above). `POST /api/creative-director` would
    // otherwise let any caller bind an unrelated project to an existing
    // commission, inheriting that commission's provider pin and getting stopped
    // when it is paused or deleted. Only the scheduler's fire and the
    // bridgeFromIssue teaser path set it, and both call the service directly.
    // Additive: the whole record round-trips through the JSONB column verbatim
    // (sanitizeProjectForSync / mergeProjectRecord), so no schema-version bump.
    commissionId,
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
    // Per-project provider/model pins for the treatment/plan/evaluation stages
    // (per-project CD provider/model pins). `{}` = every stage inherits the
    // global AI Assignment. Additive — round-trips through the JSONB column
    // verbatim, so no schema-version bump is needed for federation.
    modelOverrides: normalizeModelOverrides(modelOverrides),
    // Which image/video BACKEND this project's enqueued media jobs render on
    // (#3135) — `{ image?: { mode, modelId? }, video?: { … } }`, or null for "use
    // the install default", which is what every pre-#3135 project has. Set from a
    // creative commission's `generation.imageMode`/`.videoMode` so a scheduled
    // fire can't have its pinned backend silently overridden by the planner LLM's
    // freehand job params. Additive — the whole record round-trips through the
    // JSONB column verbatim, so this needs no schema-version bump.
    renderBackend: normalizeRenderBackend(renderBackend),
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
  if (!local) return { next: remote.workspace === 'video' ? { ...remote, videoReplica: true, videoExecution: null } : remote, inserted: true, remoteWins: true, changed: true };
  // Video owner records cannot acquire approvals or execution through a peer.
  if (local.workspace === 'video' && local.videoReplica !== true) return { next: local, inserted: false, remoteWins: false, changed: false };
  if (remote.workspace === 'video') { remote.videoReplica = true; remote.videoExecution = null; }
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  // `commissionId` is machine-local — syncWire strips it, so a winning remote
  // never carries one. Re-attach the receiver's own value (mirrors
  // preserveLocalCommissionFields) or a peer's edit would silently orphan this
  // project from the commission that owns it, leaving it unstoppable from the
  // commission page and stuck on the provider it was dispatched with.
  const next = remoteWins
    ? { ...remote, ...(local.commissionId ? { commissionId: local.commissionId } : {}) }
    : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

/** Merge a project metadata patch, validating status. Returns the next record. */
export function applyProjectPatch(project, patch) {
  if (patch.status && !PROJECT_STATUSES.includes(patch.status)) {
    throw new ServerError(`Invalid status: ${patch.status}`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  if ('videoDraft' in patch && (project.workspace !== 'video' || !['draft', 'paused', 'failed'].includes(project.status))) {
    throw new ServerError('Pause Video production before editing production settings', { status: 409, code: 'INVALID_STATE' });
  }
  if ('workspace' in patch && patch.workspace !== project.workspace) {
    throw new ServerError('The project workspace cannot be changed', { status: 409, code: 'INVALID_STATE' });
  }
  const next = { ...project, ...patch, updatedAt: new Date().toISOString() };
  if ('videoDraft' in patch) next.videoDraft = creativeDirectorVideoDraftSchema.parse(patch.videoDraft);
  if (next.workspace === 'video' && next.videoDraft && ('videoDraft' in patch || 'targetDurationSeconds' in patch)) {
    const { min, max } = next.videoDraft.durationRange;
    next.targetDurationSeconds = Math.min(max, Math.max(min, next.targetDurationSeconds));
  }
  if ('renderBackend' in patch) next.renderBackend = normalizeRenderBackend(patch.renderBackend);
  // Normalize the whole override object on write so stored records never carry
  // empty/model-only stage stubs; the client sends the full object each save.
  if ('modelOverrides' in patch) next.modelOverrides = normalizeModelOverrides(patch.modelOverrides);
  // Changing the reviewer does not change the approved story or rendered clips.
  const creativeValue = (record, key) => key === 'modelOverrides'
    ? { ...record[key], evaluation: undefined } : record[key];
  if (project.workspace === 'video' && project.treatment?.artifact
      && ['videoDraft', 'targetDurationSeconds', 'aspectRatio', 'userStory', 'styleSpec', 'cast', 'startingImageFile', 'modelId', 'renderBackend', 'quality', 'modelOverrides', 'disableAudio'].some((key) => key in patch && !isDeepStrictEqual(creativeValue(next, key), creativeValue(project, key)))) {
    next.treatment = { ...project.treatment, artifact: { ...project.treatment.artifact, stale: true },
      scenes: project.treatment.scenes.map(scene => ({ ...scene, workRevision: (scene.workRevision || 0) + 1 })) };
    next.videoWorkRevision = (project.videoWorkRevision || 0) + 1;
    next.videoCutHistory = retainVideoCuts(project);
    next.videoRoughCut = null;
    next.videoFinalCut = null;
    next.finalVideoId = null;
  }
  return next;
}


function retireVideoPlan(plan) {
  return { history: [...(plan.history || []), { steps: structuredClone(plan.steps), updatedAt: plan.updatedAt }] };
}

function priorVideoTreatments(project) {
  if (!project.treatment?.artifact) return [];
  // Snapshots contain one revision only; nesting prior history grows exponentially.
  const { history = [], ...snapshot } = project.treatment;
  return [...history, structuredClone(snapshot)];
}

function assertPlannedSourceRevision(project, input) {
  if (project.workspace === 'video' && project.videoWorkRevision > 0 && input?.productionRevision !== project.videoWorkRevision) {
    throw new ServerError('This production was revised after planning began. Use the current productionRevision.', { status: 409, code: 'VIDEO_WORK_STALE' });
  }
  if (project.workspace === 'video' && project.videoPlanningContext
      && input?.sourceContextRevision !== project.videoPlanningContext.revision) {
    throw new ServerError('This plan used a different source context. Use the latest planning context and submit its sourceContextRevision.', { status: 409, code: 'VIDEO_SOURCE_CONTEXT_CHANGED' });
  }
}

/**
 * Validate + apply a treatment to a project. Returns the next record. Initializes
 * each scene's runtime fields if the agent didn't supply them, and preserves
 * paused/failed status (otherwise flips the project to 'rendering').
 */
export function applyTreatment(project, treatmentInput, sourceRevisions) {
  assertPlannedSourceRevision(project, treatmentInput);
  const parsed = creativeDirectorTreatmentSchema.safeParse(treatmentInput);
  if (!parsed.success) {
    throw new ServerError(
      `Treatment validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  let scenes = parsed.data.scenes.map((s) => ({
    ...s,
    status: s.status || 'pending',
    retryCount: s.retryCount ?? 0,
    renderedJobId: s.renderedJobId ?? null,
    evaluation: s.evaluation ?? null,
  }));
  if (project.workspace === 'video') {
    const previous = new Map((project.treatment?.scenes || []).map(scene => [scene.sceneId, scene]));
    let priorChanged = false;
    scenes = scenes.sort((a, b) => a.order - b.order).map(scene => {
      const old = previous.get(scene.sceneId);
      const unchanged = old && !project.treatment?.artifact?.stale && isDeepStrictEqual(videoSceneInputs(old), videoSceneInputs(scene))
        && !(scene.useContinuationFromPrior && priorChanged);
      priorChanged = !unchanged;
      return unchanged ? { ...scene, status: old.status, retryCount: old.retryCount, renderedJobId: old.renderedJobId,
        evaluation: old.evaluation, workRevision: old.workRevision || 0 }
        : { ...scene, status: 'pending', retryCount: 0, renderedJobId: null, evaluation: null, workRevision: (old?.workRevision || 0) + (old ? 1 : 0) };
    });
  }
  const treatment = { ...parsed.data, scenes };
  if (project.workspace === 'video') {
    treatment.artifact = compileVideoArtifact(project, treatment, sourceRevisions);
    treatment.history = priorVideoTreatments(project);
  }
  const nextStatus = (project.workspace === 'video' || project.status === 'paused' || project.status === 'failed')
    ? project.status
    : 'rendering';
  return {
    ...project,
    treatment,
    ...(project.workspace === 'video' && project.plan?.steps ? {
      plan: retireVideoPlan(project.plan),
    } : {}),
    ...(project.workspace === 'video' ? { videoCutHistory: retainVideoCuts(project), videoRoughCut: null, videoFinalCut: null, finalVideoId: null } : {}),
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
  assertPlannedSourceRevision(project, planInput);
  const parsed = creativeDirectorPlanSchema.safeParse(planInput);
  if (!parsed.success) {
    throw new ServerError(
      `Plan validation failed: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')}`,
      { status: 400, code: 'VALIDATION_ERROR' },
    );
  }
  if (project.workspace === 'video' && parsed.data.steps.some(step => step.toolName !== 'media_enqueueVideoJob')) {
    throw new ServerError('Video production plans support bounded media_enqueueVideoJob steps. Use the saved reference and audio choices for other media.', { status: 400, code: 'VIDEO_PLAN_TOOL_UNSUPPORTED' });
  }
  if (project.workspace === 'video') {
    for (const step of parsed.data.steps) {
      const params = step.args?.params || {};
      if (!Number.isFinite(params.durationSeconds) || params.durationSeconds < 1 || params.durationSeconds > 10
          || Number(params.chunks || 1) !== 1 || Number(params.batchSize || 1) !== 1) {
        throw new ServerError('Each Video plan step must render one clip with durationSeconds between 1 and 10.', { status: 400, code: 'VIDEO_PLAN_CLIP_BOUNDS' });
      }
      validateVideoShot(project, { sceneId: step.stepId, prompt: String(params.prompt || ''), durationSeconds: params.durationSeconds }, false);
    }
  }
  const prevSteps = Array.isArray(project.plan?.steps) ? project.plan.steps : [];
  const prevById = new Map(prevSteps.map((s) => [s.stepId, s]));
  const invalidated = new Set();
  if (project.workspace === 'video') {
    for (const step of parsed.data.steps) {
      const prior = prevById.get(step.stepId);
      if (!prior || project.treatment?.artifact?.stale || !isDeepStrictEqual([prior.toolName, prior.args, prior.dependsOn || []], [step.toolName, step.args, step.dependsOn || []])) invalidated.add(step.stepId);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of parsed.data.steps) if (!invalidated.has(step.stepId) && step.dependsOn?.some(id => invalidated.has(id))) {
        invalidated.add(step.stepId);
        changed = true;
      }
    }
  }
  const steps = parsed.data.steps.map((s) => {
    const prior = prevById.get(s.stepId);
    // Preserve a step the prior plan already finished successfully — a re-plan
    // must not re-run a completed render or re-issue a created record.
    if (prior && !invalidated.has(s.stepId) && PLAN_STEP_TERMINAL_SUCCESS.has(prior.status)) {
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
      status: project.workspace === 'video' ? 'pending' : s.status || 'pending',
      retryCount: project.workspace === 'video' ? 0 : s.retryCount ?? 0,
      result: project.workspace === 'video' ? null : s.result ?? null,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
    };
  });
  const replanRounds = project.plan ? (project.plan.replanRounds || 0) + 1 : 0;
  // Like treatment saves, an inert Video plan must remain editable so missing
  // attachments can be repaired. Saving a plan is not production approval.
  const nextStatus = (project.workspace === 'video' || project.status === 'paused' || project.status === 'failed')
    ? project.status
    : 'rendering';
  return {
    ...project,
    ...(project.workspace === 'video' ? { videoCutHistory: retainVideoCuts(project), videoWorkRevision: (project.videoWorkRevision || 0) + 1, videoRoughCut: null, videoFinalCut: null, finalVideoId: null } : {}),
    plan: { steps, replanRounds, ...(project.workspace === 'video' ? { submittedProductionRevision: project.videoWorkRevision || 0 } : {}), ...(project.workspace === 'video' && project.plan ? { history: [...(project.plan.history || []), ...(project.plan.steps ? [{ steps: structuredClone(prevSteps), updatedAt: project.plan.updatedAt }] : [])] } : {}), ...(parsed.data.sourceContextRevision ? { sourceContextRevision: parsed.data.sourceContextRevision } : {}), updatedAt: new Date().toISOString() },
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
  const { expectedProductionRevision, ...changes } = patch;
  if (project.workspace === 'video' && expectedProductionRevision !== undefined && expectedProductionRevision !== (project.videoWorkRevision || 0)) {
    throw new ServerError('This plan callback belongs to a superseded revision', { status: 409, code: 'VIDEO_WORK_STALE' });
  }
  const updated = { ...steps[idx], ...changes };
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
  const { expectedWorkRevision, ...changes } = patch;
  const previousScene = project.treatment.scenes[sceneIdx];
  if (project.workspace === 'video' && expectedWorkRevision !== undefined && expectedWorkRevision !== (previousScene.workRevision || 0)) {
    throw new ServerError('This shot belongs to a superseded revision. Refresh the project before applying your changes.', { status: 409, code: 'VIDEO_WORK_STALE' });
  }
  const updated = { ...previousScene, ...changes };
  const scenes = project.treatment.scenes.slice();
  scenes[sceneIdx] = updated;
  const treatment = { ...project.treatment, scenes };
  const creativeEdit = project.workspace === 'video' && treatment.artifact
    && ['prompt', 'imageStrength', 'sourceImageFile', 'useContinuationFromPrior'].some((key) => key in patch && patch[key] !== previousScene[key]);
  const audioEdit = project.workspace === 'video' && 'muteAudio' in patch && Boolean(patch.muteAudio) !== Boolean(previousScene.muteAudio);
  if (audioEdit && ['planning', 'rendering', 'stitching'].includes(project.status)) {
    throw new ServerError('Pause production before changing shot audio.', { status: 409, code: 'VIDEO_ACTIVE' });
  }
  if (audioEdit && !creativeEdit) updated.workRevision = (previousScene.workRevision || 0) + 1;
  if (creativeEdit) {
    validateVideoShot(project, updated, sceneId === [...scenes].sort((a, b) => a.order - b.order)[0].sceneId);
    updated.workRevision = (previousScene.workRevision || 0) + 1;
    updated.status = 'pending';
    updated.renderedJobId = null;
    updated.evaluation = null;
    updated.retryCount = 0;
    // A changed last frame also changes every directly continuing shot, up to
    // the next independent starting frame.
    const ordered = [...scenes].sort((a, b) => a.order - b.order);
    for (let index = ordered.findIndex(scene => scene.sceneId === sceneId) + 1; index < ordered.length && ordered[index].useContinuationFromPrior; index += 1) {
      const descendant = ordered[index];
      scenes[scenes.findIndex(scene => scene.sceneId === descendant.sceneId)] = {
        ...descendant, workRevision: (descendant.workRevision || 0) + 1,
        status: 'pending', renderedJobId: null, evaluation: null, retryCount: 0,
      };
    }
    // A shot edit changes the reviewed content, but cannot refresh stale source context.
    treatment.artifact = { ...treatment.artifact, revision: treatment.artifact.revision + 1 };
    treatment.history = priorVideoTreatments(project);
  }
  const next = {
    ...project,
    treatment,
    ...(creativeEdit && project.plan?.steps ? { plan: retireVideoPlan(project.plan) } : {}),
    ...((creativeEdit || audioEdit) ? { status: 'paused', videoWorkRevision: (project.videoWorkRevision || 0) + 1, videoCutHistory: retainVideoCuts(project), videoRoughCut: null, videoFinalCut: null, finalVideoId: null } : {}),
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
