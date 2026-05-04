import { describe, it, expect } from 'vitest';
import {
  genomeUploadSchema,
  genomeSearchSchema,
  genomeSaveMarkerSchema,
  genomeUpdateNotesSchema,
  epigeneticAddInterventionSchema,
  epigeneticLogEntrySchema,
  epigeneticUpdateInterventionSchema
} from './genomeValidation.js';

describe('genomeValidation', () => {
  describe('genomeUploadSchema', () => {
    it('accepts content of at least 100 chars and a filename', () => {
      const r = genomeUploadSchema.safeParse({
        content: 'a'.repeat(100),
        filename: 'genome.txt'
      });
      expect(r.success).toBe(true);
    });

    it('rejects content under the 100-char minimum', () => {
      const r = genomeUploadSchema.safeParse({
        content: 'short',
        filename: 'g.txt'
      });
      expect(r.success).toBe(false);
    });

    it('rejects empty filename', () => {
      const r = genomeUploadSchema.safeParse({
        content: 'a'.repeat(200),
        filename: ''
      });
      expect(r.success).toBe(false);
    });
  });

  describe('genomeSearchSchema', () => {
    it('accepts a well-formed rsid', () => {
      expect(genomeSearchSchema.safeParse({ rsid: 'rs1234' }).success).toBe(true);
      expect(genomeSearchSchema.safeParse({ rsid: 'rs7412' }).success).toBe(true);
    });

    it('rejects non-rsid strings', () => {
      expect(genomeSearchSchema.safeParse({ rsid: '1234' }).success).toBe(false);
      expect(genomeSearchSchema.safeParse({ rsid: 'snp1234' }).success).toBe(false);
      expect(genomeSearchSchema.safeParse({ rsid: 'rs' }).success).toBe(false);
      expect(genomeSearchSchema.safeParse({ rsid: 'rsABC' }).success).toBe(false);
    });
  });

  describe('genomeSaveMarkerSchema', () => {
    it('accepts a minimal marker with required fields', () => {
      const r = genomeSaveMarkerSchema.safeParse({
        rsid: 'rs1234',
        name: 'Test Marker',
        category: 'metabolism'
      });
      expect(r.success).toBe(true);
      // optional fields should default to safe values
      expect(r.data.gene).toBe('');
      expect(r.data.description).toBe('');
      expect(r.data.implications).toBe('');
      expect(r.data.status).toBe('typical');
      expect(r.data.notes).toBe('');
      expect(r.data.references).toEqual([]);
    });

    it('accepts a fully-populated marker', () => {
      const r = genomeSaveMarkerSchema.safeParse({
        rsid: 'rs429358',
        genotype: 'CT',
        chromosome: '19',
        position: '45411941',
        name: 'APOE',
        category: 'longevity',
        gene: 'APOE',
        description: 'Apolipoprotein E variant',
        implications: 'Cardio risk',
        status: 'concern',
        notes: 'Follow up annually',
        references: ['https://snpedia.com/index.php/Rs429358']
      });
      expect(r.success).toBe(true);
      expect(r.data.status).toBe('concern');
    });

    it('rejects unknown status values', () => {
      const r = genomeSaveMarkerSchema.safeParse({
        rsid: 'rs1',
        name: 'X',
        category: 'c',
        status: 'unknown_status'
      });
      expect(r.success).toBe(false);
    });

    it('rejects non-URL references', () => {
      const r = genomeSaveMarkerSchema.safeParse({
        rsid: 'rs1',
        name: 'X',
        category: 'c',
        references: ['not-a-url']
      });
      expect(r.success).toBe(false);
    });

    it('rejects rsid that does not match the pattern', () => {
      const r = genomeSaveMarkerSchema.safeParse({
        rsid: 'foo',
        name: 'X',
        category: 'c'
      });
      expect(r.success).toBe(false);
    });
  });

  describe('genomeUpdateNotesSchema', () => {
    it('accepts notes within length cap', () => {
      expect(genomeUpdateNotesSchema.safeParse({ notes: '' }).success).toBe(true);
      expect(genomeUpdateNotesSchema.safeParse({ notes: 'hi' }).success).toBe(true);
    });

    it('rejects notes above 5000 chars', () => {
      expect(genomeUpdateNotesSchema.safeParse({ notes: 'x'.repeat(5001) }).success).toBe(false);
    });
  });

  describe('epigeneticAddInterventionSchema', () => {
    it('accepts the minimum input and applies defaults', () => {
      const r = epigeneticAddInterventionSchema.safeParse({ name: 'Vitamin D' });
      expect(r.success).toBe(true);
      expect(r.data.category).toBe('custom');
      expect(r.data.frequency).toBe('daily');
      expect(r.data.trackingUnit).toBe('dose');
      expect(r.data.dosage).toBe('');
      expect(r.data.notes).toBe('');
    });

    it('accepts known categories and frequencies', () => {
      expect(epigeneticAddInterventionSchema.safeParse({
        name: 'Run', category: 'lifestyle', frequency: 'weekly'
      }).success).toBe(true);
      expect(epigeneticAddInterventionSchema.safeParse({
        name: 'Magnesium', category: 'supplement', frequency: 'as_needed'
      }).success).toBe(true);
    });

    it('rejects unknown category', () => {
      const r = epigeneticAddInterventionSchema.safeParse({
        name: 'X', category: 'mystery'
      });
      expect(r.success).toBe(false);
    });

    it('rejects unknown frequency', () => {
      const r = epigeneticAddInterventionSchema.safeParse({
        name: 'X', frequency: 'monthly'
      });
      expect(r.success).toBe(false);
    });

    it('rejects empty name', () => {
      expect(epigeneticAddInterventionSchema.safeParse({ name: '' }).success).toBe(false);
    });
  });

  describe('epigeneticLogEntrySchema', () => {
    it('accepts a positive amount with no date (date is optional)', () => {
      const r = epigeneticLogEntrySchema.safeParse({ amount: 1 });
      expect(r.success).toBe(true);
      expect(r.data.notes).toBe('');
    });

    it('accepts amount 0', () => {
      expect(epigeneticLogEntrySchema.safeParse({ amount: 0 }).success).toBe(true);
    });

    it('rejects negative amount', () => {
      expect(epigeneticLogEntrySchema.safeParse({ amount: -1 }).success).toBe(false);
    });

    it('accepts a YYYY-MM-DD date', () => {
      expect(epigeneticLogEntrySchema.safeParse({ amount: 1, date: '2026-05-03' }).success).toBe(true);
    });

    it('rejects malformed dates', () => {
      expect(epigeneticLogEntrySchema.safeParse({ amount: 1, date: '5/3/2026' }).success).toBe(false);
      expect(epigeneticLogEntrySchema.safeParse({ amount: 1, date: '2026-5-3' }).success).toBe(false);
    });
  });

  describe('epigeneticUpdateInterventionSchema', () => {
    it('accepts an empty object (all fields optional)', () => {
      expect(epigeneticUpdateInterventionSchema.safeParse({}).success).toBe(true);
    });

    it('accepts a partial update', () => {
      expect(epigeneticUpdateInterventionSchema.safeParse({ active: false }).success).toBe(true);
      expect(epigeneticUpdateInterventionSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    });

    it('rejects invalid frequency value', () => {
      expect(epigeneticUpdateInterventionSchema.safeParse({ frequency: 'monthly' }).success).toBe(false);
    });
  });
});
