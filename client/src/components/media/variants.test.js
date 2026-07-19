import { describe, it, expect } from 'vitest';
import { computeImageVariantGroup } from './variants';
import { normalizeImage } from './normalize';

const img = (filename, extra = {}) => ({ kind: 'image', filename, ...extra });

describe('computeImageVariantGroup', () => {
  it('returns null when item has no sibling in items', () => {
    const orig = img('a.png');
    expect(computeImageVariantGroup(orig, [orig])).toBeNull();
  });

  it('returns null for non-image items (videos do not have clean lineage)', () => {
    const video = { kind: 'video', filename: 'a.mp4' };
    const cleaned = img('a_clean-aggressive.png', { cleanedFrom: 'a.mp4' });
    expect(computeImageVariantGroup(video, [video, cleaned])).toBeNull();
  });

  it('returns null when items is empty / not an array', () => {
    expect(computeImageVariantGroup(img('a.png'), [])).toBeNull();
    expect(computeImageVariantGroup(img('a.png'), null)).toBeNull();
  });

  it('groups original + one cleaned sibling, active = original', () => {
    const orig = img('a.png');
    const cleaned = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive' });
    const result = computeImageVariantGroup(orig, [orig, cleaned]);
    expect(result).not.toBeNull();
    expect(result.group).toEqual([
      { label: 'Original', item: orig },
      { label: 'Cleaned (aggressive)', item: cleaned },
    ]);
    expect(result.active.item.filename).toBe('a.png');
  });

  it('groups when the preview IS the cleaned copy, active = cleaned', () => {
    const orig = img('a.png');
    const cleaned = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive' });
    const result = computeImageVariantGroup(cleaned, [orig, cleaned]);
    expect(result).not.toBeNull();
    expect(result.active.label).toBe('Cleaned (aggressive)');
  });

  it('labels a resize-squeeze clean as "Cleaned (resize-squeeze)" (issue #1764)', () => {
    const orig = img('a.png');
    const cleaned = img('a_clean-resize-squeeze.png', { cleanedFrom: 'a.png', cleanLevel: 'resize-squeeze' });
    const result = computeImageVariantGroup(orig, [orig, cleaned]);
    expect(result).not.toBeNull();
    expect(result.group).toEqual([
      { label: 'Original', item: orig },
      { label: 'Cleaned (resize-squeeze)', item: cleaned },
    ]);
  });

  it('orders light before aggressive when both legacy clean variants exist', () => {
    const orig = img('a.png');
    const aggressive = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive' });
    const light = img('a_clean-light.png', { cleanedFrom: 'a.png', cleanLevel: 'light' });
    const result = computeImageVariantGroup(orig, [orig, aggressive, light]);
    expect(result.group.map((g) => g.label)).toEqual([
      'Original',
      'Cleaned (light)',
      'Cleaned (aggressive)',
    ]);
  });

  it('omits "Original" entry if the source image is not in the items list (cleaned-only collection)', () => {
    const cleaned1 = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive' });
    const cleaned2 = img('a_clean-light.png', { cleanedFrom: 'a.png', cleanLevel: 'light' });
    const result = computeImageVariantGroup(cleaned1, [cleaned1, cleaned2]);
    expect(result.group.map((g) => g.label)).toEqual([
      'Cleaned (light)',
      'Cleaned (aggressive)',
    ]);
  });

  it('labels a SynthID-defeat regen variant "Regenerated" (grouped via cleanedFrom)', () => {
    const orig = img('a.png');
    const regen = img('regen-uuid.png', { cleanedFrom: 'a.png', regenerated: true, regenStrength: 0.4 });
    const result = computeImageVariantGroup(orig, [orig, regen]);
    expect(result.group.map((g) => g.label)).toEqual(['Original', 'Regenerated']);
  });

  it('mixes cleaned and regenerated variants under one source with distinct labels', () => {
    const orig = img('a.png');
    const cleaned = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive', createdAt: '2024-01-01' });
    const regen = img('regen-uuid.png', { cleanedFrom: 'a.png', regenerated: true, createdAt: '2024-01-02' });
    const result = computeImageVariantGroup(regen, [orig, cleaned, regen]);
    expect(result.group.map((g) => g.label)).toEqual(['Original', 'Cleaned (aggressive)', 'Regenerated']);
    expect(result.active.label).toBe('Regenerated');
  });

  it('labels a regen variant correctly through the real normalizeImage path (issue #912)', () => {
    // Guards the actual UI path: the gallery feeds normalizeImage output (not
    // raw sidecars) into computeImageVariantGroup, so the `regenerated`
    // discriminator must survive normalization or the variant mislabels.
    const orig = normalizeImage({ filename: 'a.png', prompt: 'x' });
    const regen = normalizeImage({ filename: 'r.png', cleanedFrom: 'a.png', regenerated: true, regenStrength: 0.4 });
    const result = computeImageVariantGroup(regen, [orig, regen]);
    expect(result.group.map((g) => g.label)).toEqual(['Original', 'Regenerated']);
    expect(result.active.label).toBe('Regenerated');
  });

  it('returns null when only the original exists (no clean siblings yet — no toggle needed)', () => {
    const orig = img('a.png');
    const unrelated = img('b.png');
    expect(computeImageVariantGroup(orig, [orig, unrelated])).toBeNull();
  });

  it('returns null when the preview filename does not match any group entry', () => {
    // Defensive: preview was passed but it isn't actually part of the variant
    // set (e.g. items list was filtered after preview was set). Toggle should
    // not render rather than mislead with a stale group.
    const orig = img('a.png');
    const cleaned = img('a_clean-aggressive.png', { cleanedFrom: 'a.png', cleanLevel: 'aggressive' });
    const other = img('c.png'); // preview pointing at an unrelated image
    expect(computeImageVariantGroup(other, [orig, cleaned, other])).toBeNull();
  });
});
