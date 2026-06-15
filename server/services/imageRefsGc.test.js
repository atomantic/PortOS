import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm, utimes, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  sweepOrphanRefImages,
  collectReferencedRefBasenames,
  ORPHAN_REF_MAX_AGE_MS,
} from './imageRefsGc.js';

// Pin a clock so age math is deterministic.
const NOW = Date.parse('2026-06-12T00:00:00Z');
const OLD = NOW - ORPHAN_REF_MAX_AGE_MS - 60_000; // just past the grace window
const YOUNG = NOW - 60_000; // 1 min old — inside the window

let root;
let refsDir;
let imagesDir;

// Write a staged-upload file with a controlled mtime.
async function stageRef(name, mtimeMs = OLD) {
  const p = join(refsDir, name);
  await writeFile(p, 'x');
  const secs = mtimeMs / 1000;
  await utimes(p, secs, secs);
}

// Write a gallery sidecar that references the given init/reference basenames.
async function sidecar(jobId, { init = null, refs = [] } = {}) {
  await writeFile(
    join(imagesDir, `${jobId}.metadata.json`),
    JSON.stringify({ id: jobId, initImageFilename: init, referenceImageFilenames: refs }),
  );
}

beforeEach(async () => {
  root = join(tmpdir(), `portos-imagerefsgc-${process.pid}-${Math.floor(NOW)}-${Math.random().toString(36).slice(2)}`);
  refsDir = join(root, 'image-refs');
  imagesDir = join(root, 'images');
  await mkdir(refsDir, { recursive: true });
  await mkdir(imagesDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('collectReferencedRefBasenames', () => {
  it('collects init + reference basenames from every sidecar, deduped', async () => {
    await sidecar('job1', { init: 'init-aaa.png', refs: ['ref-bbb.png', 'ref-ccc.png'] });
    await sidecar('job2', { init: 'init-aaa.png' }); // duplicate init across renders
    const set = await collectReferencedRefBasenames(imagesDir);
    expect([...set].sort()).toEqual(['init-aaa.png', 'ref-bbb.png', 'ref-ccc.png']);
  });

  it('normalizes any path to a basename and tolerates absent/empty fields', async () => {
    await sidecar('job1', { init: '/abs/path/init-ddd.png', refs: [] });
    await sidecar('job2', {}); // both fields null/empty
    await writeFile(join(imagesDir, 'job3.metadata.json'), '{ not json'); // tolerated
    const set = await collectReferencedRefBasenames(imagesDir);
    expect([...set]).toEqual(['init-ddd.png']);
  });

  it('returns an empty set when the images dir is missing', async () => {
    const set = await collectReferencedRefBasenames(join(root, 'does-not-exist'));
    expect(set.size).toBe(0);
  });
});

describe('sweepOrphanRefImages', () => {
  // Staged uploads are always named from randomUUID(), so the discriminator
  // is hex+dash only — fixtures use UUID-shaped names to match real files.
  const ORPHAN_A = 'init-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa.png';
  const ORPHAN_B = 'ref-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb.png';
  const KEPT_INIT = 'init-cccccccc-3333-4333-8333-cccccccccccc.png';
  const KEPT_REF = 'ref-dddddddd-4444-4444-8444-dddddddddddd.png';
  const YOUNG_INIT = 'init-eeeeeeee-5555-4555-8555-eeeeeeeeeeee.png';

  it('deletes old, unreferenced staged uploads', async () => {
    await stageRef(ORPHAN_A, OLD);
    await stageRef(ORPHAN_B, OLD);
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res.deleted).toBe(2);
    expect(existsSync(join(refsDir, ORPHAN_A))).toBe(false);
    expect(existsSync(join(refsDir, ORPHAN_B))).toBe(false);
  });

  it('keeps a file still referenced by a gallery sidecar, even when old', async () => {
    await stageRef(KEPT_INIT, OLD);
    await sidecar('job1', { init: KEPT_INIT });
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res).toMatchObject({ deleted: 0, keptReferenced: 1 });
    expect(existsSync(join(refsDir, KEPT_INIT))).toBe(true);
  });

  it('keeps a referenced file named only in referenceImageFilenames', async () => {
    await stageRef(KEPT_REF, OLD);
    await sidecar('job1', { refs: [KEPT_REF] });
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res.deleted).toBe(0);
    expect(res.keptReferenced).toBe(1);
  });

  it('spares a young unreferenced file (codex / in-flight backstop)', async () => {
    await stageRef(YOUNG_INIT, YOUNG);
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res).toMatchObject({ deleted: 0, keptYoung: 1 });
    expect(existsSync(join(refsDir, YOUNG_INIT))).toBe(true);
  });

  it('never touches non-staged files (character sheets, others)', async () => {
    await stageRef('universe-14590a09-chr-cb8e-blueprint-aaa.png', OLD);
    await stageRef('sheet-something.png', OLD);
    await stageRef('random.png', OLD);
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res.deleted).toBe(0);
    const remaining = await readdir(refsDir);
    expect(remaining.sort()).toEqual([
      'random.png',
      'sheet-something.png',
      'universe-14590a09-chr-cb8e-blueprint-aaa.png',
    ]);
  });

  it('handles a mixed dir: deletes only old+unreferenced staged uploads', async () => {
    await stageRef(ORPHAN_A, OLD); // delete
    await stageRef(KEPT_REF, OLD); // keep (referenced)
    await stageRef(YOUNG_INIT, YOUNG); // keep (young)
    await stageRef('universe-x-blueprint.png', OLD); // keep (not staged pattern)
    await sidecar('job1', { refs: [KEPT_REF] });
    const res = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(res).toEqual({ deleted: 1, keptReferenced: 1, keptYoung: 1 });
    expect(existsSync(join(refsDir, ORPHAN_A))).toBe(false);
    expect(existsSync(join(refsDir, KEPT_REF))).toBe(true);
    expect(existsSync(join(refsDir, YOUNG_INIT))).toBe(true);
    expect(existsSync(join(refsDir, 'universe-x-blueprint.png'))).toBe(true);
  });

  it('is a no-op when the refs dir is missing or empty', async () => {
    const missing = await sweepOrphanRefImages({ now: NOW, refsDir: join(root, 'nope'), imagesDir });
    expect(missing).toEqual({ deleted: 0, keptReferenced: 0, keptYoung: 0 });
    const empty = await sweepOrphanRefImages({ now: NOW, refsDir, imagesDir });
    expect(empty).toEqual({ deleted: 0, keptReferenced: 0, keptYoung: 0 });
  });
});
