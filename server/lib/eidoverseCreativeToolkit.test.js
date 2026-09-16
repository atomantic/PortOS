import { describe, expect, it } from 'vitest';
import {
  EIDOVERSE_CREATIVE_LAYOUTS,
  EIDOVERSE_CREATIVE_MATERIALS,
  EIDOVERSE_CREATIVE_MOTIFS,
  buildDistrictTemplateAugmentOperations,
  buildDistrictTemplateFoundationDraft,
  describeCreativeCatalog,
  generateDistrictTemplatePlacement,
} from './eidoverseCreativeToolkit.js';
import { eidoverseFoundationInputSchema, styleLeakFindings } from './eidoverseFoundations.js';

const ANCHOR = [4, 0, -6];

describe('describeCreativeCatalog', () => {
  it('projects a small, unique, prompt-safe catalog', () => {
    const catalog = describeCreativeCatalog();
    for (const [key, source] of [
      ['materials', EIDOVERSE_CREATIVE_MATERIALS],
      ['motifs', EIDOVERSE_CREATIVE_MOTIFS],
      ['layouts', EIDOVERSE_CREATIVE_LAYOUTS],
    ]) {
      expect(catalog[key]).toHaveLength(source.length);
      expect(new Set(catalog[key].map((entry) => entry.id)).size).toBe(source.length);
      for (const entry of catalog[key]) {
        expect(Object.keys(entry).sort()).toEqual(['description', 'id', 'label']);
      }
    }
    // Cosmetics (colorHex) never ride into the prompt-facing projection.
    expect(JSON.stringify(catalog.materials)).not.toContain('colorHex');
  });
});

describe('generateDistrictTemplatePlacement', () => {
  it('is deterministic for a given layout, anchor, and seed', () => {
    const first = generateDistrictTemplatePlacement({ layoutId: 'grove-cluster', anchor: ANCHOR, propCount: 5, seed: 'beacon-row' });
    const second = generateDistrictTemplatePlacement({ layoutId: 'grove-cluster', anchor: ANCHOR, propCount: 5, seed: 'beacon-row' });
    expect(second).toEqual(first);
  });

  it('diverges on a different seed and reports the requested count', () => {
    const a = generateDistrictTemplatePlacement({ layoutId: 'grove-cluster', anchor: ANCHOR, propCount: 5, seed: 'alpha' });
    const b = generateDistrictTemplatePlacement({ layoutId: 'grove-cluster', anchor: ANCHOR, propCount: 5, seed: 'beta' });
    expect(a).toHaveLength(5);
    expect(a).not.toEqual(b);
  });

  it('places every prop of a radial-ring at an equal radius around the anchor', () => {
    const placement = generateDistrictTemplatePlacement({ layoutId: 'radial-ring', anchor: ANCHOR, propCount: 4, seed: 'ring' });
    expect(placement).toHaveLength(4);
    for (const { pos } of placement) {
      const radius = Math.hypot(pos[0] - ANCHOR[0], pos[2] - ANCHOR[2]);
      expect(radius).toBeCloseTo(6, 1);
    }
  });

  it('clamps prop count into [1, 16] rather than accepting an unbounded request', () => {
    expect(generateDistrictTemplatePlacement({ layoutId: 'grid-plot', anchor: ANCHOR, propCount: 999, seed: 'x' })).toHaveLength(16);
    expect(generateDistrictTemplatePlacement({ layoutId: 'grid-plot', anchor: ANCHOR, propCount: 0, seed: 'x' })).toHaveLength(1);
  });

  it('refuses an unknown layout id with the closed vocabulary named in the error', () => {
    expect(() => generateDistrictTemplatePlacement({ layoutId: 'floating-islands', anchor: ANCHOR, seed: 'x' }))
      .toThrow(/Unknown layout "floating-islands".*radial-ring/);
  });

  it('refuses a malformed anchor', () => {
    expect(() => generateDistrictTemplatePlacement({ layoutId: 'radial-ring', anchor: [1, 2], seed: 'x' })).toThrow(RangeError);
    expect(() => generateDistrictTemplatePlacement({ layoutId: 'radial-ring', anchor: [1, 2, Number.NaN], seed: 'x' })).toThrow(RangeError);
  });
});

describe('buildDistrictTemplateAugmentOperations', () => {
  it('produces one spawn operation per placed prop, using the same deterministic positions', () => {
    const placement = generateDistrictTemplatePlacement({ layoutId: 'arc-row', anchor: ANCHOR, propCount: 3, seed: 'stall-row' });
    const operations = buildDistrictTemplateAugmentOperations({
      layoutId: 'arc-row', anchor: ANCHOR, propCount: 3, seed: 'stall-row', assetPath: 'eidoverse/assets/models/lantern.glb', idPrefix: 'stall',
    });
    expect(operations).toHaveLength(3);
    expect(operations.every((op) => op.verb === 'spawn')).toBe(true);
    expect(operations.map((op) => op.args.pos)).toEqual(placement.map((prop) => prop.pos));
    expect(new Set(operations.map((op) => op.args.id)).size).toBe(3);
  });

  it('refuses an empty asset path', () => {
    expect(() => buildDistrictTemplateAugmentOperations({ layoutId: 'arc-row', anchor: ANCHOR, assetPath: '  ' })).toThrow(RangeError);
  });
});

describe('buildDistrictTemplateFoundationDraft', () => {
  const base = {
    id: 'garden-arcade', title: 'Garden Arcade', summary: 'A colonnade of lanterns around the arrival plaza.',
    contributionId: 'beacon-relay', materialId: 'sunbaked-clay', motifId: 'lantern-row', anchor: ANCHOR,
  };

  it('parses as a valid eidoverseFoundationInputSchema input, with no style leak in body', () => {
    const draft = buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'grid-plot', seed: 'garden-seed' });
    const parsed = eidoverseFoundationInputSchema.safeParse(draft);
    expect(parsed.success).toBe(true);
    expect(styleLeakFindings(draft.body)).toEqual([]);
  });

  it('keeps generative substance in body and cosmetics in style', () => {
    const draft = buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'radial-ring', seed: 'garden-seed' });
    expect(draft.body).toMatchObject({ layoutId: 'radial-ring', propCount: 6 });
    expect(draft.body.placement).toHaveLength(6);
    expect(draft.style).toEqual({ materialId: 'sunbaked-clay', motifId: 'lantern-row', palette: '#c97a4a', motif: 'lantern-row' });
    expect(JSON.stringify(draft.body)).not.toContain('palette');
  });

  it('reproduces the same body for the same explicit seed', () => {
    const first = buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'radial-ring', seed: 'fixed-seed' });
    const second = buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'radial-ring', seed: 'fixed-seed' });
    expect(second.body).toEqual(first.body);
  });

  it('refuses an unknown material or motif id', () => {
    expect(() => buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'radial-ring', materialId: 'gold-leaf' })).toThrow(RangeError);
    expect(() => buildDistrictTemplateFoundationDraft({ ...base, layoutId: 'radial-ring', motifId: 'confetti' })).toThrow(RangeError);
  });
});
