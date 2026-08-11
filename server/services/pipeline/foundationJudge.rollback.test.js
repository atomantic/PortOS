/**
 * Foundation rollback fidelity — verified against the REAL universe write path.
 *
 * The main `foundationJudge.test.js` suite stubs `updateUniverse` with a shallow
 * merge, so it cannot see what actually stalled the gate in production: undoing a
 * character repair is ITSELF a content change, and the real `updateUniverse`
 * re-stamps `updatedAt` on every canon entry whose content changed (the
 * canon→catalog LWW clock). A byte-comparison of the checkpoint therefore failed
 * on a perfectly faithful revert, and the autopilot paused with
 * "checkpoint verification failed after rollback" every single time a character
 * repair was rolled back.
 *
 * These tests run the checkpoint/restore round-trip through the actual
 * universeBuilder store (file-backed, in a per-suite tmpdir) so the write path's
 * stamping and pointer-preservation behavior is exercised, not re-implemented.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'foundation-rollback-test-'));

vi.mock('../../lib/fileUtils.js', async (importActual) => {
  const actual = await importActual();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
    // Every sheet filename "exists" so mergePreservedSheetPointers takes its
    // preserve branch — the behavior this suite asserts the comparison tolerates.
    resolveImageRef: vi.fn((ref) => (typeof ref === 'string' && ref ? `/mock/refs/${ref}` : null)),
  };
});
vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

// Everything the foundation judge needs but this round-trip doesn't exercise.
vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn(),
  resolveStageContext: vi.fn(async () => ({ contextWindow: 200_000 })),
  resolveJudgeForStage: vi.fn(async () => ({ provider: { id: 'judge-x' }, model: 'jm-heavy' })),
}));
vi.mock('../promptService.js', () => ({ getStage: vi.fn(() => ({ name: 'writer' })) }));
vi.mock('./issues.js', async (importActual) => ({
  ...(await importActual()),
  listIssues: vi.fn(async () => []),
}));
vi.mock('./seriesCanon.js', async (importActual) => ({
  ...(await importActual()),
  getSeriesCanon: vi.fn(async () => ({ characters: [] })),
}));
vi.mock('./arcPlanner.js', async (importActual) => ({
  ...(await importActual()),
  restoreArcState: vi.fn(async () => ({ restored: true, episodesRestored: 0 })),
  snapshotArcState: vi.fn(async () => ({ seriesId: 'ser-1', arc: null, seasons: [], episodes: [] })),
}));

// In-memory series record — the series store isn't what's under test here; the
// universe canon write path is.
let seriesState = null;
vi.mock('./series.js', async (importActual) => ({
  ...(await importActual()),
  getSeries: vi.fn(async () => structuredClone(seriesState)),
  updateSeries: vi.fn(async (_id, patch) => {
    seriesState = { ...seriesState, ...structuredClone(patch) };
    return structuredClone(seriesState);
  }),
}));

// Imported after the mocks (which are hoisted above the TEST_DATA_ROOT literal)
// so the mocked `PATHS.data` is in place before the store modules read it.
const { BIBLE_KEYS } = await import('../../lib/storyBible.js');
const { createUniverse, getUniverse, updateUniverse, PREMISE_MAX } = await import('../universeBuilder.js');
const {
  snapshotFoundationState,
  restoreFoundationState,
  __testing,
} = await import('./foundationJudge.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const CAST = [
  {
    name: 'Example Lead',
    role: 'protagonist',
    want: 'to reopen the gateway network',
    need: 'to stop bargaining with the dead',
    referenceSheetImageRef: 'lead-sheet.png',
    imageRefs: ['lead-1.png'],
  },
  { name: 'Example Rival', role: 'antagonist', want: 'to keep the gates shut', need: 'to be believed' },
];

async function seedFoundation() {
  const universe = await createUniverse({
    name: `Example Universe ${Math.random().toString(36).slice(2, 8)}`,
    logline: 'world before',
    premise: 'rules before',
    styleNotes: 'style before',
    influences: { embrace: ['Example'], avoid: [] },
    characters: CAST,
    places: [{ name: 'Example Gatehouse', description: 'a shuttered relay station', imageRefs: ['gate-1.png'] }],
  });
  seriesState = {
    id: 'ser-1',
    universeId: universe.id,
    styleNotes: 'voice before',
    styleGuide: null,
    characterArcs: [{ characterName: 'Example Lead', want: 'to reopen the network', status: 'draft' }],
  };
  return universe;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('restoreFoundationState — against the real universe write path', () => {
  it('reports a character rollback as restored even though the write path re-stamps updatedAt', async () => {
    const universe = await seedFoundation();
    const checkpoint = await snapshotFoundationState('ser-1');

    // What a character repair does: rewrite the framework fields of the existing
    // cast through the mutator form, and add a character the judge asked for.
    await updateUniverse(universe.id, (latest) => ({
      characters: [
        ...latest.characters.map((c) => ({ ...c, need: `${c.need} (rewritten by the repair)` })),
        { name: 'Example Confidant', role: 'supporting', want: 'to be trusted', need: 'to trust' },
      ],
    }));
    seriesState = {
      ...seriesState,
      characterArcs: [
        ...seriesState.characterArcs,
        { characterName: 'Example Confidant', want: 'a seat at the table', status: 'draft' },
      ],
    };

    const rollback = await restoreFoundationState('ser-1', checkpoint);

    expect(rollback).toMatchObject({ restored: true, mismatchedFields: [] });
    expect(rollback.reason).toBeNull();

    const after = await getUniverse(universe.id);
    expect(after.characters.map((c) => c.name)).toEqual(['Example Lead', 'Example Rival']);
    expect(after.characters.map((c) => c.need)).toEqual([
      'to stop bargaining with the dead',
      'to be believed',
    ]);
    expect(seriesState.characterArcs).toHaveLength(1);

    // The reason the naive byte-comparison failed: the revert legitimately moved
    // the LWW clock forward on every entry it changed back.
    const beforeStamp = checkpoint.universe.characters.find((c) => c.name === 'Example Lead').updatedAt;
    const afterStamp = after.characters.find((c) => c.name === 'Example Lead').updatedAt;
    expect(Date.parse(afterStamp)).toBeGreaterThan(Date.parse(beforeStamp));
  });

  it('still reports a mismatch — naming the field — when authored content does not come back', async () => {
    const universe = await seedFoundation();
    const checkpoint = await snapshotFoundationState('ser-1');
    // A checkpoint the write path provably cannot reproduce: an over-cap premise
    // comes back truncated by the sanitizer, so the restored record legitimately
    // differs from what was asked for — exactly the case the check exists for.
    const corrupted = structuredClone(checkpoint);
    corrupted.universe.premise = 'x'.repeat(PREMISE_MAX + 100);

    const rollback = await restoreFoundationState('ser-1', corrupted);

    expect(rollback.restored).toBe(false);
    expect(rollback.mismatchedFields).toContain('universe.premise');
    expect(rollback.reason).toContain('universe.premise');
    // Untouched fields stay out of the diagnosis so the pause names one thing.
    expect(rollback.mismatchedFields).not.toContain('universe.characters');
    await getUniverse(universe.id);
  });

  it('ignores only the write-path-owned canon fields, not authored ones', () => {
    const { mismatchedFoundationFields, CANON_WRITE_PATH_OWNED_FIELDS } = __testing;
    const entry = {
      id: 'chr-1', name: 'Example Lead', need: 'trust',
      updatedAt: '2026-01-01T00:00:00.000Z',
      referenceSheetImageRef: 'a.png', referenceSheets: { front: 'f.png' }, imageRefs: ['a.png'],
    };
    const snap = (character) => ({
      universeId: 'uni-1',
      universe: { logline: 'L', premise: 'P', styleNotes: 'S', influences: {}, characters: [character] },
      series: { styleNotes: 'V', styleGuide: null, characterArcs: [] },
      arcState: { arc: null, seasons: [], episodes: [] },
    });

    // Every owned field differing → still a faithful restore.
    const volatile = {
      ...entry,
      updatedAt: '2026-08-11T12:00:00.000Z',
      referenceSheetImageRef: 'b.png', referenceSheets: { front: 'g.png' }, imageRefs: ['a.png', 'b.png'],
    };
    expect(CANON_WRITE_PATH_OWNED_FIELDS).toContain('updatedAt');
    expect(mismatchedFoundationFields(snap(entry), snap(volatile))).toEqual([]);

    // An authored field differing → still caught.
    expect(mismatchedFoundationFields(snap(entry), snap({ ...volatile, need: 'something else' })))
      .toEqual(['universe.characters']);
  });

  it('strips the write-path-owned fields from EVERY canon array, not just characters', () => {
    const { comparableUniverseFields } = __testing;
    const owned = {
      updatedAt: '2026-01-01T00:00:00.000Z',
      referenceSheetImageRef: 'a.png',
      referenceSheets: { front: 'f.png' },
      imageRefs: ['a.png'],
    };
    // No `characters` key at all — the old `characters`-only guard bailed out
    // here and returned every other canon array with its owned fields intact.
    const universe = {
      logline: 'L',
      ...Object.fromEntries(BIBLE_KEYS
        .filter((key) => key !== 'characters')
        .map((key) => [key, [{ id: `${key}-1`, name: `Example ${key}`, ...owned }]])),
    };

    const comparable = comparableUniverseFields(universe);

    expect(comparable.logline).toBe('L');
    for (const key of BIBLE_KEYS.filter((k) => k !== 'characters')) {
      expect(Object.keys(comparable[key][0]).sort()).toEqual(['id', 'name']);
    }
  });

  it('tolerates the write path re-stamping a NON-character canon entry', async () => {
    const universe = await seedFoundation();
    const before = await getUniverse(universe.id);

    // A worldbuilding repair rewriting an existing place — the same shape of
    // edit a character repair makes, on the canon array the character-only
    // stripping used to miss.
    await updateUniverse(universe.id, (latest) => ({
      places: latest.places.map((p) => ({ ...p, description: `${p.description} (rewritten by the repair)` })),
    }));
    // ...and the faithful undo, which is itself a content change.
    await updateUniverse(universe.id, () => ({ places: structuredClone(before.places) }));
    const after = await getUniverse(universe.id);

    const { comparableUniverseFields } = __testing;
    // Authored content came back byte-for-byte once the owned fields are gone.
    expect(comparableUniverseFields(after).places).toEqual(comparableUniverseFields(before).places);
    // ...and the reason a raw comparison would have failed: the LWW clock moved.
    expect(Date.parse(after.places[0].updatedAt))
      .toBeGreaterThan(Date.parse(before.places[0].updatedAt));
  });

  it('distinguishes an absent checkpoint field from a null one', () => {
    const { mismatchedFoundationFields } = __testing;
    const base = {
      universeId: 'uni-1',
      universe: { logline: 'L', premise: 'P', styleNotes: 'S', influences: {}, characters: [] },
      arcState: { arc: null, seasons: [], episodes: [] },
    };
    // Checkpoint never carried a styleGuide (the restore skips absent fields), but
    // the repair added one — an unrevertable leftover the verification must catch.
    const checkpoint = { ...base, series: { styleNotes: 'V', characterArcs: [] } };
    const after = { ...base, series: { styleNotes: 'V', styleGuide: null, characterArcs: [] } };
    expect(mismatchedFoundationFields(checkpoint, after)).toEqual(['series.styleGuide']);
  });
});
