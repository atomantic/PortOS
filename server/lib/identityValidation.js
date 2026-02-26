import { z } from 'zod';

export const sectionStatusEnum = z.enum(['active', 'pending', 'unavailable']);

export const chronotypeEnum = z.enum(['morning', 'intermediate', 'evening']);

const hhmmRegex = /^([01]\d|2[0-3]):[0-5]\d$/;

export const chronotypeBehavioralInputSchema = z.object({
  preferredWakeTime: z.string().regex(hhmmRegex, 'Must be HH:MM format').optional(),
  preferredSleepTime: z.string().regex(hhmmRegex, 'Must be HH:MM format').optional(),
  peakFocusStart: z.string().regex(hhmmRegex, 'Must be HH:MM format').optional(),
  peakFocusEnd: z.string().regex(hhmmRegex, 'Must be HH:MM format').optional(),
  caffeineLastIntake: z.string().regex(hhmmRegex, 'Must be HH:MM format').optional()
});

// --- Longevity Schemas ---

export const birthDateInputSchema = z.object({
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
});

// --- Goal Schemas ---

export const goalHorizonEnum = z.enum([
  '1-year', '3-year', '5-year', '10-year', '20-year', 'lifetime'
]);

export const goalCategoryEnum = z.enum([
  'creative', 'family', 'health', 'financial', 'legacy', 'mastery'
]);

export const goalStatusEnum = z.enum(['active', 'completed', 'abandoned']);

export const createGoalInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  horizon: goalHorizonEnum.optional().default('5-year'),
  category: goalCategoryEnum.optional().default('mastery')
});

export const updateGoalInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  horizon: goalHorizonEnum.optional(),
  category: goalCategoryEnum.optional(),
  status: goalStatusEnum.optional()
});

export const addMilestoneInputSchema = z.object({
  title: z.string().min(1).max(200),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format').optional()
});
