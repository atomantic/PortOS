/**
 * Runtime atlas compiler (#2898): evidence-chain validation (walk set,
 * selection, run manifests, frame + anchor sha256s), the geometry contract
 * (9×8 grid, per-direction single scale, pivot ground line), immutable
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
import { lockAllAnchors as lockAllAnchorsFixture } from './spriteTestFixtures.js';

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
const { WALK_PHASES, walkPhaseLabels } = await import('./walkPostprocess.js');

let seq = 0;
const newId = () => `atlas-char-${++seq}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function lockAllAnchors(id) {
  await records.createRecord({ kind: 'character', name: 'Atlas Walker' }, id);
  await lockAllAnchorsFixture(TEST_ROOT, id, { lockReference, directions: SPRITE_DIRECTIONS });
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

async function buildFinalizedWalkSet(recordId, { frameCount = WALK_PHASES.length, fps } = {}) {
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
      await walkFramePng(join(dir, rel), 20 + i * 8);
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
