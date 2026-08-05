import { describe, expect, it } from 'vitest';
import {
  GENERAL_FAMILY_ID,
  THREEJS_MODEL_FAMILIES,
  THREEJS_MODEL_FAMILY_IDS,
  THREEJS_MODEL_FAMILY_OPTIONS,
  buildThreejsFamilyChecklist,
  findMissingFamilyComponents,
  getThreejsModelFamily,
} from './threejsModelFamilies.js';

describe('the taxonomy itself', () => {
  it('keeps every family id unique and exposes general as an explicit option', () => {
    expect(new Set(THREEJS_MODEL_FAMILY_IDS).size).toBe(THREEJS_MODEL_FAMILY_IDS.length);
    expect(THREEJS_MODEL_FAMILY_IDS[0]).toBe(GENERAL_FAMILY_ID);
    expect(THREEJS_MODEL_FAMILY_OPTIONS.map((option) => option.id)).toEqual(THREEJS_MODEL_FAMILY_IDS);
    // Every option needs a label AND the one line telling the user when to pick
    // it — a picker of bare ids is how a taxonomy stops getting used.
    for (const option of THREEJS_MODEL_FAMILY_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.length).toBeGreaterThan(0);
    }
  });

  it('gives every family real content in all four dimensions', () => {
    // A family missing any one of these degrades to a worse-than-nothing
    // checklist: components with no aliases match nothing, and a family with no
    // orbit views cannot tell the user what to check.
    for (const family of THREEJS_MODEL_FAMILIES) {
      expect(family.components.length).toBeGreaterThanOrEqual(5);
      expect(family.materialZones.length).toBeGreaterThan(0);
      expect(family.reviewAxes.length).toBeGreaterThan(0);
      expect(family.orbitViews.length).toBeGreaterThan(0);
      for (const component of family.components) {
        expect(component.aliases.length).toBeGreaterThan(0);
        // Aliases are matched against lowercased spec text, so an uppercase
        // alias would silently never match.
        for (const alias of component.aliases) expect(alias).toBe(alias.toLowerCase());
      }
    }
  });
});

describe('getThreejsModelFamily', () => {
  it('resolves a known family', () => {
    expect(getThreejsModelFamily('vehicle')?.label).toBe('Vehicle');
  });

  it('degrades an absent, general, or unknown id to no checklist', () => {
    // A record synced from a peer running a newer taxonomy must still render;
    // "no checklist" is always a safe answer, throwing is not.
    expect(getThreejsModelFamily(undefined)).toBeNull();
    expect(getThreejsModelFamily(GENERAL_FAMILY_ID)).toBeNull();
    expect(getThreejsModelFamily('kaiju-mecha-hybrid')).toBeNull();
  });
});

describe('buildThreejsFamilyChecklist', () => {
  it('emits nothing for the default family so the shipped prompt is unchanged', () => {
    expect(buildThreejsFamilyChecklist(GENERAL_FAMILY_ID)).toBe('');
    expect(buildThreejsFamilyChecklist(undefined)).toBe('');
    expect(buildThreejsFamilyChecklist('not-a-family')).toBe('');
  });

  it('names every required component, material zone, review axis, and orbit view', () => {
    const family = getThreejsModelFamily('weapon');
    const block = buildThreejsFamilyChecklist('weapon');
    for (const component of family.components) expect(block).toContain(component.name);
    for (const zone of family.materialZones) expect(block).toContain(zone);
    for (const axis of family.reviewAxes) expect(block).toContain(axis);
    for (const view of family.orbitViews) expect(block).toContain(view);
  });

  it('states the floor-not-ceiling framing and the limitations escape hatch', () => {
    // Without both, the checklist becomes a ceiling — the model inventories the
    // listed components, stops looking, and silently drops what it cannot find.
    const block = buildThreejsFamilyChecklist('character');
    expect(block).toContain('FLOOR, not a');
    expect(block).toContain('ceiling');
    expect(block).toContain('limitations');
  });
});

describe('findMissingFamilyComponents', () => {
  const specWith = (overrides = {}) => ({
    summary: '',
    limitations: [],
    parts: [],
    detailInventory: [],
    ...overrides,
  });

  it('returns null when no family applies, so callers can skip the check entirely', () => {
    expect(findMissingFamilyComponents(specWith(), GENERAL_FAMILY_ID)).toBeNull();
    expect(findMissingFamilyComponents(specWith(), undefined)).toBeNull();
  });

  it('reports every required component when the spec says nothing at all', () => {
    const result = findMissingFamilyComponents(specWith(), 'device');
    expect(result.family.id).toBe('device');
    expect(result.missing).toEqual(getThreejsModelFamily('device').components.map((c) => c.name));
  });

  it('accepts evidence from a detail feature, a part name, or a nested child part', () => {
    const result = findMissingFamilyComponents(specWith({
      detailInventory: [{ feature: 'Recessed display bezel', evidence: 'Front face' }],
      parts: [{ name: 'Outer housing', children: [{ name: 'Cooling vent bank' }] }],
    }), 'device');
    expect(result.missing).not.toContain('Display or indicator');
    expect(result.missing).not.toContain('Enclosure');
    // Nested children count — a component modelled two levels down is still
    // modelled, and reporting it missing would send refinement after geometry
    // that already exists.
    expect(result.missing).not.toContain('Vents or cooling');
  });

  it('treats an explicit limitation as accounting for a component', () => {
    // The gate is looking for silence, not for a negative answer: a model that
    // consciously ruled a component out did the right thing and must not be
    // told to go build it.
    const result = findMissingFamilyComponents(specWith({
      limitations: ['The reference crops the vehicle above its wheels, so none are modelled.'],
    }), 'vehicle');
    expect(result.missing).not.toContain('Ground contact or propulsion');
  });

  it('matches case-insensitively', () => {
    const shouty = findMissingFamilyComponents(specWith({
      parts: [{ name: 'PRIMARY HULL' }],
    }), 'vehicle');
    expect(shouty.missing).not.toContain('Chassis or hull');
  });

  it('tolerates a spec with no arrays where it expects them', () => {
    // The evaluator's inputs come off a stored record, which may predate any of
    // these fields; a throw here would take down the whole coverage pass.
    const result = findMissingFamilyComponents({}, 'character');
    expect(result.missing.length).toBe(getThreejsModelFamily('character').components.length);
  });
});
