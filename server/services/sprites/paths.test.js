/**
 * toRecordRelativeAssetPath (#2895 importer follow-up): pure path-rebasing
 * helper used by walk.js to normalize source-pipeline-relative asset paths
 * embedded in imported manifests down to the record-relative form PortOS's
 * own client reads. No PATHS/spriteDir dependency — kept dependency-free so
 * this suite runs with zero mocking.
 */

import { describe, it, expect } from 'vitest';
import { toRecordRelativeAssetPath } from './paths.js';

describe('toRecordRelativeAssetPath', () => {
  it('strips the source-repo marker for this record', () => {
    expect(toRecordRelativeAssetPath('pioneer', 'art-source/sprites/pioneer/grok/walk-east-abc/generated/strip.png'))
      .toBe('grok/walk-east-abc/generated/strip.png');
  });

  it('passes through an already record-relative path unchanged', () => {
    expect(toRecordRelativeAssetPath('pioneer', 'grok/walk-east-abc/generated/strip.png'))
      .toBe('grok/walk-east-abc/generated/strip.png');
  });

  it('strips a leading slash on an already record-relative path (matches importer.js relToCharacterDir)', () => {
    expect(toRecordRelativeAssetPath('pioneer', '/grok/walk-east-abc/generated/strip.png'))
      .toBe('grok/walk-east-abc/generated/strip.png');
  });

  it('rejects a repo-anchored path outside this record (provenance, not a copied asset)', () => {
    expect(toRecordRelativeAssetPath('pioneer', 'art-pipeline/sprite-manager/animation_postprocess.py')).toBeNull();
    expect(toRecordRelativeAssetPath('pioneer', 'game/assets/sprites/pioneer/pioneer-animation-atlas.png')).toBeNull();
  });

  it('rejects the marker for a DIFFERENT record id (cross-record confinement)', () => {
    expect(toRecordRelativeAssetPath('pioneer', 'art-source/sprites/trailhand/reference/main.png')).toBeNull();
  });

  it('rejects traversal segments', () => {
    expect(toRecordRelativeAssetPath('pioneer', '../../etc/passwd')).toBeNull();
    expect(toRecordRelativeAssetPath('pioneer', 'grok/../../../etc/passwd')).toBeNull();
  });

  it('rejects empty path segments', () => {
    expect(toRecordRelativeAssetPath('pioneer', 'grok//strip.png')).toBeNull();
  });

  it('rejects missing/empty/non-string input', () => {
    expect(toRecordRelativeAssetPath('pioneer', '')).toBeNull();
    expect(toRecordRelativeAssetPath('pioneer', null)).toBeNull();
    expect(toRecordRelativeAssetPath('pioneer', undefined)).toBeNull();
    expect(toRecordRelativeAssetPath('pioneer', 42)).toBeNull();
  });
});
