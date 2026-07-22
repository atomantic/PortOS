/**
 * Sprite importer against a synthetic source tree (#2895, phase 1). Builds an
 * ElsewhereAcres-layout fixture in a tmpdir, imports it into a tmp data root,
 * and asserts the selective-copy rules (candidates/raw intermediates stay
 * behind), the manifest sha256 verification, and the record upserts. Also
 * covers the path-confinement gate in paths.js.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'sprite-importer-data-'));
const SOURCE_ROOT = mkdtempSync(join(tmpdir(), 'sprite-importer-src-'));
const SPRITES_ROOT = join(TEST_DATA_ROOT, 'sprites');

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT, sprites: SPRITES_ROOT } };
});

const { importFromSource } = await import('./importer.js');
const { getRecord, updateRecord, getRecordWithAssets } = await import('./records.js');
const { resolveSpriteAssetPath, listSpriteAssets } = await import('./paths.js');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

beforeAll(() => {
  const anchorBytes = 'FAKE-PNG-ANCHOR-SOUTH';
  const runManifest = JSON.stringify({ kind: 'deterministically-packaged-grok-walk-video', direction: 'south' }, null, 2);
  writeTree(SOURCE_ROOT, {
    'art-pipeline/characters/hero.json': {
      schemaVersion: 1, characterId: 'hero', displayName: 'Hero', archetype: 'adult-humanoid-v1',
    },
    'art-source/sprites/hero/reference/hero-reference-set-v1.json': {
      schemaVersion: 1,
      mainReference: { path: 'art-source/sprites/hero/reference/hero-main.png' },
      anchors: [
        { id: 'south', path: 'art-source/sprites/hero/reference/hero-anchor-south.png', sha256: sha256(anchorBytes) },
        { id: 'east', path: 'art-source/sprites/hero/reference/hero-anchor-east.png', sha256: sha256('DIFFERENT-BYTES') },
      ],
    },
    'art-source/sprites/hero/reference/hero-main.png': 'FAKE-PNG-MAIN',
    'art-source/sprites/hero/reference/hero-anchor-south.png': anchorBytes,
    'art-source/sprites/hero/reference/hero-anchor-east.png': 'TAMPERED-ANCHOR-EAST',
    'art-source/sprites/hero/reference/candidates/reject-1.png': 'UNAPPROVED',
    'art-source/sprites/hero/walk/hero-walk-set-v1.json': {
      schemaVersion: 1, kind: 'finalized-eight-direction-walk-set', characterId: 'hero', status: 'final',
      directions: {
        south: {
          status: 'approved',
          runPath: 'art-source/sprites/hero/grok/run-1',
          runManifest: 'art-source/sprites/hero/grok/run-1/south-manifest.json',
          runManifestSha256: sha256(runManifest),
        },
        // Traversal attempt: a crafted runPath must be rejected, never joined
        // into a write destination outside data/sprites/.
        north: {
          status: 'approved',
          runPath: 'art-source/sprites/hero/../../../../tmp/sprite-escape',
          runManifest: 'art-source/sprites/hero/../../../../tmp/sprite-escape/x.json',
          runManifestSha256: sha256('x'),
        },
      },
    },
    'art-source/sprites/hero/grok/run-1/south-manifest.json': runManifest,
    'art-source/sprites/hero/grok/run-1/south-strip.png': 'FAKE-STRIP',
    'art-source/sprites/hero/grok/run-1/raw/frame-000.png': 'RAW-INTERMEDIATE',
    'art-source/sprites/hero/runtime/v1/hero-animation-atlas-v1.png': 'FAKE-ATLAS',
    'art-pipeline/catalog/runtime-selection.json': { selectionId: 's1', characterId: 'hero', status: 'selected' },
    'game/assets/sprites/flora/flora-atlas.png': 'FAKE-FLORA-ATLAS',
    'game/assets/sprites/flora/flora-atlas.png.import': 'GODOT-IMPORT-SIDECAR',
    'game/assets/sprites/flora/README.md': '# flora',
    'game/assets/sprites/hero/hero-animation-atlas.png': 'PUBLISHED-COPY',
  });
});

afterAll(() => {
  rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
  rmSync(SOURCE_ROOT, { recursive: true, force: true });
});

describe('importFromSource', () => {
  it('imports approved assets, skips intermediates, verifies hashes, upserts records', async () => {
    const { results, totals } = await importFromSource({ sourceRoot: SOURCE_ROOT });

    const hero = results.find((r) => r.id === 'hero');
    expect(hero.kind).toBe('character');
    // one good anchor + the run manifest verify; the tampered east anchor errors
    expect(hero.verified).toBe(2);
    expect(hero.errors).toEqual([
      'walk set north: unsafe run path rejected: art-source/sprites/hero/../../../../tmp/sprite-escape',
      'sha256 mismatch: reference/hero-anchor-east.png',
    ]);
    expect(existsSync('/tmp/sprite-escape')).toBe(false);

    const heroDir = join(SPRITES_ROOT, 'hero');
    expect(existsSync(join(heroDir, 'character-spec.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'reference/hero-anchor-south.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'reference/candidates/reject-1.png'))).toBe(false);
    expect(existsSync(join(heroDir, 'walk/hero-walk-set-v1.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/south-strip.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/raw/frame-000.png'))).toBe(false);
    expect(existsSync(join(heroDir, 'runtime/v1/hero-animation-atlas-v1.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'catalog/runtime-selection.json'))).toBe(true);

    // props family imported (PNG + README, never the Godot .import sidecar);
    // the character's published game dir is NOT double-imported as props.
    const flora = results.find((r) => r.id === 'flora');
    expect(flora.kind).toBe('props');
    expect(existsSync(join(SPRITES_ROOT, 'flora/atlas/flora-atlas.png'))).toBe(true);
    expect(existsSync(join(SPRITES_ROOT, 'flora/atlas/flora-atlas.png.import'))).toBe(false);
    expect(results.some((r) => r.id === 'hero' && r.kind === 'props')).toBe(false);

    expect(totals.subjects).toBe(2);
    expect(totals.errors).toBe(2);

    const record = await getRecord('hero');
    expect(record).toMatchObject({ kind: 'character', name: 'Hero', status: 'imported', chromaKey: '#FF00FF' });
    expect(record.spec.archetype).toBe('adult-humanoid-v1');
  });

  it('re-import preserves user-managed record fields', async () => {
    await updateRecord('hero', { notes: 'reviewed', chromaKey: '#00FF00' });
    await importFromSource({ sourceRoot: SOURCE_ROOT, characters: ['hero'], includeProps: false });
    const record = await getRecord('hero');
    expect(record.notes).toBe('reviewed');
    expect(record.chromaKey).toBe('#00FF00');
  });

  it('rejects a root that is not a sprite pipeline', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'sprite-importer-empty-'));
    await expect(importFromSource({ sourceRoot: empty })).rejects.toMatchObject({ code: 'INVALID_SOURCE_ROOT' });
    rmSync(empty, { recursive: true, force: true });
  });
});

describe('paths confinement', () => {
  it('resolves inside the record dir and lists imported assets', async () => {
    const abs = resolveSpriteAssetPath('hero', 'reference/hero-main.png');
    expect(abs.startsWith(join(SPRITES_ROOT, 'hero'))).toBe(true);
    const assets = await listSpriteAssets('hero');
    expect(assets.some((a) => a.path === 'reference/hero-main.png')).toBe(true);
  });

  it('getRecordWithAssets pairs the record with its disk listing', async () => {
    const detail = await getRecordWithAssets('hero');
    expect(detail.record.id).toBe('hero');
    expect(detail.assets.length).toBeGreaterThan(0);
    expect(await getRecordWithAssets('nobody')).toBeNull();
  });

  it('refuses traversal and bad ids', () => {
    expect(() => resolveSpriteAssetPath('hero', '../other/file.png')).toThrow(/escapes/);
    expect(() => resolveSpriteAssetPath('hero', '/etc/passwd')).toThrow(/escapes/);
    expect(() => resolveSpriteAssetPath('../hero', 'x.png')).toThrow(/Invalid sprite id/);
  });
});
