/**
 * Authoring the user-defined animation-track store (#3153).
 *
 * The store's READ side is covered by `animationTrackStore.test.js` and the row
 * rules by `animationTracks.test.js`. What only this module can get wrong is the
 * write side, and specifically the three things it decides on the user's behalf:
 *
 *   - the DERIVED fields (five discriminators + `standaloneContract`), because a
 *     wrong derivation hands one track another's on-disk evidence chain or leaves a
 *     record kind with zero/two publishable baselines — either of which is a boot
 *     failure on the NEXT start, not a visible error now
 *   - the REFUSALS: a built-in, a collision, a delete that would orphan approved
 *     renders, a directionality flip on authored work
 *   - the cache invalidation, since a write that left the cache standing reports
 *     success while the running server keeps serving the old table
 *
 * `PATHS` is redirected at a temp tree (the sibling suites' idiom) so every case
 * writes and re-reads a real store file: the contract is about a file on disk, and
 * mocking the writer away would leave "did the merge round-trip?" untested.
 *
 * `records.js` is mocked rather than seeded because `recordsCarryingTrack` reaches
 * the DB/file facade — this suite is about the CRUD decisions, and the on-disk
 * evidence scan itself is asserted in `animationTrackWorkflow.test.js`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { storedTrackRow, writeAnimationTrackStore } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-track-crud-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, { data: TEST_ROOT, sprites: join(TEST_ROOT, 'sprites') });
  return actual;
});

// The record scan behind the in-use refusal. Per-test control over which records
// carry a track, so the refusal and the happy path are both exercised without
// laying down selection/set files for every case.
const recordsCarryingTrack = vi.fn(async () => []);
vi.mock('./animationTrackWorkflow.js', () => ({
  recordsCarryingTrack: (...args) => recordsCarryingTrack(...args),
}));

const {
  listAnimationTracks, createAnimationTrack, updateAnimationTrack, deleteAnimationTrack,
  animationTrackStoreOrigin,
} = await import('./animationTrackCrud.js');
// The derivation lives beside the row contract it must satisfy (#3153 review).
const { deriveTrackFields } = await import('./animationTracks.js');
const { __resetAnimationTrackStore, animationTrackStorePath } = await import('./animationTrackStore.js');

const STORE = join(TEST_ROOT, 'sprites', 'animation-tracks.json');

/** Seed the on-disk store with `rows` (or clear it) and drop the registry cache. */
async function seedStore(rows) {
  await writeAnimationTrackStore(TEST_ROOT, rows);
  __resetAnimationTrackStore();
}

const readStore = () => JSON.parse(readFileSync(STORE, 'utf-8'));
const byId = (result, id) => result.tracks.find((row) => row.id === id);

// A minimally-valid create payload — the user-facing subset the route validates,
// with none of the derived fields.
const authored = (overrides = {}) => ({
  id: 'chest-opening',
  label: 'Chest opening',
  directional: false,
  kinds: ['object'],
  minFrameCount: 2,
  maxFrameCount: 8,
  defaultFrameCount: 4,
  minFps: 2,
  maxFps: 12,
  defaultFps: 6,
  promptTemplate: 'Animate the {{kind}} {{name}} opening once.',
  ...overrides,
});

beforeEach(async () => {
  recordsCarryingTrack.mockClear();
  recordsCarryingTrack.mockImplementation(async () => []);
  // Every test starts from an empty store so `walk` is the only row and each case
  // states the rows it needs — an inherited scanner/ambient would silently satisfy
  // the standalone-baseline invariant the derivation tests are about.
  await seedStore([]);
});

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('deriveTrackFields', () => {
  it('derives all five discriminators from the id, camel/snake-casing as the registry expects', () => {
    expect(deriveTrackFields('chest-opening')).toEqual({
      contractFrameCountField: 'chestOpeningFrameCount',
      contractFpsField: null,
      selectionKind: 'reviewed-chest-opening-selection',
      setKind: 'finalized-chest-opening-set',
      finalErrorCode: 'CHEST_OPENING_SET_FINAL',
    });
  });

  it('handles a single-word id without inventing separators', () => {
    expect(deriveTrackFields('jetpack')).toMatchObject({
      contractFrameCountField: 'jetpackFrameCount',
      setKind: 'finalized-jetpack-set',
      finalErrorCode: 'JETPACK_SET_FINAL',
    });
  });

  it('reproduces the seeded rows exactly, so the derivation is the same rule the seed used', () => {
    // The seed is what an upgraded install already carries; a derivation that
    // disagreed would mean re-saving scanner through the UI silently renamed the
    // on-disk files an approved set is keyed by.
    expect(deriveTrackFields('scanner')).toMatchObject({
      contractFrameCountField: 'scannerFrameCount',
      selectionKind: 'reviewed-scanner-selection',
      setKind: 'finalized-scanner-set',
    });
  });
});

// `standaloneContract` — which track is a record kind's publishable baseline — is a
// CROSS-ROW answer, so it is asserted through the mutations that recompute it rather
// than as a unit: the invariant is a property of the resulting table, and the bug it
// once had (deriving against the pre-image) was invisible to a per-row check. The
// promotion/demotion cases live with `deleteAnimationTrack`/`createAnimationTrack`
// below; these cover the two rules that decide the answer.
describe('standaloneContract derivation', () => {
  it('declines the kind a BUILT-IN already owns (a character action rides beside walk)', async () => {
    const result = await createAnimationTrack(authored({ id: 'jetpack', kinds: ['character'] }));
    expect(byId(result, 'jetpack').standaloneContract).toBe(false);
  });

  it('claims a kind nothing owns yet (the first place loop IS the baseline)', async () => {
    const result = await createAnimationTrack(authored({ id: 'shutter', kinds: ['place'] }));
    expect(byId(result, 'shutter').standaloneContract).toBe(true);
  });

  it('refuses a row spanning an owned kind AND a free one — there is no valid answer', async () => {
    // `walk` owns `character`, so the row can't be a baseline; but then nothing is
    // `place`'s baseline. Both answers are wrong, so the assert refuses rather than
    // silently picking one — the user's fix is to split it into two types.
    const err = await createAnimationTrack(authored({ id: 'combo', kinds: ['place', 'character'] }))
      .catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
    expect(err.message).toContain("record kind 'place'");
  });

  it('keeps a baseline row as the baseline when it is re-saved', async () => {
    await seedStore([storedTrackRow({ kinds: ['object'] })]);
    expect(byId(listAnimationTracks(), 'chest-opening').standaloneContract).toBe(true);
    const result = await updateAnimationTrack('chest-opening', { label: 'Chest opens' });
    expect(byId(result, 'chest-opening').standaloneContract).toBe(true);
  });
});

describe('listAnimationTracks', () => {
  it('lists the built-in walk row on an install with an empty store', () => {
    const result = listAnimationTracks();
    expect(result.tracks.map((row) => row.id)).toEqual(['walk']);
    expect(byId(result, 'walk').builtin).toBe(true);
    expect(result.storePath).toBe('sprites/animation-tracks.json');
  });

  it('lists stored rows after the built-in, with their derived fields visible', async () => {
    await seedStore([storedTrackRow()]);
    const result = listAnimationTracks();
    expect(result.tracks.map((row) => row.id)).toEqual(['walk', 'chest-opening']);
    expect(byId(result, 'chest-opening')).toMatchObject({
      builtin: false, setKind: 'finalized-chest-opening-set',
    });
  });
});

describe('createAnimationTrack', () => {
  it('persists the authored subset plus the derived fields and drops the cache', async () => {
    const result = await createAnimationTrack(authored());
    // The write landed on disk in the store's own shape…
    const doc = readStore();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.tracks).toHaveLength(1);
    expect(doc.tracks[0]).toMatchObject({
      id: 'chest-opening',
      contractFrameCountField: 'chestOpeningFrameCount',
      setKind: 'finalized-chest-opening-set',
      builtin: false,
    });
    // …and the returned table is the FRESH one, which only holds if the cache was
    // invalidated — a stale cache would answer `['walk']` here.
    expect(result.tracks.map((row) => row.id)).toEqual(['walk', 'chest-opening']);
    expect(result.restartRequired).toBe(true);
  });

  it('does not persist an unknown field even if one reaches the service', async () => {
    // The route's `.strict()` schema rejects this first; the service whitelists
    // anyway, so a hand-edited row can't round-trip an unknown key back into a save.
    await createAnimationTrack({ ...authored(), builtin: true, setKind: 'finalized-eight-direction-walk-set' });
    const row = readStore().tracks[0];
    expect(row.builtin).toBe(false);
    expect(row.setKind).toBe('finalized-chest-opening-set');
  });

  it('refuses an id that already names a stored track', async () => {
    await createAnimationTrack(authored());
    await expect(createAnimationTrack(authored())).rejects.toMatchObject({
      status: 409, code: 'ANIMATION_TRACK_EXISTS',
    });
  });

  it('refuses an id that names the built-in walk track', async () => {
    await expect(createAnimationTrack(authored({ id: 'walk' }))).rejects.toMatchObject({
      status: 409, code: 'BUILTIN_ANIMATION_TRACK',
    });
  });

  it('refuses a row whose DERIVED discriminator collides with an existing track', async () => {
    // The user types only an id, but the id is what produces the on-disk kinds — so
    // a collision must be caught at save time, naming the conflict, rather than
    // bricking the next boot. Here a hand-edited row already claims the contract
    // field `chest-opening` derives, which the new row cannot rename away from.
    await seedStore([storedTrackRow({
      id: 'opening',
      contractFrameCountField: 'chestOpeningFrameCount',
      selectionKind: 'reviewed-other-selection',
      setKind: 'finalized-other-set',
      finalErrorCode: 'OTHER_SET_FINAL',
    })]);
    const err = await createAnimationTrack(authored()).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
    expect(err.message).toContain('chestOpeningFrameCount');
    // Nothing was written — a refused save must not half-land.
    expect(readStore().tracks.map((row) => row.id)).toEqual(['opening']);
  });

  it('preserves a hand-edited row\'s discriminators when a SIBLING is created', async () => {
    // The seeded `scanner` row's `reviewed-directional-scanner-selection` is NOT what
    // `deriveTrackFields('scanner')` produces, and it names the file an approved
    // scanner set on this machine is keyed by — so an unrelated create must carry it
    // over verbatim rather than re-deriving and orphaning that set.
    await seedStore([storedTrackRow({
      id: 'scanner',
      kinds: ['character'],
      standaloneContract: false,
      contractFrameCountField: 'scannerFrameCount',
      selectionKind: 'reviewed-directional-scanner-selection',
      setKind: 'finalized-eight-direction-scanner-set',
      finalErrorCode: 'SCANNER_SET_FINAL',
    })]);
    const result = await createAnimationTrack(authored());
    expect(byId(result, 'scanner')).toMatchObject({
      selectionKind: 'reviewed-directional-scanner-selection',
      setKind: 'finalized-eight-direction-scanner-set',
    });
  });

  it('refuses every mutation while the store on disk is already invalid', async () => {
    // A hand-edited row claiming no baseline for a kind nothing else owns is refused
    // by the store's own LOAD (the same guard that runs at boot), before this surface
    // gets a table to recompose — so the user fixes the file rather than having a
    // write silently rewrite their row's flags out from under them.
    await seedStore([storedTrackRow({ id: 'lamp-flicker', kinds: ['place'], standaloneContract: false })]);
    const err = await createAnimationTrack(authored({ id: 'shutter', kinds: ['object'] })).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
    expect(err.message).toContain("record kind 'place'");
  });
});

describe('an already-invalid store', () => {
  it('answers a read with a 409 naming the broken row, not an opaque 500', async () => {
    // A hand-broken file is the user's own edit to the very file this surface is
    // about, so the drawer must be able to show the message beside the rows.
    await seedStore([storedTrackRow({ minFrameCount: 'six' })]);
    const err = await Promise.resolve().then(() => listAnimationTracks()).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
    expect(err.message).toContain('minFrameCount');
  });

  it('answers a mutation the same way instead of half-writing over it', async () => {
    await seedStore([storedTrackRow({ minFrameCount: 'six' })]);
    await expect(createAnimationTrack(authored({ id: 'shutter' }))).rejects.toMatchObject({
      status: 409, code: 'ANIMATION_TRACK_CONFLICT',
    });
    expect(readStore().tracks.map((row) => row.id)).toEqual(['chest-opening']);
  });
});

describe('updateAnimationTrack', () => {
  beforeEach(async () => { await seedStore([storedTrackRow()]); });

  it('applies a partial patch and leaves the rest of the row alone', async () => {
    const result = await updateAnimationTrack('chest-opening', { label: 'Chest opens', maxFrameCount: 12 });
    expect(byId(result, 'chest-opening')).toMatchObject({
      label: 'Chest opens',
      maxFrameCount: 12,
      minFrameCount: 2,
      defaultFrameCount: 4,
      promptTemplate: storedTrackRow().promptTemplate,
      setKind: 'finalized-chest-opening-set',
    });
    expect(result.restartRequired).toBe(true);
  });

  it('keeps a baseline row as the baseline when re-saved (it must not flip off against itself)', async () => {
    expect(byId(listAnimationTracks(), 'chest-opening').standaloneContract).toBe(true);
    const result = await updateAnimationTrack('chest-opening', { label: 'Chest opens' });
    expect(byId(result, 'chest-opening').standaloneContract).toBe(true);
  });

  it('refuses editing a built-in track', async () => {
    await expect(updateAnimationTrack('walk', { label: 'Stride' })).rejects.toMatchObject({
      status: 409, code: 'BUILTIN_ANIMATION_TRACK',
    });
  });

  it('404s an unknown track', async () => {
    await expect(updateAnimationTrack('nope', { label: 'x' })).rejects.toMatchObject({
      status: 404, code: 'UNKNOWN_ANIMATION_TRACK',
    });
  });

  it('refuses a bounds patch the registry would reject, without writing it', async () => {
    const err = await updateAnimationTrack('chest-opening', { minFrameCount: 6 }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_CONFLICT' });
    expect(err.message).toContain('minFrameCount <= defaultFrameCount');
    expect(readStore().tracks[0].minFrameCount).toBe(2);
  });

  it('retunes bounds and the prompt on an IN-USE track (the packer clamps into the new range)', async () => {
    recordsCarryingTrack.mockImplementation(async () => ['pioneer']);
    const result = await updateAnimationTrack('chest-opening', { maxFrameCount: 12, promptTemplate: 'New wording.' });
    expect(byId(result, 'chest-opening')).toMatchObject({ maxFrameCount: 12, promptTemplate: 'New wording.' });
  });

  it('refuses a DIRECTIONALITY flip on an in-use track, naming the records', async () => {
    recordsCarryingTrack.mockImplementation(async () => ['pioneer', 'crates']);
    const err = await updateAnimationTrack('chest-opening', { directional: true }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_IN_USE' });
    expect(err.message).toContain('pioneer');
    expect(err.message).toContain('crates');
    expect(readStore().tracks[0].directional).toBe(false);
  });

  it('allows a directionality flip when nothing carries the track', async () => {
    const result = await updateAnimationTrack('chest-opening', { directional: true });
    expect(byId(result, 'chest-opening').directional).toBe(true);
    expect(recordsCarryingTrack).toHaveBeenCalledWith('chest-opening');
  });
});

describe('Object.prototype track ids', () => {
  // "constructor" satisfies the route id regex; it must read as an unknown track,
  // never as the inherited Object function.
  it('404s update and delete of an inherited member name and still allows creating the id', async () => {
    await expect(updateAnimationTrack('constructor', { label: 'x' })).rejects.toMatchObject({ status: 404, code: 'UNKNOWN_ANIMATION_TRACK' });
    await expect(deleteAnimationTrack('constructor')).rejects.toMatchObject({ status: 404, code: 'UNKNOWN_ANIMATION_TRACK' });
    const created = await createAnimationTrack(authored({ id: 'constructor' }));
    expect(created.tracks.map((row) => row.id)).toContain('constructor');
  });
});

describe('deleteAnimationTrack', () => {
  it('removes the row and re-reads the table', async () => {
    await seedStore([storedTrackRow(), storedTrackRow({
      id: 'lamp-flicker',
      kinds: ['place'],
      contractFrameCountField: 'lampFlickerFrameCount',
      selectionKind: 'reviewed-lamp-flicker-selection',
      setKind: 'finalized-lamp-flicker-set',
      finalErrorCode: 'LAMP_FLICKER_SET_FINAL',
    })]);
    const result = await deleteAnimationTrack('lamp-flicker');
    expect(result.tracks.map((row) => row.id)).toEqual(['walk', 'chest-opening']);
    expect(readStore().tracks.map((row) => row.id)).toEqual(['chest-opening']);
  });

  it('refuses a delete that would orphan approved work, listing the records and offering no force', async () => {
    await seedStore([storedTrackRow()]);
    recordsCarryingTrack.mockImplementation(async () => ['pioneer']);
    const err = await deleteAnimationTrack('chest-opening').catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: 'ANIMATION_TRACK_IN_USE' });
    expect(err.message).toContain('pioneer');
    expect(err.context?.records).toEqual(['pioneer']);
    // Still on disk — a refused delete must not have removed anything.
    expect(readStore().tracks.map((row) => row.id)).toEqual(['chest-opening']);
  });

  it('refuses deleting a built-in track', async () => {
    await expect(deleteAnimationTrack('walk')).rejects.toMatchObject({
      status: 409, code: 'BUILTIN_ANIMATION_TRACK',
    });
  });

  it('404s an unknown track', async () => {
    await expect(deleteAnimationTrack('nope')).rejects.toMatchObject({
      status: 404, code: 'UNKNOWN_ANIMATION_TRACK',
    });
  });

  it('PROMOTES a surviving same-kind track when the kind\'s baseline is deleted', async () => {
    // The regression this guards: deriving `standaloneContract` against the
    // pre-image left `place` with zero baselines and 409'd a delete that should
    // succeed — so "delete ambient, then keep your own place loop" was impossible.
    // The answer must be derived over the POST-mutation table.
    await seedStore([
      storedTrackRow({
        id: 'ambient',
        kinds: ['place'],
        contractFrameCountField: 'ambientFrameCount',
        selectionKind: 'reviewed-ambient-selection',
        setKind: 'finalized-ambient-set',
        finalErrorCode: 'AMBIENT_SET_FINAL',
        standaloneContract: true,
      }),
      storedTrackRow({ id: 'shutter', kinds: ['place'], standaloneContract: false }),
    ]);
    const result = await deleteAnimationTrack('ambient');
    expect(result.tracks.map((row) => row.id)).toEqual(['walk', 'shutter']);
    expect(byId(result, 'shutter').standaloneContract).toBe(true);
  });

  it('re-derives independent kinds without disturbing each other', async () => {
    await seedStore([
      storedTrackRow({ id: 'shutter', kinds: ['place'] }),
      storedTrackRow({
        id: 'lamp-flicker',
        kinds: ['object'],
        contractFrameCountField: 'lampFlickerFrameCount',
        selectionKind: 'reviewed-lamp-flicker-selection',
        setKind: 'finalized-lamp-flicker-set',
        finalErrorCode: 'LAMP_FLICKER_SET_FINAL',
      }),
    ]);
    const result = await deleteAnimationTrack('shutter');
    expect(byId(result, 'lamp-flicker').standaloneContract).toBe(true);
  });

  it('DEMOTES a new row\'s claim rather than giving a kind two baselines', async () => {
    // The other direction of the same derivation: `place` already has a baseline,
    // so a second place track must not claim one (the assert would refuse "has 2").
    await seedStore([storedTrackRow({ id: 'shutter', kinds: ['place'] })]);
    const result = await createAnimationTrack(authored({ id: 'awning', kinds: ['place'] }));
    expect(byId(result, 'shutter').standaloneContract).toBe(true);
    expect(byId(result, 'awning').standaloneContract).toBe(false);
  });
});

describe('animationTrackStoreOrigin', () => {
  it("reports 'seed' before this install has its own store file", async () => {
    rmSync(STORE, { force: true });
    __resetAnimationTrackStore();
    expect(await animationTrackStoreOrigin()).toBe('seed');
  });

  it("reports 'store' once a save has written the user copy", async () => {
    rmSync(STORE, { force: true });
    __resetAnimationTrackStore();
    await createAnimationTrack(authored());
    expect(existsSync(animationTrackStorePath())).toBe(true);
    expect(await animationTrackStoreOrigin()).toBe('store');
  });
});

describe('concurrent writes', () => {
  it('serializes two creates so neither read-modify-write loses the other', async () => {
    // One store file, so the queue is a single tail — without it both creates read
    // the same empty pre-image and the second write drops the first row.
    await Promise.all([
      createAnimationTrack(authored()),
      createAnimationTrack(authored({
        id: 'lamp-flicker', label: 'Lamp flicker', kinds: ['place'],
      })),
    ]);
    expect(readStore().tracks.map((row) => row.id).sort()).toEqual(['chest-opening', 'lamp-flicker']);
  });
});
