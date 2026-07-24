/**
 * Publish-to-managed-app (#2898): binding validation (app existence, repo
 * anchoring, traversal refusal), atomic destination replace, diverged-
 * destination refusal, idempotent re-publish, occurrence-count-guarded code
 * binding verify/rewrite, and the publish history. The atlas compiler is
 * mocked (covered by atlas.test.js) — these tests own everything after it.
 *
 * Also covers the export contract (#2982): the optional runtimeContract's
 * shape validation, the publish-time geometry guard, and the layout.json
 * sidecar written beside the published PNG.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { createHash } from 'crypto';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-publish-test-'));
const APP_REPO = join(TEST_ROOT, 'game-repo');

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, {
    data: TEST_ROOT,
    sprites: join(TEST_ROOT, 'sprites'),
  });
  return actual;
});

const OTHER_APP_REPO = join(TEST_ROOT, 'other-game-repo');
const APPS = {
  'game-app': { id: 'game-app', name: 'Example Game', repoPath: APP_REPO },
  'other-app': { id: 'other-app', name: 'Other Example Game', repoPath: OTHER_APP_REPO },
};
const getAppById = vi.fn(async (id) => APPS[id] || null);
vi.mock('../apps.js', () => ({ getAppById: (...args) => getAppById(...args) }));

const isDeploying = vi.fn(() => false);
vi.mock('../appDeployer.js', () => ({ isDeploying: (...args) => isDeploying(...args) }));

const compileAtlasInTail = vi.fn();
vi.mock('./atlas.js', () => ({
  compileAtlasInTail: (...args) => compileAtlasInTail(...args),
}));

const records = await import('./records.js');
const { setPublishBinding, publishAtlas, validatePublishBinding } = await import('./publish.js');
const { walkPhaseLabels } = await import('./walkBounds.js');

let seq = 0;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const { SPRITE_DIRECTIONS: DIRECTIONS } = await import('./prompts.js');

// The geometry block a real compile writes into the runtime pointer — the
// publish path reads it for the contract guard and the layout sidecar.
const atlasGeometry = (walkFrameCount = 8, overrides = {}) => ({
  columns: ['idle', ...walkPhaseLabels(walkFrameCount), 'scanner'],
  directionOrder: DIRECTIONS,
  rows: DIRECTIONS.length,
  cellSize: 96,
  walkFrameCount,
  walkFps: 12,
  ...overrides,
});

const sidecarPath = (destPath) => destPath.replace(/\.png$/, '.layout.json');
const readSidecar = async (destPath) =>
  JSON.parse(await readFile(join(APP_REPO, sidecarPath(destPath)), 'utf8'));

async function characterWithAtlas(atlasBytes = 'atlas-png-bytes-v1', geometry = atlasGeometry()) {
  const id = `pub-char-${++seq}`;
  await records.createRecord({ kind: 'character', name: 'Publisher' }, id);
  const atlasRel = `runtime/v1/${id}-animation-atlas-v1.png`;
  const abs = join(TEST_ROOT, 'sprites', id, atlasRel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, atlasBytes);
  compileAtlasInTail.mockResolvedValue({
    created: false,
    version: 1,
    atlasPath: atlasRel,
    atlasSha256: sha256(Buffer.from(atlasBytes)),
    geometry,
  });
  return { id, atlasRel, atlasBytes };
}

const BINDING = { appId: 'game-app', atlasDestPath: 'assets/sprites/hero/hero-atlas.png' };

beforeEach(async () => {
  getAppById.mockClear();
  isDeploying.mockReset();
  isDeploying.mockReturnValue(false);
  compileAtlasInTail.mockReset();
  rmSync(join(TEST_ROOT, 'sprite-records.json'), { force: true });
  rmSync(APP_REPO, { recursive: true, force: true });
  rmSync(OTHER_APP_REPO, { recursive: true, force: true });
  await mkdir(APP_REPO, { recursive: true });
  await mkdir(OTHER_APP_REPO, { recursive: true });
});
afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('validatePublishBinding / setPublishBinding', () => {
  it('persists a normalized binding on the record', async () => {
    const { id } = await characterWithAtlas();
    const updated = await setPublishBinding(id, {
      ...BINDING,
      codeBinding: { path: 'src/Hero.cs', resourcePath: 'res://assets/sprites/hero/hero-atlas.png' },
    });
    expect(updated.publishBinding).toEqual({
      appId: 'game-app',
      atlasDestPath: 'assets/sprites/hero/hero-atlas.png',
      codeBinding: {
        path: 'src/Hero.cs',
        resourcePath: 'res://assets/sprites/hero/hero-atlas.png',
        requiredOccurrenceCount: 1,
      },
      runtimeContract: null,
    });
  });

  it('clears with null', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    const cleared = await setPublishBinding(id, null);
    expect(cleared.publishBinding).toBeNull();
  });

  it('refuses an unknown app and a traversal destination', async () => {
    await expect(validatePublishBinding({ ...BINDING, appId: 'nope' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_APP' });
    await expect(validatePublishBinding({ ...BINDING, atlasDestPath: '../outside.png' }))
      .rejects.toMatchObject({ code: 'INVALID_PUBLISH_PATH' });
    await expect(validatePublishBinding({ ...BINDING, atlasDestPath: '/abs/path.png' }))
      .rejects.toMatchObject({ code: 'INVALID_PUBLISH_PATH' });
    // Non-.png destinations die at the route's Zod schema (spritePublishBindingSchema).
  });

  it('validates the runtimeContract shape at save time', async () => {
    const { id } = await characterWithAtlas();
    const saved = await setPublishBinding(id, {
      ...BINDING,
      runtimeContract: { walkFrameCount: 8, cellSize: 96, columnCount: 10 },
    });
    expect(saved.publishBinding.runtimeContract).toEqual({
      walkFrameCount: 8, cellSize: 96, columnCount: 10,
    });

    for (const bad of [
      { walkFrameCount: 0 },
      { walkFrameCount: 99 },
      { walkFrameCount: 8.5 },
      { cellSize: 96 },
      { walkFrameCount: 8, cellSize: 'big' },
      { walkFrameCount: 8, columnCount: -1 },
    ]) {
      await expect(validatePublishBinding({ ...BINDING, runtimeContract: bad }))
        .rejects.toMatchObject({ status: 400, code: 'INVALID_RUNTIME_CONTRACT' });
    }
    await expect(validatePublishBinding({ ...BINDING, runtimeContract: [8] }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_RUNTIME_CONTRACT' });
  });

  it('inherits an omitted runtimeContract and clears it only on an explicit null', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, { ...BINDING, runtimeContract: { walkFrameCount: 8 } });

    // The publish form saves appId/dest/codeBinding only — an omitted key must
    // not silently wipe the contract the app declared through the API.
    const resaved = await setPublishBinding(id, { ...BINDING, atlasDestPath: 'assets/sprites/hero/moved.png' });
    expect(resaved.publishBinding.runtimeContract).toEqual({ walkFrameCount: 8, cellSize: null, columnCount: null });

    const cleared = await setPublishBinding(id, { ...BINDING, runtimeContract: null });
    expect(cleared.publishBinding.runtimeContract).toBeNull();
  });

  it('does not carry a contract across a re-point to a different app', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, { ...BINDING, runtimeContract: { walkFrameCount: 8 } });
    // The contract describes the grid ONE app was built against — holding a
    // different app to it would 409 every publish against an expectation it
    // never declared.
    const repointed = await setPublishBinding(id, { ...BINDING, appId: 'other-app' });
    expect(repointed.publishBinding.runtimeContract).toBeNull();
  });
});

describe('publishAtlas', () => {
  it('refuses without a binding', async () => {
    const { id } = await characterWithAtlas();
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_BINDING_REQUIRED' });
  });

  it('atomically writes the atlas into the app repo and records the publication', async () => {
    const { id, atlasBytes } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    const result = await publishAtlas(id);

    expect(result.published).toBe(true);
    const destAbs = join(APP_REPO, BINDING.atlasDestPath);
    expect((await readFile(destAbs)).toString()).toBe(atlasBytes);
    expect(result.publication).toMatchObject({
      appId: 'game-app',
      appName: 'Example Game',
      atlasDestPath: BINDING.atlasDestPath,
      version: 1,
      destPreviousSha256: null,
      codeBinding: null,
    });
    const history = JSON.parse(
      await readFile(join(TEST_ROOT, 'sprites', id, 'runtime/publications.json'), 'utf8'),
    );
    expect(history).toHaveLength(1);
  });

  it('is idempotent when the destination already holds the current bytes', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await publishAtlas(id);
    const again = await publishAtlas(id);
    expect(again.published).toBe(false);
    expect(again.upToDate).toBe(true);
    const history = JSON.parse(
      await readFile(join(TEST_ROOT, 'sprites', id, 'runtime/publications.json'), 'utf8'),
    );
    expect(history).toHaveLength(1);
  });

  it('refuses a destination changed outside PortOS since the previous publish', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await publishAtlas(id);
    await writeFile(join(APP_REPO, BINDING.atlasDestPath), 'hand-edited-in-game-repo');
    // A NEW compiled atlas (different bytes) must refuse rather than clobber.
    const nextBytes = 'atlas-png-bytes-v2';
    const nextRel = `runtime/v2/${id}-animation-atlas-v2.png`;
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runtime/v2'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, nextRel), nextBytes);
    compileAtlasInTail.mockResolvedValue({
      created: true, version: 2, atlasPath: nextRel, atlasSha256: sha256(Buffer.from(nextBytes)), geometry: atlasGeometry(),
    });
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_DEST_DIVERGED' });
  });

  it('refuses an occupied destination it never published unless acknowledged', async () => {
    const { id, atlasBytes } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await mkdir(join(APP_REPO, 'assets/sprites/hero'), { recursive: true });
    await writeFile(join(APP_REPO, BINDING.atlasDestPath), 'hand-made-atlas-from-before-portos');

    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_DEST_OCCUPIED' });
    // Explicit acknowledgment replaces it and records the prior sha.
    const acked = await publishAtlas(id, { acknowledgeOverwrite: true });
    expect(acked.published).toBe(true);
    expect(acked.publication.destPreviousSha256).toBe(sha256(Buffer.from('hand-made-atlas-from-before-portos')));
    expect((await readFile(join(APP_REPO, BINDING.atlasDestPath))).toString()).toBe(atlasBytes);
  });

  it('refuses to publish while the app is deploying', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    isDeploying.mockReturnValue(true);
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'APP_DEPLOY_IN_PROGRESS' });
    expect(isDeploying).toHaveBeenCalledWith(APP_REPO);
  });

  it('verifies the code binding by occurrence count and refuses drift', async () => {
    const { id } = await characterWithAtlas();
    const resource = 'res://assets/sprites/hero/hero-atlas.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    await writeFile(join(APP_REPO, 'src/Hero.cs'), `var atlas = load("${resource}");\n`);
    await setPublishBinding(id, {
      ...BINDING,
      codeBinding: { path: 'src/Hero.cs', resourcePath: resource },
    });
    const ok = await publishAtlas(id);
    expect(ok.published).toBe(true);
    expect(ok.publication.codeBinding).toMatchObject({ rewritten: false });

    // Drift: the resource path appears twice now.
    await writeFile(join(APP_REPO, 'src/Hero.cs'), `load("${resource}"); load("${resource}");\n`);
    const nextBytes = 'atlas-png-bytes-v2';
    const nextRel = `runtime/v2/${id}-animation-atlas-v2.png`;
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runtime/v2'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, nextRel), nextBytes);
    compileAtlasInTail.mockResolvedValue({
      created: true, version: 2, atlasPath: nextRel, atlasSha256: sha256(Buffer.from(nextBytes)), geometry: atlasGeometry(),
    });
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'CODE_BINDING_DRIFTED' });
    // The drifted binding aborted BEFORE the atlas was replaced.
    expect((await readFile(join(APP_REPO, BINDING.atlasDestPath))).toString()).toBe('atlas-png-bytes-v1');
  });

  it('rewrites the code binding on a real destination move (baseline follows the file, not the dest)', async () => {
    const { id } = await characterWithAtlas();
    const oldResource = 'res://assets/sprites/hero/old-name.png';
    const newResource = 'res://assets/sprites/hero/new-name.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    await writeFile(join(APP_REPO, 'src/Hero.cs'), `var atlas = load("${oldResource}");\n`);

    await setPublishBinding(id, {
      appId: 'game-app',
      atlasDestPath: 'assets/sprites/hero/old-name.png',
      codeBinding: { path: 'src/Hero.cs', resourcePath: oldResource },
    });
    await publishAtlas(id);

    // Real move: atlasDestPath AND resourcePath both change. The code-binding
    // baseline must be found via the file (appId + codeBinding.path), because
    // no publication exists for the NEW destination yet.
    await setPublishBinding(id, {
      appId: 'game-app',
      atlasDestPath: 'assets/sprites/hero/new-name.png',
      codeBinding: { path: 'src/Hero.cs', resourcePath: newResource },
    });
    const result = await publishAtlas(id);
    expect(result.published).toBe(true);
    expect(result.publication.codeBinding).toMatchObject({ rewritten: true, previousResourcePath: oldResource });
    expect(await readFile(join(APP_REPO, 'src/Hero.cs'), 'utf8')).toContain(newResource);
  });

  it('records a publication when an up-to-date publish rewrites the code binding', async () => {
    const { id } = await characterWithAtlas();
    const oldResource = 'res://assets/sprites/hero/old-atlas.png';
    const newResource = 'res://assets/sprites/hero/hero-atlas.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    await writeFile(join(APP_REPO, 'src/Hero.cs'), `var atlas = load("${oldResource}");\n`);
    await setPublishBinding(id, { ...BINDING, codeBinding: { path: 'src/Hero.cs', resourcePath: oldResource } });
    await publishAtlas(id);

    // Same dest bytes, new resource path → binding-only fix, but the game
    // source WAS mutated, so history must say so.
    await setPublishBinding(id, { ...BINDING, codeBinding: { path: 'src/Hero.cs', resourcePath: newResource } });
    const result = await publishAtlas(id);
    expect(result.published).toBe(false);
    expect(result.codeBinding).toMatchObject({ rewritten: true, previousResourcePath: oldResource });
    expect(result.publication).toMatchObject({ upToDateBaseline: true });
    const history = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, 'runtime/publications.json'), 'utf8'));
    expect(history).toHaveLength(2);
    // The recorded baseline lets a THIRD publish see the current resource path.
    const third = await publishAtlas(id);
    expect(third.published).toBe(false);
    expect(third.codeBinding).toMatchObject({ rewritten: false });
  });

  it('seeds a history baseline when the first publish finds its own bytes already at the destination', async () => {
    const { id, atlasBytes } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await mkdir(join(APP_REPO, 'assets/sprites/hero'), { recursive: true });
    await writeFile(join(APP_REPO, BINDING.atlasDestPath), atlasBytes);

    const first = await publishAtlas(id);
    expect(first.upToDate).toBe(true);
    expect(first.publication).toMatchObject({ upToDateBaseline: true });

    // A later changed atlas now reads as DIVERGED-checkable, not OCCUPIED.
    const nextBytes = 'atlas-png-bytes-v2';
    const nextRel = `runtime/v2/${id}-animation-atlas-v2.png`;
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runtime/v2'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, nextRel), nextBytes);
    compileAtlasInTail.mockResolvedValue({
      created: true, version: 2, atlasPath: nextRel, atlasSha256: sha256(Buffer.from(nextBytes)), geometry: atlasGeometry(),
    });
    const second = await publishAtlas(id);
    expect(second.published).toBe(true);
  });

  it('reuses the current pointer geometry when compiling for publish', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);

    // No pointer yet → default geometry (undefined override).
    await publishAtlas(id);
    expect(compileAtlasInTail).toHaveBeenLastCalledWith(id, { geometry: undefined });

    // A pointer with custom geometry → publish compiles with exactly it.
    const geometry = { cellSize: 64, pivot: [32, 56], targetMaxHeight: 44, targetMaxWidth: 52 };
    await writeFile(
      join(TEST_ROOT, 'sprites', id, 'runtime/current.json'),
      JSON.stringify({ version: 1, atlasPath: `runtime/v1/${id}-animation-atlas-v1.png`, geometry }),
    );
    await publishAtlas(id);
    expect(compileAtlasInTail).toHaveBeenLastCalledWith(id, { geometry });
  });

  it('refuses to ship a tampered or missing compiled atlas file', async () => {
    const { id, atlasRel } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await writeFile(join(TEST_ROOT, 'sprites', id, atlasRel), 'tampered-after-compile');
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 422, code: 'ATLAS_OUTPUT_TAMPERED' });
    rmSync(join(TEST_ROOT, 'sprites', id, atlasRel));
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 422, code: 'ATLAS_OUTPUT_MISSING' });
    expect(await readFile(join(APP_REPO, BINDING.atlasDestPath)).catch(() => null)).toBeNull();
  });
});

describe('runtime contract guard (#2982)', () => {
  it('publishes when the compiled geometry matches the declared contract', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, {
      ...BINDING,
      runtimeContract: { walkFrameCount: 8, cellSize: 96, columnCount: 10 },
    });
    const result = await publishAtlas(id);
    expect(result.published).toBe(true);
  });

  it('refuses a frame-count mismatch with both counts named, leaving the repo untouched', async () => {
    const { id } = await characterWithAtlas('atlas-png-bytes-12f', atlasGeometry(12));
    await setPublishBinding(id, {
      ...BINDING,
      runtimeContract: { walkFrameCount: 8, cellSize: 96, columnCount: 10 },
    });
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_CONTRACT_MISMATCH' });
    await expect(publishAtlas(id)).rejects.toThrow(/14 columns \(12 walk frames\).*expects 10 \(8 walk frames\)/s);
    await expect(publishAtlas(id)).rejects.toThrow(/reprocess this walk set to 8 frames/);
    // Nothing landed in the game repo — not the atlas, not the sidecar.
    expect(await readFile(join(APP_REPO, BINDING.atlasDestPath)).catch(() => null)).toBeNull();
    expect(await readFile(join(APP_REPO, sidecarPath(BINDING.atlasDestPath))).catch(() => null)).toBeNull();
  });

  it('refuses a cell-size mismatch', async () => {
    const { id } = await characterWithAtlas('atlas-png-bytes-64px', atlasGeometry(8, { cellSize: 64 }));
    await setPublishBinding(id, { ...BINDING, runtimeContract: { walkFrameCount: 8, cellSize: 96 } });
    await expect(publishAtlas(id)).rejects.toThrow(/cells are 64px but Example Game expects 96px/);
  });

  it('publishes a non-8-frame atlas unchecked when no contract is declared', async () => {
    const { id } = await characterWithAtlas('atlas-png-bytes-12f', atlasGeometry(12));
    await setPublishBinding(id, BINDING);
    const result = await publishAtlas(id);
    expect(result.published).toBe(true);
    expect((await readSidecar(BINDING.atlasDestPath)).walkFrameCount).toBe(12);
  });
});

describe('layout sidecar (#2982)', () => {
  it('writes the sidecar beside the atlas with the column list the atlas actually has', async () => {
    const { id, atlasBytes } = await characterWithAtlas('atlas-png-bytes-12f', atlasGeometry(12));
    await setPublishBinding(id, BINDING);
    const result = await publishAtlas(id);

    const layout = await readSidecar(BINDING.atlasDestPath);
    expect(layout).toMatchObject({
      schemaVersion: 1,
      kind: 'portos-sprite-atlas-layout',
      characterId: id,
      atlasFile: 'hero-atlas.png',
      cellSize: 96,
      rows: 8,
      walkFrameCount: 12,
      columnCount: 14,
      previewFps: 12,
      sourceAtlasSha256: sha256(Buffer.from(atlasBytes)),
    });
    expect(layout.columns[0]).toBe('idle');
    expect(layout.columns.at(-1)).toBe('scanner');
    expect(layout.columns).toHaveLength(14);
    // Per-track spans so a future multi-frame track is additive, not a rewrite.
    expect(layout.tracks).toEqual({
      idle: { start: 0, count: 1 },
      walk: { start: 1, count: 12 },
      scanner: { start: 13, count: 1 },
    });
    // previewFps travels labeled as authoring-only — the app must not animate from it.
    expect(layout.previewFpsNote).toMatch(/Authoring metadata only/);
    expect(result.publication).toMatchObject({ layoutDestPath: 'assets/sprites/hero/hero-atlas.layout.json' });
  });

  it('is a no-op on an unchanged republish but self-heals a deleted sidecar', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await publishAtlas(id);

    const again = await publishAtlas(id);
    expect(again.upToDate).toBe(true);
    expect(again.layoutWritten).toBe(false);
    let history = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, 'runtime/publications.json'), 'utf8'));
    expect(history).toHaveLength(1);

    // The atlas is still current but its sidecar was deleted in the game repo —
    // the pair must converge rather than leave the atlas undescribed.
    rmSync(join(APP_REPO, sidecarPath(BINDING.atlasDestPath)));
    const healed = await publishAtlas(id);
    expect(healed.upToDate).toBe(true);
    expect(healed.layoutWritten).toBe(true);
    expect((await readSidecar(BINDING.atlasDestPath)).walkFrameCount).toBe(8);
    history = JSON.parse(await readFile(join(TEST_ROOT, 'sprites', id, 'runtime/publications.json'), 'utf8'));
    expect(history).toHaveLength(2);
  });

  it('rewrites the sidecar when the atlas changes', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await publishAtlas(id);
    expect((await readSidecar(BINDING.atlasDestPath)).walkFrameCount).toBe(8);

    const nextBytes = 'atlas-png-bytes-v2';
    const nextRel = `runtime/v2/${id}-animation-atlas-v2.png`;
    await mkdir(join(TEST_ROOT, 'sprites', id, 'runtime/v2'), { recursive: true });
    await writeFile(join(TEST_ROOT, 'sprites', id, nextRel), nextBytes);
    compileAtlasInTail.mockResolvedValue({
      created: true,
      version: 2,
      atlasPath: nextRel,
      atlasSha256: sha256(Buffer.from(nextBytes)),
      geometry: atlasGeometry(10),
    });
    const result = await publishAtlas(id);
    expect(result.published).toBe(true);
    expect(result.layoutWritten).toBe(true);
    const layout = await readSidecar(BINDING.atlasDestPath);
    expect(layout).toMatchObject({
      walkFrameCount: 10, columnCount: 12, atlasVersion: 2, sourceAtlasSha256: sha256(Buffer.from(nextBytes)),
    });
  });

  it('refuses to replace a sidecar PortOS did not write unless acknowledged', async () => {
    const { id } = await characterWithAtlas();
    await setPublishBinding(id, BINDING);
    await mkdir(join(APP_REPO, 'assets/sprites/hero'), { recursive: true });
    await writeFile(join(APP_REPO, sidecarPath(BINDING.atlasDestPath)), '{"kind":"someone-elses-file"}');

    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_LAYOUT_OCCUPIED' });
    // The refusal aborts before the atlas lands.
    expect(await readFile(join(APP_REPO, BINDING.atlasDestPath)).catch(() => null)).toBeNull();

    const acked = await publishAtlas(id, { acknowledgeOverwrite: true });
    expect(acked.published).toBe(true);
    expect((await readSidecar(BINDING.atlasDestPath)).kind).toBe('portos-sprite-atlas-layout');
  });

  it('refuses an occupied sidecar BEFORE rewriting the game source', async () => {
    const { id } = await characterWithAtlas();
    const oldResource = 'res://assets/sprites/hero/old-name.png';
    const newResource = 'res://assets/sprites/hero/hero-atlas.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    const sourceBefore = `var atlas = load("${oldResource}");\n`;
    await writeFile(join(APP_REPO, 'src/Hero.cs'), sourceBefore);
    // A pending code-binding REWRITE (the previous publish recorded the old
    // resource path) plus a foreign sidecar at the destination.
    await setPublishBinding(id, {
      appId: 'game-app',
      atlasDestPath: 'assets/sprites/hero/old-name.png',
      codeBinding: { path: 'src/Hero.cs', resourcePath: oldResource },
    });
    await publishAtlas(id);
    await setPublishBinding(id, { ...BINDING, codeBinding: { path: 'src/Hero.cs', resourcePath: newResource } });
    await writeFile(join(APP_REPO, sidecarPath(BINDING.atlasDestPath)), 'not even json');

    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_LAYOUT_OCCUPIED' });
    // The refusal must land before applyCodeBinding mutates the game source —
    // otherwise the source points at an atlas this publish declined to write.
    expect(await readFile(join(APP_REPO, 'src/Hero.cs'), 'utf8')).toBe(sourceBefore);
    expect(await readFile(join(APP_REPO, BINDING.atlasDestPath)).catch(() => null)).toBeNull();
  });

  it('refuses an occupied sidecar before rewriting the game source on the up-to-date path too', async () => {
    const { id, atlasBytes } = await characterWithAtlas();
    const oldResource = 'res://assets/sprites/hero/old-name.png';
    const newResource = 'res://assets/sprites/hero/hero-atlas.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    const sourceBefore = `var atlas = load("${oldResource}");\n`;
    await writeFile(join(APP_REPO, 'src/Hero.cs'), sourceBefore);
    await setPublishBinding(id, {
      appId: 'game-app',
      atlasDestPath: 'assets/sprites/hero/old-name.png',
      codeBinding: { path: 'src/Hero.cs', resourcePath: oldResource },
    });
    await publishAtlas(id);

    // The NEW destination already holds the current atlas bytes, so the publish
    // takes the up-to-date branch — which still rewrites the game source, and
    // so must also refuse the foreign sidecar before doing it.
    await setPublishBinding(id, { ...BINDING, codeBinding: { path: 'src/Hero.cs', resourcePath: newResource } });
    await writeFile(join(APP_REPO, BINDING.atlasDestPath), atlasBytes);
    await writeFile(join(APP_REPO, sidecarPath(BINDING.atlasDestPath)), '{"kind":"someone-elses-file"}');

    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'PUBLISH_LAYOUT_OCCUPIED' });
    expect(await readFile(join(APP_REPO, 'src/Hero.cs'), 'utf8')).toBe(sourceBefore);
  });

  it('refuses to publish an atlas whose geometry carries no column layout', async () => {
    const { id } = await characterWithAtlas('atlas-png-bytes-nogeo', undefined);
    compileAtlasInTail.mockResolvedValue({
      created: false,
      version: 1,
      atlasPath: `runtime/v1/${id}-animation-atlas-v1.png`,
      atlasSha256: sha256(Buffer.from('atlas-png-bytes-nogeo')),
    });
    await setPublishBinding(id, BINDING);
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 422, code: 'ATLAS_GEOMETRY_UNKNOWN' });
    expect(await readFile(join(APP_REPO, BINDING.atlasDestPath)).catch(() => null)).toBeNull();
  });
});
