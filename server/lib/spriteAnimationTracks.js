/**
 * Sprites — the animation-track registry (issue #3015).
 *
 * The animation-track registry (`ANIMATION_TRACKS`, `WALK_TRACK`, `TRACK_BOUND_TRIPLES`,
 * `AUTHORED_TRACK_FIELDS`) — a zero-import table of per-track frame/fps bounds.
 *
 * One row per track carries its own bounds, defaults, directionality and the
 * `runtimeContract` field names it occupies, so adding a track is a row plus its
 * pipeline, never a hunt for hard-coded 6/16 literals.
 *
 * **Sharp-free leaf, deliberately.** `server/lib/spriteValidation.js` builds its Zod
 * ranges from these rows and must not pull the native image graph (sharp/ffmpeg)
 * into request validation. This module imports NOTHING; `animationTracks.test.js`
 * asserts that transitively.
 *
 * **Unknown track ids are an error, not a fallback.** `getAnimationTrack('nope')`
 * throws instead of handing back walk's range. Absent (`undefined`/`null`) means
 * the default track (`walk`); an empty string is present and invalid.
 *
 * **Which records may carry a track is registry data.** Each row declares the
 * record `kinds` that may carry it, and the gates ask the registry
 * (`tracksForKind` / `kindSupportsTrack`) instead of naming a kind.
 *
 * **The per-track WORKFLOW is registry data.** Differences between tracks are
 * either FIELDS on the row (`selectionKind`/`setKind`) or derived from one
 * (`directional` decides facing count and which locked reference seeds the
 * render); `animationTrackWorkflow.js` is the one implementation. A user-defined
 * track is a row plus a prompt template.
 *
 * **`walk` is the only COMPILED-IN row.** Every other track lives in the
 * user-defined store `animationTrackStore.js` reads (seeded from
 * `data.reference/sprites/animation-tracks.json` by migration 211). The MERGE
 * cannot live here because this module imports nothing, so the store imports this
 * and never the reverse; callers that must see user rows resolve
 * `getEffectiveAnimationTracks()` and pass it as the `tracks` parameter.
 *
 * A stored row also carries `promptTemplate` and `builtin: false`.
 * `assertAnimationTrackRows` validates it exactly like this table's rows, so a
 * bad row fails loudly at load.
 */

/** The default track, and the only one compiled into this build. */
export const WALK_TRACK = 'walk';
/**
 * Seeded track ids, still NAMED here because `atlas.js` dispatches its bespoke
 * evidence chains on them and on-disk sets carry them. They are not rows in
 * `ANIMATION_TRACKS`; resolve them through `getEffectiveAnimationTracks()`, as
 * `getAnimationTrack` on the compiled table alone throws for them.
 */
export const SCANNER_TRACK = 'scanner';
export const AMBIENT_TRACK = 'ambient';

/**
 * Every animation track compiled into this build: only `walk`. Merge with the
 * user-defined store via `getEffectiveAnimationTracks()` before handing this to a
 * reader that must see a user's tracks.
 *
 * - `minFrameCount` / `maxFrameCount` - the authoring range the packer clamps
 *   into and the Zod schemas check against.
 * - `defaultFrameCount` / `defaultFps` - bottom rung of the target precedence
 *   chain (`animationTargets.js`).
 * - `directional` - one atlas ROW per facing (walk: 8); `trackRowCount` turns it
 *   into the rows the track's cells may occupy.
 * - `kinds` - sprite record kinds that may carry this track; the animation gates
 *   read this instead of testing for `'character'`.
 * - `contractFrameCountField` / `contractFpsField` - the track's field names in an
 *   app's `publishBinding.runtimeContract`. The fps field may be `null`.
 * - `selectionKind` / `setKind` - `kind` discriminators of the on-disk review
 *   selection and finalized set; the atlas compiler VALIDATES them (`atlas.js`).
 * - `finalErrorCode` - the `code` on the 409 a finalized set answers
 *   generate/approve with; per row so clients matching `SCANNER_SET_FINAL` keep working.
 * - `standaloneContract` - true when this track's frame count alone describes a
 *   publishable atlas. DECLARED, not inferred from order, because stored rows come
 *   from a user-ordered store.
 * - `builtin` - true for a compiled row, false for a stored one. The store's merge
 *   (a user row may not shadow `walk`) and the prompt resolver read it.
 * - `promptTemplate` (stored rows ONLY) - the literal i2v instruction. A builtin
 *   row omits it and resolves through the compiled builder in `trackPrompts.js`.
 *
 * Which reference seeds an i2v render is DERIVED (`sourceReferenceFor`), not
 * declared, so a row cannot claim a pairing that cannot work.
 */
export const ANIMATION_TRACKS = Object.freeze({
  [WALK_TRACK]: Object.freeze({
    id: WALK_TRACK,
    label: 'Walk cycle',
    directional: true,
    // A walk cycle is a character gait; places and objects have none.
    kinds: Object.freeze(['character']),
    minFrameCount: 6,
    maxFrameCount: 16,
    defaultFrameCount: 12,
    minFps: 4,
    maxFps: 24,
    defaultFps: 10,
    contractFrameCountField: 'walkFrameCount',
    // `spriteRuntimeContractSchema` declares no fps key, so this is reachable only
    // by a legacy/hand-built contract; kept, not nulled, to preserve its resolution.
    contractFpsField: 'walkFps',
    // Walk keeps its own bespoke service (walk.js); these describe its on-disk
    // contract for the compiler without routing it through the generic module.
    selectionKind: 'reviewed-directional-walk-selection',
    setKind: 'finalized-eight-direction-walk-set',
    finalErrorCode: 'WALK_SET_FINAL',
    // A character publishes off its walk.
    standaloneContract: true,
    builtin: true,
  }),
});

/**
 * The min/default/max triples every row must keep in order. Shared by the assert
 * below, the request schemas in `server/lib/spriteValidation.js`, and the client's
 * pre-submit check.
 */
export const TRACK_BOUND_TRIPLES = Object.freeze([
  Object.freeze(['minFrameCount', 'defaultFrameCount', 'maxFrameCount']),
  Object.freeze(['minFps', 'defaultFps', 'maxFps']),
]);

/**
 * The fields of a row a USER authors. Everything not listed (`contractFrameCountField`,
 * `contractFpsField`, `selectionKind`, `setKind`, `finalErrorCode`,
 * `standaloneContract`, `builtin`) names a disk file, publish-contract key or
 * globally-unique invariant and is derived from the id (`animationTrackCrud.js`).
 * One list feeds both the request schema and the service whitelist, which would
 * otherwise fail in opposite directions when they drift.
 */
export const AUTHORED_TRACK_FIELDS = Object.freeze([
  'label', 'directional', 'kinds',
  'minFrameCount', 'maxFrameCount', 'defaultFrameCount',
  'minFps', 'maxFps', 'defaultFps',
  'promptTemplate',
]);

/**
 * The on-disk / publish-contract discriminators a track's id determines, plus the
 * `contractFpsField` a user-defined row always declines. Derived rather than typed
 * because `assertAnimationTrackRows` requires each to be globally unique and they
 * name artifacts the compiler re-verifies. `contractFpsField` is `null` because
 * fps is preview-only; an fps contract key would offer the app a knob nothing reads.
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
 * Validate a registry's rows, throwing on the first violation. Run at module load
 * so a bad row blocks boot with a message naming the field instead of surfacing
 * as `NaN` or a Zod throw at first render. Exported and pure (table as argument)
 * so the uniqueness guard can be proven against a synthetic multi-row fixture.
 */
export function assertAnimationTrackRows(tracks) {
  const claimedContractFields = new Map();
  const claimedOnDiskKinds = new Map();
  for (const id of Object.keys(tracks)) {
    const row = tracks[id];
    if (row.id !== id) throw new Error(`animationTracks: row '${id}' declares mismatched id '${row.id}'`);
    if (typeof row.label !== 'string' || !row.label) throw new Error(`animationTracks: track '${id}' needs a label`);
    if (typeof row.directional !== 'boolean') throw new Error(`animationTracks: track '${id}' needs a boolean 'directional'`);
    // A row with no kinds could never be carried by any record.
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
    for (const field of ['selectionKind', 'setKind', 'finalErrorCode']) {
      if (typeof row[field] !== 'string' || !row[field]) {
        throw new Error(`animationTracks: track '${id}' needs a non-empty '${field}'`);
      }
    }
    if (typeof row.standaloneContract !== 'boolean') {
      throw new Error(`animationTracks: track '${id}' needs a boolean 'standaloneContract'`);
    }
    if (typeof row.builtin !== 'boolean') {
      throw new Error(`animationTracks: track '${id}' needs a boolean 'builtin'`);
    }
    // EXACTLY ONE prompt source per row: the compiled builder (`builtin`, no
    // template) or its own `promptTemplate` (stored). Neither throws after the user
    // clicks generate; both lets the stored value silently win over `prompts.test.js`.
    const hasTemplate = typeof row.promptTemplate === 'string' && !!row.promptTemplate.trim();
    if (hasTemplate === row.builtin) {
      throw new Error(
        row.builtin
          ? `animationTracks: builtin track '${id}' must not carry a 'promptTemplate' — its prompt is the compiled builder`
          : `animationTracks: user-defined track '${id}' needs a non-empty 'promptTemplate'`,
      );
    }
    // Duplicate selection/set kinds would let one track's finalized set satisfy
    // another's compiler evidence check.
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
    // Two tracks must not claim the same runtimeContract field (e.g. a row
    // copy-pasted from walk's would silently pin to walk's `walkFrameCount`).
    // The knob name rides along so one row naming a field for BOTH knobs reports sensibly.
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
  // Every record kind any row admits needs EXACTLY ONE standalone track (its
  // publish baseline): zero means it can never publish, several make "which set
  // must be finalized" ambiguous. Cross-row, so it runs after the per-row loop.
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
 * The locked reference a track's image-to-video render is seeded from: `'anchor'`
 * (this facing's own directional anchor) or `'main'` (the one locked main).
 *
 * DERIVED from `directional`: seeding every facing from the single main would
 * render the same clip eight times and pass every later check, and a
 * non-directional track has no anchor to read.
 */
export function sourceReferenceFor(id, tracks = ANIMATION_TRACKS) {
  return getAnimationTrack(id, tracks).directional ? 'anchor' : 'main';
}

/**
 * The one track a record of `kind` publishes off: its baseline, whose finalized
 * set the compile path requires. `null` for a kind no row admits. Single
 * definition shared by the publish-contract schema and the compile dispatch.
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
 * track; anything else unrecognized THROWS so a typo can never validate against
 * walk's range. The table is a parameter so callers can use a synthetic or
 * effective multi-row table without bypassing this unknown-id boundary.
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
 * The atlas rows one track's cells may occupy: every row for a directional
 * track, exactly row 0 otherwise. `directionCount` is a parameter because this
 * module is a leaf and the canonical direction list lives in `prompts.js`.
 */
export function trackRowCount(id, directionCount, tracks = ANIMATION_TRACKS) {
  const row = getAnimationTrack(id, tracks);
  if (!Number.isInteger(directionCount) || directionCount < 1) {
    throw new Error(`animationTracks: trackRowCount needs a positive direction count, got ${directionCount}`);
  }
  return row.directional ? directionCount : 1;
}

/**
 * Every track a record of this `kind` may carry, in registration order. A kind
 * with no rows has no animation path; a blank kind matches nothing so a
 * malformed record can't inherit character's permissions.
 */
export function tracksForKind(kind, tracks = ANIMATION_TRACKS) {
  if (typeof kind !== 'string' || !kind) return [];
  return Object.values(tracks).filter((row) => row.kinds.includes(kind));
}

/**
 * True when a record of `kind` may carry the named track. A predicate, not a
 * boundary: an unknown track id answers `false` rather than throwing.
 */
export function kindSupportsTrack(kind, id, tracks = ANIMATION_TRACKS) {
  if (!isAnimationTrack(id, tracks)) return false;
  return typeof kind === 'string' && !!kind && tracks[id].kinds.includes(kind);
}

// Round-then-clamp; unusable input (NaN, non-numeric) falls back to the default, not a bound.
const clampInto = (n, min, max, fallback) => {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
};

/**
 * Clamp a requested frame count into `track`'s authoring range. Pass the
 * effective table for a user-defined track (unknown to the compiled default).
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
