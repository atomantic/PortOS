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
 */

/** The default track — the only one that exists today. */
export const WALK_TRACK = 'walk';
/** The first short, directional character action (#3018). */
export const SCANNER_TRACK = 'scanner';
/** The first non-directional environment loop (#3045). */
export const AMBIENT_TRACK = 'ambient';

/**
 * Every known animation track.
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
  }),
  [SCANNER_TRACK]: Object.freeze({
    id: SCANNER_TRACK,
    label: 'Scanner action',
    directional: true,
    // A scanner pose is still one per character facing, so it reuses the
    // locked directional anchors and fills all eight atlas rows.
    kinds: Object.freeze(['character']),
    minFrameCount: 2,
    maxFrameCount: 8,
    defaultFrameCount: 4,
    minFps: 2,
    maxFps: 12,
    defaultFps: 6,
    contractFrameCountField: 'scannerFrameCount',
    // The game owns action timing; PortOS carries fps as preview provenance.
    contractFpsField: null,
  }),
  [AMBIENT_TRACK]: Object.freeze({
    id: AMBIENT_TRACK,
    label: 'Ambient loop',
    directional: false,
    // `props` is the legacy import-only spelling of `object`; keeping it here
    // makes an imported prop atlas and a newly-authored object behave alike.
    kinds: Object.freeze(['place', 'object', 'props']),
    minFrameCount: 2,
    maxFrameCount: 6,
    defaultFrameCount: 3,
    minFps: 2,
    maxFps: 12,
    defaultFps: 4,
    contractFrameCountField: 'ambientFrameCount',
    // Ambient cadence belongs to the consuming app. PortOS keeps fps only as
    // authoring-preview provenance, like scanner.
    contractFpsField: null,
  }),
});

/** Known track ids, in registry order. */
export const ANIMATION_TRACK_IDS = Object.freeze(Object.keys(ANIMATION_TRACKS));

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
    for (const [min, def, max] of [
      ['minFrameCount', 'defaultFrameCount', 'maxFrameCount'],
      ['minFps', 'defaultFps', 'maxFps'],
    ]) {
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
}

assertAnimationTrackRows(ANIMATION_TRACKS);

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

/** Clamp a requested frame count into `track`'s authoring range. */
export function clampTrackFrameCount(n, track) {
  const row = getAnimationTrack(track);
  return clampInto(n, row.minFrameCount, row.maxFrameCount, row.defaultFrameCount);
}

/** Clamp a requested playback fps into `track`'s authoring range. */
export function clampTrackFps(n, track) {
  const row = getAnimationTrack(track);
  return clampInto(n, row.minFps, row.maxFps, row.defaultFps);
}
