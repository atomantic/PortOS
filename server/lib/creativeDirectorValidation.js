import { z } from 'zod';
import { ASPECT_RATIOS, QUALITIES, PROJECT_STATUSES, SCENE_STATUSES, PLAN_STEP_STATUSES } from './creativeDirectorPresets.js';
import { ARC_SHAPE_IDS, ARC_ROLES } from './storyArc.js';
import { BIBLE_LIMITS } from './storyBible.js';
import { emptyToUndefined } from './zodCompat.js';

// =============================================================================
// CREATIVE DIRECTOR + CREATE-SUITE IMPORTER SCHEMAS
// =============================================================================
// Split out of validation.js (issue #1151); validation.js re-exports
// everything here so existing deep imports keep working. The import from
// zodCompat.js (not validation.js) supplies emptyToUndefined — ESM hoists
// validation.js's `export * from` of this module, so importing validation.js
// back from here would evaluate before its body runs (TDZ).


export const creativeDirectorAspectRatioSchema = z.enum(ASPECT_RATIOS);
export const creativeDirectorQualitySchema = z.enum(QUALITIES);

// Top-level project create. modelId is required because each LTX variant
// has a different speed/VRAM/quality profile and the project locks it at
// creation. targetDurationSeconds is capped at 600 (10 min) per the v1 plan
// — much beyond that and the agent's treatment quality drifts hard.
// Strict basename: rejects path separators and the exact `.`/`..` segments.
// Used for both startingImageFile (project create) and sourceImageFile
// (per-scene) since both feed into `join(PATHS.images, ...)` later. The
// downstream consumers also do a resolve+prefix-check against PATHS.images
// (sceneRunner.js) — that's the real traversal guard; this validator just
// catches the obvious bad values at the route boundary. Note: a substring
// check on `..` would over-reject legitimate names like `my..image.png`,
// so we only reject the exact dot segments and rely on prefix-checks for
// the actual escape protection.
const safeBasename = z.string()
  .max(256)
  .regex(/^[^/\\]+$/, 'must be a basename (no path separators)')
  .refine((v) => v !== '.' && v !== '..',
    'must not be `.` or `..`');

// One cast member — a catalog ingredient seeded into the project (#1808). Stored
// on the project record and surfaced to the treatment agent for grounding +
// per-scene casting. `ingredientId` is the stable catalog id so the agent (and a
// future casting UI) can reference a specific member. The server derives this
// array from `catalogIngredientIds`; it's accepted on the wire too so a direct
// API caller (or a sync round-trip) can supply it explicitly.
export const creativeDirectorCastMemberSchema = z.object({
  ingredientId: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  type: z.string().max(64).optional(),
  role: z.string().max(64).optional(),
  summary: z.string().max(500).optional(),
});

// Production directive (CDO Phase 2, #2184) — the brief the planner agent turns
// into a plan. `goal` is the free-text intent ("produce a 6-issue noir comic in
// universe X with covers and a teaser trailer"); `deliverables` is the checklist
// of requested outputs; `constraints` scopes the run (target universe/series
// ids, output formats, and a daily-action budget cap). Kept permissive on the
// constraint values — the plan advance loop gates each tool call at dispatch, so
// the directive is context for the planner, not an enforcement surface itself.
export const creativeDirectorDirectiveSchema = z.object({
  goal: z.string().min(1).max(5000),
  deliverables: z.array(z.string().min(1).max(200)).max(20).default([]),
  constraints: z.object({
    universeId: z.string().max(120).nullable().optional(),
    seriesId: z.string().max(120).nullable().optional(),
    formats: z.array(z.string().min(1).max(64)).max(20).optional(),
    budgetCap: z.number().int().min(0).max(100000).nullable().optional(),
  }).default({}),
});

// Per-project AI model override (issue: per-project CD provider/model pins).
// Each Creative Director cognitive stage (treatment / plan / evaluation) can be
// pinned to a specific provider + model ON THIS PROJECT, overriding the global
// `settings.creativeDirector.<stage>` AI Assignment. A stage is only overridden
// when it names a `providerId`; a blank/absent stage inherits the global pin
// (which itself falls back to the system default). `model` is optional — blank
// uses the provider's default/auto model. Kept permissive on the string values;
// the runtime resolver (agentBridge / sceneEvaluator) validates the provider is
// usable and of the right harness type before honoring it. Additive on the
// project record (round-trips through the JSONB `data` column verbatim), so it
// needs no schema-version bump for federation.
export const creativeDirectorStagePinSchema = z.object({
  providerId: z.string().max(120).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
}).strict();

export const creativeDirectorModelOverridesSchema = z.object({
  treatment: creativeDirectorStagePinSchema.optional(),
  plan: creativeDirectorStagePinSchema.optional(),
  evaluation: creativeDirectorStagePinSchema.optional(),
}).strict();

export const creativeDirectorProjectCreateSchema = z.object({
  name: z.string().min(1).max(200),
  aspectRatio: creativeDirectorAspectRatioSchema,
  quality: creativeDirectorQualitySchema,
  modelId: z.string().min(1).max(64),
  targetDurationSeconds: z.number().int().min(5).max(600),
  styleSpec: z.string().max(5000).default(''),
  startingImageFile: safeBasename.nullable().optional(),
  userStory: z.string().max(10000).nullable().optional(),
  // Catalog "Remix into → Creative Director" handoff (#1761/#1808): the selected
  // ingredient ids. The service resolves them to live records, folds them into
  // the project `cast`, and links them via catalog_ingredient_refs. Bounded to
  // 50 to match the remix multi-select cap.
  catalogIngredientIds: z.array(z.string().trim().max(64)).max(50).optional(),
  // Server-derived from catalogIngredientIds; also accepted directly for off-UI
  // callers and sync. Schema-parity with buildProjectRecord's `cast` field.
  cast: z.array(creativeDirectorCastMemberSchema).max(50).optional(),
  // Audio defaults OFF for CD projects — current model audio output is
  // inconsistent across renders and the user can re-enable per-project.
  // (videoGen one-offs still default to enabled.)
  disableAudio: z.boolean().optional().default(true),
  autoAcceptScenes: z.boolean().optional().default(false),
  // Optional back-pointer to the pipeline issue that spawned this project,
  // used by the stitch step to mix in audio-stage music. Bare CD projects
  // (no pipeline origin) leave this null.
  sourceIssueId: z.string().min(1).max(64).nullable().optional(),
  // Production directive (CDO Phase 2, #2184). When present the project is
  // PLAN-driven: the planner agent turns this brief into a validated step list
  // the generalized advance loop executes through the gated creative tool
  // registry. Absent → the legacy video treatment/scene flow (unchanged).
  directive: creativeDirectorDirectiveSchema.nullable().optional(),
  // Optional per-project provider/model pins for the treatment/plan/evaluation
  // stages. Absent → every stage inherits the global AI Assignment.
  modelOverrides: creativeDirectorModelOverridesSchema.optional(),
});

// Autonomous auto-cast (#1810). `types` narrows the catalog search to a set of
// castable atom types (default character/place/object/scene server-side); `limit`
// caps how many candidates the hybrid search returns. The suggest variant needs a
// brief to search on; the apply variant derives one from the project when omitted.
const autoCastTypes = z.array(z.string().trim().min(1).max(64)).max(10).optional();
const autoCastLimit = z.number().int().min(1).max(50).optional();

export const creativeDirectorAutoCastSuggestSchema = z.object({
  brief: z.string().min(1).max(10000),
  types: autoCastTypes,
  limit: autoCastLimit,
});

export const creativeDirectorAutoCastApplySchema = z.object({
  // Omitted → the service derives the brief from the project's name/style/story.
  brief: z.string().max(10000).optional(),
  types: autoCastTypes,
  limit: autoCastLimit,
  // Auto-compose (#1817): when true, kick off the treatment agent after the cast
  // is seeded so the director autonomously writes a treatment + scene plan
  // grounded in the auto-cast cast. The route only honors it when the project has
  // a non-empty cast and no treatment yet (never clobbers an existing one).
  compose: z.boolean().optional(),
  // First-pass gen (#1818): when true, enqueue a catalog portrait render for each
  // newly auto-cast member that lacks a portrait so the cast "arrives on-model".
  // Reuses the durable media-job → catalog attach hook (#1359); strictly optional
  // and only seeds queue-backed image-gen modes (local / codex).
  generateFirstPass: z.boolean().optional(),
  // First-pass music bed (#1928, split from #1867): when true, enqueue an
  // optional background audio render for the project so it "arrives" with a
  // mood-setting bed. Reuses the durable media-job → project attach hook
  // (creativeDirectorMusicBedHook); strictly optional and skips gracefully if
  // no local audio-gen engine is provisioned.
  generateFirstPassMusicBed: z.boolean().optional(),
});

// Update is restricted to a few editable fields. modelId / aspectRatio /
// quality / targetDurationSeconds are locked at creation — changing them
// mid-project would invalidate already-rendered segments.
//
// Server-managed fields (timelineProjectId, runs, treatment) are
// intentionally NOT in this schema. timelineProjectId is set only by
// stitchRunner.js — accepting it in PATCH payloads would let a client
// point a CD project at an unrelated user timeline project, which the
// next stitch would silently overwrite via updateTimelineProject.
export const creativeDirectorProjectUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  styleSpec: z.string().max(5000).optional(),
  userStory: z.string().max(10000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  finalVideoId: z.string().max(64).nullable().optional(),
  failureReason: z.string().max(500).nullable().optional(),
  // Toggleable post-creation — only affects future scene renders.
  disableAudio: z.boolean().optional(),
  // Per-project provider/model pins (editable from the CD project's Models
  // drawer). A stage naming a providerId overrides the global AI Assignment;
  // a blank stage inherits it. The whole object replaces the stored one.
  modelOverrides: creativeDirectorModelOverridesSchema.optional(),
}).strict();

// One scene in the treatment, written by the agent on the treatment task.
export const creativeDirectorSceneSchema = z.object({
  sceneId: z.string().min(1).max(64),
  order: z.number().int().min(0),
  intent: z.string().min(1).max(1000),
  prompt: z.string().min(1).max(8000),
  negativePrompt: z.string().max(8000).optional().default(''),
  durationSeconds: z.number().min(1).max(10),
  useContinuationFromPrior: z.boolean().default(false),
  sourceImageFile: safeBasename.nullable().optional(),
  // How strongly the source image conditions the i2v render. 1.0 = preserve
  // source closely; lower values give the model more freedom to drift.
  // Null lets the runtime pick — `sceneRunner.js` applies 0.85 as the
  // default for continuation scenes (anchors the next clip to the prior
  // last-frame so renders don't drift hard), and leaves it null otherwise
  // (mlx_video / dgrauet uses its own default).
  imageStrength: z.number().min(0).max(1).nullable().optional(),
  status: z.enum(SCENE_STATUSES).default('pending'),
  retryCount: z.number().int().min(0).max(10).default(0),
  renderedJobId: z.string().max(64).nullable().optional(),
  // Per-scene casting (#1808) — the catalog cast members the agent bound to this
  // scene, referencing the project `cast` by ingredientId. Optional: the agent
  // only sets it when a scene features specific characters/places, and bare
  // (non-remix) projects never carry it. Capped at the same 50 as the project
  // cast so a busy scene can't make the whole treatment fail validation.
  cast: z.array(creativeDirectorCastMemberSchema).max(50).optional(),
  evaluation: z.object({
    score: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
    accepted: z.boolean(),
    sampledAt: z.string().optional(),
  }).nullable().optional(),
});

// The full treatment doc the agent writes after the planning task.
export const creativeDirectorTreatmentSchema = z.object({
  logline: z.string().min(1).max(500),
  synopsis: z.string().min(1).max(5000),
  scenes: z.array(creativeDirectorSceneSchema).min(1).max(120),
});

// Used by the agent when finishing a scene render.
export const creativeDirectorSceneUpdateSchema = z.object({
  // Full SCENE_STATUSES — the evaluator agent flips a scene back to 'pending'
  // (with an updated prompt + bumped retryCount) to request a re-render; see
  // creativeDirectorPrompts.js and completionHook.js's advanceAfterSceneSettled.
  status: z.enum(SCENE_STATUSES).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  renderedJobId: z.string().max(64).nullable().optional(),
  prompt: z.string().min(1).max(8000).optional(),
  // Evaluator may adjust per-scene strength on retry — e.g. drop from
  // 0.85 → 0.6 when the seed image is too dominant or raise toward 1.0
  // when continuation drifted.
  imageStrength: z.number().min(0).max(1).nullable().optional(),
  evaluation: z.object({
    score: z.number().min(0).max(1).optional(),
    notes: z.string().max(2000).optional(),
    accepted: z.boolean(),
    sampledAt: z.string().optional(),
  }).nullable().optional(),
}).strict();

// ---------------------------------------------------------------------------
// Production plans (CDO Phase 2, #2184).
//
// A plan is the validated step list the planner agent (`cd-plan`) writes for a
// directive-driven project. Each step names a creative-tool-registry tool
// (`toolName`) + its args, plus a `dependsOn[]` DAG edge list; the generalized
// advance loop executes steps sequentially (deps respected) through the gated
// `dispatchCreativeTool` chokepoint. `toolName` is validated as a bounded string
// here — the registry is a services module (lib can't import it), so the advance
// loop rejects an unknown tool at dispatch time (Unknown creative tool).
// ---------------------------------------------------------------------------

export const creativeDirectorPlanStepSchema = z.object({
  // Word chars + hyphen only — this MUST stay in lockstep with the cross-step
  // result-reference grammar in planAdvance.js (`{{steps.<stepId>.result.<key>}}`,
  // stepId group `[\w-]+`, #2773). A looser stepId here would let the planner mint
  // an id that a downstream step can't reference, with no safe re-plan recovery
  // (the producer already ran, and renaming the step re-runs it). Rejecting at
  // plan-author time surfaces a 4xx the planner fixes per the cd-plan prompt.
  stepId: z.string().min(1).max(64).regex(/^[\w-]+$/, 'stepId must contain only word characters or hyphens'),
  toolName: z.string().min(1).max(64),
  // Free-form tool args — each tool re-validates against its own Zod schema at
  // dispatch, so the plan gate stays permissive (an over-strict gate here would
  // duplicate every tool's schema and drift from it).
  args: z.record(z.any()).default({}),
  // DAG edges: stepIds that must reach a terminal-success state before this step
  // runs. Empty = runnable immediately (subject to sequential ordering).
  dependsOn: z.array(z.string().min(1).max(64)).max(50).default([]),
  // Runtime fields — the agent may omit them on a fresh plan; the sanitizer
  // (applyPlan) defaults status→pending, retryCount→0, result→null.
  status: z.enum(PLAN_STEP_STATUSES).optional(),
  retryCount: z.number().int().min(0).max(10).optional(),
  result: z.record(z.any()).nullable().optional(),
}).strict();

export const creativeDirectorPlanSchema = z.object({
  steps: z.array(creativeDirectorPlanStepSchema).min(1).max(60),
}).strict();

// Blocked-step triage actions (CDO Phase 4, #2186). The studio UI's Plan tab
// dispatches one of these against a single plan step:
//   - `skip`  → mark the step `skipped` (a terminal-success state), unblocking
//               its dependents, and resume the plan advance loop.
//   - `retry` → reset a `blocked`/`failed` step back to `pending` (clearing its
//               prior result + retryCount) so the advance loop re-dispatches it.
//               Doubles as the "approve" affordance for a step the gate blocked
//               (destructive / over-budget): once the human raises the budget or
//               flips autonomy, retry re-runs just that step.
export const creativeDirectorPlanStepActionSchema = z.object({
  action: z.enum(['skip', 'retry']),
}).strict();

// ---------------------------------------------------------------------------
// Create Suite — Importer.
//
// The importer takes a finished prose/script source and reverse-engineers
// universe canon + series arc + issue split. Zod here enforces the wire
// shape; the heavy validation (entry-level field caps, kind-specific
// trimming) lives in storyBible.sanitizeBibleList + storyArc.sanitizeArc so
// commit-side mutations always run through the same sanitizers the rest of
// the pipeline uses. The canon/arc/issue entries below therefore use
// `.passthrough()` — we want every field the LLM picked to reach the
// sanitizer, not get stripped at the schema gate.
// ---------------------------------------------------------------------------

export const IMPORTER_CONTENT_TYPES = Object.freeze([
  'short-story', 'novel', 'screenplay', 'comic-script',
]);

// Hard ceiling at the schema layer (mirrors writersRoomDraftSaveSchema). The
// orchestrator's IMPORTER_SOURCE_CHAR_LIMIT matches this 5MB ceiling and
// returns a friendlier error; the real operational limit is dynamic — the
// active provider's context window.
const importerSourceField = z.string().min(1).max(5_000_000);

// Per-issue verbatim-excerpt ceiling (seeds stages.prose / stages.comicScript /
// stages.teleplay).
// MUST stay ≤ `STAGE_OUTPUT_MAX` in server/services/pipeline/issues.js (400_000)
// — createIssue trims stage output to that, so a larger excerpt would be
// SILENTLY TRUNCATED on commit despite the import being advertised as verbatim.
// (lib can't import from services; importer.test.js pins the invariant.) Far
// below importerSourceField's 5MB so a single bundled comic issue can't blow
// past it silently — analyze validates against this so the failure surfaces at
// analyze, not as a commit-time truncation/400.
export const IMPORTER_PROSE_EXCERPT_MAX = 400_000;

// Classify endpoint only sees the source — no universe/series context. The
// LLM only consumes the head, so the schema is intentionally minimal.
export const importerClassifySchema = z.object({
  source: importerSourceField,
  providerOverride: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  // Pinned model id for the chosen provider; '' from the UI ("Default model")
  // coerces to undefined so runStagedLLM falls back to the stage/provider
  // default model.
  modelOverride: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
}).strict();

export const importerAnalyzeSchema = z.object({
  universeName: z.string().trim().min(1).max(200),
  seriesName: z.string().trim().min(1).max(200),
  contentType: z.enum(IMPORTER_CONTENT_TYPES),
  source: importerSourceField,
  // UI sends `''` for "no override picked"; coerce to undefined so the
  // server's `await getProviderById(undefined)` short-circuit kicks in.
  providerOverride: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  // Pinned model id for the chosen provider; '' from the UI ("Default model")
  // coerces to undefined so runStagedLLM falls back to the stage/provider
  // default model.
  modelOverride: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
  targetIssueCount: z.number().int().min(1).max(50).optional(),
}).strict();

// Retry-issues endpoint — re-runs ONLY the issue split after a failed analyze
// (canon + arc are preserved client-side). No universe/series names needed;
// `arcSummary` (optional) lets the LLM align issue boundaries to the arc the
// user already has in the Review panel, and `seriesName` is purely cosmetic
// prompt context.
export const importerRetryIssuesSchema = z.object({
  contentType: z.enum(IMPORTER_CONTENT_TYPES),
  source: importerSourceField,
  seriesName: z.string().trim().max(200).optional(),
  arcSummary: z.string().max(8000).optional(),
  providerOverride: z.preprocess(emptyToUndefined, z.string().trim().max(120).optional()),
  modelOverride: z.preprocess(emptyToUndefined, z.string().trim().max(200).optional()),
  targetIssueCount: z.number().int().min(1).max(50).optional(),
}).strict();

// Single canon-entry schema — every per-kind sanitizer (character / place /
// object) only requires a `name`; `.passthrough()` keeps every LLM-emitted
// field (firstAppearance, slugline, palette, …) for the sanitizer.
const importerCanonEntry = z.object({
  name: z.string().trim().min(1).max(BIBLE_LIMITS.NAME_MAX),
}).passthrough();

// Arc shape — every field optional so a partial preview (user cleared some
// fields in the Review step) still validates; sanitizeArc fills in the
// shape-level defaults.
const importerArcShape = z.object({
  logline: z.string().max(500).optional(),
  summary: z.string().max(8000).optional(),
  protagonistArc: z.string().max(4000).optional(),
  themes: z.array(z.string().max(100)).max(20).optional(),
  shape: z.enum(ARC_SHAPE_IDS).optional(),
}).passthrough();

// Season + issue entries used inside the commit payload. Seasons stay
// permissive (sanitizer normalizes numbers + ids + status); issues need
// `title` for createIssue but otherwise let the orchestrator decide.
const importerSeasonEntry = z.object({
  number: z.number().int().min(1).max(99).optional(),
  title: z.string().trim().max(200).optional(),
  logline: z.string().max(500).optional(),
  synopsis: z.string().max(4000).optional(),
  endingHook: z.string().max(1000).optional(),
  episodeCountTarget: z.number().int().min(0).max(999).optional(),
}).passthrough();

const importerIssueEntry = z.object({
  title: z.string().trim().min(1).max(300),
  // Optional — the service's commitImport auto-assigns the next free
  // arcPosition when omitted (mirrors the season.number auto-assign).
  // The wire previously required this, which orphaned the service-side
  // auto-assign as dead code for HTTP callers; making it optional puts
  // wire + service on one contract and keeps the auto-assign reachable.
  arcPosition: z.number().int().min(1).max(9999).optional(),
  // The LLM may legitimately omit arcRole on a B-plot-light volume; gate
  // the enum but allow the field to be missing. Wrap with z.preprocess so
  // an empty string from the UI's "clear" affordance maps to undefined.
  arcRole: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.enum(ARC_ROLES).optional(),
  ),
  // Season the issue belongs to. Optional — orchestrator picks the first
  // season when omitted on a multi-season import.
  seasonNumber: z.number().int().min(1).max(99).optional(),
  logline: z.string().max(500).optional(),
  synopsis: z.string().max(4000).optional(),
  // 500K cap matches the issue's stages.prose.output limit so a long
  // novel chapter can land verbatim. Optional — the LLM may omit the
  // excerpt on some issues. When present, must be non-empty + non-whitespace
  // so it doesn't seed prose.output with whitespace and mark the stage
  // `ready` misleadingly. Exported so the mechanical comic splitter can
  // validate against the SAME ceiling at analyze time (a verbatim split could
  // otherwise produce an excerpt commit would reject — a confusing dead-end).
  proseExcerpt: z.string().min(1).max(IMPORTER_PROSE_EXCERPT_MAX).refine(
    (s) => s.trim().length > 0,
    { message: 'proseExcerpt must contain non-whitespace content' },
  ).optional(),
}).passthrough();

export const importerCommitSchema = z.object({
  universeId: z.string().trim().min(1).max(120),
  seriesId: z.string().trim().min(1).max(120),
  canonSelections: z.object({
    characters: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
    places: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
    objects: z.array(importerCanonEntry).max(BIBLE_LIMITS.ENTRIES_PER_BIBLE_MAX).default([]),
  }).default({ characters: [], places: [], objects: [] }),
  arc: importerArcShape.nullable().optional(),
  seasons: z.array(importerSeasonEntry).max(50).default([]),
  issues: z.array(importerIssueEntry).min(1).max(50),
  // Drives which stage each issue's verbatim excerpt seeds: a script-form
  // import seeds its matching script stage (ready) and the pipeline never
  // regenerates — `comic-script` → `stages.comicScript`, `screenplay` →
  // `stages.teleplay`; prose-like types seed `stages.prose`. Optional +
  // defaulting to prose-seed keeps older clients (which don't send it) on the
  // prior behavior.
  contentType: z.enum(IMPORTER_CONTENT_TYPES).optional(),
  // Opt-in AI formatting cleanup: when true, each seeded excerpt is run through
  // the manuscript-reformat pass at commit time so imported text arrives clean
  // (issue #1335). One LLM call per issue + best-effort fallback, so it defaults
  // off; older clients that don't send it keep the verbatim-seed behavior.
  cleanupFormatting: z.boolean().optional().default(false),
  // Replace-mode flag — when true, every existing issue on the series is
  // deleted before the incoming `issues` are created, and `series.arc` +
  // `series.seasons[]` are written verbatim (not merged). Canon is still
  // merged additively even in replace mode — universe canon is shared
  // across series, so a per-series destructive replace would be wrong.
  // Defaults to false to preserve the additive merge behavior.
  replaceMode: z.boolean().optional().default(false),
}).strict();

