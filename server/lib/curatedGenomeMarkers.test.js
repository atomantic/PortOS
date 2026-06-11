import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  CURATED_MARKERS,
  MARKER_CATEGORIES,
  formatGenotype,
  classifyGenotype,
  resolveApoeHaplotype,
} from './curatedGenomeMarkers.js';

const dir = dirname(fileURLToPath(import.meta.url));
const rawJson = JSON.parse(readFileSync(join(dir, 'curatedGenomeMarkers.json'), 'utf8'));

// Issue #1154 moved the ~116-marker dataset out of the .js literal into a
// co-located JSON loaded at module init. These guard that load + the
// classification logic the .js kept.
describe('curatedGenomeMarkers — JSON-backed dataset', () => {
  it('CURATED_MARKERS is the parsed JSON, non-empty', () => {
    expect(Array.isArray(CURATED_MARKERS)).toBe(true);
    expect(CURATED_MARKERS.length).toBe(rawJson.length);
    expect(CURATED_MARKERS.length).toBeGreaterThan(100);
  });

  it('every marker has the documented shape and a known category', () => {
    const categories = new Set(Object.keys(MARKER_CATEGORIES));
    for (const m of CURATED_MARKERS) {
      expect(typeof m.rsid, `rsid of ${JSON.stringify(m).slice(0, 60)}`).toBe('string');
      // Most are dbSNP `rs…` ids; a few are 23andMe internal `i…` ids.
      expect(m.rsid).toMatch(/^(rs|i)\d+$/);
      expect(typeof m.gene).toBe('string');
      expect(categories.has(m.category), `unknown category '${m.category}' on ${m.rsid}`).toBe(true);
      expect(Array.isArray(m.rules)).toBe(true);
      for (const rule of m.rules) {
        expect(Array.isArray(rule.genotypes)).toBe(true);
        expect(typeof rule.status).toBe('string');
      }
    }
  });

  it('rsids are unique', () => {
    const ids = CURATED_MARKERS.map((m) => m.rsid);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('formatGenotype', () => {
  it('returns null for missing/no-call genotypes', () => {
    expect(formatGenotype('')).toBeNull();
    expect(formatGenotype('--')).toBeNull();
    expect(formatGenotype('00')).toBeNull();
    expect(formatGenotype(null)).toBeNull();
  });

  it('formats a two-allele string to slash form (uppercased, trimmed)', () => {
    expect(formatGenotype('ct')).toBe('C/T');
    expect(formatGenotype(' AG ')).toBe('A/G');
  });

  it('expands a single allele to homozygous', () => {
    expect(formatGenotype('C')).toBe('C/C');
  });

  it('passes through an already-slashed genotype', () => {
    expect(formatGenotype('C/T')).toBe('C/T');
  });
});

describe('classifyGenotype', () => {
  const marker = { rules: [{ genotypes: ['G/G'], status: 'beneficial' }, { genotypes: ['G/T'], status: 'typical' }] };

  it('returns not_found for an empty/no-call genotype', () => {
    expect(classifyGenotype(marker, '')).toBe('not_found');
    expect(classifyGenotype(marker, '--')).toBe('not_found');
  });

  it('returns the rule status when a genotype matches', () => {
    expect(classifyGenotype(marker, 'GG')).toBe('beneficial');
    expect(classifyGenotype(marker, 'GT')).toBe('typical');
  });

  it('falls back to typical for an unknown-but-valid genotype', () => {
    expect(classifyGenotype(marker, 'TT')).toBe('typical');
  });
});

describe('resolveApoeHaplotype', () => {
  it('resolves the ε3/ε3 baseline (T/T + C/C)', () => {
    const r = resolveApoeHaplotype('TT', 'CC');
    expect(r?.haplotype).toBe('ε3/ε3');
    expect(r?.status).toBe('typical');
  });

  it('resolves ε4/ε4 as major_concern (C/C + C/C)', () => {
    const r = resolveApoeHaplotype('CC', 'CC');
    expect(r?.haplotype).toBe('ε4/ε4');
    expect(r?.status).toBe('major_concern');
  });

  it('is allele-order-insensitive (C/T == T/C)', () => {
    expect(resolveApoeHaplotype('CT', 'CC')?.haplotype).toBe(resolveApoeHaplotype('TC', 'CC')?.haplotype);
  });

  it('returns null when either SNP is a no-call', () => {
    expect(resolveApoeHaplotype('--', 'CC')).toBeNull();
    expect(resolveApoeHaplotype('TT', '')).toBeNull();
  });
});
