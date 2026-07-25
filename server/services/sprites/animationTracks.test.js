/**
 * The per-track animation registry (#3015) — the rows themselves, the
 * unknown-track error boundary, the per-track clamps, and the sharp-free
 * property `server/lib/validation.js` depends on.
 *
 * The walk row is pinned to its historical values on purpose: #3015 is a
 * refactor, and a registry that quietly moved walk's floor would change every
 * render's geometry while looking like plumbing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  WALK_TRACK, SCANNER_TRACK, AMBIENT_TRACK, ANIMATION_TRACKS, ANIMATION_TRACK_IDS,
  isAnimationTrack, getAnimationTrack, clampTrackFrameCount, clampTrackFps,
  assertAnimationTrackRows, trackRowCount, tracksForKind, kindSupportsTrack,
} from './animationTracks.js';
import { SPRITE_RECORD_KINDS } from './recordsLogic.js';
import { AMBIENT_TRACK_ROW } from './spriteTestFixtures.js';
import {
  staticImportSpecifiers, staticImportClosure, specifierMatchesPackage,
} from '../../lib/staticImportGraph.js';
import {
  WALK_DEFAULT_FRAME_COUNT as CLIENT_DEFAULT_FRAME_COUNT,
  WALK_DEFAULT_FPS as CLIENT_DEFAULT_FPS,
  WALK_FRAME_COUNT_OPTIONS as CLIENT_FRAME_COUNT_OPTIONS,
  walkFpsOptionsFor as clientWalkFpsOptionsFor,
} from '../../../client/src/lib/spriteTrimmer.js';

const SPRITES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = dirname(dirname(SPRITES_DIR));

describe('the registry rows', () => {
  it('reproduces the walk track\'s historical bounds and defaults exactly', () => {
    // #3015 is a refactor — walk behaves identically end to end.
    expect(getAnimationTrack(WALK_TRACK)).toMatchObject({
      id: 'walk',
      directional: true,
      // #3017 moved the gate into the registry without loosening it: a walk
      // cycle is a character gait, so `place`/`object` are still refused.
      kinds: ['character'],
      minFrameCount: 6,
      maxFrameCount: 16,
      defaultFrameCount: 12,
      minFps: 4,
      maxFps: 24,
      defaultFps: 10,
      contractFrameCountField: 'walkFrameCount',
      contractFpsField: 'walkFps',
    });
  });

  it('registers the short scanner action independently of walk', () => {
    expect(getAnimationTrack(SCANNER_TRACK)).toMatchObject({
      id: SCANNER_TRACK,
      directional: true,
      kinds: ['character'],
      minFrameCount: 2,
      maxFrameCount: 8,
      defaultFrameCount: 4,
      minFps: 2,
      maxFps: 12,
      defaultFps: 6,
      contractFrameCountField: 'scannerFrameCount',
      contractFpsField: null,
    });
  });

  it('registers the single-row ambient loop for places and objects', () => {
    expect(getAnimationTrack(AMBIENT_TRACK)).toMatchObject({
      id: AMBIENT_TRACK,
      label: 'Ambient loop',
      directional: false,
      kinds: ['place', 'object', 'props'],
      minFrameCount: 2,
      maxFrameCount: 6,
      defaultFrameCount: 3,
      minFps: 2,
      maxFps: 12,
      defaultFps: 4,
      contractFrameCountField: 'ambientFrameCount',
      contractFpsField: null,
    });
  });

  it('describes every declared track completely', () => {
    // Mirrors the module-load guard in animationTracks.js (which is what
    // actually blocks boot on a bad row) so a shape violation reads as a named
    // assertion here rather than only as an import-time throw somewhere else.
    for (const id of ANIMATION_TRACK_IDS) {
      const row = ANIMATION_TRACKS[id];
      expect(row.id, `${id}.id must match its registry key`).toBe(id);
      expect(typeof row.label).toBe('string');
      expect(typeof row.directional).toBe('boolean');
      expect(Array.isArray(row.kinds) && row.kinds.length > 0, `${id}.kinds must be non-empty`).toBe(true);
      expect(typeof row.contractFrameCountField).toBe('string');
      // `null` is legal here — a track whose speed an app has no say in — so
      // this must stay as permissive as the module-load guard, or the first row
      // that uses the null form goes red while booting perfectly fine.
      expect(row.contractFpsField === null || typeof row.contractFpsField === 'string').toBe(true);
      for (const field of ['minFrameCount', 'maxFrameCount', 'defaultFrameCount', 'minFps', 'maxFps', 'defaultFps']) {
        expect(Number.isInteger(row[field]), `${id}.${field} must be an integer`).toBe(true);
      }
      expect(row.minFrameCount).toBeLessThanOrEqual(row.maxFrameCount);
      expect(row.minFps).toBeLessThanOrEqual(row.maxFps);
      expect(row.defaultFrameCount).toBeGreaterThanOrEqual(row.minFrameCount);
      expect(row.defaultFrameCount).toBeLessThanOrEqual(row.maxFrameCount);
      expect(row.defaultFps).toBeGreaterThanOrEqual(row.minFps);
      expect(row.defaultFps).toBeLessThanOrEqual(row.maxFps);
    }
  });

  it('accepts the shipped registry', () => {
    expect(() => assertAnimationTrackRows(ANIMATION_TRACKS)).not.toThrow();
  });

  it('is frozen so a caller cannot mutate the shared bounds', () => {
    expect(() => { ANIMATION_TRACKS.walk.minFrameCount = 1; }).toThrow();
    expect(ANIMATION_TRACKS.walk.minFrameCount).toBe(6);
  });
});

describe('the module-load row guard', () => {
  // Driven against SYNTHETIC rows, not the shipped table. Asserting properties
  // of the (single-row) real registry would only re-derive the implementation:
  // the guard could be deleted outright and such a test would stay green.
  const walk = getAnimationTrack(WALK_TRACK);
  const second = {
    ...walk, id: 'scanner', label: 'Scanner', minFrameCount: 3, defaultFrameCount: 4, maxFrameCount: 8,
    contractFrameCountField: 'scannerFrameCount', contractFpsField: 'scannerFps',
  };
  const twoRows = (overrides = {}) => ({ walk, scanner: { ...second, ...overrides } });

  it('accepts a well-formed second row', () => {
    expect(() => assertAnimationTrackRows(twoRows())).not.toThrow();
  });

  it('rejects a second row that copy-pastes walk\'s contract field', () => {
    // The regression the guard exists for: resolveAnimationTarget would read
    // the WALK's walkFrameCount for the scanner and report it frameCountLocked.
    expect(() => assertAnimationTrackRows(twoRows({ contractFrameCountField: 'walkFrameCount' })))
      .toThrow(/claimed by both 'walk\.contractFrameCountField' and 'scanner\.contractFrameCountField'/);
  });

  it('names both knobs when ONE row claims one field for both of them', () => {
    expect(() => assertAnimationTrackRows({ scanner: { ...second, contractFpsField: 'scannerFrameCount' } }))
      .toThrow(/'scanner\.contractFrameCountField' and 'scanner\.contractFpsField'/);
  });

  it('rejects a row no record kind can carry (#3017)', () => {
    // A row with no kinds is unreachable work — nothing could ever carry it,
    // and the gate would refuse every record with a message blaming the record.
    expect(() => assertAnimationTrackRows(twoRows({ kinds: [] }))).toThrow(/needs a non-empty 'kinds' array/);
    expect(() => assertAnimationTrackRows(twoRows({ kinds: 'character' }))).toThrow(/needs a non-empty 'kinds' array/);
    expect(() => assertAnimationTrackRows(twoRows({ kinds: ['character', ''] }))).toThrow(/non-string entry in 'kinds'/);
  });

  it('lets a row opt out of an fps contract field with null', () => {
    expect(() => assertAnimationTrackRows(twoRows({ contractFpsField: null }))).not.toThrow();
    // …and two such rows don't collide on "null".
    expect(() => assertAnimationTrackRows({
      walk: { ...walk, contractFpsField: null }, scanner: { ...second, contractFpsField: null },
    })).not.toThrow();
  });

  it.each([
    ['a mismatched id', { id: 'nope' }, /mismatched id/],
    ['a missing label', { label: '' }, /needs a label/],
    ['a non-boolean directional', { directional: 'yes' }, /boolean 'directional'/],
    ['a non-integer bound', { maxFrameCount: 8.5 }, /integer 'maxFrameCount'/],
    ['a default outside its range', { defaultFrameCount: 99 }, /minFrameCount <= defaultFrameCount <= maxFrameCount/],
    ['a default fps outside its range', { defaultFps: 99 }, /minFps <= defaultFps <= maxFps/],
    ['an empty contract frame-count field', { contractFrameCountField: '' }, /needs a contractFrameCountField/],
    ['an undefined contract fps field', { contractFpsField: undefined }, /contractFpsField \(or null\)/],
  ])('rejects %s', (_label, overrides, message) => {
    expect(() => assertAnimationTrackRows(twoRows(overrides))).toThrow(message);
  });
});

describe('getAnimationTrack — absent vs unrecognized', () => {
  it('treats an absent id as the default track, preserving pre-#3015 call sites', () => {
    expect(getAnimationTrack().id).toBe(WALK_TRACK);
    expect(getAnimationTrack(undefined).id).toBe(WALK_TRACK);
    expect(getAnimationTrack(null).id).toBe(WALK_TRACK);
  });

  it('keeps unknown ids distinct from the shipped scanner track', () => {
    // The sentinel rule: "not set" resolves to the default; "set to something
    // this build does not know" is an error. Silently handing back walk's 6–16
    // would reject a legitimate 4-frame action for reasons nothing explains.
    expect(getAnimationTrack(SCANNER_TRACK).id).toBe(SCANNER_TRACK);
    expect(() => getAnimationTrack('unknown')).toThrow(/Unknown animation track 'unknown'/);
  });

  it('treats an empty string as present-and-invalid, not absent', () => {
    expect(() => getAnimationTrack('')).toThrow(/Unknown animation track/);
  });

  it('rejects a non-string id and inherited Object keys', () => {
    expect(isAnimationTrack('toString')).toBe(false);
    expect(isAnimationTrack(7)).toBe(false);
    expect(() => getAnimationTrack('toString')).toThrow(/Unknown animation track/);
  });
});

describe('directionality and record-kind support (#3017)', () => {
  // `AMBIENT_TRACK_ROW` is a synthetic NON-directional row admitting the two
  // kinds that had no animation path at all. The shipped registry's only track
  // is directional and character-only, so a test written against it alone could
  // not tell "reads the row" from "hardcodes 8 / hardcodes 'character'" — the
  // same injected-table idiom the guard tests above use.
  const walk = getAnimationTrack(WALK_TRACK);
  const MIXED = { walk, ambient: AMBIENT_TRACK_ROW };

  it('accepts a well-formed non-directional row', () => {
    expect(() => assertAnimationTrackRows(MIXED)).not.toThrow();
  });

  it('turns directionality into a row count, scaled to the grid it is asked about', () => {
    expect(trackRowCount('walk', 8, MIXED)).toBe(8);
    expect(trackRowCount('walk', 4, MIXED)).toBe(4);
    // A track with no facing is ONE row whatever the grid height — that single
    // row is row 0, and the rest of its column span stays transparent.
    expect(trackRowCount('ambient', 8, MIXED)).toBe(1);
    expect(trackRowCount('ambient', 4, MIXED)).toBe(1);
  });

  it('refuses an unusable direction count rather than returning NaN rows', () => {
    expect(() => trackRowCount('walk', 0, MIXED)).toThrow(/positive direction count/);
    expect(() => trackRowCount('walk', 2.5, MIXED)).toThrow(/positive direction count/);
    // Unknown ids stay getAnimationTrack's boundary.
    expect(() => trackRowCount('nope', 8, MIXED)).toThrow(/Unknown animation track 'nope'/);
  });

  it('answers which tracks a record kind may carry — the whole track-presence gate', () => {
    expect(tracksForKind('character', MIXED).map((r) => r.id)).toEqual(['walk']);
    expect(tracksForKind('place', MIXED).map((r) => r.id)).toEqual(['ambient']);
    expect(tracksForKind('object', MIXED).map((r) => r.id)).toEqual(['ambient']);
    // The gate's negative case: a kind no row lists has no animation path.
    expect(tracksForKind('props', MIXED)).toEqual([]);
    // A malformed record must not inherit character's permissions by default.
    expect(tracksForKind('', MIXED)).toEqual([]);
    expect(tracksForKind(undefined, MIXED)).toEqual([]);
    expect(tracksForKind(null, MIXED)).toEqual([]);
  });

  it('reports per-track support, refusing an unknown track rather than throwing', () => {
    expect(kindSupportsTrack('character', 'walk', MIXED)).toBe(true);
    expect(kindSupportsTrack('place', 'walk', MIXED)).toBe(false);
    expect(kindSupportsTrack('place', 'ambient', MIXED)).toBe(true);
    // A predicate is the wrong place to throw — the gates use it to DECIDE.
    expect(kindSupportsTrack('character', 'nope', MIXED)).toBe(false);
  });

  it('admits ambient loops for non-character sprite kinds', () => {
    expect(tracksForKind('character').map((r) => r.id)).toEqual([WALK_TRACK, SCANNER_TRACK]);
    for (const kind of ['place', 'object', 'props']) {
      expect(tracksForKind(kind).map((r) => r.id), `${kind} carries the ambient loop`).toEqual([AMBIENT_TRACK]);
    }
  });

  it('spells every `kinds` entry from the real record vocabulary', () => {
    // The module-load guard can only check that `kinds` holds non-empty
    // strings, because animationTracks.js imports nothing (asserted below) and
    // the vocabulary lives in recordsLogic.js. So `kinds: ['charcter']` passes
    // every guard, makes the track uncarryable by anything, and surfaces only
    // as the baffling "No animation track applies to character records".
    // Cross-checked here, where reaching another module is fine — the same
    // place the client-mirror parity check lives.
    for (const id of ANIMATION_TRACK_IDS) {
      for (const kind of ANIMATION_TRACKS[id].kinds) {
        expect(SPRITE_RECORD_KINDS, `${id}.kinds names an unknown record kind '${kind}'`).toContain(kind);
      }
    }
  });
});

describe('per-track clamps', () => {
  it('clamps into the named track\'s range and rounds', () => {
    expect(clampTrackFrameCount(2, WALK_TRACK)).toBe(6);
    expect(clampTrackFrameCount(99, WALK_TRACK)).toBe(16);
    expect(clampTrackFrameCount(11.6, WALK_TRACK)).toBe(12);
    expect(clampTrackFps(1, WALK_TRACK)).toBe(4);
    expect(clampTrackFps(240, WALK_TRACK)).toBe(24);
  });

  it('falls back to the track\'s default for unusable input', () => {
    expect(clampTrackFrameCount('nope', WALK_TRACK)).toBe(12);
    expect(clampTrackFps(undefined, WALK_TRACK)).toBe(10);
  });

  it('defaults to the walk track when none is named', () => {
    expect(clampTrackFrameCount(99)).toBe(16);
    expect(clampTrackFps(99)).toBe(24);
  });

  it('clamps scanner values against scanner bounds', () => {
    expect(clampTrackFrameCount(99, SCANNER_TRACK)).toBe(8);
    expect(clampTrackFrameCount(-1, SCANNER_TRACK)).toBe(2);
    expect(clampTrackFps(99, SCANNER_TRACK)).toBe(12);
    expect(clampTrackFps(-1, SCANNER_TRACK)).toBe(2);
  });

  it('clamps ambient values against the ambient range', () => {
    expect(clampTrackFrameCount(99, AMBIENT_TRACK)).toBe(6);
    expect(clampTrackFrameCount(-1, AMBIENT_TRACK)).toBe(2);
    expect(clampTrackFps(99, AMBIENT_TRACK)).toBe(12);
    expect(clampTrackFps(-1, AMBIENT_TRACK)).toBe(2);
  });
});

describe('walkBounds re-reads the walk row (no call-site churn)', () => {
  it('exposes exactly the registry values under its historical export names', async () => {
    const bounds = await import('./walkBounds.js');
    const row = getAnimationTrack(WALK_TRACK);
    expect({
      min: bounds.WALK_MIN_FRAME_COUNT,
      max: bounds.WALK_MAX_FRAME_COUNT,
      def: bounds.WALK_DEFAULT_FRAME_COUNT,
      minFps: bounds.WALK_MIN_FPS,
      maxFps: bounds.WALK_MAX_FPS,
      defFps: bounds.WALK_DEFAULT_FPS,
    }).toEqual({
      min: row.minFrameCount,
      max: row.maxFrameCount,
      def: row.defaultFrameCount,
      minFps: row.minFps,
      maxFps: row.maxFps,
      defFps: row.defaultFps,
    });
  });

  it('keeps clampFrameCount / clampFps behaving as the walk-track clamps', async () => {
    const { clampFrameCount, clampFps } = await import('./walkBounds.js');
    for (const n of [-1, 0, 5, 6, 11.6, 16, 99, 'nope', undefined, null]) {
      expect(clampFrameCount(n)).toBe(clampTrackFrameCount(n, WALK_TRACK));
      expect(clampFps(n)).toBe(clampTrackFps(n, WALK_TRACK));
    }
  });
});

describe('sharp-free leaf property', () => {
  // The property that actually matters is on `server/lib/validation.js`: it
  // builds its sprite frame-count/fps ranges from this registry, and the whole
  // reason walkBounds.js was split out (and now animationTracks.js beneath it)
  // is to keep the native image graph out of REQUEST VALIDATION. Asserting only
  // the three leaves would pass while someone routed sharp into validation.js
  // through any of its ~90 other closure members, so validation.js is the first
  // entry point here, not an afterthought.
  const NATIVE = ['sharp', 'canvas', 'fluent-ffmpeg', '@ffmpeg-installer/ffmpeg'];

  it.each([
    ['the request-validation graph', join(SERVER_DIR, 'lib', 'validation.js')],
    ['animationTracks.js', join(SPRITES_DIR, 'animationTracks.js')],
    ['walkBounds.js', join(SPRITES_DIR, 'walkBounds.js')],
    ['animationTargets.js', join(SPRITES_DIR, 'animationTargets.js')],
    // #3016: the atlas grid is the ONE definition of a column span, shared by
    // the compiler (which imports sharp) and the layout sidecar (which must
    // not). If either of these two ever reaches sharp, that split has silently
    // collapsed and the sidecar builder drags the native image graph along.
    ['atlasGrid.js', join(SPRITES_DIR, 'atlasGrid.js')],
    ['atlasLayout.js', join(SPRITES_DIR, 'atlasLayout.js')],
  ])('%s reaches no native image/video dependency', (_label, entry) => {
    const { packages } = staticImportClosure(entry);
    const offending = [...packages].filter((p) => NATIVE.some((n) => specifierMatchesPackage(p, n)));
    expect(offending, `must not reach ${offending.join(', ')}`).toEqual([]);
  });

  it('keeps animationTracks.js a true leaf — it imports nothing at all', () => {
    expect(staticImportSpecifiers(join(SPRITES_DIR, 'animationTracks.js'))).toEqual([]);
  });

  it('actually walks the graph (positive control — the guard is not vacuous)', () => {
    // Three ways the assertions above could pass for the wrong reason: the walk
    // never follows relative imports, it never records bare packages, or an
    // unresolvable specifier silently truncates it. Pin the first two against a
    // module that genuinely reaches sharp.
    const walkBounds = staticImportClosure(join(SPRITES_DIR, 'walkBounds.js'));
    expect([...walkBounds.files]).toContain(join(SPRITES_DIR, 'animationTracks.js'));

    const packer = staticImportClosure(join(SPRITES_DIR, 'walkPostprocess.js'));
    expect([...packer.packages], 'walkPostprocess is the native-graph module this split exists to fence off')
      .toContain('sharp');

    // …and that validation.js's closure is genuinely large, so a resolver gap
    // can't make its clean result meaningless.
    expect(staticImportClosure(join(SERVER_DIR, 'lib', 'validation.js')).files.size).toBeGreaterThan(20);
  });
});

describe('client mirror parity', () => {
  // `client/src/lib/spriteTrimmer.js` restates walk's bounds as literals so the
  // pickers can seed their option lists without importing a server module. The
  // registry is now the source of truth for a SET of ranges, so the first real
  // per-track bounds change — the entire motivation for #3015 — would silently
  // desync the picker from the server's Zod range and surface as a 400 with no
  // field-level explanation. Same guard shape as catalogTypes.parity.test.js.
  const walk = getAnimationTrack(WALK_TRACK);

  it('mirrors the walk defaults', () => {
    expect(CLIENT_DEFAULT_FRAME_COUNT).toBe(walk.defaultFrameCount);
    expect(CLIENT_DEFAULT_FPS).toBe(walk.defaultFps);
  });

  it('seeds the frame-count picker from the walk row\'s full range', () => {
    expect(CLIENT_FRAME_COUNT_OPTIONS[0]).toBe(walk.minFrameCount);
    expect(CLIENT_FRAME_COUNT_OPTIONS.at(-1)).toBe(walk.maxFrameCount);
  });

  it('seeds the fps picker within the walk row\'s range', () => {
    // The list is even-stepped, so it need not END exactly on the max — but it
    // must start at the floor, never offer a value the server would reject, AND
    // stay within one step of the ceiling. Without that upper pin the guard
    // passes in precisely the scenario it exists for: raise the row's maxFps and
    // the client's hard-coded 24 still satisfies "≤ max" while the picker
    // silently stops offering speeds the server now accepts.
    // Measure the ceiling against the UN-SPLICED base list: the helper splices a
    // non-even current value into its options so the <select> never lies, so
    // seeding it with `defaultFps` would let a row whose default sat near a
    // raised max (maxFps 30, defaultFps 30) satisfy the pin via the spliced-in
    // value while the picker still stopped at the client's hard-coded 24.
    // A non-finite argument short-circuits the splice and returns the base list.
    const options = clientWalkFpsOptionsFor(NaN);
    expect(options[0]).toBe(walk.minFps);
    expect(Math.max(...options)).toBeLessThanOrEqual(walk.maxFps);
    expect(walk.maxFps - Math.max(...options)).toBeLessThan(2);
  });

  it('keeps the publish form\'s hard-coded frame-count bounds in step', () => {
    // PublishWorkflow.jsx is a React component (not importable under the server
    // runner), so its two mirrored literals are asserted as source text.
    const src = readFileSync(
      join(SERVER_DIR, '..', 'client', 'src', 'components', 'sprites', 'PublishWorkflow.jsx'),
      'utf-8',
    );
    expect(src).toContain(`const WALK_MIN_FRAME_COUNT = ${walk.minFrameCount};`);
    expect(src).toContain(`const WALK_MAX_FRAME_COUNT = ${walk.maxFrameCount};`);
  });
});
