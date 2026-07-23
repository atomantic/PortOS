/**
 * Migration 202 — grok/ → runs/ neutral sprite run storage. Builds a fully
 * compiled character under the legacy grok/ layout and asserts the migration
 * (a) moves the run directories, (b) rewrites every embedded grok/ path, and
 * (c) recomputes the sha CASCADE so the post-migration state is internally
 * consistent (the exact invariant atlas.js's compile idempotency relies on),
 * while leaving image-byte shas and imported/redraw records untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import migration from './202-neutral-sprite-run-dirs.js';

let ROOT;
const sprites = () => join(ROOT, 'data', 'sprites');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaFile = async (abs) => sha(await readFile(abs));
const readJson = async (abs) => JSON.parse(await readFile(abs, 'utf8'));
const exists = (abs) => stat(abs).then(() => true, () => false);
const writeJson = (abs, obj) => writeFile(abs, JSON.stringify(obj));

const RUN_ID = 'walk-east-abcd1234';

// A self-consistent compiled character under the legacy grok/ layout: run
// record + postprocess manifest + finalized selection/walk-set + a compiled
// atlas version, with every content-sha computed exactly as the live code does.
async function buildGrokCharacter(id) {
  const recDir = join(sprites(), id);
  const runDir = join(recDir, 'grok', RUN_ID);
  const genDir = join(runDir, 'generated');
  await mkdir(join(genDir, 'frames'), { recursive: true });
  await mkdir(join(recDir, 'walk'), { recursive: true });
  await mkdir(join(recDir, 'runtime', 'v1'), { recursive: true });
  await mkdir(join(recDir, 'reference'), { recursive: true });

  // Image bytes (byte-identical after the dir move → their shas must not change).
  const framePng = Buffer.from('frame-pixels');
  const stripPng = Buffer.from('strip-pixels');
  const atlasPng = Buffer.from('atlas-pixels');
  const anchorPng = Buffer.from('anchor-pixels');
  await writeFile(join(genDir, 'frames', '00-left-contact.png'), framePng);
  await writeFile(join(genDir, `${id}-walk-east-strip.png`), stripPng);
  await writeFile(join(recDir, 'runtime', 'v1', `${id}-animation-atlas-v1.png`), atlasPng);
  await writeFile(join(recDir, 'reference', `${id}-east-v1.png`), anchorPng);

  // Postprocess manifest — embeds grok/ frame + strip paths; image shas are real.
  const ppRel = `grok/${RUN_ID}/generated/${id}-walk-east-manifest.json`;
  const ppManifest = {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: id,
    direction: 'east',
    frameRate: 12,
    frameCount: 8,
    sourceVideoPath: `grok/${RUN_ID}/generated/source-video.mp4`,
    manifestPath: ppRel,
    frames: [{ outputIndex: 0, phase: 'left-contact', path: `grok/${RUN_ID}/generated/frames/00-left-contact.png`, sha256: sha(framePng) }],
    stripPath: `grok/${RUN_ID}/generated/${id}-walk-east-strip.png`,
    stripSha256: sha(stripPng),
  };
  await writeJson(join(genDir, `${id}-walk-east-manifest.json`), ppManifest);
  const ppSha = await shaFile(join(genDir, `${id}-walk-east-manifest.json`));

  await writeJson(join(runDir, 'animation-run.json'), {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    id: RUN_ID,
    characterId: id,
    direction: 'east',
    status: 'candidate',
    animationInputPath: `grok/${RUN_ID}/generated/input-anchor-transparent.png`,
    postprocessManifest: ppRel,
    stripPreview: { stripPath: `grok/${RUN_ID}/generated/${id}-walk-east-strip.png`, frameCount: 8 },
  });

  // Selection: east approved, runManifestSha256 pins the postprocess manifest.
  const selRel = `walk/${id}-walk-selection-v1.json`;
  await writeJson(join(recDir, selRel), {
    schemaVersion: 1,
    kind: 'reviewed-directional-walk-selection',
    characterId: id,
    status: 'complete',
    directions: {
      east: { status: 'approved', runId: RUN_ID, runPath: `grok/${RUN_ID}`, runManifest: ppRel, runManifestSha256: ppSha, approvedAt: 't' },
    },
  });
  const selSha = await shaFile(join(recDir, selRel));

  // Walk-set: selectionSha256 pins the selection file.
  const wsRel = `walk/${id}-walk-set-v1.json`;
  await writeJson(join(recDir, wsRel), {
    schemaVersion: 1,
    kind: 'finalized-eight-direction-walk-set',
    characterId: id,
    status: 'final',
    selectionPath: selRel,
    selectionSha256: selSha,
    directions: {
      east: { status: 'approved', runId: RUN_ID, runPath: `grok/${RUN_ID}`, runManifest: ppRel, runManifestSha256: ppSha, approvedAt: 't' },
    },
  });
  const wsSha = await shaFile(join(recDir, wsRel));

  // Compiled atlas manifest: embeds grok/ provenance + a reference/ anchor path.
  const atlasManRel = `runtime/v1/${id}-animation-atlas-v1-manifest.json`;
  await writeJson(join(recDir, atlasManRel), {
    schemaVersion: 1,
    kind: 'reviewed-walk-set-runtime-atlas',
    characterId: id,
    version: 1,
    atlasPath: `runtime/v1/${id}-animation-atlas-v1.png`,
    directions: [{ direction: 'east', runManifestPath: ppRel, cells: [
      { column: 'idle', sourcePath: `reference/${id}-east-v1.png` },
      { column: 'left-contact', sourcePath: `grok/${RUN_ID}/generated/frames/00-left-contact.png` },
    ] }],
  });
  const atlasManSha = await shaFile(join(recDir, atlasManRel));

  await writeJson(join(recDir, 'runtime', 'current.json'), {
    schemaVersion: 1,
    kind: 'runtime-atlas-selection',
    characterId: id,
    version: 1,
    atlasPath: `runtime/v1/${id}-animation-atlas-v1.png`,
    atlasSha256: sha(atlasPng),
    manifestPath: atlasManRel,
    manifestSha256: atlasManSha,
    walkSetSha256: wsSha,
  });
  return { recDir, framePng, stripPng, atlasPng };
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'mig-202-')); });
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('migration 202 — grok/ → runs/ neutral sprite run dirs', () => {
  it('moves run dirs, rewrites every grok/ path, and keeps the sha cascade consistent', async () => {
    const id = 'walker-one';
    const { recDir, framePng, atlasPng } = await buildGrokCharacter(id);

    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 1 });

    // 1. Directory moved.
    expect(await exists(join(recDir, 'grok'))).toBe(false);
    expect(await exists(join(recDir, 'runs', RUN_ID, 'animation-run.json'))).toBe(true);
    expect(await exists(join(recDir, 'runs', RUN_ID, 'generated', 'frames', '00-left-contact.png'))).toBe(true);

    // 2. No grok/ path survives anywhere in the JSON.
    const runRec = await readJson(join(recDir, 'runs', RUN_ID, 'animation-run.json'));
    expect(runRec.postprocessManifest).toBe(`runs/${RUN_ID}/generated/${id}-walk-east-manifest.json`);
    expect(runRec.stripPreview.stripPath).toBe(`runs/${RUN_ID}/generated/${id}-walk-east-strip.png`);

    const pp = await readJson(join(recDir, 'runs', RUN_ID, 'generated', `${id}-walk-east-manifest.json`));
    expect(pp.stripPath).toBe(`runs/${RUN_ID}/generated/${id}-walk-east-strip.png`);
    expect(pp.frames[0].path).toBe(`runs/${RUN_ID}/generated/frames/00-left-contact.png`);
    // Image-byte sha is preserved (the migration never re-hashes moved pixels).
    expect(pp.frames[0].sha256).toBe(sha(framePng));

    // 3. The content-sha cascade is internally consistent post-migration.
    const selAbs = join(recDir, 'walk', `${id}-walk-selection-v1.json`);
    const wsAbs = join(recDir, 'walk', `${id}-walk-set-v1.json`);
    const ptrAbs = join(recDir, 'runtime', 'current.json');
    const sel = await readJson(selAbs);
    const ws = await readJson(wsAbs);
    const ptr = await readJson(ptrAbs);
    expect(sel.directions.east.runPath).toBe(`runs/${RUN_ID}`);
    expect(sel.directions.east.runManifestSha256).toBe(await shaFile(join(recDir, 'runs', RUN_ID, 'generated', `${id}-walk-east-manifest.json`)));
    expect(ws.selectionSha256).toBe(await shaFile(selAbs));
    expect(ws.directions.east.runManifest).toBe(`runs/${RUN_ID}/generated/${id}-walk-east-manifest.json`);
    expect(ptr.walkSetSha256).toBe(await shaFile(wsAbs));
    expect(ptr.manifestSha256).toBe(await shaFile(join(recDir, ptr.manifestPath)));
    // Atlas PNG bytes (and its pinned sha) untouched.
    expect(ptr.atlasSha256).toBe(sha(atlasPng));

    // 4. Atlas manifest provenance rewritten; the reference/ anchor left alone.
    const atlasMan = await readJson(join(recDir, ptr.manifestPath));
    expect(atlasMan.directions[0].runManifestPath).toBe(`runs/${RUN_ID}/generated/${id}-walk-east-manifest.json`);
    expect(atlasMan.directions[0].cells[0].sourcePath).toBe(`reference/${id}-east-v1.png`);
    expect(atlasMan.directions[0].cells[1].sourcePath).toBe(`runs/${RUN_ID}/generated/frames/00-left-contact.png`);
  });

  it('is idempotent — a second run changes nothing and does not throw', async () => {
    const id = 'walker-two';
    const { recDir } = await buildGrokCharacter(id);
    await migration.up({ rootDir: ROOT });

    const snapshot = async () => ({
      sel: await readFile(join(recDir, 'walk', `${id}-walk-selection-v1.json`), 'utf8'),
      ws: await readFile(join(recDir, 'walk', `${id}-walk-set-v1.json`), 'utf8'),
      ptr: await readFile(join(recDir, 'runtime', 'current.json'), 'utf8'),
    });
    const before = await snapshot();
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 }); // gate skips the already-migrated record
    expect(await snapshot()).toEqual(before);
  });

  it('leaves an imported/redraw-only record (no grok/) untouched', async () => {
    const id = 'imported-hero';
    const recDir = join(sprites(), id);
    await mkdir(join(recDir, 'walk'), { recursive: true });
    const sel = {
      schemaVersion: 1, characterId: id, status: 'complete',
      directions: { east: { status: 'approved', runManifest: `art-source/sprites/${id}/imagegen/v19/x-manifest.json`, approvedAt: 't' } },
    };
    await writeJson(join(recDir, 'walk', `${id}-walk-selection-v1.json`), sel);
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await readJson(join(recDir, 'walk', `${id}-walk-selection-v1.json`))).toEqual(sel);
  });

  it('refuses a move collision (runs/<runId> already exists) and stays pending', async () => {
    const id = 'walker-collide';
    const { recDir } = await buildGrokCharacter(id);
    // A pre-existing runs/<runId> blocks the move — must not merge/overwrite.
    await mkdir(join(recDir, 'runs', RUN_ID), { recursive: true });
    await writeFile(join(recDir, 'runs', RUN_ID, 'sentinel.txt'), 'do-not-clobber');

    await expect(migration.up({ rootDir: ROOT })).rejects.toThrow(/failed to migrate/);
    // The legacy run is left in place; the sentinel is untouched.
    expect(await exists(join(recDir, 'grok', RUN_ID))).toBe(true);
    expect(await readFile(join(recDir, 'runs', RUN_ID, 'sentinel.txt'), 'utf8')).toBe('do-not-clobber');
  });
});
