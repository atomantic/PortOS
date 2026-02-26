import { z } from 'zod';

// =============================================================================
// MEATSPACE CONFIG & LIFESTYLE
// =============================================================================

export const smokingStatusSchema = z.enum(['never', 'former', 'current']);
export const dietQualitySchema = z.enum(['excellent', 'good', 'fair', 'poor']);
export const stressLevelSchema = z.enum(['low', 'moderate', 'high']);

export const lifestyleSchema = z.object({
  smokingStatus: smokingStatusSchema.optional().default('never'),
  alcoholDrinksPerDay: z.number().min(0).max(50).optional(),
  exerciseMinutesPerWeek: z.number().min(0).max(2000).optional().default(150),
  sleepHoursPerNight: z.number().min(0).max(24).optional().default(7.5),
  dietQuality: dietQualitySchema.optional().default('good'),
  stressLevel: stressLevelSchema.optional().default('moderate'),
  bmi: z.number().min(10).max(80).optional(),
  chronicConditions: z.array(z.string().max(100)).optional().default([])
});

export const configSchema = z.object({
  sex: z.enum(['male', 'female']).optional(),
  sexSource: z.enum(['genome', 'questionnaire']).optional(),
  lifestyle: lifestyleSchema.optional()
});

export const configUpdateSchema = configSchema.partial();
export const lifestyleUpdateSchema = lifestyleSchema.partial();

// =============================================================================
// ALCOHOL
// =============================================================================

export const drinkLogSchema = z.object({
  name: z.string().max(200).optional().default(''),
  oz: z.number().min(0.1).max(1000),
  abv: z.number().min(0).max(100),
  count: z.number().int().min(1).max(100).optional().default(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

// =============================================================================
// BLOOD TESTS
// =============================================================================

export const bloodTestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metabolicPanel: z.record(z.number().nullable()).optional(),
  cbc: z.record(z.number().nullable()).optional(),
  lipids: z.record(z.number().nullable()).optional(),
  thyroid: z.record(z.number().nullable()).optional(),
  hormones: z.record(z.number().nullable()).optional(),
  homocysteine: z.number().nullable().optional()
});

// =============================================================================
// BODY COMPOSITION
// =============================================================================

export const bodyEntrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weightLbs: z.number().min(50).max(1000).optional(),
  weightKg: z.number().min(20).max(500).optional(),
  musclePct: z.number().min(0).max(100).nullable().optional(),
  fatPct: z.number().min(0).max(100).nullable().optional(),
  boneMass: z.number().nullable().optional(),
  temperature: z.number().nullable().optional()
});

// =============================================================================
// EPIGENETIC TESTS
// =============================================================================

export const epigeneticTestSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  chronologicalAge: z.number().min(0).max(150).optional(),
  biologicalAge: z.number().min(0).max(150).optional(),
  paceOfAging: z.number().min(0).max(5).optional(),
  organScores: z.record(z.number().nullable()).optional()
});

// =============================================================================
// EYES
// =============================================================================

export const eyeExamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rightSphere: z.number().nullable().optional(),
  rightCylinder: z.number().nullable().optional(),
  rightAxis: z.number().nullable().optional(),
  leftSphere: z.number().nullable().optional(),
  leftCylinder: z.number().nullable().optional(),
  leftAxis: z.number().nullable().optional()
});

// =============================================================================
// TSV IMPORT
// =============================================================================

export const tsvImportSchema = z.object({
  content: z.string().min(1).max(10 * 1024 * 1024)
});
