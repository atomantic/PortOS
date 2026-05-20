import { describe, it, expect, vi, beforeEach } from 'vitest';

const NOT_SYNCED_ERROR = 'ClinVar database not synced. Click "Sync ClinVar" first.';
const NO_GENOME_ERROR = 'No genome data uploaded.';

// Mock the file-system helpers clinvar.js consumes. The service reads the
// compact index + meta via tryReadFile and writes/deletes via fs/promises.
const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { meatspace: '/mock/meatspace' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  tryReadFile: vi.fn(async (path) => (fileStore.has(path) ? fileStore.get(path) : null)),
  safeJSONParse: (raw, fallback) => {
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn(async (path, data) => {
    fileStore.set(path, data);
  }),
  unlink: vi.fn(async (path) => {
    if (!fileStore.has(path)) {
      const err = new Error('ENOENT');
      err.code = 'ENOENT';
      throw err;
    }
    fileStore.delete(path);
  })
}));

const INDEX_PATH = '/mock/meatspace/clinvar-index.json';
const META_PATH = '/mock/meatspace/clinvar-meta.json';
const GZ_PATH = '/mock/meatspace/clinvar-raw.txt.gz';

const {
  getClinvarStatus,
  invalidateClinvarCache,
  scanClinvar,
  deleteClinvar
} = await import('./clinvar.js');

describe('clinvar service', () => {
  beforeEach(() => {
    fileStore.clear();
    invalidateClinvarCache();
  });

  describe('getClinvarStatus', () => {
    it('returns { synced: false } when no meta file exists', async () => {
      expect(await getClinvarStatus()).toEqual({ synced: false });
    });

    it('returns the parsed meta payload when present', async () => {
      const meta = {
        synced: true,
        syncedAt: '2026-05-19T00:00:00.000Z',
        variantCount: 12345,
        downloadSize: 50_000_000,
        indexSize: 4_000_000
      };
      fileStore.set(META_PATH, JSON.stringify(meta));
      expect(await getClinvarStatus()).toEqual(meta);
    });
  });

  describe('scanClinvar', () => {
    it('errors when the index has not been synced', async () => {
      const result = await scanClinvar(new Map());
      expect(result.error).toBe(NOT_SYNCED_ERROR);
    });

    it('errors when snpIndex is missing', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({}));
      const result = await scanClinvar(null);
      expect(result.error).toBe(NO_GENOME_ERROR);
    });

    it('matches rsids against the ClinVar index and returns enriched findings', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs1: { g: 'BRCA1', s: 'pathogenic', c: ['Hereditary cancer'], r: 3, x: 'Pathogenic', n: 5 },
        rs2: { g: 'CYP2C19', s: 'drug_response', c: ['Clopidogrel response'], r: 2, x: 'drug response', n: 2 }
      }));
      const snpIndex = new Map([
        ['rs1', { genotype: 'AG', chromosome: '17', position: '41197695' }],
        ['rs2', { genotype: 'GG', chromosome: '10', position: '96521656' }],
        ['rs9999', { genotype: 'AA', chromosome: '1', position: '1' }] // not in index
      ]);

      const result = await scanClinvar(snpIndex);

      expect(result.totalMatched).toBe(2);
      expect(result.findings).toHaveLength(2);

      const brca1 = result.findings.find(f => f.rsid === 'rs1');
      expect(brca1).toMatchObject({
        gene: 'BRCA1',
        severity: 'pathogenic',
        status: 'major_concern',
        conditions: ['Hereditary cancer'],
        reviewStars: 3,
        submissions: 5,
        genotype: 'AG',
        chromosome: '17',
        position: '41197695'
      });

      const cyp = result.findings.find(f => f.rsid === 'rs2');
      expect(cyp.status).toBe('concern');
      expect(cyp.severity).toBe('drug_response');

      expect(result.bySeverity).toEqual({
        pathogenic: 1,
        drug_response: 1,
        risk_factor: 0,
        protective: 0
      });
    });

    it('sorts pathogenic before drug_response before risk_factor before protective', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs_prot: { g: 'G1', s: 'protective', c: [], r: 1, x: 'protective', n: 1 },
        rs_risk: { g: 'G2', s: 'risk_factor', c: [], r: 1, x: 'risk factor', n: 1 },
        rs_drug: { g: 'G3', s: 'drug_response', c: [], r: 1, x: 'drug response', n: 1 },
        rs_path: { g: 'G4', s: 'pathogenic', c: [], r: 1, x: 'pathogenic', n: 1 }
      }));
      const snpIndex = new Map([
        ['rs_prot', { genotype: 'CC' }],
        ['rs_risk', { genotype: 'AT' }],
        ['rs_drug', { genotype: 'GG' }],
        ['rs_path', { genotype: 'TT' }]
      ]);

      const { findings } = await scanClinvar(snpIndex);
      expect(findings.map(f => f.severity)).toEqual([
        'pathogenic',
        'drug_response',
        'risk_factor',
        'protective'
      ]);
    });

    it('breaks ties on severity by review-star count (descending)', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs_low: { g: 'G1', s: 'pathogenic', c: [], r: 1, x: 'pathogenic', n: 1 },
        rs_high: { g: 'G2', s: 'pathogenic', c: [], r: 4, x: 'pathogenic', n: 1 },
        rs_mid: { g: 'G3', s: 'pathogenic', c: [], r: 2, x: 'pathogenic', n: 1 }
      }));
      const snpIndex = new Map([
        ['rs_low', { genotype: 'AA' }],
        ['rs_high', { genotype: 'AA' }],
        ['rs_mid', { genotype: 'AA' }]
      ]);

      const { findings } = await scanClinvar(snpIndex);
      expect(findings.map(f => f.rsid)).toEqual(['rs_high', 'rs_mid', 'rs_low']);
    });

    it('maps unknown severity to the generic "concern" status', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs_weird: { g: 'Gx', s: 'mystery', c: [], r: 0, x: 'mystery', n: 1 }
      }));
      const { findings } = await scanClinvar(new Map([['rs_weird', { genotype: 'AA' }]]));
      expect(findings[0].status).toBe('concern');
    });

    it('returns gracefully when the index file is corrupt JSON', async () => {
      fileStore.set(INDEX_PATH, 'not-json-at-all{{{');
      const result = await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));
      expect(result.error).toBe(NOT_SYNCED_ERROR);
    });
  });

  describe('invalidateClinvarCache', () => {
    it('forces the next scan to re-read the index file from disk', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs1: { g: 'G1', s: 'pathogenic', c: [], r: 1, x: 'pathogenic', n: 1 }
      }));
      const first = await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));
      expect(first.totalMatched).toBe(1);

      // Mutate disk-state; with the cache live, the next scan should still see rs1.
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs2: { g: 'G2', s: 'pathogenic', c: [], r: 1, x: 'pathogenic', n: 1 }
      }));
      const cached = await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));
      expect(cached.totalMatched).toBe(1);

      // After invalidation, the next scan sees the fresh disk state.
      invalidateClinvarCache();
      const fresh = await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));
      expect(fresh.totalMatched).toBe(0);
    });
  });

  describe('deleteClinvar', () => {
    it('unlinks index + meta + raw, clears the cache, and reports success', async () => {
      fileStore.set(INDEX_PATH, JSON.stringify({
        rs1: { g: 'G1', s: 'pathogenic', c: [], r: 1, x: 'pathogenic', n: 1 }
      }));
      fileStore.set(META_PATH, JSON.stringify({ synced: true }));
      fileStore.set(GZ_PATH, 'binary-bytes');

      // Prime the in-memory cache.
      await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));

      const result = await deleteClinvar();
      expect(result).toEqual({ success: true });
      expect(fileStore.has(INDEX_PATH)).toBe(false);
      expect(fileStore.has(META_PATH)).toBe(false);
      expect(fileStore.has(GZ_PATH)).toBe(false);

      // Cache cleared: next scan with no index file returns the error sentinel.
      const scanAfter = await scanClinvar(new Map([['rs1', { genotype: 'AA' }]]));
      expect(scanAfter.error).toBe(NOT_SYNCED_ERROR);
    });

    it('succeeds even if no ClinVar files exist (unlink ENOENT is swallowed)', async () => {
      const result = await deleteClinvar();
      expect(result).toEqual({ success: true });
    });
  });
});
