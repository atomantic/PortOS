import { z } from 'zod';

export const genomeUploadSchema = z.object({
  content: z.string().min(100, 'Genome file content too short'),
  filename: z.string().min(1, 'Filename required')
});

export const genomeSearchSchema = z.object({
  rsid: z.string().regex(/^rs\d+$/, 'Must be a valid rsid (e.g., rs1234)')
});

export const genomeSaveMarkerSchema = z.object({
  rsid: z.string().regex(/^rs\d+$/),
  genotype: z.string().optional(),
  chromosome: z.string().optional(),
  position: z.string().optional(),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(50),
  gene: z.string().max(100).optional().default(''),
  description: z.string().max(2000).optional().default(''),
  implications: z.string().max(2000).optional().default(''),
  status: z.enum(['beneficial', 'typical', 'concern', 'major_concern', 'not_found']).optional().default('typical'),
  notes: z.string().max(5000).optional().default(''),
  references: z.array(z.string().url()).optional().default([])
});

export const genomeUpdateNotesSchema = z.object({
  notes: z.string().max(5000)
});

// === Epigenetic Lifestyle Tracking ===

export const epigeneticAddInterventionSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  name: z.string().min(1).max(200),
  category: z.enum(['supplement', 'lifestyle', 'custom']).default('custom'),
  dosage: z.string().max(200).optional().default(''),
  frequency: z.enum(['daily', 'weekly', 'as_needed']).default('daily'),
  trackingUnit: z.string().min(1).max(50).default('dose'),
  notes: z.string().max(5000).optional().default('')
});

export const epigeneticLogEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD format').optional(),
  amount: z.number().min(0),
  notes: z.string().max(2000).optional().default('')
});

export const epigeneticUpdateInterventionSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  dosage: z.string().max(200).optional(),
  frequency: z.enum(['daily', 'weekly', 'as_needed']).optional(),
  notes: z.string().max(5000).optional(),
  active: z.boolean().optional()
});
