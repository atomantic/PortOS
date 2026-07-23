/**
 * On-disk asset deletion (#2930 follow-up): prune old runtime atlas versions
 * and superseded reference/candidate renders. Asserts the four guards —
 * confinement (traversal + record root), the state-index refusal, the
 * live-atlas refusal — plus the two delete shapes (a runtime version deletes
 * as a unit; every other asset deletes as the single file) and ENOENT
 * idempotency. assets.js imports the walk.js graph, so the same mocks as
 * atlas.test.js keep the import side-effect-free.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdir, writeFile, access } from 'fs/promises';
import { vi } from 'vitest';

const TEST_ROOT = mkdtempSync(join(tmpdir(), 'sprite-assets-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  Object.assign(actual.PATHS, { data: TEST_ROOT, sprites: join(TEST_ROOT, 'sprites') });
  return actual;
});
vi.mock('../settings.js', () => ({ getSettings: async () => ({ imageGen: { mode: 'codex' } }) }));
vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: () => ({ jobId: 'job-1', position: 0, status: 'queued' }),
  mediaJobEvents: { on: () => {}, off: () => {} },
}));

const { deleteSpriteAsset } = await import('./assets.js');

let seq = 0;
const newId = () => `assets-char-${++seq}`;
const recDir = (id) => join(TEST_ROOT, 'sprites', id);

async function writeFileAt(id, rel, contents = 'x') {
  const abs = join(recDir(id), rel);
  await mkdir(join(abs, '..'), { recursive: true });
  await writeFile(abs, contents);
  return abs;
}

const exists = (abs) => access(abs).then(() => true, () => false);

/** Seed vN with a PNG + sidecar manifest and a current.json pointing at `currentVersion`. */
async function seedRuntime(id, versions, currentVersion) {
  const stem = `${id}-animation-atlas`;
  for (const v of versions) {
    await writeFileAt(id, `runtime/v${v}/${stem}-v${v}.png`, `png-v${v}`);
    await writeFileAt(id, `runtime/v${v}/${stem}-v${v}-manifest.json`, '{}');
  }
  await writeFileAt(id, 'runtime/current.json', JSON.stringify({
    kind: 'runtime-atlas-selection',
    version: currentVersion,
    atlasPath: `runtime/v${currentVersion}/${stem}-v${currentVersion}.png`,
    manifestPath: `runtime/v${currentVersion}/${stem}-v${currentVersion}-manifest.json`,
  }));
}

afterAll(() => rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('deleteSpriteAsset', () => {
  it('deletes a superseded runtime version as a unit (PNG + manifest), leaving the current one', async () => {
    const id = newId();
    await seedRuntime(id, [9, 10], 10);
    const stem = `${id}-animation-atlas`;

    const res = await deleteSpriteAsset(id, `runtime/v9/${stem}-v9.png`);
    expect(res).toMatchObject({ deleted: true, removed: 'runtime/v9' });

    expect(await exists(join(recDir(id), `runtime/v9/${stem}-v9.png`))).toBe(false);
    expect(await exists(join(recDir(id), `runtime/v9/${stem}-v9-manifest.json`))).toBe(false);
    expect(await exists(join(recDir(id), 'runtime/v9'))).toBe(false);
    // Current version and pointer untouched.
    expect(await exists(join(recDir(id), `runtime/v10/${stem}-v10.png`))).toBe(true);
    expect(await exists(join(recDir(id), 'runtime/current.json'))).toBe(true);
  });

  it('refuses to delete the atlas the current pointer selects', async () => {
    const id = newId();
    await seedRuntime(id, [10], 10);
    const stem = `${id}-animation-atlas`;

    await expect(deleteSpriteAsset(id, `runtime/v10/${stem}-v10.png`))
      .rejects.toMatchObject({ code: 'ATLAS_IN_USE', status: 409 });
    // Nothing removed.
    expect(await exists(join(recDir(id), `runtime/v10/${stem}-v10.png`))).toBe(true);
  });

  it('refuses to delete the record state index files', async () => {
    const id = newId();
    await seedRuntime(id, [1], 1);

    for (const rel of ['runtime/current.json', 'runtime/publications.json']) {
      await writeFileAt(id, rel, '{}');
      await expect(deleteSpriteAsset(id, rel))
        .rejects.toMatchObject({ code: 'PROTECTED_STATE_FILE', status: 409 });
    }
    // Non-canonical spellings that resolve to the same protected file must be
    // refused too — the guard compares the confined path, not the raw input.
    for (const rel of ['./runtime/current.json', 'runtime//current.json']) {
      await expect(deleteSpriteAsset(id, rel))
        .rejects.toMatchObject({ code: 'PROTECTED_STATE_FILE', status: 409 });
    }
    expect(await exists(join(recDir(id), 'runtime/current.json'))).toBe(true);
  });

  it('deletes a single non-versioned asset (a superseded reference candidate)', async () => {
    const id = newId();
    const abs = await writeFileAt(id, 'reference/candidates/main-candidate-v3.png', 'png');
    await writeFileAt(id, 'reference/candidates/main-candidate-v4.png', 'png');

    const res = await deleteSpriteAsset(id, 'reference/candidates/main-candidate-v3.png');
    expect(res).toMatchObject({ deleted: true, removed: 'reference/candidates/main-candidate-v3.png' });
    expect(await exists(abs)).toBe(false);
    // Sibling untouched — a single-file delete never removes the directory.
    expect(await exists(join(recDir(id), 'reference/candidates/main-candidate-v4.png'))).toBe(true);
  });

  it('rejects traversal and the record root', async () => {
    const id = newId();
    await writeFileAt(id, 'reference/main.png', 'png');
    await expect(deleteSpriteAsset(id, '../other/secret.png'))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' });
    await expect(deleteSpriteAsset(id, '.'))
      .rejects.toMatchObject({ code: 'INVALID_ASSET_PATH' });
  });

  it('is idempotent for an already-gone file (force swallows ENOENT)', async () => {
    const id = newId();
    await mkdir(recDir(id), { recursive: true });
    const res = await deleteSpriteAsset(id, 'reference/never-existed.png');
    expect(res).toMatchObject({ deleted: true });
  });
});
