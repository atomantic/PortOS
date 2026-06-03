import { describe, it, expect } from 'vitest';
import {
  PROVENANCE_LEVELS,
  PROVENANCE_LEVEL_IDS,
  getProvenanceLevel,
} from './healthProvenance.js';

describe('healthProvenance', () => {
  it('defines the four provenance levels named in issue #710', () => {
    expect(PROVENANCE_LEVEL_IDS).toEqual([
      'data-backed',
      'inferred',
      'experimental',
      'speculative',
    ]);
  });

  it('every level carries label, tone, description, and a what-would-change explainer', () => {
    for (const id of PROVENANCE_LEVEL_IDS) {
      const meta = PROVENANCE_LEVELS[id];
      expect(meta.id).toBe(id);
      expect(meta.label).toBeTruthy();
      expect(['success', 'accent', 'warning', 'muted']).toContain(meta.tone);
      expect(meta.description.length).toBeGreaterThan(10);
      expect(meta.whatWouldChange.length).toBeGreaterThan(10);
    }
  });

  it('resolves a known level id', () => {
    expect(getProvenanceLevel('speculative')).toBe(PROVENANCE_LEVELS.speculative);
  });

  it('is tolerant of casing and separators', () => {
    expect(getProvenanceLevel('Data Backed')).toBe(PROVENANCE_LEVELS['data-backed']);
    expect(getProvenanceLevel('DATA_BACKED')).toBe(PROVENANCE_LEVELS['data-backed']);
    expect(getProvenanceLevel('  experimental  ')).toBe(PROVENANCE_LEVELS.experimental);
  });

  it('falls back to inferred for unknown or empty input', () => {
    expect(getProvenanceLevel('nonsense')).toBe(PROVENANCE_LEVELS.inferred);
    expect(getProvenanceLevel('')).toBe(PROVENANCE_LEVELS.inferred);
    expect(getProvenanceLevel(null)).toBe(PROVENANCE_LEVELS.inferred);
    expect(getProvenanceLevel(undefined)).toBe(PROVENANCE_LEVELS.inferred);
    expect(getProvenanceLevel(42)).toBe(PROVENANCE_LEVELS.inferred);
  });
});
