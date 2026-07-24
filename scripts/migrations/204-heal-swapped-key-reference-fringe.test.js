/**
 * Migration 204 — re-normalize main-reference sprites that were locked with a
 * chroma-key swap so the leftover old-key (magenta) fringe is decontaminated.
 * Builds a locked record whose on-disk main-reference PNG still carries the
 * magenta halo (the pre-#2963 verbatim-copy output), then asserts the migration
 * re-derives the reference from its preserved candidate, removes the halo,
 * repins the content sha on both the main reference and the shared south
 * anchor, and leaves same-key / already-clean records alone.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import migration from './204-heal-swapped-key-reference-fringe.js';

let ROOT;
const sprites = () => join(ROOT, 'data', 'sprites');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const shaFile = async (abs) => sha(await readFile(abs));
const readJson = async (abs) => JSON.parse(await readFile(abs, 'utf8'));
const writeJson = (abs, obj) => writeFile(abs, JSON.stringify(obj, null, 2));

const MAGENTA = { r: 255, g: 0, b: 255 };
const GREEN = { r: 0, g: 255, b: 0 };
const FRINGE = { r: 204, g: 51, b: 204 }; // 0.8 magenta / 0.2 green — survives the mask

// 64×64 magenta candidate: green rect + an anti-aliased magenta/green fringe
// column just left of it (the source the lock masked against magenta).
async function fringeCandidatePng() {
  const w = 64; const h = 64;
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = MAGENTA;
      if (x >= 20 && x < 30 && y >= 10 && y < 30) c = GREEN;
      else if (x === 19 && y >= 10 && y < 30) c = FRINGE;
      const i = (y * w + x) * 3;
      buf[i] = c.r; buf[i + 1] = c.g; buf[i + 2] = c.b;
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer();
}

// Scan a locked reference PNG for magenta-dominant (old-key halo) pixels.
async function magentaHaloCount(abs) {
  const { data, info } = await sharp(abs).raw().toBuffer({ resolveWithObject: true });
  let halo = 0;
  for (let p = 0; p < info.width * info.height; p++) {
    const r = data[p * info.channels];
    const g = data[p * info.channels + 1];
    const b = data[p * info.channels + 2];
    if (r > 150 && b > 150 && g < 120) halo++;
  }
  return halo;
}

// A locked main reference in the broken (swapped-key, fringe-left) state:
// generation key magenta, selected key blue, and the on-disk locked PNG is the
// raw candidate (stand-in for the pre-fix verbatim-copy output — any bytes that
// differ from the decontaminated re-normalize exercise the repair path).
async function buildLockedRecord(id, { genKey = '#FF00FF', canvasKey = '#0000FF' } = {}) {
  const recDir = join(sprites(), id);
  const candDir = join(recDir, 'reference', 'candidates');
  await mkdir(candDir, { recursive: true });

  const candPng = await fringeCandidatePng();
  await writeFile(join(candDir, 'walk-south-candidate-01.png'), candPng);
  await writeJson(join(candDir, 'walk-south-candidate-01.generation.json'), {
    schemaVersion: 1, kind: 'sprite-reference-generation', characterId: id,
    target: 'main', anchorId: 'walk-south', direction: 'south', chromaKey: genKey,
  });

  const lockedRel = `reference/${id}-walk-south-v1.png`;
  const lockedAbs = join(recDir, lockedRel);
  await writeFile(lockedAbs, candPng); // fringed stand-in
  const lockedSha = sha(candPng);

  await writeJson(join(recDir, 'reference', `${id}-reference-set-v1.json`), {
    schemaVersion: 1, manifestId: `${id}-reference-set-v1`, status: 'in-progress',
    chromaKey: canvasKey, chromaKeyAutoSelected: true,
    mainReference: {
      path: lockedRel, role: 'immutable-root', background: 'chroma-key',
      locked: true, lockedFrom: 'reference/candidates/walk-south-candidate-01.png',
      lockedAt: 't', sha256: lockedSha,
    },
    anchors: [
      { id: 'walk-south', kind: 'walk-anchor', direction: 'south', status: 'locked', path: lockedRel, sha256: lockedSha },
      { id: 'walk-north', kind: 'walk-anchor', direction: 'north', status: 'pending' },
    ],
  });
  return { recDir, lockedAbs, lockedSha };
}

beforeEach(() => { ROOT = mkdtempSync(join(tmpdir(), 'mig-204-')); });
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('migration 204 — heal swapped-key reference fringe', () => {
  it('re-normalizes the locked main, removes the magenta halo, and repins shas', async () => {
    const id = 'xeno-fixture';
    const { recDir, lockedAbs, lockedSha } = await buildLockedRecord(id);
    expect(await magentaHaloCount(lockedAbs)).toBeGreaterThan(0); // fringed before

    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 1 });

    expect(await magentaHaloCount(lockedAbs)).toBe(0); // halo gone after re-key
    const newSha = await shaFile(lockedAbs);
    expect(newSha).not.toBe(lockedSha);

    const manifest = await readJson(join(recDir, 'reference', `${id}-reference-set-v1.json`));
    expect(manifest.mainReference.sha256).toBe(newSha);
    const south = manifest.anchors.find((a) => a.id === 'walk-south');
    expect(south.sha256).toBe(newSha); // shared file — sha repinned
    // Identity is preserved: same selected key, same lockedFrom candidate.
    expect(manifest.chromaKey).toBe('#0000FF');
    expect(manifest.mainReference.lockedFrom).toBe('reference/candidates/walk-south-candidate-01.png');
  });

  it('is idempotent — a second run re-derives identical bytes and reports migrated: 0', async () => {
    const id = 'xeno-idem';
    const { recDir, lockedAbs } = await buildLockedRecord(id);
    await migration.up({ rootDir: ROOT });
    const healed = await shaFile(lockedAbs);
    const manifest = await readFile(join(recDir, 'reference', `${id}-reference-set-v1.json`), 'utf8');

    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await shaFile(lockedAbs)).toBe(healed);
    expect(await readFile(join(recDir, 'reference', `${id}-reference-set-v1.json`), 'utf8')).toBe(manifest);
  });

  it('leaves a same-key lock (no swap, no fringe) untouched', async () => {
    const id = 'no-swap';
    const { recDir, lockedAbs, lockedSha } = await buildLockedRecord(id, { genKey: '#0000FF', canvasKey: '#0000FF' });
    const before = await readFile(join(recDir, 'reference', `${id}-reference-set-v1.json`), 'utf8');

    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await shaFile(lockedAbs)).toBe(lockedSha); // file untouched
    expect(await readFile(join(recDir, 'reference', `${id}-reference-set-v1.json`), 'utf8')).toBe(before);
  });

  it('skips a record with no locked main reference', async () => {
    const id = 'unlocked';
    const recDir = join(sprites(), id);
    await mkdir(join(recDir, 'reference'), { recursive: true });
    const manifest = {
      schemaVersion: 1, chromaKey: null,
      mainReference: { path: null, role: 'immutable-root', background: 'chroma-key', locked: false },
      anchors: [],
    };
    await writeJson(join(recDir, 'reference', `${id}-reference-set-v1.json`), manifest);
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
    expect(await readJson(join(recDir, 'reference', `${id}-reference-set-v1.json`))).toEqual(manifest);
  });

  it('returns migrated: 0 on an install with no sprites tree', async () => {
    const res = await migration.up({ rootDir: ROOT });
    expect(res).toMatchObject({ ok: true, migrated: 0 });
  });
});
