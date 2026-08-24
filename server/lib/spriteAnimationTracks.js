/**
 * Sprites — the animation-track registry (issue #3015).
 *
 * Frame-count and fps bounds used to be GLOBAL and walk-shaped: one 6–16 /
 * 4–24 range applied to every animation, because the walk cycle was the only
 * animation that existed. #2985 made the persisted target *track-keyed*
 * (`animationTargets.walk`), but nothing described what tracks exist or what
 * each one's legal range is — so a 3-frame ambient loop (a tree in the wind)
 * was unrepresentable. The shipped 4-frame scanner action proves the registry
 * supports a real non-walk range below walk's floor.
 *
 * This module is that description. One row per known track carries its own
 * bounds, defaults, directionality, and the `runtimeContract` field names it
 * occupies — so adding a track is a row here plus its pipeline, never a hunt
 * for hard-coded 6/16 literals. `walk` is the first and (today) only row and
 * reproduces its historical values exactly; `walkBounds.js` now re-reads this
 * row rather than defining the range itself.
 *
 * **Sharp-free leaf, deliberately.** `server/lib/validation.js` builds its Zod
 * ranges from these rows and must not drag the native image graph
 * (sharp/ffmpeg, via walkPostprocess) into the request-validation graph — the
 * same split walkBounds.js was created for, now one level deeper. This module
 * imports NOTHING. `animationTracks.test.js` asserts that transitively.
 *
 * **Unknown track ids are an error, not a fallback.** `getAnimationTrack('nope')`
 * throws instead of quietly handing back walk's range — a mis-keyed track that
 * silently validated against walk's 6–16 would let a 4-frame action be rejected
 * for reasons no message explains. Absent (`undefined`/`null`) means "the
 * default track" and resolves to `walk`, which is what preserves every existing
 * call site; an empty string is *present and invalid*, so it throws.
 *
 * **Which records may carry a track is registry data too (#3017).** The whole
 * sprite animation surface used to be gated on a literal `kind !== 'character'`
 * check, which is why `place` and `object` records had no animation path at all
 * — a tree in the wind or a flickering lamp was unrepresentable not because the
 * atlas couldn't hold it but because the gate refused the record. Each row now
 * declares the record `kinds` that may carry it, and the gates ask the registry
 * (`tracksForKind` / `kindSupportsTrack`) instead of naming a kind. Walk stays
 * character-only, so behavior is unchanged today; a row that lists `place` is
 * all it takes to unlock those records, with no gate edit anywhere.
 *
 * **The per-track WORKFLOW is registry data too (#3136).** `scanner` and
 * `ambient` each shipped as a ~300-line clone of walk's state/start/package/
 * approve/invalidate stack — identical control flow differing only in which
 * reference image seeds the render, what the on-disk selection/set files are
 * called, and which prompt text goes to the provider. Those differences are now
 * either FIELDS on the row (`selectionKind`/`setKind`) or derived from one
 * (`directional` decides both the facing count and which locked reference seeds
 * the render), and `animationTrackWorkflow.js` is the one implementation both
 * drive. A user-defined track is therefore a row plus a prompt template — no new
 * service module, no new routes.
 *
 * **`walk` is the only COMPILED-IN row (#3152).** Every other track — including
 * `scanner` and `ambient`, which shipped as compiled rows through #3018/#3045 —
 * now lives in the user-defined store `animationTrackStore.js` reads, seeded
 * from `data.reference/sprites/animation-tracks.json` by migration 211. That
 * store is what makes "a chest opening" or "a flower blossoming" a user action
 * rather than a PortOS code change, and it is why this table shrank to one row
 * instead of growing a fourth. The MERGE cannot live here: this module does file
 * I/O nowhere and imports nothing (see the leaf note above), so the store
 * imports this and never the reverse. Callers that must see user rows resolve
 * `getEffectiveAnimationTracks()` and pass it through the `tracks` parameter
 * every reader below already takes.
 *
 * A stored row carries two fields a compiled one doesn't: `promptTemplate` (the
 * i2v wording `trackPrompts.js` falls back to, since a user row has no compiled
 * builder) and `builtin: false`. `assertAnimationTrackRows` validates a stored
 * row exactly as it validates this table's, so a bad row fails loudly at load
 * rather than corrupting a render hours later.
 */

/** The default track — and the only one compiled into this build (#3152). */
export const WALK_TRACK = 'walk';
/**
 * The seeded short directional character action (#3018) and non-directional
 * environment loop (#3045).
 *
 * Still NAMED here because `atlas.js` dispatches its two bespoke evidence chains
 * on these exact ids and existing on-disk sets carry them — but they are no
 * longer ROWS in `ANIMATION_TRACKS`: migration 211 moved both into the
 * user-defined store, where a user can retune or delete them like any other
 * track. Resolve them through `getEffectiveAnimationTracks()`; a `getAnimationTrack`
 * call against the compiled table alone will (correctly) throw for them.
 */
export const SCANNER_TRACK = 'scanner';
export const AMBIENT_TRACK = 'ambient';

/**
 * Every animation track compiled into this build — `walk`, and only `walk`
 * (#3152). Merge with the user-defined store via `getEffectiveAnimationTracks()`
 * before handing this to any reader that must see a user's tracks.
 *
 * - `minFrameCount` / `maxFrameCount` — the authoring range the packer clamps
 *   into and the Zod schemas range-check against.
 * - `defaultFrameCount` / `defaultFps` — the bottom rung of the target
 *   precedence chain (see `animationTargets.js`).
 * - `directional` — true when the track occupies one atlas ROW per facing
 *   (walk: 8 directions); a future ambient loop would be false (one row).
 *   Load-bearing since #3017: `trackRowCount` turns it into the number of rows
 *   the track's cells may occupy, and the compiler refuses a cell outside them.
 * - `kinds` — the sprite record kinds that may carry this track. The animation
 *   gates read this instead of testing for `'character'`, so unlocking a record
 *   kind is a data change here rather than a hunt through the service layer.
 * - `contractFrameCountField` / `contractFpsField` — the field names this track
 *   occupies in an app's `publishBinding.runtimeContract` (#2982). Named here so
 *   the app rung of the precedence chain is track-driven rather than hard-coded
 *   to `walkFrameCount`. `contractFpsField` may be `null` for a track whose
 *   speed an app has no say in.
 * - `selectionKind` / `setKind` (#3136) — the `kind` discriminators the track's
 *   on-disk review selection and finalized set carry. Registry data because the
 *   atlas compiler VALIDATES them (`atlas.js`), so a track's on-disk contract
 *   and the compiler's expectation cannot drift.
 * - `finalErrorCode` (#3136) — the `code` on the 409 a finalized set answers
 *   generate/approve with. Named per row so an existing client that matches on
 *   `SCANNER_SET_FINAL` keeps working after the clone collapsed.
 * - `standaloneContract` (#3136) — true when this track's frame count is enough
 *   ON ITS OWN to describe a publishable atlas, because a record can be
 *   published with only this track authored. Walk (a character's baseline) and
 *   ambient (a place's) qualify; a short ACTION like scanner always rides beside
 *   the walk it shares rows with, so pinning only its span describes no atlas
 *   that could exist. DECLARED rather than inferred from registration order: it
 *   is a load-bearing publish-validation rule, and #3152 merges rows from a
 *   user-ordered store where "first row for this kind" would silently change.
 * - `builtin` (#3152) — true for a row compiled into this build, false for one
 *   loaded from the user-defined store. Read by the store's merge (a user row may
 *   not shadow `walk`) and by the prompt resolver (a builtin row has a compiled
 *   prompt builder; a stored one carries `promptTemplate` instead).
 * - `promptTemplate` (#3152, stored rows ONLY) — the i2v instruction sent to the
 *   provider for this track, as literal text. A builtin row omits it and resolves
 *   through the compiled builder in `trackPrompts.js`; a stored row must carry it,
 *   because there is no code to fall back to.
 *
 * Which locked reference an i2v render is seeded from is DERIVED, not declared:
 * a directional track renders one clip per facing and so must seed from that
 * facing's own anchor (`sourceReferenceFor` below), while a non-directional one
 * has no per-facing anchor and seeds from the single locked main. Stating it as
 * a field would let a row claim a pairing that cannot work.
 */
export const ANIMATION_TRACKS = Object.freeze({
  [WALK_TRACK]: Object.freeze({
    id: WALK_TRACK,
    label: 'Walk cycle',
    directional: true,
    // A walk cycle is a character gait — a place or an object has no gait to
    // author, so walk stays character-only and every existing gate keeps its
    // exact behavior. What changed in #3017 is only WHERE that fact lives.
    kinds: Object.freeze(['character']),
    minFrameCount: 6,
    maxFrameCount: 16,
    defaultFrameCount: 12,
    minFps: 4,
    maxFps: 24,
    defaultFps: 10,
    contractFrameCountField: 'walkFrameCount',
    // `spriteRuntimeContractSchema` deliberately declares no fps key (a
    // distance-driven consumer has no animation-fps concept), so today this is
    // reachable only by a legacy/hand-built contract object — kept, not
    // nulled, because dropping it would change resolution behavior for those.
    // A second track copying this row should decide its own answer.
    contractFpsField: 'walkFps',
    // Walk predates the generic workflow and keeps its own bespoke service
    // (walk.js — reprocess, trims, per-direction reopen, source-frame
    // extraction, set-level targets), so these describe its on-disk contract
    // for the compiler's benefit without routing it through the generic module.
    selectionKind: 'reviewed-directional-walk-selection',
    setKind: 'finalized-eight-direction-walk-set',
    finalErrorCode: 'WALK_SET_FINAL',
    // A character publishes off its walk — the compile path requires a finalized
    // walk set before it emits anything at all.
    standaloneContract: true,
    // The one mandatory built-in. `scanner` and `ambient` were `builtin: true`
    // rows here until #3152 moved them into the user-defined store as seed data.
    builtin: true,
  }),
});

// There is deliberately no `ANIMATION_TRACK_IDS` export (#3152 removed it). It
// would now mean "the COMPILED ids" — `['walk']` — while reading as "every track
// id", which is the wrong answer at every call site that wanted it: those want the
// merged table's ids and must ask `getEffectiveAnimationTrackIds()` in
// `animationTrackStore.js`. Iterate `Object.keys(ANIMATION_TRACKS)` inline when you
// genuinely mean the compiled rows only.

/**
 * The min/default/max triples every row must keep in order.
 *
 * Exported because three places need this exact pairing and had each spelled their
 * own copy: the assert below, the request schemas in `server/lib/validation.js`
 * (which front-run the assert so the form gets a per-field 400), and the client's
 * pre-submit check. A fourth knob added to one copy and missed in another is the
 * drift this prevents.
 */
export const TRACK_BOUND_TRIPLES = Object.freeze([
  Object.freeze(['minFrameCount', 'defaultFrameCount', 'maxFrameCount']),
  Object.freeze(['minFps', 'defaultFps', 'maxFps']),
]);

/**
 * The fields of a row a USER authors, as opposed to the ones PortOS derives.
 *
 * The complement is deliberate and load-bearing: everything NOT listed here
 * (`contractFrameCountField`, `contractFpsField`, `selectionKind`, `setKind`,
 * `finalErrorCode`, `standaloneContract`, `builtin`) names a file on disk, a
 * publish-contract key, or a cross-row invariant that `assertAnimationTrackRows`
 * requires to be globally unique — so it is derived from the id rather than typed
 * (see `animationTrackCrud.js`). Named here, beside the assert that validates the
 * whole row, so the request schema and the service's whitelist build from ONE list
 * instead of two that fail in opposite directions when they drift: a field in the
 * schema but not the whitelist validates and is then silently dropped, and one in
 * the whitelist but not the schema is rejected as an unrecognized key.
 */
export const AUTHORED_TRACK_FIELDS = Object.freeze([
  'label', 'directional', 'kinds',
  'minFrameCount', 'maxFrameCount', 'defaultFrameCount',
  'minFps', 'maxFps', 'defaultFps',
  'promptTemplate',
]);

/**
 * The five on-disk / publish-contract discriminators a track's id determines, plus
 * the `contractFpsField` a user-defined row always declines.
 *
 * Derived rather than typed because `assertAnimationTrackRows` requires each to be
 * globally unique and they name artifacts the atlas compiler re-verifies — a typo in
 * one would hand this track another's evidence chain. Lives here, beside that
 * assert, so one module knows a row's whole shape.
 *
 * `contractFpsField` is `null` to match both seeded rows: PortOS's fps is
 * preview-only (a distance-driven consumer owns its timing), so a new track claiming
 * an fps contract key would offer the app a knob nothing reads.
 */
export function deriveTrackFields(id) {
  const camel = id.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
  return {
    contractFrameCountField: `${camel}FrameCount`,
    contractFpsField: null,
    selectionKind: `reviewed-${id}-selection`,
    setKind: `finalized-${id}-set`,
    finalErrorCode: `${id.replace(/-/g, '_').toUpperCase()}_SET_FINAL`,
  };
}

/**
 * Validate a registry's rows, throwing on the first violation.
 *
 * Called at module load below (the navManifest.js / catalogTypes.js idiom): a
 * row missing a bound would otherwise boot clean and surface much later as
 * `NaN` out of a Math.min, or as `z.number().min(undefined)` throwing at the
 * first sprite render. A bad row should block boot with a message naming the
 * field, not corrupt a render hours later.
 *
 * Exported and pure — taking the table as an argument — so the guard can be
 * proven against a synthetic multi-row fixture. Asserting set-uniqueness over
 * the real (currently single-row) table would only re-derive the
 * implementation: the whole guard could be deleted and such a test would stay
 * green, which is exactly the regression it exists to prevent.
 */
export function assertAnimationTrackRows(tracks) {
  const claimedContractFields = new Map();
  const claimedOnDiskKinds = new Map();
  for (const id of Object.keys(tracks)) {
    const row = tracks[id];
    if (row.id !== id) throw new Error(`animationTracks: row '${id}' declares mismatched id '${row.id}'`);
    if (typeof row.label !== 'string' || !row.label) throw new Error(`animationTracks: track '${id}' needs a label`);
    if (typeof row.directional !== 'boolean') throw new Error(`animationTracks: track '${id}' needs a boolean 'directional'`);
    // A row with no kinds is unreachable work: nothing could ever carry it, and
    // the gate would refuse every record with a message blaming the record.
    if (!Array.isArray(row.kinds) || !row.kinds.length) {
      throw new Error(`animationTracks: track '${id}' needs a non-empty 'kinds' array`);
    }
    if (row.kinds.some((kind) => typeof kind !== 'string' || !kind)) {
      throw new Error(`animationTracks: track '${id}' has a non-string entry in 'kinds'`);
    }
    for (const field of ['minFrameCount', 'maxFrameCount', 'defaultFrameCount', 'minFps', 'maxFps', 'defaultFps']) {
      if (!Number.isInteger(row[field])) throw new Error(`animationTracks: track '${id}' needs an integer '${field}'`);
    }
    if (typeof row.contractFrameCountField !== 'string' || !row.contractFrameCountField) {
      throw new Error(`animationTracks: track '${id}' needs a contractFrameCountField`);
    }
    if (row.contractFpsField !== null && (typeof row.contractFpsField !== 'string' || !row.contractFpsField)) {
      throw new Error(`animationTracks: track '${id}' needs a contractFpsField (or null)`);
    }
    // #3136 — the workflow shape.
    for (const field of ['selectionKind', 'setKind', 'finalErrorCode']) {
      if (typeof row[field] !== 'string' || !row[field]) {
        throw new Error(`animationTracks: track '${id}' needs a non-empty '${field}'`);
      }
    }
    if (typeof row.standaloneContract !== 'boolean') {
      throw new Error(`animationTracks: track '${id}' needs a boolean 'standaloneContract'`);
    }
    // #3152 — where the row came from, and (for a stored row) its prompt.
    if (typeof row.builtin !== 'boolean') {
      throw new Error(`animationTracks: track '${id}' needs a boolean 'builtin'`);
    }
    // EXACTLY ONE prompt source per row — the invariant, stated as itself rather
    // than as two provenance checks. A row's prompt is either the compiled builder
    // `trackPrompts.js` holds for it (`builtin`, no template) or its own
    // `promptTemplate` (stored). Neither means a throw out of `buildTrackVideoPrompt`
    // AFTER the user clicked generate; both means two definitions of one track's
    // wording, where the stored value silently wins over the text
    // `prompts.test.js` pins. Refuse either at load, where the message names the row.
    const hasTemplate = typeof row.promptTemplate === 'string' && !!row.promptTemplate.trim();
    if (hasTemplate === row.builtin) {
      throw new Error(
        row.builtin
          ? `animationTracks: builtin track '${id}' must not carry a 'promptTemplate' — its prompt is the compiled builder`
          : `animationTracks: user-defined track '${id}' needs a non-empty 'promptTemplate'`,
      );
    }
    // Two tracks sharing a selection/set `kind` is the same class of bug as two
    // sharing a contract field: the compiler validates a set by its `kind`, so a
    // duplicate would let one track's finalized set satisfy the other's evidence
    // check and compile the wrong frames into its span.
    for (const knob of ['selectionKind', 'setKind']) {
      const owner = claimedOnDiskKinds.get(row[knob]);
      if (owner) {
        throw new Error(
          `animationTracks: on-disk kind '${row[knob]}' is claimed by both '${owner.id}.${owner.knob}' and '${id}.${knob}'`,
        );
      }
      claimedOnDiskKinds.set(row[knob], { id, knob });
    }
    for (const [min, def, max] of TRACK_BOUND_TRIPLES) {
      if (!(row[min] <= row[def] && row[def] <= row[max])) {
        throw new Error(`animationTracks: track '${id}' needs ${min} <= ${def} <= ${max}`);
      }
    }
    // Two tracks must not claim the same runtimeContract field. The anticipated
    // failure is a second row copy-pasted from walk's: `resolveAnimationTarget`
    // would then read the WALK's `walkFrameCount` for that track and, whenever
    // that value happens to land inside its range, return it with
    // `frameCountLocked: true` — silently pinning one track to another's
    // contract and throwing a lock error citing a binding that never mentioned
    // it. The knob name rides along so a row that names ONE field for BOTH of
    // its knobs doesn't report as "claimed by both 'walk' and 'walk'".
    for (const knob of ['contractFrameCountField', 'contractFpsField']) {
      const field = row[knob];
      if (field === null) continue;
      const owner = claimedContractFields.get(field);
      if (owner) {
        throw new Error(
          `animationTracks: contract field '${field}' is claimed by both '${owner.id}.${owner.knob}' and '${id}.${knob}'`,
        );
      }
      claimedContractFields.set(field, { id, knob });
    }
  }
  // Every record kind any row admits must have EXACTLY ONE standalone track —
  // the baseline it publishes off. Zero means a record of that kind can be
  // authored but never publish (its runtime contract could name no required
  // field, and the compiler has no evidence chain to require); more than one
  // means "which set must be finalized before compiling?" has two answers. This
  // is a cross-row invariant, so it runs after the per-row loop.
  const standaloneByKind = new Map();
  for (const id of Object.keys(tracks)) {
    if (!tracks[id].standaloneContract) continue;
    for (const kind of tracks[id].kinds) {
      standaloneByKind.set(kind, [...(standaloneByKind.get(kind) || []), id]);
    }
  }
  for (const id of Object.keys(tracks)) {
    for (const kind of tracks[id].kinds) {
      const owners = standaloneByKind.get(kind) || [];
      if (owners.length !== 1) {
        throw new Error(
          `animationTracks: record kind '${kind}' needs exactly one standaloneContract track, has ${owners.length}${owners.length ? ` (${owners.join(', ')})` : ''}`,
        );
      }
    }
  }
}

assertAnimationTrackRows(ANIMATION_TRACKS);

/**
 * The locked reference artifact a track's image-to-video render is seeded from:
 * `'anchor'` (this facing's own locked directional anchor) or `'main'` (the one
 * locked main reference).
 *
 * DERIVED from `directional` rather than declared, because only one pairing can
 * work. A directional track renders one clip per facing, so seeding all eight
 * rows from the single main would render the same south-facing clip eight times
 * and pass every later check — nothing downstream re-reads which facing was
 * asked for. The inverse has no anchor to read at all: a place record never
 * generates directional anchors.
 */
export function sourceReferenceFor(id, tracks = ANIMATION_TRACKS) {
  return getAnimationTrack(id, tracks).directional ? 'anchor' : 'main';
}

/**
 * The one track a record of `kind` publishes off — its baseline, whose finalized
 * set the compile path requires and whose frame count alone is a valid runtime
 * contract. `null` for a kind no row admits.
 *
 * One definition, asked by the publish-contract schema (which field is required)
 * and the compile dispatch (which evidence chain to validate). Those two used to
 * answer it separately — one by registration order, one as
 * `ambient-and-not-walk` — and agreed only by coincidence.
 */
export function primaryTrackForKind(kind, tracks = ANIMATION_TRACKS) {
  if (typeof kind !== 'string' || !kind) return null;
  return Object.values(tracks).find((row) => row.standaloneContract && row.kinds.includes(kind)) || null;
}

/** True when `id` names a track in `tracks` (the shipped registry by default). */
export function isAnimationTrack(id, tracks = ANIMATION_TRACKS) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(tracks, id);
}

/**
 * The registry row for `id`. Absent (`undefined`/`null`) resolves to the default
 * track; anything else unrecognized THROWS rather than falling back, so a typo
 * can never be validated against walk's range by accident.
 *
 * The table is a parameter — the same idiom `assertAnimationTrackRows(tracks)`
 * uses — so a caller that must work across a *set* of tracks (the atlas grid,
 * #3016) can be exercised against a synthetic multi-row table while the shipped
 * registry has one row, WITHOUT that caller growing a private lookup that
 * bypasses this unknown-id boundary.
 */
export function getAnimationTrack(id, tracks = ANIMATION_TRACKS) {
  const key = id === undefined || id === null ? WALK_TRACK : id;
  if (!isAnimationTrack(key, tracks)) {
    throw new Error(
      `Unknown animation track '${String(key)}' — known tracks: ${Object.keys(tracks).join(', ')}.`,
    );
  }
  return tracks[key];
}

/**
 * The atlas rows one track's cells may occupy, given how many facings the grid
 * has: every row for a directional track, exactly one (row 0) for a
 * non-directional one.
 *
 * `directionCount` is a PARAMETER rather than an import because this module is
 * a true leaf — `animationTracks.test.js` asserts it imports nothing at all —
 * and the canonical direction list lives in `prompts.js`. Callers that already
 * know the grid pass its real height; `atlasGrid.js` supplies the default.
 */
export function trackRowCount(id, directionCount, tracks = ANIMATION_TRACKS) {
  const row = getAnimationTrack(id, tracks);
  if (!Number.isInteger(directionCount) || directionCount < 1) {
    throw new Error(`animationTracks: trackRowCount needs a positive direction count, got ${directionCount}`);
  }
  return row.directional ? directionCount : 1;
}

/**
 * Every track a record of this `kind` may carry, in registration order.
 *
 * This is the whole of the "track-presence gate" (#3017): a record kind with no
 * rows has no animation path, and a kind with at least one does — replacing the
 * literal `kind !== 'character'` test the sprite services used to make. An
 * absent/blank kind matches nothing rather than defaulting to a kind, so a
 * malformed record can't inherit character's permissions.
 */
export function tracksForKind(kind, tracks = ANIMATION_TRACKS) {
  if (typeof kind !== 'string' || !kind) return [];
  return Object.values(tracks).filter((row) => row.kinds.includes(kind));
}

/**
 * True when a record of `kind` may carry the named track. A predicate, not a
 * boundary: an unrecognized track id answers `false` rather than throwing,
 * because the gates call this to DECIDE. The row is an O(1) lookup, so this
 * asks it directly instead of rebuilding `tracksForKind`'s array to re-find it.
 */
export function kindSupportsTrack(kind, id, tracks = ANIMATION_TRACKS) {
  if (!isAnimationTrack(id, tracks)) return false;
  return typeof kind === 'string' && !!kind && tracks[id].kinds.includes(kind);
}

// Round-then-clamp, with unusable input (NaN, non-numeric) falling back to the
// knob's default rather than to a bound — the two knobs differ only in which
// three row fields they read.
const clampInto = (n, min, max, fallback) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
};

/**
 * Clamp a requested frame count into `track`'s authoring range.
 *
 * `tracks` is the same injectable table every reader above takes (#3152) —
 * callers that must clamp a USER-DEFINED track pass the effective table, since a
 * stored row is unknown to the compiled default and would throw.
 */
export function clampTrackFrameCount(n, track, tracks = ANIMATION_TRACKS) {
  const row = getAnimationTrack(track, tracks);
  return clampInto(n, row.minFrameCount, row.maxFrameCount, row.defaultFrameCount);
}

/** Clamp a requested playback fps into `track`'s authoring range. */
export function clampTrackFps(n, track, tracks = ANIMATION_TRACKS) {
  const row = getAnimationTrack(track, tracks);
  return clampInto(n, row.minFps, row.maxFps, row.defaultFps);
}
