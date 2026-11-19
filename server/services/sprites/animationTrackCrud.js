/**
 * Sprites — the write half of the user-defined animation-track store.
 *
 * **Separate from `animationTrackStore.js`.** That module is imported by
 * `server/lib/spriteValidation.js` (which builds sprite Zod ranges from the effective
 * registry at load), and its tests pin how narrow its import graph may be.
 * Refusing to delete a track with authored work means scanning every record, which
 * reaches `records.js` and the native image graph (sharp). Reads stay in the
 * leaf-ish store; writes live here, with the route layer as the only consumer.
 *
 * **Five row fields are DERIVED from the id, never typed.**
 * `assertAnimationTrackRows` refuses two rows claiming the same
 * `contractFrameCountField`, `selectionKind` or `setKind`; those strings name
 * on-disk files and publish-contract keys, so a typo would let another track's
 * finalized set satisfy this one's evidence check. A derived value that collides is
 * refused at save time by the same assert, naming the conflict.
 *
 * `standaloneContract` is derived too: it is a cross-row invariant (exactly one
 * standalone track per record kind), so the correct value depends on the rest of the
 * table. A new row is the baseline exactly when none of the kinds it claims already
 * has one; a row spanning a kind with a baseline and one without is refused by name.
 *
 * **Writes are serialized and the cache invalidated.** One `data/` file, one
 * `createFileWriteQueue` tail, so a create cannot read a stale pre-image mid-delete.
 * Every mutation ends in `__resetAnimationTrackStore()`.
 *
 * **A mutation still reports `restartRequired`.** The registry is live after the
 * cache reset, but `spriteValidation.js` builds `spriteRuntimeContractSchema`'s per-track
 * fields once at module load, so a new track's `<id>FrameCount` key is stripped by
 * Zod until the process restarts.
 */

import { atomicWrite, pathExists } from '../../lib/fileUtils.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  WALK_TRACK, AUTHORED_TRACK_FIELDS, assertAnimationTrackRows, deriveTrackFields, isAnimationTrack,
} from './animationTracks.js';
import {
  ANIMATION_TRACK_STORE_REL,
  ANIMATION_TRACK_STORE_SCHEMA_VERSION,
  animationTrackStorePath,
  getEffectiveAnimationTracks,
  __resetAnimationTrackStore,
} from './animationTrackStore.js';
import { recordsCarryingTrack } from './animationTrackWorkflow.js';

// One store file, so ONE tail: a per-id queue would let two tracks' writes interleave on the same JSON.
const queueStoreWrite = createFileWriteQueue();

/** The stored (non-builtin) rows, in registration order. */
const storedRows = (tracks) => Object.values(tracks).filter((row) => !row.builtin);
/** The compiled-in rows (`walk`) — never mutable, always first in the merged table. */
const builtinRows = (tracks) => Object.values(tracks).filter((row) => row.builtin);

/**
 * Run a registry call whose failure is a bare `Error`, as a 409 the form can show.
 * Boot wants a loud crash; here the error answers a user request about that file, and
 * the registry's messages already name the field, claimants or record kind, so they
 * are surfaced verbatim instead of as an opaque 500.
 */
function asConflict(fn) {
  try {
    return fn();
  } catch (err) {
    throw new ServerError(err.message, { status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
  }
}

/**
 * The user-facing subset of a row, in the shape the CRUD surface accepts.
 * Whitelisted from `AUTHORED_TRACK_FIELDS` so a hand-edited unknown key cannot
 * round-trip into a saved row and the two lists cannot drift.
 */
const authoredFields = (row) => ({
  id: row.id,
  ...Object.fromEntries(AUTHORED_TRACK_FIELDS.map((key) => (
    [key, Array.isArray(row[key]) ? [...row[key]] : row[key]]
  ))),
});

/**
 * Whether a row is its record kinds' publishable baseline: true only when NONE of
 * the kinds it claims is owned by another row in the same prospective table.
 *
 * `rows` is the whole post-mutation set, so deleting a kind's baseline lets a
 * surviving track become one instead of 409ing. Order-dependent by design: the
 * earlier row wins a contested kind (matching `walk`-first registration), keeping
 * the answer stable across installs.
 */
function withDerivedBaselines(rows, builtins) {
    // Seed from the BUILTINS only: their claim is fixed; stored rows arrive from
    // `composeRow` with no `standaloneContract` and are decided below.
  const claimed = new Set();
  for (const row of builtins) {
    if (row.standaloneContract) for (const kind of row.kinds) claimed.add(kind);
  }
  return rows.map((row) => {
    const standaloneContract = row.kinds.every((kind) => !claimed.has(kind));
    if (standaloneContract) for (const kind of row.kinds) claimed.add(kind);
    return { ...row, standaloneContract };
  });
}

/**
 * A stored row's PortOS-owned fields, minus `standaloneContract` (a cross-row answer
 * `withDerivedBaselines` fills in later).
 *
 * When `existing` is on disk the five discriminators are carried over VERBATIM, not
 * re-derived: a hand-edited or differently-seeded `setKind` (the shipped `scanner`
 * row) names files an approved set already carries, so re-deriving on a label edit
 * would orphan it. Only a brand-new id derives them.
 */
const composeRow = (authored, existing = null) => ({
  ...authored,
  ...(existing ? {
    contractFrameCountField: existing.contractFrameCountField,
    contractFpsField: existing.contractFpsField,
    selectionKind: existing.selectionKind,
    setKind: existing.setKind,
    finalErrorCode: existing.finalErrorCode,
  } : deriveTrackFields(authored.id)),
  builtin: false,
});

/**
 * The prospective stored-row set for a mutation: discriminators preserved, every
 * `standaloneContract` re-derived over the RESULT. `added`, `replacement` (swaps in
 * for its own id) and `dropId` are the three mutations as one rebuild, so baseline
 * promotion/demotion is computed identically for each.
 */
const nextStoredRows = (tracks, { added = null, replacement = null, dropId = null } = {}) => {
  const kept = storedRows(tracks)
    .filter((row) => row.id !== dropId)
    .map((row) => composeRow(
      replacement && row.id === replacement.id ? replacement : authoredFields(row),
      row,
    ));
  const rows = added ? [...kept, composeRow(added)] : kept;
  return withDerivedBaselines(rows, builtinRows(tracks));
};

/**
 * The effective table. Every read on this surface goes through this rather than the
 * store's getter, so a hand-broken store is a 409 on every path, never a 500 on one.
 */
const effectiveTracksOrThrow = () => asConflict(getEffectiveAnimationTracks);

/**
 * Every track the effective registry knows, built-in first. Returns FULL rows
 * (derived fields included) so a collision refusal is actionable.
 */
export function listAnimationTracks() {
  return {
    tracks: Object.values(effectiveTracksOrThrow()),
    storePath: ANIMATION_TRACK_STORE_REL,
  };
}

/**
 * Persist a stored-row set, then drop the registry cache. The seed's `_comment` is
 * deliberately not carried over: once saved through the UI the file is the user's.
 */
async function writeStoredRows(rows) {
  await atomicWrite(animationTrackStorePath(), {
    schemaVersion: ANIMATION_TRACK_STORE_SCHEMA_VERSION,
    tracks: rows,
  });
  __resetAnimationTrackStore();
}

/**
 * Validate the prospective merged table (compiled `walk` plus stored rows) through
 * the SAME guard the store runs at load, so a saved row can never brick the next boot.
 */
function assertTableValid(tracks, rows) {
  const byId = [...builtinRows(tracks), ...rows].map((row) => [row.id, row]);
  asConflict(() => assertAnimationTrackRows(Object.fromEntries(byId)));
}

/**
 * Refuse a mutation to a built-in track by name. `walk` is the mandatory baseline:
 * its bounds feed the Zod schemas and its `setKind` gates every character compile.
 * The loader already refuses a shadowing row; this gives the user a refusal instead
 * of a 404 for a track they can see.
 */
function refuseBuiltin(trackId, tracks) {
  const row = isAnimationTrack(trackId, tracks) ? tracks[trackId] : undefined;
  if (trackId === WALK_TRACK || (row && row.builtin)) {
    throw new ServerError(
      `'${trackId}' is a built-in animation type and cannot be edited or deleted`,
      { status: 409, code: 'BUILTIN_ANIMATION_TRACK' },
    );
  }
}

/** 409 for a built-in, 404 for a well-formed id that names no stored track. */
function requireStored(trackId, tracks) {
  refuseBuiltin(trackId, tracks);
  const row = isAnimationTrack(trackId, tracks) ? tracks[trackId] : undefined;
  if (!row) {
    throw new ServerError(
      `Unknown animation type '${trackId}' — the registered types are: ${Object.keys(tracks).join(', ')}`,
      { status: 404, code: 'UNKNOWN_ANIMATION_TRACK' },
    );
  }
  return row;
}

/**
 * Refuse a mutation that would orphan authored work, listing the records.
 *
 * "In use" is any record carrying this track's finalized set OR a review selection
 * with at least one approved direction. Both are keyed by the `setKind`/
 * `selectionKind` strings a delete removes, so the atlas compiler would find
 * evidence for an unknown track (or, on a directionality flip, expect a different
 * row count than the set was frozen with).
 *
 * No force flag: silently dropping approved renders is worse than a refusal the user
 * can act on by reopening those sets first.
 */
async function refuseIfInUse(trackId, action) {
  const recordIds = await recordsCarryingTrack(trackId);
  if (!recordIds.length) return;
  throw new ServerError(
    `Cannot ${action} '${trackId}' — ${recordIds.length} sprite${recordIds.length === 1 ? '' : 's'} `
    + `already ${recordIds.length === 1 ? 'carries' : 'carry'} approved ${trackId} work: ${recordIds.join(', ')}. `
    + 'Reopen or unlock those sets first.',
    { status: 409, code: 'ANIMATION_TRACK_IN_USE', context: { records: recordIds } },
  );
}

// Every mutation answers with the fresh table plus the honest scope boundary, so
// the client never has to guess whether its write is live.
const mutationResult = () => ({ ...listAnimationTracks(), restartRequired: true });

/** Create one user-defined animation type. */
export function createAnimationTrack(input) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    if (isAnimationTrack(input.id, tracks)) {
      refuseBuiltin(input.id, tracks);
      throw new ServerError(
        `Animation type '${input.id}' already exists — edit it instead, or choose another id`,
        { status: 409, code: 'ANIMATION_TRACK_EXISTS' },
      );
    }
    const rows = nextStoredRows(tracks, { added: input });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/**
 * Update one user-defined animation type. `id` is immutable: renaming would migrate
 * on-disk `<trackId>/` directories, every run's `track` field and manifest, so it is
 * an explicit delete-plus-create.
 *
 * A directionality FLIP on an in-use track is refused like a delete: the frozen set's
 * `directionOrder` would disagree with the compiler's new row count. Other fields
 * (label, bounds, prompt) are safe to retune; the packer clamps into the new range.
 */
export function updateAnimationTrack(trackId, patch) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    const existing = authoredFields(requireStored(trackId, tracks));
    const next = { ...existing, ...patch, id: trackId };
    if (next.directional !== existing.directional) {
      await refuseIfInUse(trackId, 'change the facing mode of');
    }
    const rows = nextStoredRows(tracks, { replacement: next });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/** Delete one user-defined animation type, refusing when work depends on it. */
export function deleteAnimationTrack(trackId) {
  return queueStoreWrite(async () => {
    const tracks = effectiveTracksOrThrow();
    requireStored(trackId, tracks);
    await refuseIfInUse(trackId, 'delete');
    const rows = nextStoredRows(tracks, { dropId: trackId });
    assertTableValid(tracks, rows);
    await writeStoredRows(rows);
    return mutationResult();
  });
}

/**
 * Whether this install has its own store file yet, and where the rows came from, so
 * the drawer can say "these are the shipped starter types" before the first save.
 */
export async function animationTrackStoreOrigin() {
  return (await pathExists(animationTrackStorePath())) ? 'store' : 'seed';
}
