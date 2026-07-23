/**
 * Publish-to-managed-app (#2898): binding validation (app existence, repo
 * anchoring, traversal refusal), atomic destination replace, diverged-
 * destination refusal, idempotent re-publish, occurrence-count-guarded code
 * binding verify/rewrite, and the publish history. The atlas compiler is
 * mocked (covered by atlas.test.js) — these tests own everything after it.
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

const getAppById = vi.fn(async (id) => (id === 'game-app'
  ? { id: 'game-app', name: 'Example Game', repoPath: APP_REPO }
  : null));
vi.mock('../apps.js', () => ({ getAppById: (...args) => getAppById(...args) }));

const isDeploying = vi.fn(() => false);
vi.mock('../appDeployer.js', () => ({ isDeploying: (...args) => isDeploying(...args) }));

const compileAtlasInTail = vi.fn();
vi.mock('./atlas.js', () => ({
  compileAtlasInTail: (...args) => compileAtlasInTail(...args),
}));

const records = await import('./records.js');
const { setPublishBinding, publishAtlas, validatePublishBinding } = await import('./publish.js');

let seq = 0;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

async function characterWithAtlas(atlasBytes = 'atlas-png-bytes-v1') {
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
  await mkdir(APP_REPO, { recursive: true });
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
      created: true, version: 2, atlasPath: nextRel, atlasSha256: sha256(Buffer.from(nextBytes)),
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
      created: true, version: 2, atlasPath: nextRel, atlasSha256: sha256(Buffer.from(nextBytes)),
    });
    await expect(publishAtlas(id)).rejects.toMatchObject({ status: 409, code: 'CODE_BINDING_DRIFTED' });
    // The drifted binding aborted BEFORE the atlas was replaced.
    expect((await readFile(join(APP_REPO, BINDING.atlasDestPath))).toString()).toBe('atlas-png-bytes-v1');
  });

  it('rewrites an occurrence-guarded moved resource path', async () => {
    const { id } = await characterWithAtlas();
    const oldResource = 'res://assets/sprites/hero/old-atlas.png';
    const newResource = 'res://assets/sprites/hero/hero-atlas.png';
    await mkdir(join(APP_REPO, 'src'), { recursive: true });
    await writeFile(join(APP_REPO, 'src/Hero.cs'), `var atlas = load("${oldResource}");\n`);

    // Simulate a previous publish that recorded the old resource path.
    await setPublishBinding(id, {
      ...BINDING,
      codeBinding: { path: 'src/Hero.cs', resourcePath: oldResource },
    });
    await publishAtlas(id);

    // Destination moved: same dest bytes, new resource path in the binding.
    await setPublishBinding(id, {
      ...BINDING,
      codeBinding: { path: 'src/Hero.cs', resourcePath: newResource },
    });
    const result = await publishAtlas(id);
    expect(result.published).toBe(false); // dest bytes unchanged — binding-only fix
    expect(result.codeBinding).toMatchObject({ rewritten: true, previousResourcePath: oldResource });
    expect(await readFile(join(APP_REPO, 'src/Hero.cs'), 'utf8')).toContain(newResource);
  });
});
