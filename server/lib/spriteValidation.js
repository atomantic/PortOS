import { z } from 'zod';
import {
  SPRITE_ID_PATTERN, SPRITE_RECORD_KINDS, ANCHOR_DIRECTIONS, SPRITE_DIRECTIONS,
  TURNAROUND_ID, ANIMATION_PROVIDER_IDS,
} from './spriteVocabulary.js';
import { CHROMA_KEY_HEXES } from './spriteChromaKey.js';
import {
  WALK_TRACK, AUTHORED_TRACK_FIELDS, TRACK_BOUND_TRIPLES,
} from './spriteAnimationTracks.js';
// #3152 — the EFFECTIVE table (compiled `walk` + the user-defined store), so a
// user's track validates against its own bounds and occupies its own contract
// field with no schema edit. The store reads one small JSON config synchronously
// (see its header for why sync is the right answer here), which is what lets the
// schemas below stay module-load constants rather than becoming lazily-built.
import {
  effectiveTrack, getEffectiveAnimationTracks, getEffectiveAnimationTrackIds,
} from './spriteAnimationTrackStore.js';
// From lib since #5021 — the generation-mode alphabets live below validation.
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import {
  cloudModelIdString, grokVideoDurationSchema, isSafeSubdirFilter, recordRenderPinFields,
} from './sharedSchemas.js';

/**
 * Sprite Manager Zod schemas (issues #2895–#2898, #2979–#2985, #3015, #3136,
 * #3153). Split out of `validation.js` (issue #3873), which re-exports this
 * module so every existing `import { spriteXSchema } from '../lib/validation.js'`
 * keeps working.
 *
 * Cycle note: like every other per-domain `*Validation.js` file, this module
 * must NOT import from `validation.js` — ESM hoists its `export * from` lines,
 * so this file evaluates before that module's body runs and any value read back
 * would hit the TDZ. The cross-domain fragments this domain needs
 * (`cloudModelIdString`, `grokVideoDurationSchema`, `isSafeSubdirFilter`,
 * `recordRenderPinFields`) therefore live in the leaf `sharedSchemas.js`.
 */

// Animation-track-aware bounds (#3015). Frame-count / fps ranges are per track,
// not global, so the factories below take a track id and build the range from
// that track's registry row. An absent id is the default (walk) track, which is
// what keeps every pre-#3015 schema identical; an unrecognized one throws out of
// `getAnimationTrack` at schema-CONSTRUCTION time, so a mis-keyed track is a
// boot failure naming the known tracks rather than a range that silently
// validates a scanner action against walk's 6–16.
//
// There is deliberately no exported `track` field schema yet: no request shape
// carries a track id until the first second track lands, and an exported-but-
// unwired validator is false confidence.
export function spriteTrackFrameCountSchema(track) {
  const row = effectiveTrack(track);
  return z.number().int().min(row.minFrameCount).max(row.maxFrameCount);
}

export function spriteTrackFpsSchema(track) {
  const row = effectiveTrack(track);
  return z.number().int().min(row.minFps).max(row.maxFps);
}

// Sprite Manager (issue #2895, phase 1). Import runs against a local
// filesystem path the user supplies (the source pipeline checkout); the
// importer validates the tree shape server-side. The id pattern is owned by
// recordsLogic.js (ids double as data/sprites/ directory names) — a pure,
// dependency-free module, so importing it here can't disturb mocked suites.
export const spriteImportRequestSchema = z.object({
  sourceRoot: z.string().min(1).max(1024),
  characters: z.array(z.string().regex(SPRITE_ID_PATTERN)).optional(),
  includeProps: z.boolean().optional(),
});

// Delete one on-disk asset by its record-relative `path` (the same value the
// listing and static route use). Shape gate only — confinement, the live-atlas
// refusal, and the per-record write tail are the service's job (assets.js).
export const spriteAssetDeleteSchema = z.object({
  path: z.string().min(1).max(1024),
});

export const spriteRecordUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  // Reclassify an existing record between the noun kinds (#2932). `props` is
  // accepted so an imported family round-trips without a 400, but the UI never
  // creates one. Schema-parity with spriteCreateSchema below.
  kind: z.enum(SPRITE_RECORD_KINDS).optional(),
  notes: z.string().max(10000).nullable().optional(),
  // Fixed three-key set (#2895 decision) — manual override is limited to the
  // same keys the auto-selection picks from. Imported legacy records keep
  // whatever hex they carried (the importer writes via upsert, not this
  // schema); null clears back to auto-select-on-lock.
  chromaKey: z.enum(CHROMA_KEY_HEXES).nullable().optional(),
  // Per-record render pin (#3231 Phase 3) — this sprite's default image
  // backend + cloud model for reference renders.
  ...recordRenderPinFields,
});

// Phase 4 (issue #2898): publish binding — the shape check only; app
// existence and repo path anchoring are the publish service's job (they need
// filesystem + apps access). Repo-relative paths, no traversal, no absolutes.
const spriteRepoRelativePath = z.string().min(1).max(1024)
  .refine((p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'), {
    message: 'must be a repo-relative path with no traversal',
  });

// The grid the consuming app was built against (#2982). Optional: an absent
// contract publishes unchecked, exactly as bindings did before it existed.
// A directional consumer names `walkFrameCount`; an ambient-only consumer names
// `ambientFrameCount`. Playback speed is deliberately absent: consumers own
// timing, so PortOS's fps is preview-only and never part of the contract.
//
// The per-track frame-count keys are BUILT from the registry (#3136) rather than
// named one by one: each row already declares the `contractFrameCountField` it
// occupies, and `assertAnimationTrackRows` refuses two rows claiming the same
// one, so deriving the schema from those declarations is what lets a
// user-defined track's contract field validate against ITS bounds with no schema
// edit. Before this, adding a track meant remembering to add a fourth literal
// here — and forgetting meant the field was silently stripped by Zod and the
// app rung of the target-precedence chain went dead for that track.
const spriteTrackContractFields = Object.fromEntries(
  Object.values(getEffectiveAnimationTracks())
    .map((row) => [row.contractFrameCountField, spriteTrackFrameCountSchema(row.id).optional()]),
);

// The tracks whose frame count is enough ON ITS OWN to make a contract
// meaningful — a record can't be published without one of these authored, so a
// contract that pins none of them describes no atlas that could ever exist. The
// registry DECLARES this per row (`standaloneContract`), which reproduces the
// historical "walkFrameCount or ambientFrameCount" rule and stays correct for a
// user-defined track. It is the same field `atlas.js` dispatches its compile
// evidence chain on, so publish validation and compile can't disagree.
const SPRITE_STANDALONE_CONTRACT_FIELDS = Object.values(getEffectiveAnimationTracks())
  .filter((row) => row.standaloneContract)
  .map((row) => row.contractFrameCountField);

export const spriteRuntimeContractSchema = z.object({
  // Ranges come from each track's registry row (#3015/#3136). `walkFrameCount`
  // and its siblings are spread in from `spriteTrackContractFields` above —
  // `grep walkFrameCount` finds the row in animationTracks.js that names it.
  ...spriteTrackContractFields,
  cellSize: z.number().int().min(16).max(1024).nullable().optional(),
  columnCount: z.number().int().min(1).max(256).nullable().optional(),
}).superRefine((value, ctx) => {
  // An empty set means no registered track is a publishable baseline. The boot
  // guard in `assertAnimationTrackRows` makes that unreachable today (it
  // requires exactly one per record kind), but this schema must not silently
  // become "any contract passes" if that ever changes — with `[0]` undefined,
  // `path: [undefined]` and an empty message would report a rejection nothing
  // could act on. Refuse the whole contract with a message naming the cause.
  if (!SPRITE_STANDALONE_CONTRACT_FIELDS.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: 'No animation track declares itself a publishable baseline (standaloneContract) — a runtime contract cannot be validated',
    });
    return;
  }
  if (SPRITE_STANDALONE_CONTRACT_FIELDS.every((field) => value[field] === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [SPRITE_STANDALONE_CONTRACT_FIELDS[0]],
      message: `${SPRITE_STANDALONE_CONTRACT_FIELDS.join(' or ')} is required for a runtime contract`,
    });
  }
});

export const spritePublishBindingSchema = z.object({
  appId: z.string().min(1).max(200),
  atlasDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'atlasDestPath must point at a .png atlas file',
  }),
  portraitDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'portraitDestPath must point at a .png image file',
  }).nullable().optional(),
  presentationIdleDestPath: spriteRepoRelativePath.refine((p) => p.toLowerCase().endsWith('.png'), {
    message: 'presentationIdleDestPath must point at a .png sprite strip',
  }).nullable().optional(),
  codeBinding: z.object({
    path: spriteRepoRelativePath,
    resourcePath: z.string().min(1).max(1024),
    requiredOccurrenceCount: z.number().int().min(1).max(1000).optional(),
  }).nullable().optional(),
  // Absent (key omitted) inherits the stored contract; explicit null clears it
  // — see setPublishBinding. Keep the two distinguishable: `.optional()` must
  // stay separate from `.nullable()` here.
  runtimeContract: spriteRuntimeContractSchema.nullable().optional(),
}).nullable();

// acknowledgeOverwrite: explicit consent to replace a destination atlas
// PortOS never published (409 PUBLISH_DEST_OCCUPIED otherwise).
export const spriteAtlasPublishSchema = z.object({
  acknowledgeOverwrite: z.boolean().optional(),
});

// Optional per-compile geometry overrides (player default: 96px cells,
// pivot (48,88), 86×74 content bounds). Columns/rows are the fixed contract.
export const spriteAtlasCompileSchema = z.object({
  geometry: z.object({
    cellSize: z.number().int().min(16).max(1024).optional(),
    pivot: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional(),
    targetMaxHeight: z.number().int().min(8).max(1024).optional(),
    targetMaxWidth: z.number().int().min(8).max(1024).optional(),
  }).optional(),
});

// Phase 2 (issue #2896): reference workflow. prompts.js / chromaKey.js are
// pure sprite modules (like recordsLogic.js) so importing their constants
// here can't disturb mocked suites; modes.js is the dependency-free image-gen
// enum module.
export const spriteCreateSchema = z.object({
  id: z.string().regex(SPRITE_ID_PATTERN).optional(),
  name: z.string().trim().min(1).max(200),
  // Noun taxonomy (#2932): the UI's New Sprite panel picks character/place/
  // object. `props` is accepted for parity with the enum but stays import-only
  // in practice. Absent → the service defaults to 'character'.
  kind: z.enum(SPRITE_RECORD_KINDS).optional(),
  spec: z.record(z.string(), z.unknown()).nullable().optional(),
  // Per-record render pin (#3231 Phase 3) — seedable at create time (fork).
  ...recordRenderPinFields,
});

// 'turnaround' is the identity root of the turnaround-first workflow (#2979) —
// generated and locked before the main, which the anchors then descend from.
const spriteReferenceTargetSchema = z.enum([TURNAROUND_ID, 'main', ...ANCHOR_DIRECTIONS]);

// Multipart callers send numbers as form-field strings — coerce before range
// checks ('' → undefined so an empty field doesn't become 0).
const optionalUnitNumber = z.preprocess(
  (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
  z.number().min(0).max(1).optional(),
);

export const spriteReferenceGenerateSchema = z.object({
  target: spriteReferenceTargetSchema,
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  model: z.string().trim().max(64).optional(),
  effort: z.string().trim().max(32).optional(),
  designPrompt: z.string().max(4000).optional(),
  // Extra free-text guidance appended to a turnaround or anchor re-roll (e.g.
  // "no pocket on the right sleeve") so regenerating diverges from the
  // previous render instead of reproducing the same mistake.
  correctionPrompt: z.string().max(4000).optional(),
  // Re-process one existing turnaround candidate with a correction note. The
  // service validates that this is a real turnaround candidate owned by the
  // record before using it as the i2i seed.
  initImageCandidate: z.string().trim().max(500).optional(),
  initImageStrength: optionalUnitNumber,
  // Alternative i2i seed sources for the main target — resolved server-side and
  // mutually exclusive with an uploaded `referenceImage` file (which the route
  // handles separately). `initImageGalleryFile` is a render-history gallery
  // basename; `initImageSpriteId` is another sprite whose locked main reference
  // seeds this one (the "fork"/derive-from case). Ignored for anchor targets.
  initImageGalleryFile: z.string().trim().max(300).optional(),
  initImageSpriteId: z.string().trim().max(200).optional(),
});

// Fork a new character from an existing sprite's locked main reference: create
// the record, then image+text→image its main from the source reference. The
// design prompt is REQUIRED here (unlike a from-scratch generate) — a fork with
// no instructions is just a duplicate.
export const spriteForkSchema = z.object({
  name: z.string().trim().min(1).max(200),
  id: z.string().trim().max(200).optional(),
  designPrompt: z.string().trim().min(1).max(4000),
  mode: z.enum(QUEUEABLE_IMAGE_MODES).optional(),
  model: cloudModelIdString('model must be a valid model id').max(RECORD_RENDER_MODEL_MAX).optional(),
  effort: z.string().trim().max(32).optional(),
  initImageStrength: optionalUnitNumber,
});

export const spriteReferenceLockSchema = z.object({
  target: spriteReferenceTargetSchema,
  candidate: z.string().min(1).max(500),
  // Confirm-through for a clip-risk main lock (409 CHROMA_CLIP_RISK otherwise).
  acceptClipRisk: z.boolean().optional(),
});

// Only the seven turnaround-derived anchors can be revised in place. The
// turnaround and main remain frozen identity evidence, and south is the main.
export const spriteReferenceUnlockSchema = z.object({
  direction: z.enum(ANCHOR_DIRECTIONS),
});

// Phase 3 (issue #2897): walk-animation workflow. All 8 directions are
// animatable (south's anchor is the frozen main itself).
const spriteWalkDirectionSchema = z.enum(SPRITE_DIRECTIONS);

// Any run the walk state can resolve — which is every run id PortOS actually
// hands the client, not just the native `walk-<dir>-<hex>` shape: an imported
// run's id is its source-named directory slug (`run-3`), and a redraw run's id
// is a record-relative manifest path. Every service behind this resolves the id
// against server-owned walk state and dereferences only paths that state itself
// recorded (through resolveSpriteAssetPath), so the schema bounds shape and
// length only — the shared `isSafeSubdirFilter` predicate (safe charset, no `..`
// segment, no leading `/`), so a hardening tweak there reaches these routes too.
const spriteResolvableRunIdSchema = z.string().min(1).max(1024)
  .refine(isSafeSubdirFilter, { message: 'invalid run id' });

// Walk-cycle authoring bounds — built from the walk row of the sharp-free
// animation-track registry so the request schema and the server-side clamp
// share ONE range definition (a bounds change can't silently diverge).
// animationTracks pulls in no deps at all, native or otherwise.
const spriteWalkFrameCountSchema = spriteTrackFrameCountSchema(WALK_TRACK);
const spriteWalkFpsSchema = spriteTrackFpsSchema(WALK_TRACK);

export const spriteWalkGenerateSchema = z.object({
  direction: spriteWalkDirectionSchema,
  // WHICH engine renders the source clip (#4876): the cloud grok lane or the
  // local MiniMax H3 one. Omitted → grok, so an older client and every persisted
  // retry render exactly where they did before the local lane existed.
  provider: z.enum(ANIMATION_PROVIDER_IDS).optional(),

  // Clip length in seconds; the service defaults to 6s when omitted. Only
  // affects how much source footage the packer can choose from — the cycle's
  // look is set by frameCount/fps below.
  duration: grokVideoDurationSchema.optional(),
  // Deterministic-postprocess knobs (not grok's): how many frames the packed
  // cycle holds and how fast it plays back. Omitted → the set's pinned cycle
  // target; a value that DISAGREES with that target is refused with 409
  // WALK_TARGET_MISMATCH (#2985), since every direction in one atlas must share
  // the geometry.
  frameCount: spriteWalkFrameCountSchema.optional(),
  fps: spriteWalkFpsSchema.optional(),
  // Free-text guidance appended to a re-roll's motion prompt (#3134) — the same
  // additive correction the reference/anchor renders take. Absent or blank
  // leaves the prompt byte-identical to a blind regenerate.
  correctionPrompt: z.string().max(4000).optional(),
});

// Non-walk animation tracks share ONE generate/approve request shape, built per
// track from its registry row (#3136) — `scanner` gets 2–8 frames / 2–12fps and
// `ambient` gets 2–6 / 2–12 from the same factory, so a user-defined track needs
// no schema edit at all. Two facts make one shape work for both:
//
//   - `direction` is OPTIONAL here even for a directional track, because the
//     route builds the schema for the track it resolved and a non-directional
//     one derives row 0 server-side. The route requires it (below) exactly when
//     the resolved row is directional, so a directional generate can't slip
//     through without a facing — that check reads the same registry the bounds
//     came from, rather than being restated as a second enum.
//   - the remaining knobs are already registry-derived.
const buildSpriteTrackGenerateSchema = (track) => z.object({
  direction: spriteWalkDirectionSchema.optional(),
  // WHICH engine renders the source clip (#4876): the cloud grok lane or the
  // local MiniMax H3 one. Omitted → grok, so an older client and every persisted
  // retry render exactly where they did before the local lane existed.
  provider: z.enum(ANIMATION_PROVIDER_IDS).optional(),

  duration: grokVideoDurationSchema.optional(),
  frameCount: spriteTrackFrameCountSchema(track).optional(),
  fps: spriteTrackFpsSchema(track).optional(),
  correctionPrompt: z.string().max(4000).optional(),
});

// One schema per registered track, built at module load — the same
// derive-from-the-registry idiom `spriteTrackContractFields` uses, rather than
// re-allocating six Zod objects on every generate request.
const SPRITE_TRACK_GENERATE_SCHEMAS = Object.fromEntries(
  getEffectiveAnimationTrackIds().map((id) => [id, buildSpriteTrackGenerateSchema(id)]),
);

/**
 * The generate schema for one track. Unregistered ids build on demand so the
 * unknown-track error still comes from `getAnimationTrack` (naming the known
 * tracks) rather than reading as "no schema" — though the route validates
 * `trackId` against the registry first, so that path is defense in depth.
 */
export function spriteTrackGenerateSchema(track) {
  return SPRITE_TRACK_GENERATE_SCHEMAS[track] || buildSpriteTrackGenerateSchema(track);
}

export const spriteTrackApproveSchema = z.object({
  direction: spriteWalkDirectionSchema.optional(),
  runId: spriteResolvableRunIdSchema,
});

export const spriteTrackReopenSchema = z.object({
  direction: spriteWalkDirectionSchema.optional(),
});

// The `:trackId` path param. Shape gate only — whether the id names a REGISTERED
// track (and whether this record's kind may carry it) is the service's job, so
// the 404/400 names the known tracks instead of a regex failure. The charset
// matches the registry's slug ids and, load-bearingly, can never contain a `/`
// or `.` that would let the id widen the route's path.
export const spriteTrackParamsSchema = z.object({
  trackId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, 'invalid animation track id'),
});

// Authoring a user-defined animation type (#3153) — the user-facing subset of a
// registry row, and NOTHING else. The five on-disk/contract discriminators
// (`contractFrameCountField`, `selectionKind`, `setKind`, `finalErrorCode`,
// `contractFpsField`) plus `standaloneContract` and `builtin` are DERIVED by
// `animationTrackCrud.js` and deliberately absent here: they name files on disk and
// publish-contract keys that `assertAnimationTrackRows` requires to be globally
// unique, so accepting them from a request would let a typo hand one track another's
// evidence chain. `.strict()` is what makes that a 400 the user can see rather than a
// silently-stripped field they think they set.
//
// The frame/fps bounds are NOT registry-derived (unlike every other sprite schema
// here) because this request is what DEFINES a track's bounds — there is no row to
// read them from yet. The outer envelope is the widest the pipeline can pack; the
// `min <= default <= max` ordering is the registry's own cross-field rule and is
// asserted by `assertAnimationTrackRows` at save time, restated here only so the
// form gets a per-field 400 instead of a whole-table 409.
const spriteTrackBoundSchema = z.number().int().min(1).max(64);
const spriteTrackFpsBoundSchema = z.number().int().min(1).max(60);

// Keyed off AUTHORED_TRACK_FIELDS so this shape and the service's whitelist cannot
// drift — a field in one and not the other fails silently in one direction (Zod
// strips it) and as an unrecognized key in the other. The unusual `Object.fromEntries`
// spelling is what makes that coupling mechanical: adding a key to the constant
// without a validator here is an immediate boot failure naming the field, instead of
// a value that reaches the store unvalidated.
const SPRITE_ANIMATION_TRACK_FIELD_SCHEMAS = {
  label: z.string().min(1).max(120),
  directional: z.boolean(),
  kinds: z.array(z.enum(SPRITE_RECORD_KINDS)).min(1),
  minFrameCount: spriteTrackBoundSchema,
  maxFrameCount: spriteTrackBoundSchema,
  defaultFrameCount: spriteTrackBoundSchema,
  minFps: spriteTrackFpsBoundSchema,
  maxFps: spriteTrackFpsBoundSchema,
  defaultFps: spriteTrackFpsBoundSchema,
  // The i2v instruction. A stored row MUST carry one (a user-defined track has no
  // compiled prompt builder to fall back to), so this is required on create and
  // non-empty on update — an empty template would throw out of
  // `buildTrackVideoPrompt` after the user clicked Generate.
  promptTemplate: z.string().min(1).max(4000),
};

const spriteAnimationTrackFields = Object.fromEntries(AUTHORED_TRACK_FIELDS.map((key) => {
  const schema = SPRITE_ANIMATION_TRACK_FIELD_SCHEMAS[key];
  if (!schema) throw new Error(`validation: no schema for authored animation-track field '${key}'`);
  return [key, schema];
}));

// `min <= default <= max` on both knobs (the registry's own `TRACK_BOUND_TRIPLES`,
// so the front-run check can't disagree with the assert it front-runs), reported on
// the offending field so the form can point at it.
//
// Applied to each schema rather than once to a shared base because zod 4 refuses
// `.partial()` on an object that already carries a refinement — so the shape has to
// be finished first, then refined. The partial (update) case is why each triple is
// skipped unless all three values are present: a patch that supplies only `maxFps`
// is validated against the merged row by the service, not here.
const refineTrackBounds = (schema) => schema.superRefine((value, ctx) => {
  for (const [min, def, max] of TRACK_BOUND_TRIPLES) {
    if ([value[min], value[def], value[max]].some((v) => v === undefined)) continue;
    if (value[min] <= value[def] && value[def] <= value[max]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [def],
      message: `${min} <= ${def} <= ${max} is required`,
    });
  }
});

export const spriteAnimationTrackCreateSchema = refineTrackBounds(z.object({
  // The id names the on-disk `<trackId>/` directory and every run's `track` field,
  // so it reuses the same slug charset the `:trackId` param enforces.
  id: spriteTrackParamsSchema.shape.trackId,
  ...spriteAnimationTrackFields,
}).strict());

// `id` is absent from the patch on purpose — renaming would have to migrate the
// on-disk directories, every run record and every manifest, so it is a
// delete-plus-create the user makes explicitly. `.strict()` turns an attempted
// rename into a 400 naming `id` rather than a silent no-op.
export const spriteAnimationTrackUpdateSchema = refineTrackBounds(
  z.object(spriteAnimationTrackFields).strict().partial(),
).refine((patch) => Object.keys(patch).length > 0, { message: 'at least one field is required' });

// Pin the walk track's cycle target at the SET level (#2985). Both knobs are
// required: the target is one atomic set-level decision, and a partial write
// would leave "which value did I actually pin?" ambiguous on a record every
// later render is gated against.
export const spriteWalkTargetSchema = z.object({
  frameCount: spriteWalkFrameCountSchema,
  fps: spriteWalkFpsSchema,
});

export const spriteWalkApproveSchema = z.object({
  direction: spriteWalkDirectionSchema,
  // Also the resolvable shape (#2980): approve has been layout-aware since
  // #2993 — "a re-derived import stays in the run directory it was imported
  // into, and its approval must record THAT path" — so the native-only regex
  // dead-ended the reopen → re-derive → re-approve flow at its last click for
  // exactly the imported runs that work was for. What makes an approval safe is
  // approveWalkDirectionImpl's candidate/manifest/strip/frame tamper checks, not
  // a charset that encodes an obsolete provenance assumption.
  runId: spriteResolvableRunIdSchema,
});

// The optional acknowledgement is shared by both ways to re-open imported walk
// work. Defaulted rather than `.optional()` so the service's own default and the
// wire shape agree, and an older client's body still means "do not override".
const spriteWalkAcknowledgeNoClipsSchema = z.boolean().default(false);

export const spriteWalkReopenSchema = z.object({
  direction: spriteWalkDirectionSchema,
  acknowledgeNoClips: spriteWalkAcknowledgeNoClipsSchema,
});

export const spriteWalkUnlockSchema = z.object({
  acknowledgeNoClips: spriteWalkAcknowledgeNoClipsSchema,
});

export const spriteWalkPostprocessSchema = z.object({
  // Resolvable, not native-only (#2980): since #2993 the reprocess is
  // layout-aware and re-derives an IMPORTED run in the directory it was imported
  // into — which the strict shape rejected at the door, leaving the one path
  // back onto the set's target unreachable for exactly the population that
  // needs it.
  runId: spriteResolvableRunIdSchema,
  // Reprocess the on-disk clip without regenerating. Omitted fields adopt the
  // set's pinned cycle target (#2985) — NOT the run's stored values, since a
  // reprocess is how a drifted direction is brought back onto the target. A
  // supplied value that disagrees with the target is refused with 409
  // WALK_TARGET_MISMATCH.
  frameCount: spriteWalkFrameCountSchema.optional(),
  fps: spriteWalkFpsSchema.optional(),
});

// The raw ffmpeg frames behind one run (#2980) — a read-only enumeration of the
// directory `listSpriteAssets` deliberately skips. Path params, so the run id
// arrives as a URL segment; the trimmer can select an imported or redraw run, so
// it takes the resolvable shape rather than the native one.
export const spriteWalkSourceFramesParamsSchema = z.object({
  runId: spriteResolvableRunIdSchema,
});

// Trim geometry (strip path, cell size, frame labels) derives server-side
// from the run's packaged manifest — the client only names the run and
// which frames stay enabled.
export const spriteWalkTrimSchema = z.object({
  runId: spriteResolvableRunIdSchema,
  enabledColumns: z.array(z.number().int().min(0).max(63)).min(2).max(64)
    .refine((cols) => new Set(cols).size === cols.length, { message: 'columns must be unique' }),
  fps: z.number().int().min(1).max(60).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(),
});
