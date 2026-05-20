import { describe, it, expect } from 'vitest';
import { computeImageVariantGroup } from './variants';

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
