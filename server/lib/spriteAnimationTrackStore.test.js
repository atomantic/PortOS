/**
 * The user-defined animation-track store (#3152).
 *
 * The store is what turns "add an animation type" from a PortOS release into a
 * data edit, so what matters here is not that it can read a file — it is that
 * every way a stored row could quietly corrupt the sprite pipeline fails LOUDLY
 * instead. `assertAnimationTrackRows` already owns the row-shape rules
 * (`animationTracks.test.js` proves those against synthetic tables); this suite
 * covers what only the store can get wrong:
 *
 *   - the MERGE — `walk` stays, stored rows join, order is stable
 *   - the SEED FALLBACK — an install with no user copy still sees scanner/ambient,
 *     which is the upgrade path's whole safety net
 *   - the SENTINEL rules — absent ≠ empty ≠ corrupt
 *   - the `walk`-shadow refusal and the duplicate-id refusal
 *   - `builtin: false` FORCED, not read from the row
 *   - the cache, and that resetting it re-reads
 *
 * `PATHS` is redirected at a temp tree so every case writes a real store file: the
 * store's contract is about files on disk, and mocking its reader away would leave
 * the sentinel distinctions (ENOENT vs. unparseable) untested — those are exactly
 * where a "helpful" fallback would silently revert a user's tracks to the shipped
 * defaults.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { storedTrackRow } from '../services/sprites/spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-track-store-test-'));

vi.mock('./fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, { data: TEST_ROOT, sprites: join(TEST_ROOT, 'sprites') });
  return actual;
});

const {
  getEffectiveAnimationTracks, getEffectiveAnimationTrackIds, __resetAnimationTrackStore,
  animationTrackStorePath, animationTrackSeedPath, ANIMATION_TRACK_STORE_SCHEMA_VERSION,
  classifyStoreReadError,
} = await import('./spriteAnimationTrackStore.js');
const { ANIMATION_TRACKS, WALK_TRACK } = await import('./spriteAnimationTracks.js');

const STORE_PATH = animationTrackStorePath();

// The shared stored-row shape (spriteTestFixtures.js), so a future required row
// field is one edit rather than one per suite.
const userRow = storedTrackRow;

// Written synchronously here (not through the shared async `writeAnimationTrackStore`)
// because `beforeEach` must have the file in place before the first sync store read,
// and several cases write a deliberately malformed string.
const writeStore = (doc) => {
  mkdirSync(join(TEST_ROOT, 'sprites'), { recursive: true });
  writeFileSync(STORE_PATH, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2));
};

const writeTracks = (tracks) => writeStore({ schemaVersion: ANIMATION_TRACK_STORE_SCHEMA_VERSION, tracks });

beforeEach(() => {
  rmSync(STORE_PATH, { force: true });
  __resetAnimationTrackStore();
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('the merge', () => {
  it('keeps walk and appends stored rows in a stable order', () => {
    writeTracks([userRow(), userRow({
      id: 'flower-blossoming',
      label: 'Flower blossoming',
      kinds: ['place'],
      contractFrameCountField: 'flowerBlossomingFrameCount',
      selectionKind: 'reviewed-flower-blossoming-selection',
      setKind: 'finalized-flower-blossoming-set',
      finalErrorCode: 'FLOWER_BLOSSOMING_SET_FINAL',
      // `place` already has a standalone baseline in this table only if another
      // row claims it — here nothing else does, so this row is `place`'s primary.
    })]);
    // `walk` FIRST, then store order — load-bearing, because the atlas span order
    // and every derived id list follow it, so a shuffle would recompile pixels.
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'chest-opening', 'flower-blossoming']);
    expect(getEffectiveAnimationTracks()[WALK_TRACK]).toEqual(ANIMATION_TRACKS[WALK_TRACK]);
  });

  it('marks a stored row user-defined even when the row claims otherwise', () => {
    // FORCED, not read. A row claiming `builtin: true` would otherwise pass the
    // "builtin rows carry no promptTemplate" guard by shedding its prompt, then
    // throw at generate time with no compiled builder to fall back to.
    writeTracks([{ ...userRow(), builtin: true }]);
    expect(getEffectiveAnimationTracks()['chest-opening'].builtin).toBe(false);
  });

  it('validates the merged table, so a row that collides WITH WALK is refused', () => {
    // The invariant a per-row check would miss: this row is internally fine and
    // only conflicts across rows. Claiming walk's contract field would make
    // `resolveAnimationTarget` read walk's `walkFrameCount` for this track and
    // return it as a locked value, citing a binding that never mentioned it.
    writeTracks([userRow({ contractFrameCountField: 'walkFrameCount' })]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/claimed by both/);
  });

  it('refuses a stored row that collides with another stored row\'s on-disk kind', () => {
    writeTracks([userRow(), userRow({
      id: 'second',
      contractFrameCountField: 'secondFrameCount',
      // Same setKind as the first row: the compiler validates a finalized set BY
      // its kind, so a duplicate lets one track's set satisfy the other's
      // evidence check and compile the wrong frames into its span.
      selectionKind: 'reviewed-second-selection',
      standaloneContract: false,
    })]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/finalized-chest-opening-set/);
  });

  it('refuses a stored row missing its promptTemplate', () => {
    // There is no compiled builder for a stored row, so a blank template would
    // surface as a throw only AFTER the user clicked generate.
    const { promptTemplate, ...noPrompt } = userRow();
    expect(promptTemplate).toBeTruthy();
    writeTracks([noPrompt]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/needs a non-empty 'promptTemplate'/);
    __resetAnimationTrackStore();
    writeTracks([userRow({ promptTemplate: '   ' })]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/needs a non-empty 'promptTemplate'/);
  });

  it('refuses a stored row that redefines walk', () => {
    // Walk's bounds feed the Zod schemas and its setKind gates every character
    // compile, so a data edit must not be able to replace it.
    writeTracks([userRow({ id: WALK_TRACK })]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/mandatory built-in/);
  });

  it('refuses a duplicate stored id rather than letting the last one win', () => {
    writeTracks([userRow(), userRow({ label: 'A different label' })]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/defined twice/);
  });

  it('refuses a stored row with no usable id', () => {
    writeTracks([{ ...userRow(), id: '' }]);
    expect(() => getEffectiveAnimationTracks()).toThrow(/non-empty string id/);
  });
});

describe('absent vs. empty vs. corrupt (the sentinel rules)', () => {
  it('falls back to the shipped seed when the user copy is absent', () => {
    // The upgrade path's safety net: module load happens BEFORE boot migrations,
    // so on the first boot after #3152 there is no user copy yet. Without this,
    // that boot would build a contract schema with no `scannerFrameCount` and
    // refuse to compile an already-approved scanner set.
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'scanner', 'ambient']);
    expect(animationTrackSeedPath()).toMatch(/data\.reference[/\\]sprites[/\\]animation-tracks\.json$/);
  });

  it('treats an EXISTING store as authoritative — the seed is not merged in', () => {
    // What makes a deletion stick. A user who removed `scanner` must not have it
    // resurrected from the seed on the next read.
    writeTracks([userRow()]);
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'chest-opening']);
    expect(getEffectiveAnimationTracks().scanner).toBeUndefined();
  });

  it('treats an empty tracks array as "the user deleted everything", not as absent', () => {
    // `[]` is a legitimate state — walk alone — and must NOT fall through to the
    // seed, which would make deleting every track impossible.
    writeTracks([]);
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK]);
  });

  it('throws on an unreadable store rather than silently reverting to the seed', () => {
    // The sentinel rule that matters most: a user whose hand edit broke the JSON
    // must get an error naming the file, not a silent revert to shipped defaults
    // that reads as "my tracks vanished".
    writeStore('{ "tracks": [ oops ');
    expect(() => getEffectiveAnimationTracks()).toThrow(/is not valid JSON/);
  });

  it('reports a real IO failure with the path named', () => {
    // A store that exists but cannot be read is a real user-facing problem, so it
    // must throw naming the file rather than silently serving shipped defaults —
    // the same sentinel rule as the unparseable case above. Provoked with a
    // directory where a file is expected, which produces a genuine errno (EISDIR).
    mkdirSync(STORE_PATH, { recursive: true });
    try {
      expect(() => getEffectiveAnimationTracks()).toThrow(/cannot read/);
    } finally {
      rmSync(STORE_PATH, { recursive: true, force: true });
    }
  });

  it('degrades to walk alone when the read never reached a filesystem', () => {
    // Why this matters: `server/lib/validation.js` builds its sprite Zod ranges from
    // the effective registry at MODULE LOAD, and nearly every route and service
    // imports validation.js — so this store gets resolved inside suites that have
    // nothing to do with sprites, including ones that stub `fs` with a partial
    // factory (`vi.mock('fs', () => ({ existsSync }))`). Such a read throws a
    // TypeError with NO errno; classifying that as "no store" is what keeps those
    // suites from failing at import time over a file they never asked about, and it
    // cannot mask a real install problem because an install always has `fs`.
    //
    // Asserted on the classifier rather than by re-mocking `fs` here: the store
    // binds `readFileSync` at import, so a namespace spy in this file would not
    // intercept it and the test would pass without exercising anything.
    expect(classifyStoreReadError(new TypeError('readFileSync is not a function'))).toBe('no-filesystem');
    expect(classifyStoreReadError(Object.assign(new Error('nope'), { code: 'EACCES' }))).toBe('io-error');
    expect(classifyStoreReadError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe('absent');
  });
});

describe('the cache', () => {
  it('reads once per process and re-reads after a reset', () => {
    writeTracks([userRow()]);
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'chest-opening']);

    // A write with no reset must NOT take effect — that is the documented
    // restart boundary, and it is what keeps a compile from validating spans
    // against a table the render that produced them never saw.
    writeTracks([userRow({
      id: 'other',
      contractFrameCountField: 'otherFrameCount',
      selectionKind: 'reviewed-other-selection',
      setKind: 'finalized-other-set',
      finalErrorCode: 'OTHER_SET_FINAL',
    })]);
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'chest-opening']);

    __resetAnimationTrackStore();
    expect(getEffectiveAnimationTrackIds()).toEqual([WALK_TRACK, 'other']);
  });

  it('returns the identical frozen table object on repeat calls', () => {
    writeTracks([userRow()]);
    const first = getEffectiveAnimationTracks();
    expect(getEffectiveAnimationTracks()).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => { first['chest-opening'].minFrameCount = 1; }).toThrow();
  });
});
