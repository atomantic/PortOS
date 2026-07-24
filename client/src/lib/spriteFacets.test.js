import { describe, it, expect } from 'vitest';
import {
  classifySpriteAsset, classifySpriteAssets, groupSpriteAssetsByRole,
  SPRITE_ASSET_ROLES, SPRITE_ROLE_LABELS,
} from './spriteFacets.js';

// Paths here are the shapes the server actually writes (see the module header)
// with a placeholder record id — never a real record from the live install.
const facets = (path) => classifySpriteAsset(path);

describe('classifySpriteAsset — role', () => {
  it('reads a locked reference and an anchor as the reference set', () => {
    expect(facets('reference/example-walk-south-v1.png').role).toBe('reference');
    expect(facets('reference/example-walk-north-east-v2.png').role).toBe('reference');
    expect(facets('reference/candidates/walk-east-candidate-3.png').role).toBe('reference');
  });

  it('separates strips, frames, animations and review evidence inside a run', () => {
    expect(facets('grok/walk-east-abc12345/generated/example-walk-east-strip.png').role).toBe('strip');
    expect(facets('grok/walk-east-abc12345/generated/frames/00-left-contact.png').role).toBe('frame');
    expect(facets('grok/walk-east-abc12345/generated/source-video.mp4').role).toBe('animation');
    expect(facets('grok/walk-east-abc12345/generated/review/example-walk-east-contrast-review.png').role).toBe('evidence');
  });

  it('classifies sidecar JSON as a manifest, not as the directory it sits in', () => {
    // The ordering trap: `runtime/current.json` starts with `runtime/`, which
    // would read as an atlas if the extension check ran second.
    expect(facets('runtime/current.json').role).toBe('manifest');
    expect(facets('runtime/v3/example-v3-manifest.json').role).toBe('manifest');
    expect(facets('reference/example-reference-set-v1.json').role).toBe('manifest');
  });

  it('classifies published atlases and imported props families as atlases', () => {
    expect(facets('runtime/v3/example-v3.png').role).toBe('atlas');
    expect(facets('atlas/props-crates.png').role).toBe('atlas');
  });

  it('splits a saved trim into its strip and its animation', () => {
    expect(facets('walk/trims/east-loop-v001-strip.png').role).toBe('strip');
    expect(facets('walk/trims/east-loop-v001.gif').role).toBe('animation');
  });

  it('classifies imported strips whose filename is not the native `-strip` infix', () => {
    // Imported layouts name strips `strip.png` or `strip-video-…` — the native
    // `-strip` infix test dropped these into the generic sprite bucket, losing
    // their Strips group + inline actions.
    expect(facets('runs/imported-7/generated/strip.png').role).toBe('strip');
    expect(facets('imagegen/v19/strip-video-12-clean-alpha.png').role).toBe('strip');
    // A word that merely contains "strip" as a substring must not match.
    expect(facets('reference/pinstripe-swatch.png').role).not.toBe('strip');
  });
});

describe('classifySpriteAsset — status', () => {
  it('maps each tree to its lifecycle status', () => {
    expect(facets('runtime/v3/example-v3.png').status).toBe('runtime');
    expect(facets('reference/example-walk-south-v1.png').status).toBe('approved');
    expect(facets('reference/candidates/walk-east-candidate-1.png').status).toBe('candidate');
    expect(facets('reference/uploads/design.png').status).toBe('source');
    expect(facets('grok/walk-east-abc12345/generated/example-walk-east-strip.png').status).toBe('candidate');
    // A saved trim is a draft loop, not an approved artifact.
    expect(facets('walk/trims/east-loop-v001-strip.png').status).toBe('candidate');
  });

  it('honors an imported rejected/ segment', () => {
    expect(facets('runs/walk-east-legacy/rejected/take-1.png').status).toBe('rejected');
  });
});

describe('classifySpriteAsset — direction and run', () => {
  it('prefers the longest direction so a compound never truncates', () => {
    // `walk-south-east-…` must not read as `south` — ordered longest-first
    // alternation is what makes the boundary correct.
    expect(facets('grok/walk-south-east-abc12345/generated/frames/00-a.png').direction).toBe('south-east');
    expect(facets('grok/walk-south-abc12345/generated/frames/00-a.png').direction).toBe('south');
  });

  it('reads the direction off a default trim slug that carries no walk- prefix', () => {
    expect(facets('walk/trims/north-west-loop-v001-strip.png').direction).toBe('north-west');
  });

  it('extracts the run id from both on-disk run layouts', () => {
    expect(facets('grok/walk-east-abc12345/generated/x.png').runId).toBe('walk-east-abc12345');
    expect(facets('runs/imported-run-7/generated/x.png').runId).toBe('imported-run-7');
    expect(facets('reference/example-walk-east-v1.png').runId).toBeNull();
  });

  it('uses the run id as the family and the tree name otherwise', () => {
    expect(facets('grok/walk-east-abc12345/generated/x.png').family).toBe('walk-east-abc12345');
    expect(facets('walk/trims/east-loop-v001.gif').family).toBe('trims');
    expect(facets('reference/example-walk-east-v1.png').family).toBe('reference');
    expect(facets('loose-file.png').family).toBe('files');
  });

  it('degrades an unrecognized or missing path instead of throwing', () => {
    expect(facets('')).toEqual({ family: 'files', status: 'source', role: 'sprite', direction: null, runId: null });
    expect(facets(undefined).role).toBe('sprite');
    expect(facets('mystery/thing.png')).toMatchObject({ family: 'mystery', status: 'source', role: 'sprite' });
  });
});

describe('classifySpriteAssets — supersede', () => {
  it('demotes every approved version below the highest of its stem', () => {
    const rows = classifySpriteAssets([
      { path: 'reference/example-walk-east-v1.png' },
      { path: 'reference/example-walk-east-v2.png' },
      { path: 'reference/example-walk-east-v3.png' },
    ]);
    expect(rows.map((r) => r.facets.status)).toEqual(['superseded', 'superseded', 'approved']);
  });

  it('keeps versions of DIFFERENT stems independent', () => {
    const rows = classifySpriteAssets([
      { path: 'reference/example-walk-east-v2.png' },
      { path: 'reference/example-walk-west-v1.png' },
    ]);
    expect(rows.every((r) => r.facets.status === 'approved')).toBe(true);
  });

  it('leaves trim versions as candidates — supersede only demotes approved artifacts', () => {
    // Trims are draft loops (status candidate), so the approved-only supersede
    // pass never reclassifies them; both versions stay candidate.
    const rows = classifySpriteAssets([
      { path: 'walk/trims/east-loop-v001-strip.png' },
      { path: 'walk/trims/east-loop-v002-strip.png' },
    ]);
    expect(rows.map((r) => r.facets.status)).toEqual(['candidate', 'candidate']);
  });

  it('leaves runtime atlases alone — the publish pointer decides which is live', () => {
    const rows = classifySpriteAssets([
      { path: 'runtime/v1/example-v1.png' },
      { path: 'runtime/v2/example-v2.png' },
    ]);
    expect(rows.every((r) => r.facets.status === 'runtime')).toBe(true);
  });

  it('does not mutate the input rows', () => {
    const input = [{ path: 'reference/example-walk-east-v1.png' }, { path: 'reference/example-walk-east-v2.png' }];
    classifySpriteAssets(input);
    expect(input[0].facets).toBeUndefined();
  });

  it('tolerates a non-array listing', () => {
    expect(classifySpriteAssets(null)).toEqual([]);
  });
});

describe('groupSpriteAssetsByRole', () => {
  it('returns only non-empty roles, in the declared render order, and never a Manifests group', () => {
    const groups = groupSpriteAssetsByRole([
      { path: 'runtime/current.json' }, // a publish-pointer manifest — behind-the-scenes, not shown
      { path: 'grok/walk-east-abc12345/generated/example-walk-east-strip.png' },
      { path: 'reference/example-walk-east-v1.png' },
    ]);
    expect(groups.map((g) => g.role)).toEqual(['reference', 'strip']);
    expect(groups.some((g) => g.role === 'manifest')).toBe(false);
    expect(groups[0].label).toBe(SPRITE_ROLE_LABELS.reference);
    expect(groups.every((g) => g.assets.length > 0)).toBe(true);
  });

  it('folds a runtime version manifest onto its atlas row instead of a Manifests group', () => {
    const groups = groupSpriteAssetsByRole([
      { path: 'runtime/v3/hero-animation-atlas-v3.png' },
      { path: 'runtime/v3/hero-animation-atlas-v3-manifest.json' },
    ]);
    expect(groups.map((g) => g.role)).toEqual(['atlas']);
    const [atlasRow] = groups[0].assets;
    expect(atlasRow.manifest?.path).toBe('runtime/v3/hero-animation-atlas-v3-manifest.json');
    // The manifest row is not double-counted as its own asset.
    expect(groups[0].assets).toHaveLength(1);
  });

  it('does not attach the publish pointer to an atlas — only the per-version sidecar', () => {
    const groups = groupSpriteAssetsByRole([
      { path: 'runtime/v2/hero-animation-atlas-v2.png' },
      { path: 'runtime/current.json' },
      { path: 'atlas/props-sheet.png' }, // imported props atlas — no sidecar
    ]);
    const atlas = groups.find((g) => g.role === 'atlas');
    const runtimeRow = atlas.assets.find((a) => a.path.startsWith('runtime/'));
    const importedRow = atlas.assets.find((a) => a.path.startsWith('atlas/'));
    expect(runtimeRow.manifest).toBeUndefined();
    expect(importedRow.manifest).toBeUndefined();
  });

  it('labels every declared role', () => {
    expect(SPRITE_ASSET_ROLES.every((r) => typeof SPRITE_ROLE_LABELS[r] === 'string')).toBe(true);
  });

  it('carries the classified facets through onto each row', () => {
    const [group] = groupSpriteAssetsByRole([{ path: 'grok/walk-east-abc12345/generated/e-walk-east-strip.png', size: 12 }]);
    expect(group.assets[0]).toMatchObject({ size: 12, facets: { direction: 'east', runId: 'walk-east-abc12345' } });
  });
});
