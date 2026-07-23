/**
 * Runtime atlas compiler (#2898): evidence-chain validation (walk set,
 * selection, run manifests, frame + anchor sha256s), the geometry contract
 * (10×8 grid, per-direction single scale, pivot ground line), immutable
 * versioning, and compile idempotency. Fixtures lock a real reference set
 * (real normalize + chroma-key selection) and hand-write the walk artifacts
 * with a correct hash chain.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { createHash } from 'crypto';

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
const { WALK_PHASES } = await import('./walkPostprocess.js');

let seq = 0;
const newId = () => `atlas-char-${++seq}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function writeCandidatePng(path) {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let p = 0; p < w * h; p++) buf.set([255, 0, 255], p * 3);
  for (let y = 10; y < 40; y++) for (let x = 22; x < 32; x++) buf.set([23, 107, 101], (y * w + x) * 3);
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toFile(path);
}

async function placeCandidate(recordId, target, name) {
  const candDir = join(TEST_ROOT, 'sprites', recordId, 'reference', 'candidates');
  await writeCandidatePng(join(candDir, name));
  await writeFile(join(candDir, `${name.replace(/\.png$/, '')}.generation.json`), JSON.stringify({
    schemaVersion: 1, target, chromaKey: '#FF00FF',
  }));
  return `reference/candidates/${name}`;
}

async function lockAllAnchors(id) {
  await records.createRecord({ kind: 'character', name: 'Atlas Walker' }, id);
  await lockReference(id, { target: 'main', candidate: await placeCandidate(id, 'main', 'walk-south-candidate-01.png') });
  for (const dir of SPRITE_DIRECTIONS.filter((d) => d !== 'south')) {
    await lockReference(id, { target: dir, candidate: await placeCandidate(id, dir, `walk-${dir}-candidate-01.png`) });
  }
}

/** Transparent 40×40 RGBA frame with an opaque 20×30 figure. */
async function walkFramePng(path, tint) {
  const w = 40; const h = 40;
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 5; y < 35; y++) {
    for (let x = 10; x < 30; x++) {
      buf.set([tint, 107, 101, 255], (y * w + x) * 4);
    }
  }
  await mkdir(join(path, '..'), { recursive: true });
  await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).png().toFile(path);
}

async function buildFinalizedWalkSet(recordId) {
  const manifest = await loadManifest(recordId);
  const chromaKey = manifest.chromaKey;
  const dir = join(TEST_ROOT, 'sprites', recordId);
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
    for (let i = 0; i < WALK_PHASES.length; i++) {
      const name = `${String(i).padStart(2, '0')}-${WALK_PHASES[i]}.png`;
      const rel = `${generatedRel}/frames/${name}`;
      await walkFramePng(join(dir, rel), 20 + i * 8);
      frames.push({
        outputIndex: i,
        phase: WALK_PHASES[i],
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

async function finalizedCharacter() {
  const id = newId();
  await lockAllAnchors(id);
  await buildFinalizedWalkSet(id);
  return id;
}

beforeEach(() => {
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('compileAtlas', () => {
  it('compiles the 10×8 player atlas with full provenance and a current pointer', async () => {
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
    expect(manifest.geometry.columns).toEqual(['idle', ...WALK_PHASES, 'scanner']);
    expect(manifest.geometry.directionOrder).toEqual(SPRITE_DIRECTIONS);
    expect(manifest.directions).toHaveLength(8);
    for (const row of manifest.directions) {
      expect(row.cells).toHaveLength(10);
      expect(row.cells[0].policy).toBe('locked-directional-reference-anchor');
      expect(row.cells[9].policy).toBe('locked-idle-placeholder');
      // Scanner mirrors the idle cell's placement exactly.
      expect(row.cells[9].occupiedBounds).toEqual(row.cells[0].occupiedBounds);
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
    expect(meta.width).toBe(64 * 10);
    expect(meta.height).toBe(64 * 8);
  });

  it('refuses an imported legacy walk set with an explicit code (not a tamper error)', async () => {
    const id = await finalizedCharacter();
    const setAbs = join(TEST_ROOT, 'sprites', id, `walk/${id}-walk-set-v1.json`);
    const walkSet = JSON.parse(await readFile(setAbs, 'utf8'));
    walkSet.selectionPath = `art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`;
    await writeFile(setAbs, JSON.stringify(walkSet));
    await expect(compileAtlas(id)).rejects.toMatchObject({ status: 409, code: 'LEGACY_IMPORTED_WALK_SET' });
  });

  it('self-heals a deleted versioned atlas instead of returning a dangling pointer', async () => {
    const id = await finalizedCharacter();
    const first = await compileAtlas(id);
    rmSync(join(TEST_ROOT, 'sprites', id, first.atlasPath));
    const again = await compileAtlas(id);
    expect(again.version).toBe(first.version); // re-writes the same version, not a new one
    expect(await readFile(join(TEST_ROOT, 'sprites', id, first.atlasPath))).toBeTruthy();
  });

  it('rejects geometry whose content bounds cannot fit the cell', async () => {
    const id = await finalizedCharacter();
    await expect(compileAtlas(id, { geometry: { cellSize: 64, targetMaxWidth: 64 } }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_GEOMETRY' });
  });
});
