/**
 * Runtime atlas compiler (#2898): evidence-chain validation (walk set,
 * selection, run manifests, frame + anchor sha256s), the geometry contract
 * (9×8 grid, per-direction single scale, pivot ground line), immutable
 * versioning, and compile idempotency. Fixtures lock a real reference set
 * (real normalize + chroma-key selection) and hand-write the walk artifacts
 * with a correct hash chain.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile, readFile, rm } from 'fs/promises';
import { createHash } from 'crypto';
import { lockAllAnchors as lockAllAnchorsFixture, placeCandidate, trackSpan as fullSpan } from './spriteTestFixtures.js';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-atlas-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
    images: join(TEST_ROOT, 'images'),
  });
  return actual;
});

vi.mock('../imageGen/index.js', () => ({
  resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }),
}));
vi.mock('../settings.js', () => ({
  getSettings: async () => ({ imageGen: { mode: 'codex' } }),
}));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: () => ({ jobId: 'job-1', position: 0, status: 'queued' }),
  mediaJobEvents: { on: () => {}, off: () => {} },
}));

const records = await import('./records.js');
const { lockReference, loadManifest } = await import('./reference.js');
const { compileAtlas, getAtlasState, ATLAS_COLUMNS, DEFAULT_ATLAS_GEOMETRY } = await import('./atlas.js');
const { SPRITE_DIRECTIONS } = await import('./prompts.js');
const { WALK_PHASES, walkPhaseLabels, WALK_FPS } = await import('./walkPostprocess.js');
const { buildAtlasGrid, compiledGridUpToDate } = await import('./atlasGrid.js');
const { getAnimationTrack, SCANNER_TRACK, AMBIENT_TRACK } = await import('./animationTracks.js');
// #3152 — `scanner`/`ambient` are seeded STORE rows, so the compiler's real table
// is the merge. Resolved once; the store caches its read.
const {
  getEffectiveAnimationTracks, __resetAnimationTrackStore,
  animationTrackStorePath, animationTrackSeedPath,
} = await import('./animationTrackStore.js');
const EFFECTIVE_TRACKS = getEffectiveAnimationTracks();

let seq = 0;
const newId = () => `atlas-char-${++seq}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function lockAllAnchors(id) {
  await records.createRecord({ kind: 'character', name: 'Atlas Walker' }, id);
  await lockAllAnchorsFixture(TEST_ROOT, id, { lockReference, directions: SPRITE_DIRECTIONS });
}

/** Transparent 40×40 RGBA frame with an opaque 20×30 figure. */
/**
 * `armX` (optional) adds a protruding block at that column — a stand-in for a
 * swinging limb, so a direction's frames differ in SILHOUETTE and not just in
 * tint. Registration bugs (#3021) only show up across differing silhouettes:
 * with the identical-shape default, every placement rule agrees and an
 * inter-cell assertion would pass vacuously.
 */
async function walkFramePng(path, tint, armX = null, speck = false) {
  const w = 40; const h = 40;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 5; y < 35; y++) {
    for (let x = 10; x < 30; x++) {
      buf.set([tint, 107, 101, 255], (y * w + x) * 4);
    }
  }
  if (armX !== null) {
    for (let y = 12; y < 20; y++) {
      for (let x = armX; x < armX + 6; x++) buf.set([tint, 107, 101, 255], (y * w + x) * 4);
    }
  }
  // A lone opaque pixel below the sole — the despill survivor / dropped shadow
  // that used to drag the whole frame's grounding down with it.
  if (speck) buf.set([tint, 107, 101, 255], (35 * w + 20) * 4);
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
}

async function buildFinalizedWalkSet(recordId, {
  frameCount = WALK_PHASES.length, fps, varyArm = false, alignment = null, speckFrames = [],
} = {}) {
  const manifest = await loadManifest(recordId);
  const chromaKey = manifest.chromaKey;
  const dir = join(TEST_ROOT, 'sprites', recordId);
  const labels = walkPhaseLabels(frameCount);
  const selection = {
    schemaVersion: 1,
    kind: 'reviewed-directional-walk-selection',
    characterId: recordId,
    status: 'complete',
    directions: {},
  };
  for (const direction of SPRITE_DIRECTIONS) {
    const runId = `walk-${direction}-${(seq++).toString(16).padStart(8, '0')}`;
    const generatedRel = `grok/${runId}/generated`;
    const frames = [];
    for (let i = 0; i < labels.length; i++) {
      const name = `${String(i).padStart(2, '0')}-${labels[i]}.png`;
      const rel = `${generatedRel}/frames/${name}`;
      await walkFramePng(join(dir, rel), 20 + i * 8, varyArm ? 2 + (i % 4) * 2 : null, speckFrames.includes(i));
      frames.push({
        outputIndex: i,
        phase: labels[i],
        path: rel,
        sha256: sha256(await readFile(join(dir, rel))),
      });
    }
    const runManifest = {
      schemaVersion: 1,
      kind: 'deterministically-packaged-grok-walk-video',
      characterId: recordId,
      direction,
      chromaKey,
      frameCount,
      ...(fps != null ? { frameRate: fps } : {}),
      ...(alignment ? { alignment } : {}),
      frames,
    };
    const manifestRel = `${generatedRel}/${recordId}-walk-${direction}-manifest.json`;
    const manifestBytes = JSON.stringify(runManifest);
    await writeFile(join(dir, manifestRel), manifestBytes);
    selection.directions[direction] = {
      status: 'approved',
      runId,
      runPath: `grok/${runId}`,
      runManifest: manifestRel,
      runManifestSha256: sha256(Buffer.from(manifestBytes)),
      approvedAt: new Date().toISOString(),
    };
  }
  await mkdir(join(dir, 'walk'), { recursive: true });
  const selectionRel = `walk/${recordId}-walk-selection-v1.json`;
  const selectionBytes = JSON.stringify(selection);
  await writeFile(join(dir, selectionRel), selectionBytes);
  const walkSet = {
    schemaVersion: 1,
    kind: 'finalized-eight-direction-walk-set',
    characterId: recordId,
    status: 'final',
    directionOrder: SPRITE_DIRECTIONS,
    selectionPath: selectionRel,
    selectionSha256: sha256(Buffer.from(selectionBytes)),
    directions: selection.directions,
    finalizedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, `walk/${recordId}-walk-set-v1.json`), JSON.stringify(walkSet));
  return { walkSet, selection };
}

async function buildFinalizedScannerSet(recordId, {
  frameCount = 4,
  fps = 6,
  trackId = SCANNER_TRACK,
  selectionKind = 'reviewed-directional-scanner-selection',
  setKind = 'finalized-eight-direction-scanner-set',
} = {}) {
  const manifest = await loadManifest(recordId);
  const dir = join(TEST_ROOT, 'sprites', recordId);
  const labels = Array.from({ length: frameCount }, (_, i) => `${trackId}-${String(i).padStart(2, '0')}`);
  const selection = {
    schemaVersion: 1,
    kind: selectionKind,
    track: trackId,
    characterId: recordId,
    status: 'complete',
    directions: {},
  };
  for (const direction of SPRITE_DIRECTIONS) {
    const runId = `${trackId}-${direction}-${(seq++).toString(16).padStart(8, '0')}`;
    const generatedRel = `runs/${runId}/generated`;
    const frames = [];
    for (let i = 0; i < labels.length; i++) {
      const rel = `${generatedRel}/frames/${String(i).padStart(2, '0')}-${labels[i]}.png`;
      await walkFramePng(join(dir, rel), 36 + i * 12, 2 + i * 2);
      frames.push({ outputIndex: i, phase: labels[i], path: rel, sha256: sha256(await readFile(join(dir, rel))) });
    }
    const runManifest = {
      schemaVersion: 1,
      kind: `deterministically-packaged-grok-${trackId}-video`,
      track: trackId,
      characterId: recordId,
      direction,
      chromaKey: manifest.chromaKey,
      frameCount,
      frameRate: fps,
      frames,
    };
    const manifestRel = `${generatedRel}/${recordId}-${trackId}-${direction}-manifest.json`;
    const manifestBytes = JSON.stringify(runManifest);
    await writeFile(join(dir, manifestRel), manifestBytes);
    selection.directions[direction] = {
      status: 'approved', runId, runPath: `runs/${runId}`, runManifest: manifestRel,
      runManifestSha256: sha256(Buffer.from(manifestBytes)), approvedAt: new Date().toISOString(),
    };
  }
  await mkdir(join(dir, trackId), { recursive: true });
  const selectionRel = `${trackId}/${recordId}-${trackId}-selection-v1.json`;
  const selectionBytes = JSON.stringify(selection);
  await writeFile(join(dir, selectionRel), selectionBytes);
  await writeFile(join(dir, `${trackId}/${recordId}-${trackId}-set-v1.json`), JSON.stringify({
    schemaVersion: 1,
    kind: setKind,
    track: trackId,
    characterId: recordId,
    status: 'final',
    directionOrder: SPRITE_DIRECTIONS,
    selectionPath: selectionRel,
    selectionSha256: sha256(Buffer.from(selectionBytes)),
    directions: selection.directions,
    finalizedAt: new Date().toISOString(),
  }));
}

async function finalizedAmbientPlace() {
  const id = `atlas-ambient-${++seq}`;
  await records.createRecord({ kind: 'place', name: 'Willow' }, id);
  const candidate = await placeCandidate(TEST_ROOT, id, 'main', 'main-candidate-01.png');
  await lockReference(id, { target: 'main', candidate });
  const manifest = await loadManifest(id);
  const dir = join(TEST_ROOT, 'sprites', id);
  const runId = `${AMBIENT_TRACK}-${(seq++).toString(16).padStart(8, '0')}`;
  const frameCount = 3;
  const frames = [];
  for (let i = 0; i < frameCount; i++) {
    const phase = `${AMBIENT_TRACK}-${String(i).padStart(2, '0')}`;
    const rel = `runs/${runId}/generated/frames/${String(i).padStart(2, '0')}-${phase}.png`;
    await walkFramePng(join(dir, rel), 30 + i * 20, 2 + i * 3);
    frames.push({ outputIndex: i, phase, path: rel, sha256: sha256(await readFile(join(dir, rel))) });
  }
  const runManifest = {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-ambient-video',
    track: AMBIENT_TRACK,
    characterId: id,
    direction: 'south',
    chromaKey: manifest.chromaKey,
    frameCount,
    frameRate: 4,
    frames,
  };
  const runManifestRel = `runs/${runId}/generated/${id}-${AMBIENT_TRACK}-manifest.json`;
  const runManifestBytes = JSON.stringify(runManifest);
  await writeFile(join(dir, runManifestRel), runManifestBytes);
  const selection = {
    schemaVersion: 1,
    kind: 'reviewed-single-row-ambient-selection',
    track: AMBIENT_TRACK,
    characterId: id,
    status: 'complete',
    directions: {
      south: {
        status: 'approved', runId, runPath: `runs/${runId}`, runManifest: runManifestRel,
        runManifestSha256: sha256(Buffer.from(runManifestBytes)), approvedAt: new Date().toISOString(),
      },
    },
  };
  await mkdir(join(dir, AMBIENT_TRACK), { recursive: true });
  const selectionRel = `${AMBIENT_TRACK}/${id}-ambient-selection-v1.json`;
  const selectionBytes = JSON.stringify(selection);
  await writeFile(join(dir, selectionRel), selectionBytes);
  await writeFile(join(dir, `${AMBIENT_TRACK}/${id}-ambient-set-v1.json`), JSON.stringify({
    schemaVersion: 1,
    kind: 'finalized-single-row-ambient-set',
    track: AMBIENT_TRACK,
    characterId: id,
    status: 'final',
    directionOrder: ['south'],
    selectionPath: selectionRel,
    selectionSha256: sha256(Buffer.from(selectionBytes)),
    directions: selection.directions,
    finalizedAt: new Date().toISOString(),
  }));
  return id;
}

async function finalizedCharacter() {
  const id = newId();
  await lockAllAnchors(id);
  await buildFinalizedWalkSet(id);
  return id;
}

beforeEach(() => {
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, {
  recursive: true,
  force: true,
  // Windows can briefly retain Sharp's image handles after toBuffer resolves.
  maxRetries: 10,
  retryDelay: 100,
}));

describe('compileAtlas', () => {
  it('compiles an ambient-only atlas with one occupied row and transparent unused rows', async () => {
    const id = await finalizedAmbientPlace();
    const result = await compileAtlas(id);
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    expect(manifest.kind).toBe('reviewed-ambient-set-runtime-atlas');
    expect(manifest.geometry).toMatchObject({
      columns: ['idle', 'ambient-00', 'ambient-01', 'ambient-02'],
      tracks: { idle: { start: 0, count: 1, rows: 1 }, ambient: { start: 1, count: 3, rows: 1 } },
      walkFrameCount: null,
      ambientFrameCount: 3,
    });
    expect(manifest.directions).toHaveLength(1);
    expect(manifest.directions[0].cells).toHaveLength(4);
    const pixels = await sharp(join(TEST_ROOT, 'sprites', id, result.atlasPath)).raw().toBuffer();
    const width = DEFAULT_ATLAS_GEOMETRY.cellSize * 4;
    const rowOneAlpha = pixels[(DEFAULT_ATLAS_GEOMETRY.cellSize * width * 4) + 3];
    expect(rowOneAlpha).toBe(0);
  });

  it('compiles an approved four-frame scanner span beside the walk span', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { frameCount: 12, fps: 10 });
    await buildFinalizedScannerSet(id);
    const result = await compileAtlas(id);
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    expect(manifest.geometry.columns).toEqual([
      'idle', ...walkPhaseLabels(12), 'scanner-00', 'scanner-01', 'scanner-02', 'scanner-03',
    ]);
    expect(manifest.geometry.tracks.scanner).toMatchObject({ start: 13, count: 4, rows: 8 });
    expect(manifest.geometry.scannerFrameCount).toBe(4);
    expect(manifest.scannerSetSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const row of manifest.directions) {
      expect(row.cells.filter((cell) => cell.column.startsWith('scanner-'))).toHaveLength(4);
    }
  });

  // #3152's stated "regression that matters": `scanner`/`ambient` stopped being
  // compiled rows and became rows in `data/sprites/animation-tracks.json`. The two
  // cases above prove the PRE-migration state compiles (no store file → the
  // data.reference seed answers). These prove the POST-migration state does too,
  // with a real user-owned store on disk — the shape every upgraded install runs,
  // and the one where a broken store→registry hand-off surfaces as "unknown
  // animation track 'scanner'" on a record that compiled fine yesterday.
  describe('after migration 211 materializes the user-owned store (#3152)', () => {
    // A byte copy of the shipped seed, exactly as the migration writes it — so this
    // asserts the migration's OUTPUT is sufficient, not merely that some
    // hand-written store works.
    // Paths come from the store's own exports rather than a hand-walked `../../..`:
    // the PATHS mock above leaves `PATHS.root` real, so `animationTrackSeedPath()`
    // and `animationTrackStorePath()` resolve exactly where the migration reads and
    // writes — and a future relocation of either file moves both at once.
    const installUserStore = async () => {
      await mkdir(join(TEST_ROOT, 'sprites'), { recursive: true });
      await writeFile(animationTrackStorePath(), await readFile(animationTrackSeedPath(), 'utf-8'));
      __resetAnimationTrackStore();
    };
    // Restore the seed-fallback state the rest of this file compiles under, so
    // ordering between suites can't matter.
    afterEach(async () => {
      await rm(animationTrackStorePath(), { force: true });
      __resetAnimationTrackStore();
    });

    it('still compiles an approved scanner set beside the walk span', async () => {
      const id = newId();
      await lockAllAnchors(id);
      await buildFinalizedWalkSet(id, { frameCount: 12, fps: 10 });
      await buildFinalizedScannerSet(id);
      await installUserStore();

      const result = await compileAtlas(id);
      const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
      // Identical geometry to the compiled-row era: span order, column labels and
      // frame count all still resolve from the (now stored) row.
      expect(manifest.geometry.columns).toEqual([
        'idle', ...walkPhaseLabels(12), 'scanner-00', 'scanner-01', 'scanner-02', 'scanner-03',
      ]);
      expect(manifest.geometry.tracks.scanner).toMatchObject({ start: 13, count: 4, rows: 8 });
      expect(manifest.geometry.scannerFrameCount).toBe(4);
    });

    it('still compiles an approved ambient loop for a place record', async () => {
      const id = await finalizedAmbientPlace();
      await installUserStore();

      const result = await compileAtlas(id);
      const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
      // The compile dispatch runs off `primaryTrackForKind('place')`/`tracksForKind`,
      // now answered by a STORED row — a compiled-table lookup there finds no track
      // for `place` and refuses the compile outright on a record that has one.
      expect(manifest.kind).toBe('reviewed-ambient-set-runtime-atlas');
      expect(manifest.geometry).toMatchObject({
        columns: ['idle', 'ambient-00', 'ambient-01', 'ambient-02'],
        ambientFrameCount: 3,
      });
    });
  });

  it('compiles and invalidates on a synthetic third registry track without compiler changes', async () => {
    const trackId = 'jetpack';
    // #3152 — built off the EFFECTIVE table: `scanner` is a stored row now, so
    // `ANIMATION_TRACKS[SCANNER_TRACK]` is undefined and spreading it would
    // silently produce a row with no bounds at all.
    const customTracks = {
      ...EFFECTIVE_TRACKS,
      [trackId]: {
        ...EFFECTIVE_TRACKS[SCANNER_TRACK],
        id: trackId,
        label: 'Jetpack burst',
        contractFrameCountField: 'jetpackFrameCount',
        selectionKind: 'reviewed-directional-jetpack-selection',
        setKind: 'finalized-eight-direction-jetpack-set',
        finalErrorCode: 'JETPACK_SET_FINAL',
      },
    };
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { frameCount: 8, fps: 10 });
    await buildFinalizedScannerSet(id, {
      trackId,
      frameCount: 3,
      selectionKind: customTracks[trackId].selectionKind,
      setKind: customTracks[trackId].setKind,
    });

    const first = await compileAtlas(id, { tracks: customTracks });
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, first.manifestPath), 'utf8'));
    expect(manifest.geometry.columns).toEqual([
      'idle', ...WALK_PHASES, 'jetpack-00', 'jetpack-01', 'jetpack-02',
    ]);
    expect(manifest.geometry.tracks.jetpack).toEqual({ start: 9, count: 3, rows: 8 });
    expect(manifest.geometry.jetpackFrameCount).toBe(3);
    expect(manifest.trackSets.jetpack.setSha256).toMatch(/^[0-9a-f]{64}$/);
    for (const row of manifest.directions) {
      expect(row.cells.filter((cell) => cell.column.startsWith('jetpack-'))).toHaveLength(3);
    }

    // A pre-#3223 pointer has the generic span but no top-level convenience
    // field. Recompile the immutable metadata into a new version even though
    // its atlas pixels and finalized track sets are unchanged.
    const pointerAbs = join(TEST_ROOT, 'sprites', id, 'runtime/current.json');
    const legacyPointer = JSON.parse(await readFile(pointerAbs, 'utf8'));
    const legacyManifestAbs = join(TEST_ROOT, 'sprites', id, first.manifestPath);
    const legacyManifest = JSON.parse(await readFile(legacyManifestAbs, 'utf8'));
    delete legacyManifest.geometry.jetpackFrameCount;
    const legacyManifestBytes = Buffer.from(`${JSON.stringify(legacyManifest, null, 2)}\n`);
    await writeFile(legacyManifestAbs, legacyManifestBytes);
    delete legacyPointer.geometry.jetpackFrameCount;
    legacyPointer.manifestSha256 = sha256(legacyManifestBytes);
    await writeFile(pointerAbs, JSON.stringify(legacyPointer));
    await rm(join(TEST_ROOT, 'sprites', id, first.atlasPath));
    const backfilled = await compileAtlas(id, { tracks: customTracks });
    expect(backfilled.created).toBe(true);
    expect(backfilled.version).toBe(first.version + 1);
    const backfilledManifest = JSON.parse(
      await readFile(join(TEST_ROOT, 'sprites', id, backfilled.manifestPath), 'utf8'),
    );
    expect(backfilledManifest.geometry.jetpackFrameCount).toBe(3);

    const unchanged = await compileAtlas(id, { tracks: customTracks });
    expect(unchanged.created).toBe(false);

    // A finalized set is part of the evidence identity even when its frame
    // bytes are unchanged. Any track's set change must invalidate the pointer,
    // not just the historical walk/scanner/ambient fields.
    const setAbs = join(TEST_ROOT, 'sprites', id, `${trackId}/${id}-${trackId}-set-v1.json`);
    const set = JSON.parse(await readFile(setAbs, 'utf8'));
    await writeFile(setAbs, JSON.stringify({ ...set, note: 're-finalized' }));
    const changed = await compileAtlas(id, { tracks: customTracks });
    expect(changed.created).toBe(true);
    expect(changed.version).toBe(backfilled.version + 1);
  });

  it('compiles the 9×8 player atlas with full provenance and a current pointer', async () => {
    const id = await finalizedCharacter();
    const result = await compileAtlas(id);

    expect(result.created).toBe(true);
    expect(result.version).toBe(1);
    expect(result.atlasPath).toBe(`runtime/v1/${id}-animation-atlas-v1.png`);

    const atlasAbs = join(TEST_ROOT, 'sprites', id, result.atlasPath);
    const meta = await sharp(atlasAbs).metadata();
    expect(meta.width).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * ATLAS_COLUMNS.length);
    expect(meta.height).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * SPRITE_DIRECTIONS.length);
    expect(sha256(await readFile(atlasAbs))).toBe(result.atlasSha256);

    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    expect(manifest.kind).toBe('reviewed-walk-set-runtime-atlas');
    // idle + 8 walk phases — no trailing scanner placeholder (#2986).
    expect(manifest.geometry.columns).toEqual(['idle', ...WALK_PHASES]);
    expect(manifest.geometry.directionOrder).toEqual(SPRITE_DIRECTIONS);
    expect(manifest.directions).toHaveLength(8);
    for (const row of manifest.directions) {
      expect(row.cells).toHaveLength(9);
      expect(row.cells[0].policy).toBe('locked-directional-reference-anchor');
      expect(row.cells.map((c) => c.column)).not.toContain('scanner');
      expect(row.cells.some((c) => c.policy === 'locked-idle-placeholder')).toBe(false);
      expect(row).not.toHaveProperty('scannerPolicy');
      for (const cell of row.cells) {
        // Feet on the pivot ground line: bounds bottom (top + height - 1) = pivot y.
        expect(cell.occupiedBounds.top + cell.occupiedBounds.height - 1).toBe(DEFAULT_ATLAS_GEOMETRY.pivot[1]);
        // Target bounds drive the scale; lanczos soft edges may extend the
        // visible bbox ~1px per side (the edge-touch checks are the hard gate).
        expect(cell.occupiedBounds.height).toBeLessThanOrEqual(DEFAULT_ATLAS_GEOMETRY.targetMaxHeight + 2);
        expect(cell.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    const state = await getAtlasState(id);
    expect(state.current.version).toBe(1);
    expect(state.current.walkSetSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(state.publications).toEqual([]);
  });

  // #3021: the compiler used to re-derive each cell's x from its own silhouette
  // centre, discarding the shared hip anchor the packer had already established
  // — so a swinging limb slid the whole character even when the strip was
  // perfectly registered. The frames here differ in silhouette (varyArm), which
  // is the only condition under which the two rules disagree.
  it('preserves the packer hip anchor across a direction, so a swinging limb cannot slide the character', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, {
      varyArm: true,
      alignment: { cellSize: 40, targetPivot: [20, 35] },
    });
    const result = await compileAtlas(id);
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));

    for (const row of manifest.directions) {
      const walkCells = row.cells.filter((c) => c.column !== 'idle');
      // Every walk cell of a direction lands on ONE x — that IS the preserved
      // registration. (The idle cell is a raw anchor with no packer alignment
      // behind it, so it keeps silhouette-centre placement and is excluded.)
      expect(new Set(walkCells.map((c) => c.translation[0])).size).toBe(1);
      // Guard against passing because the silhouettes came out identical after
      // all: the varying limb must still be visible in the measured bounds.
      expect(new Set(walkCells.map((c) => c.occupiedBounds.width)).size).toBeGreaterThan(1);
      // The runtime ground-line contract is per-cell and still holds.
      for (const cell of row.cells) {
        expect(cell.occupiedBounds.top + cell.occupiedBounds.height - 1).toBe(DEFAULT_ATLAS_GEOMETRY.pivot[1]);
      }
    }
  });

  // The packer's robust baseline is only worth having if it survives compile.
  // It nearly didn't: this stage pinned the raw bbox bottom at a FOUR TIMES more
  // sensitive alpha threshold, so it re-pinned the speck to the ground line and
  // landed the body exactly where the old code did — fixing the strip preview
  // and nothing the game actually loads.
  it('ignores a speck below the sole when grounding a compiled cell', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { speckFrames: [2], alignment: { cellSize: 40, targetPivot: [20, 35] } });
    const result = await compileAtlas(id);
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));

    for (const row of manifest.directions) {
      const walkCells = row.cells.filter((c) => c.column !== 'idle');
      // The specked frame must sit at the same height as its neighbours: one
      // stray pixel below the feet must not lift the body.
      expect(new Set(walkCells.map((c) => c.translation[1])).size).toBe(1);
    }
  });

  it('compiles a variable-frame (12-frame) walk set into a wider atlas + geometry', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { frameCount: 12, fps: 8 });
    const result = await compileAtlas(id);

    const meta = await sharp(join(TEST_ROOT, 'sprites', id, result.atlasPath)).metadata();
    // idle + 12 walk phases = 13 columns.
    expect(meta.width).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * 13);
    expect(meta.height).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * SPRITE_DIRECTIONS.length);

    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    expect(manifest.geometry.columns).toEqual(['idle', ...walkPhaseLabels(12)]);
    expect(manifest.geometry.walkFrameCount).toBe(12);
    expect(manifest.geometry.walkFps).toBe(8);
    expect(manifest.geometry.widthPx).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * 13);
    for (const row of manifest.directions) expect(row.cells).toHaveLength(13);
  });

  it('recompiles a set whose pointer still describes the pre-#2986 scanner grid', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);

    // Simulate a pointer written by the old compiler: same walk set, same cell
    // metrics, but the wider `idle + N + scanner` column list (and therefore
    // different atlas bytes). Every field the cheap pre-pixel idempotency check
    // looks at is identical EXCEPT the column list — so without that comparison
    // the stale wider grid would be reported as up-to-date and never recompile.
    const pointerAbs = join(TEST_ROOT, 'sprites', id, 'runtime/current.json');
    const pointer = JSON.parse(await readFile(pointerAbs, 'utf8'));
    pointer.atlasSha256 = 'f'.repeat(64);
    pointer.geometry = {
      ...pointer.geometry,
      columns: [...pointer.geometry.columns, 'scanner'],
      widthPx: pointer.geometry.widthPx + pointer.geometry.cellSize,
    };
    await writeFile(pointerAbs, JSON.stringify(pointer));

    const again = await compileAtlas(id);
    expect(again.created).toBe(true);
    expect(again.version).toBe(first.version + 1);
    expect(again.geometry.columns).toEqual(['idle', ...WALK_PHASES]);
    expect(again.geometry.widthPx).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * 9);
  });

  it('records each track\'s column span in the compiled geometry (#3016)', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { frameCount: 12, fps: 8 });
    const result = await compileAtlas(id);

    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    expect(manifest.geometry.tracks).toEqual({
      idle: fullSpan(0, 1),
      walk: fullSpan(1, 12),
    });
    // The descriptor, the column list and the emitted PNG width all describe
    // the same grid — a consumer resolving a track by span lands on the pixels
    // the width accounts for.
    const spanned = Object.values(manifest.geometry.tracks).reduce((n, s) => n + s.count, 0);
    expect(spanned).toBe(manifest.geometry.columns.length);
    expect(manifest.geometry.widthPx).toBe(DEFAULT_ATLAS_GEOMETRY.cellSize * spanned);
    // The pointer carries the same geometry, so the publish path sees it too.
    expect(result.geometry.tracks).toEqual(manifest.geometry.tracks);
  });

  it('records how many atlas rows each track occupies (#3017)', async () => {
    const id = await finalizedCharacter();
    const result = await compileAtlas(id);

    // Both shipped tracks are directional, so both are full-height — that is
    // the point: nothing about an existing character's atlas changes. What the
    // field buys is that a NON-directional track (a tree in the wind) can say
    // it owns row 0 only, and a consumer knows to read row 0 regardless of
    // facing instead of sampling seven transparent rows.
    expect(result.geometry.tracks.idle.rows).toBe(SPRITE_DIRECTIONS.length);
    expect(result.geometry.tracks.walk.rows).toBe(SPRITE_DIRECTIONS.length);
    expect(result.geometry.rows).toBe(SPRITE_DIRECTIONS.length);

    // Cells are placed through the spans, so every manifest columnIndex lands
    // inside its own track's span and names the column the grid has there.
    const manifest = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, result.manifestPath), 'utf8'));
    for (const row of manifest.directions) {
      for (const cell of row.cells) {
        expect(manifest.geometry.columns[cell.columnIndex]).toBe(cell.column);
      }
    }
  });

  it('stays byte-identical to a pointer that predates the rows field', async () => {
    // The idempotency regression #3017 could have caused: `rows` is new on every
    // span, so a pointer written before it would compare unequal and re-run the
    // entire pixel pipeline on every compile, forever, for every existing
    // install. Absent must normalize to full height on the way in.
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);

    const pointerAbs = join(TEST_ROOT, 'sprites', id, 'runtime/current.json');
    const pointer = JSON.parse(await readFile(pointerAbs, 'utf8'));
    pointer.geometry = {
      ...pointer.geometry,
      tracks: Object.fromEntries(
        Object.entries(pointer.geometry.tracks).map(([t, s]) => [t, { start: s.start, count: s.count }]),
      ),
    };
    await writeFile(pointerAbs, JSON.stringify(pointer));

    const again = await compileAtlas(id);
    expect(again.created).toBe(false);
    expect(again.version).toBe(first.version);
  });

  it('recompiles a set whose pointer describes a DIFFERENT track set over the same columns', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);

    // #2986's lesson one level up: a grid-shape change can leave every cell
    // metric identical, and a TRACK-SET change can leave even the column list
    // identical. Here the pointer keeps its exact column names and count but
    // re-partitions them into three tracks — a different grid that must
    // recompile. Only the atlas hash is falsified, so if the cheap pre-pixel
    // check failed to notice the track change it would return the stale pointer
    // untouched instead of writing a new version.
    const pointerAbs = join(TEST_ROOT, 'sprites', id, 'runtime/current.json');
    const pointer = JSON.parse(await readFile(pointerAbs, 'utf8'));
    expect(pointer.geometry.tracks).toEqual({ idle: fullSpan(0, 1), walk: fullSpan(1, 8) });
    pointer.atlasSha256 = 'f'.repeat(64);
    pointer.geometry = {
      ...pointer.geometry,
      tracks: {
        idle: { start: 0, count: 1 },
        walk: { start: 1, count: 4 },
        scanner: { start: 5, count: 4 },
      },
    };
    await writeFile(pointerAbs, JSON.stringify(pointer));

    const again = await compileAtlas(id);
    expect(again.created).toBe(true);
    expect(again.version).toBe(first.version + 1);
    expect(again.geometry.columns).toEqual(['idle', ...WALK_PHASES]);
    expect(again.geometry.tracks).toEqual({ idle: fullSpan(0, 1), walk: fullSpan(1, 8) });
  });

  it('stays idempotent for a legacy pointer written before the tracks descriptor existed', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);

    // Every atlas compiled before #3016 has no `geometry.tracks`. It must still
    // read as up to date, or upgrading an install re-runs the whole pixel
    // pipeline on every compile of every existing character, forever (the
    // pointer is never rewritten on the identical-bytes path, so it would never
    // gain the field and never stop).
    const pointerAbs = join(TEST_ROOT, 'sprites', id, 'runtime/current.json');
    const pointer = JSON.parse(await readFile(pointerAbs, 'utf8'));
    delete pointer.geometry.tracks;
    await writeFile(pointerAbs, JSON.stringify(pointer));

    // Assert the PRE-PIXEL predicate against the real on-disk geometry, not just
    // the compile's return value: `created: false` also holds via the
    // post-encode sha compare, so a test that only checked that would pass even
    // with the legacy fallback deleted — i.e. while the pixel pipeline ran in
    // full on every compile, which is the exact regression this guards.
    const grid = buildAtlasGrid([{ id: 'walk', frameCount: WALK_PHASES.length }]);
    expect(compiledGridUpToDate(pointer.geometry, { ...DEFAULT_ATLAS_GEOMETRY, ...grid })).toBe(true);

    const again = await compileAtlas(id);
    expect(again.created).toBe(false);
    expect(again.version).toBe(first.version);
  });

  it('compiles a pre-fps run manifest at the legacy extraction rate, not the track default', async () => {
    // Older run manifests carry no `frameRate` at all. The fallback must stay
    // the rate their frames were extracted at (12), NOT the walk track's
    // authoring default (10) — otherwise upgrading silently re-stamps every
    // newly-compiled legacy set's geometry and its published previewFps.
    const id = await finalizedCharacter();
    const result = await compileAtlas(id);
    expect(result.geometry.walkFps).toBe(WALK_FPS);
    expect(WALK_FPS).not.toBe(getAnimationTrack('walk').defaultFps);
  });

  it('refuses to compile a set whose directions disagree on frame count', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await buildFinalizedWalkSet(id, { frameCount: 12, fps: 10 });
    // Corrupt ONE direction's run manifest to carry 8 frames instead of 12, and
    // re-hash the selection entry so the tamper check passes and the frame-count
    // mismatch is what trips compile (not a broken evidence chain).
    const dir = join(TEST_ROOT, 'sprites', id);
    const selectionRel = `walk/${id}-walk-selection-v1.json`;
    const selection = JSON.parse(await readFile(join(dir, selectionRel), 'utf8'));
    const entry = selection.directions.east;
    const eightFrames = walkPhaseLabels(8).map((phase, i) => ({
      outputIndex: i, phase, path: `x/${i}.png`, sha256: 'deadbeef',
    }));
    const tampered = JSON.stringify({
      schemaVersion: 1, kind: 'deterministically-packaged-grok-walk-video',
      characterId: id, direction: 'east', chromaKey: '#FF00FF', frameCount: 8, frames: eightFrames,
    });
    await writeFile(join(dir, entry.runManifest), tampered);
    entry.runManifestSha256 = sha256(Buffer.from(tampered));
    const walkSetRel = `walk/${id}-walk-set-v1.json`;
    const walkSet = JSON.parse(await readFile(join(dir, walkSetRel), 'utf8'));
    walkSet.directions.east = entry;
    const selectionBytes = JSON.stringify(selection);
    await writeFile(join(dir, selectionRel), selectionBytes);
    walkSet.selectionSha256 = sha256(Buffer.from(selectionBytes));
    await writeFile(join(dir, walkSetRel), JSON.stringify(walkSet));

    await expect(compileAtlas(id)).rejects.toMatchObject({ code: 'ATLAS_COMPILE_INVALID' });
  });

  it('is idempotent for the same finalized set — and versions on a changed one', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);
    const second = await compileAtlas(id);
    expect(second.created).toBe(false);
    expect(second.version).toBe(first.version);
    expect(second.atlasSha256).toBe(first.atlasSha256);
  });

  it('refuses a tampered frame (per-frame sha256 revalidation)', async () => {
    const id = await finalizedCharacter();
    const walkSet = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, `walk/${id}-walk-set-v1.json`), 'utf8'));
    const frameRel = JSON.parse(
      await readFile(join(TEST_ROOT, 'sprites', id, walkSet.directions.east.runManifest), 'utf8'),
    ).frames[3].path;
    await walkFramePng(join(TEST_ROOT, 'sprites', id, frameRel), 250);
    await expect(compileAtlas(id)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses without a finalized walk set', async () => {
    const id = newId();
    await lockAllAnchors(id);
    await expect(compileAtlas(id)).rejects.toMatchObject({ status: 422, code: 'WALK_SET_REQUIRED' });
  });

  it('refuses an unapproved direction', async () => {
    const id = await finalizedCharacter();
    const setAbs = join(TEST_ROOT, 'sprites', id, `walk/${id}-walk-set-v1.json`);
    const walkSet = JSON.parse(await readFile(setAbs, 'utf8'));
    walkSet.directions.north.status = 'rejected';
    await writeFile(setAbs, JSON.stringify(walkSet));
    await expect(compileAtlas(id)).rejects.toMatchObject({ status: 422 });
  });

  it('honors a geometry override', async () => {
    const id = await finalizedCharacter();
    const result = await compileAtlas(id, {
      geometry: { cellSize: 64, pivot: [32, 56], targetMaxHeight: 44, targetMaxWidth: 52 },
    });
    const meta = await sharp(join(TEST_ROOT, 'sprites', id, result.atlasPath)).metadata();
    expect(meta.width).toBe(64 * 9);
    expect(meta.height).toBe(64 * 8);
  });

  it('scales the visual tolerance with a 2x source-density compile', async () => {
    const id = await finalizedCharacter();
    const result = await compileAtlas(id, {
      geometry: {
        cellSize: 192,
        pivot: [96, 176],
        targetMaxHeight: 148,
        targetMaxWidth: 172,
      },
    });
    const meta = await sharp(join(TEST_ROOT, 'sprites', id, result.atlasPath)).metadata();
    expect(meta.width).toBe(192 * 9);
    expect(meta.height).toBe(192 * 8);
  });

  it('refuses an imported legacy walk set with an explicit code (not a tamper error)', async () => {
    const id = await finalizedCharacter();
    const setAbs = join(TEST_ROOT, 'sprites', id, `walk/${id}-walk-set-v1.json`);
    const walkSet = JSON.parse(await readFile(setAbs, 'utf8'));
    walkSet.selectionPath = `art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`;
    await writeFile(setAbs, JSON.stringify(walkSet));
    await expect(compileAtlas(id)).rejects.toMatchObject({ status: 409, code: 'LEGACY_IMPORTED_WALK_SET' });
  });

  // #2993: the refusal is per-direction, because a direction can now leave the
  // imported state (reopen → reprocess from its imported clip → re-approve
  // rewrites its entry record-relative). A set that is otherwise fully native
  // must still be refused for the directions that have NOT been re-derived —
  // and must name them, since the remedy is applied one direction at a time.
  it('names the directions still packaged by the source pipeline', async () => {
    const id = await finalizedCharacter();
    const setAbs = join(TEST_ROOT, 'sprites', id, `walk/${id}-walk-set-v1.json`);
    const walkSet = JSON.parse(await readFile(setAbs, 'utf8'));
    walkSet.directions.north.runManifest = `art-source/sprites/${id}/${walkSet.directions.north.runManifest}`;
    await writeFile(setAbs, JSON.stringify(walkSet));
    await expect(compileAtlas(id)).rejects.toMatchObject({
      status: 409,
      code: 'LEGACY_IMPORTED_WALK_SET',
      message: expect.stringContaining('north is still packaged by the source pipeline'),
    });
  });

  it('self-heals a deleted versioned atlas instead of returning a dangling pointer', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);
    rmSync(join(TEST_ROOT, 'sprites', id, first.atlasPath));
    const again = await compileAtlas(id);
    expect(again.version).toBe(first.version); // re-writes the same version, not a new one
    expect(await readFile(join(TEST_ROOT, 'sprites', id, first.atlasPath))).toBeTruthy();
  });

  it('skips a PNG-missing slot whose surviving manifest vouches for different bytes', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);
    // Delete the v1 PNG, then change the inputs (geometry) so the recompile
    // produces DIFFERENT bytes — it must land in v2, not poison v1.
    rmSync(join(TEST_ROOT, 'sprites', id, first.atlasPath));
    const next = await compileAtlas(id, {
      geometry: { cellSize: 64, pivot: [32, 56], targetMaxHeight: 44, targetMaxWidth: 52 },
    });
    expect(next.version).toBe(first.version + 1);
    // v1's surviving manifest is untouched and still describes the original.
    const v1Manifest = JSON.parse(
      await readFile(join(TEST_ROOT, 'sprites', id, first.manifestPath), 'utf8'),
    );
    expect(v1Manifest.atlasSha256).toBe(first.atlasSha256);
  });

  it('rejects geometry whose content bounds cannot fit the cell', async () => {
    const id = await finalizedCharacter();
    await expect(compileAtlas(id, { geometry: { cellSize: 64, targetMaxWidth: 64 } }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_GEOMETRY' });
  });
});
