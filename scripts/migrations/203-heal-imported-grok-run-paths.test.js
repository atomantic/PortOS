/**
 * Migration 203 — heal the repo-anchored `art-source/sprites/<id>/grok/…` path
 * residue that migration 202 left dangling on IMPORTED sprite records (the run
 * bytes already moved to runs/, but 202's `startsWith('grok/')` neutralizer
 * never matched the source-anchored strings). Builds a record in exactly that
 * post-202 state — files under runs/, every embedded path still `…/grok/…` —
 * and asserts the migration rewrites the vendor segment to `runs/`, recomputes
 * the sha cascade, preserves the `art-source/…` provenance prefix and image
 * shas, and never touches self-consistent or non-run-path data.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import migration from './203-heal-imported-grok-run-paths.js';

let ROOT;
const sprites = () => join(ROOT, 'data', 'sprites');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaFile = async (abs) => sha(await readFile(abs));
const readJson = async (abs) => JSON.parse(await readFile(abs, 'utf8'));
const exists = (abs) => stat(abs).then(() => true, () => false);
const writeJson = (abs, obj) => writeFile(abs, JSON.stringify(obj));

const RUN_ID = 'walk-south-east-0ae1f1e496bc';

// A record in the broken post-202 state: run DIRECTORY already lives under
// runs/, but every embedded path is still the source-anchored
// `art-source/sprites/<id>/grok/…` form 202 failed to rewrite. runManifest
// points at the run record (animation-run.json) — the imported pin structure,
// distinct from 202's own tests where it points at the postprocess manifest.
async function buildBrokenImport(id) {
  const recDir = join(sprites(), id);
  const runDir = join(recDir, 'runs', RUN_ID);
  const genDir = join(runDir, 'generated');
  await mkdir(join(genDir, 'frames'), { recursive: true });
  await mkdir(join(recDir, 'walk'), { recursive: true });

  const framePng = Buffer.from('frame-pixels');
  const stripPng = Buffer.from('strip-pixels');
  await writeFile(join(genDir, 'frames', '00-left-contact.png'), framePng);
  await writeFile(join(genDir, `${id}-walk-south-east-strip.png`), stripPng);

  const anchor = (p) => `art-source/sprites/${id}/grok/${p}`;

  // Postprocess manifest — embeds source-anchored grok/ frame + strip paths.
  await writeJson(join(genDir, `${id}-walk-south-east-manifest.json`), {
    schemaVersion: 1,
    kind: 'deterministically-packaged-grok-walk-video',
    characterId: id,
    direction: 'south-east',
    frames: [{ outputIndex: 0, path: anchor(`${RUN_ID}/generated/frames/00-left-contact.png`), sha256: sha(framePng) }],
    stripPath: anchor(`${RUN_ID}/generated/${id}-walk-south-east-strip.png`),
    stripSha256: sha(stripPng),
  });

  // Run record — the frozen-imported run. Note kind/skill strings that CONTAIN
  // "grok" but are NOT paths: they must survive verbatim.
  const runRecAbs = join(runDir, 'animation-run.json');
  await writeJson(runRecAbs, {
    schemaVersion: 1,
    kind: 'grok-game-animation-frames-run',
    id: RUN_ID,
    characterId: id,
    direction: 'south-east',
    status: 'candidate',
    skill: 'local-postprocess-of-existing-grok-session-video',
    outputRoot: anchor(RUN_ID),
    postprocessManifest: anchor(`${RUN_ID}/generated/${id}-walk-south-east-manifest.json`),
    stripPreview: { path: anchor(`${RUN_ID}/generated/${id}-walk-south-east-strip.png`), frameCount: 8, fps: 12 },
  });
  const runRecSha = await shaFile(runRecAbs);

  const dirEntry = {
    status: 'approved',
    runId: RUN_ID,
    runPath: anchor(RUN_ID),
    runManifest: anchor(`${RUN_ID}/animation-run.json`),
    runManifestSha256: runRecSha,
    approvedAt: 't',
  };

  const selRel = `walk/${id}-walk-selection-v1.json`;
  await writeJson(join(recDir, selRel), {
    schemaVersion: 1,
    kind: 'reviewed-directional-walk-selection',
    characterId: id,
    status: 'complete',
    directions: { 'south-east': { ...dirEntry } },
  });
  const selSha = await shaFile(join(recDir, selRel));

  const wsRel = `walk/${id}-walk-set-v1.json`;
  await writeJson(join(recDir, wsRel), {
    schemaVersion: 1,
    kind: 'finalized-eight-direction-walk-set',
    characterId: id,
    status: 'final',
    selectionPath: `art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`,
    selectionSha256: selSha,
    directions: { 'south-east': { ...dirEntry } },
  });

  return { recDir, runDir, framePng, stripPng };
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'mig-203-')); });
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('migration 203 — heal imported grok/ run paths', () => {
  it('rewrites the source-anchored grok/ segment to runs/ and rebuilds the sha cascade', async () => {
    const id = 'pioneer-fixture';
    const { recDir, runDir, framePng } = await buildBrokenImport(id);

    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 1 });

    // Run record — grok/ segment healed, provenance prefix + non-path grok
    // strings preserved.
    const runRec = await readJson(join(runDir, 'animation-run.json'));
    expect(runRec.stripPreview.path).toBe(`art-source/sprites/${id}/runs/${RUN_ID}/generated/${id}-walk-south-east-strip.png`);
    expect(runRec.outputRoot).toBe(`art-source/sprites/${id}/runs/${RUN_ID}`);
    expect(runRec.postprocessManifest).toBe(`art-source/sprites/${id}/runs/${RUN_ID}/generated/${id}-walk-south-east-manifest.json`);
    expect(runRec.kind).toBe('grok-game-animation-frames-run'); // NOT a path — untouched
    expect(runRec.skill).toBe('local-postprocess-of-existing-grok-session-video'); // untouched

    // Postprocess manifest — paths healed, image sha preserved.
    const pp = await readJson(join(runDir, 'generated', `${id}-walk-south-east-manifest.json`));
    expect(pp.stripPath).toBe(`art-source/sprites/${id}/runs/${RUN_ID}/generated/${id}-walk-south-east-strip.png`);
    expect(pp.frames[0].path).toBe(`art-source/sprites/${id}/runs/${RUN_ID}/generated/frames/00-left-contact.png`);
    expect(pp.frames[0].sha256).toBe(sha(framePng));

    // Selection + walk-set — entries healed, sha cascade internally consistent.
    const selAbs = join(recDir, 'walk', `${id}-walk-selection-v1.json`);
    const wsAbs = join(recDir, 'walk', `${id}-walk-set-v1.json`);
    const sel = await readJson(selAbs);
    const ws = await readJson(wsAbs);
    expect(sel.directions['south-east'].runPath).toBe(`art-source/sprites/${id}/runs/${RUN_ID}`);
    expect(sel.directions['south-east'].runManifest).toBe(`art-source/sprites/${id}/runs/${RUN_ID}/animation-run.json`);
    // runManifestSha256 re-pins the rewritten run record's new bytes.
    expect(sel.directions['south-east'].runManifestSha256).toBe(await shaFile(join(runDir, 'animation-run.json')));
    expect(ws.directions['south-east'].runManifestSha256).toBe(await shaFile(join(runDir, 'animation-run.json')));
    expect(ws.selectionSha256).toBe(await shaFile(selAbs));
    // The non-grok selectionPath provenance is left intact (keeps the walk set
    // recognizable as imported).
    expect(ws.selectionPath).toBe(`art-source/sprites/${id}/walk/${id}-walk-selection-v1.json`);
  });

  it('is idempotent — a second run changes nothing and reports migrated: 0', async () => {
    const id = 'pioneer-idem';
    const { recDir } = await buildBrokenImport(id);
    await migration.up({ rootDir: ROOT });

    const snapshot = async () => ({
      sel: await readFile(join(recDir, 'walk', `${id}-walk-selection-v1.json`), 'utf8'),
      ws: await readFile(join(recDir, 'walk', `${id}-walk-set-v1.json`), 'utf8'),
      run: await readFile(join(recDir, 'runs', RUN_ID, 'animation-run.json'), 'utf8'),
    });
    const before = await snapshot();
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await snapshot()).toEqual(before);
  });

  it('leaves a self-consistent grok/-layout record (grok/ dir present) untouched', async () => {
    // A record whose runs still live under grok/ AND whose paths say grok/ is
    // internally consistent (or 202's pending move) — 203 must not touch it.
    const id = 'still-grok';
    const recDir = join(sprites(), id);
    await mkdir(join(recDir, 'grok', RUN_ID), { recursive: true });
    await mkdir(join(recDir, 'walk'), { recursive: true });
    const sel = {
      schemaVersion: 1, characterId: id, status: 'complete',
      directions: { 'south-east': { status: 'approved', runPath: `art-source/sprites/${id}/grok/${RUN_ID}`, approvedAt: 't' } },
    };
    await writeJson(join(recDir, 'walk', `${id}-walk-selection-v1.json`), sel);
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await readJson(join(recDir, 'walk', `${id}-walk-selection-v1.json`))).toEqual(sel);
  });

  it('leaves an already-neutral imported record (no grok/ residue) untouched', async () => {
    const id = 'clean-import';
    const recDir = join(sprites(), id);
    await mkdir(join(recDir, 'runs', RUN_ID), { recursive: true });
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
});
