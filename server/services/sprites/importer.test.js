/**
 * Sprite importer against a synthetic source tree (#2895, phase 1). Builds an
 * ElsewhereAcres-layout fixture in a tmpdir — including the REAL run shape
 * (run record at the run root, assets under generated/, unselected imagegen
 * candidates beside the approved manifest) — imports it into a tmp data root,
 * and asserts the manifest-driven approved-only copy rules, the sha256
 * verification (walk manifests + the catalog's hash-pinned runtime atlas),
 * and the record upserts. Also covers the path-confinement gate in paths.js.
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

const anchorBytes = 'FAKE-PNG-ANCHOR-SOUTH';
// Grok-style run: record at the run root referencing packaged assets under
// generated/ (exact strings so runManifestSha256 matches the copied bytes).
const southRunRecord = JSON.stringify({
  kind: 'grok-walk-animation-run', status: 'candidate', characterId: 'hero', direction: 'south',
  anchorPath: 'art-source/sprites/hero/reference/hero-anchor-south.png',
  stripPreview: 'art-source/sprites/hero/grok/run-1/generated/south-strip.png',
  postprocessManifest: 'art-source/sprites/hero/grok/run-1/generated/south-manifest.json',
}, null, 2);
const southPackagedManifest = JSON.stringify({
  kind: 'deterministically-packaged-grok-walk-video', direction: 'south',
  sourceVideoPath: 'art-source/sprites/hero/grok/run-1/generated/source-video.mp4',
  frames: [{ path: 'art-source/sprites/hero/grok/run-1/generated/frames/f0.png' }],
  // Hash-pinned asset record: the copied strip must verify against this.
  assets: [{ path: 'art-source/sprites/hero/grok/run-1/generated/south-strip.png', sha256: sha256('FAKE-STRIP') }],
  // Path-looking strings in log tails must be ignored, not imported.
  stdoutTail: 'wrote art-source/sprites/hero/grok/run-1/generated/raw/ghost.png',
}, null, 2);
const southReviewPreview = JSON.stringify({
  stripPath: 'art-source/sprites/hero/grok/run-1/generated/south-strip.png', frameCount: 8, fps: 12,
}, null, 2);
// Imagegen-style run (the v19-east shape): manifest + strips at the version
// root, surrounded by unselected candidates that must stay behind.
// Non-final manifest in walk/: copies as provenance, contributes no assets —
// and the finalized set hash-pins it via selectionPath/selectionSha256.
const heroWalkSelection = JSON.stringify({
  schemaVersion: 1, kind: 'reviewed-directional-walk-selection', characterId: 'hero', status: 'complete',
  directions: {
    south: {
      status: 'approved',
      runPath: 'art-source/sprites/hero/grok/run-decoy',
      runManifest: 'art-source/sprites/hero/grok/run-decoy/animation-run.json',
    },
  },
}, null, 2);
const eastManifest = JSON.stringify({
  kind: 'imagegen-redraw-manifest', direction: 'east',
  stripPath: 'art-source/sprites/hero/imagegen/v2/east-strip.png',
  // Declared but absent from the source — must surface as an error, not a
  // silent skip that still reports a fully-imported subject.
  overlayPath: 'art-source/sprites/hero/imagegen/v2/gone.png',
  // Repo-anchored provenance reference outside the character dir — ignored,
  // never treated as a missing character asset.
  contractPath: 'art-pipeline/contracts/player-sprite-standard-v2.json',
}, null, 2);

beforeAll(() => {
  writeTree(SOURCE_ROOT, {
    'art-pipeline/characters/hero.json': {
      schemaVersion: 1, characterId: 'hero', displayName: 'Hero', archetype: 'adult-humanoid-v1',
    },
    'art-pipeline/characters/buddy.json': {
      schemaVersion: 1, characterId: 'buddy', displayName: 'Buddy', archetype: 'adult-humanoid-v1',
    },
    'art-pipeline/characters/character-schema-v1.json': { $schema: 'https://json-schema.org/draft/2020-12/schema' },
    'game/assets/sprites/buddy/buddy-animation-atlas.png': 'BUDDY-PUBLISHED-COPY',
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
      selectionPath: 'art-source/sprites/hero/walk/hero-walk-selection-v1.json',
      selectionSha256: sha256(heroWalkSelection),
      directions: {
        south: {
          status: 'approved',
          runPath: 'art-source/sprites/hero/grok/run-1',
          runManifest: 'art-source/sprites/hero/grok/run-1/animation-run.json',
          runManifestSha256: sha256(southRunRecord),
        },
        east: {
          status: 'approved',
          runPath: 'art-source/sprites/hero/imagegen/v2',
          runManifest: 'art-source/sprites/hero/imagegen/v2/east-manifest.json',
          runManifestSha256: sha256(eastManifest),
        },
        west: {
          status: 'pending',
          runPath: 'art-source/sprites/hero/grok/run-3',
          runManifest: 'art-source/sprites/hero/grok/run-3/animation-run.json',
        },
        // Traversal attempt: a crafted path must be rejected, never joined
        // into a write destination outside data/sprites/.
        north: {
          status: 'approved',
          runPath: 'art-source/sprites/hero/../../../../tmp/sprite-escape',
          runManifest: 'art-source/sprites/hero/../../../../tmp/sprite-escape/x.json',
          runManifestSha256: sha256('x'),
        },
      },
    },
    'art-source/sprites/hero/walk/hero-walk-selection-v1.json': heroWalkSelection,
    'art-source/sprites/hero/grok/run-1/animation-run.json': southRunRecord,
    'art-source/sprites/hero/grok/run-1/generated/south-manifest.json': southPackagedManifest,
    'art-source/sprites/hero/grok/run-1/generated/south-strip.png': 'FAKE-STRIP',
    'art-source/sprites/hero/grok/run-1/generated/review-preview.json': southReviewPreview,
    'art-source/sprites/hero/grok/run-1/generated/source-video.mp4': 'FAKE-VIDEO',
    'art-source/sprites/hero/grok/run-1/generated/raw/frame-000.png': 'RAW-INTERMEDIATE',
    'art-source/sprites/hero/grok/run-1/generated/frames/f0.png': 'EXTRACTED-FRAME',
    'art-source/sprites/hero/grok/run-3/animation-run.json': '{"status":"pending-run"}',
    'art-source/sprites/hero/grok/run-decoy/animation-run.json': '{"status":"decoy"}',
    'art-source/sprites/hero/grok/run-decoy/generated/decoy-strip.png': 'DECOY-STRIP',
    'art-source/sprites/hero/imagegen/v2/east-manifest.json': eastManifest,
    'art-source/sprites/hero/imagegen/v2/east-strip.png': 'FAKE-EAST-STRIP',
    'art-source/sprites/hero/imagegen/v2/east-candidate-02.png': 'UNSELECTED-CANDIDATE',
    'art-source/sprites/hero/runtime/v1/hero-animation-atlas-v1.png': 'FAKE-ATLAS',
    'art-source/sprites/hero/hero-atlas-keyed.png': 'FAKE-KEYED',
    'art-pipeline/catalog/runtime-selection.json': {
      selectionId: 's1', characterId: 'hero', status: 'selected',
      selected: {
        keyedSourcePath: 'art-source/sprites/hero/hero-atlas-keyed.png',
        // Game-tree publish target: also contains "sprites/hero/" but is NOT
        // a character-dir asset — must be ignored, not reported missing.
        runtimePath: 'game/assets/sprites/hero/hero-animation-atlas.png',
        runtimeSha256: sha256('PUBLISHED-COPY'),
        immutableRuntimeArtifact: {
          path: 'art-source/sprites/hero/runtime/v1/hero-animation-atlas-v1.png',
          sha256: sha256('FAKE-ATLAS'),
        },
      },
    },
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
  it('imports approved assets manifest-driven, skips intermediates/candidates, verifies hashes', async () => {
    const { results, totals } = await importFromSource({ sourceRoot: SOURCE_ROOT });

    const hero = results.find((r) => r.id === 'hero');
    expect(hero.kind).toBe('character');
    // south anchor + pinned walk selection + south run record + pinned south
    // strip + east manifest + hash-pinned runtime atlas
    expect(hero.verified).toBe(6);
    expect(hero.errors).toEqual([
      'walk set east: referenced asset missing: imagegen/v2/gone.png',
      'walk set west: not approved (pending) — skipped',
      'walk set north: unsafe run path rejected: art-source/sprites/hero/../../../../tmp/sprite-escape/x.json',
      'sha256 mismatch: reference/hero-anchor-east.png',
    ]);

    const heroDir = join(SPRITES_ROOT, 'hero');
    // reference: locked set without candidates
    expect(existsSync(join(heroDir, 'reference/hero-anchor-south.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'reference/candidates/reject-1.png'))).toBe(false);
    // walk manifests copy as provenance
    expect(existsSync(join(heroDir, 'walk/hero-walk-set-v1.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'walk/hero-walk-selection-v1.json'))).toBe(true);
    // approved grok run: record + manifest-declared assets, never intermediates
    expect(existsSync(join(heroDir, 'grok/run-1/animation-run.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/south-manifest.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/south-strip.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/review-preview.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/source-video.mp4'))).toBe(false);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/raw/frame-000.png'))).toBe(false);
    expect(existsSync(join(heroDir, 'grok/run-1/generated/frames/f0.png'))).toBe(false);
    // approved imagegen run: manifest + selected strip only
    expect(existsSync(join(heroDir, 'imagegen/v2/east-manifest.json'))).toBe(true);
    expect(existsSync(join(heroDir, 'imagegen/v2/east-strip.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'imagegen/v2/east-candidate-02.png'))).toBe(false);
    // pending direction and non-final manifest contribute nothing
    expect(existsSync(join(heroDir, 'grok/run-3/animation-run.json'))).toBe(false);
    expect(existsSync(join(heroDir, 'grok/run-decoy'))).toBe(false);
    // published artifacts: immutable archive + keyed source + selection copy
    expect(existsSync(join(heroDir, 'runtime/v1/hero-animation-atlas-v1.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'hero-atlas-keyed.png'))).toBe(true);
    expect(existsSync(join(heroDir, 'catalog/runtime-selection.json'))).toBe(true);

    // props family imported (PNG + README, never the Godot .import sidecar);
    // character game dirs are NOT double-imported as props; schema file skipped.
    const flora = results.find((r) => r.id === 'flora');
    expect(flora.kind).toBe('props');
    expect(existsSync(join(SPRITES_ROOT, 'flora/atlas/flora-atlas.png'))).toBe(true);
    expect(existsSync(join(SPRITES_ROOT, 'flora/atlas/flora-atlas.png.import'))).toBe(false);
    expect(results.some((r) => r.kind === 'props' && (r.id === 'hero' || r.id === 'buddy'))).toBe(false);
    expect(results.some((r) => r.id === 'character-schema-v1')).toBe(false);

    expect(totals.subjects).toBe(3); // hero + buddy characters, flora props
    expect(totals.errors).toBe(4);

    const record = await getRecord('hero');
    expect(record).toMatchObject({ kind: 'character', name: 'Hero', status: 'imported', chromaKey: '#FF00FF' });
    expect(record.spec.archetype).toBe('adult-humanoid-v1');
  });

  it('a filtered character import never treats other characters\' game dirs as props', async () => {
    const { results } = await importFromSource({ sourceRoot: SOURCE_ROOT, characters: ['hero'], includeProps: true });
    expect(results.some((r) => r.id === 'buddy')).toBe(false);
    const buddy = await getRecord('buddy');
    expect(buddy.kind).toBe('character'); // not overwritten to a spec-less props record
    expect(buddy.name).toBe('Buddy');
  });

  it('re-import preserves user-managed record fields', async () => {
    await updateRecord('hero', { notes: 'reviewed', chromaKey: '#00FF00' });
    await importFromSource({ sourceRoot: SOURCE_ROOT, characters: ['hero'], includeProps: false });
    const record = await getRecord('hero');
    expect(record.notes).toBe('reviewed');
    expect(record.chromaKey).toBe('#00FF00');
  });

  it('re-import errors when a hash-pinned file disappears from the source (stale dest copy must not vouch)', async () => {
    rmSync(join(SOURCE_ROOT, 'art-source/sprites/hero/reference/hero-anchor-south.png'));
    const { results } = await importFromSource({ sourceRoot: SOURCE_ROOT, characters: ['hero'], includeProps: false });
    const hero = results.find((r) => r.id === 'hero');
    expect(hero.errors).toContain('missing from source: reference/hero-anchor-south.png');
    // the destination still holds the earlier copy — it must not count as verified
    expect(existsSync(join(SPRITES_ROOT, 'hero/reference/hero-anchor-south.png'))).toBe(true);
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
    expect(assets.some((a) => a.path === 'grok/run-1/generated/south-strip.png')).toBe(true);
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
