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

const validCalendarDate = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD format')
  .refine((value) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    const [y, m, d] = value.split('-').map(Number);
    return date.getUTCFullYear() === y && date.getUTCMonth() + 1 === m && date.getUTCDate() === d;
  }, 'Must be a valid calendar date');

export const birthDateInputSchema = z.object({
  birthDate: validCalendarDate.refine(
    (value) => {
      const today = new Date();
      today.setUTCHours(23, 59, 59, 999);
      return new Date(value) <= today;
    },
    'Birth date cannot be in the future'
  )
});

// --- Goal Schemas ---

export const goalHorizonEnum = z.enum([
  '1-year', '3-year', '5-year', '10-year', '20-year', 'lifetime'
]);

export const goalCategoryEnum = z.enum([
  'creative', 'family', 'health', 'financial', 'legacy', 'mastery'
]);

export const goalStatusEnum = z.enum(['active', 'completed', 'abandoned']);

export const goalTypeEnum = z.enum(['apex', 'sub-apex', 'standard']);

const timeBlockConfigSchema = z.object({
  preferredDays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).min(1).max(7),
  timeSlot: z.union([
    z.enum(['morning', 'afternoon', 'evening']),
    z.string().regex(hhmmRegex, 'Must be HH:MM format')
  ]),
  sessionDurationMinutes: z.number().int().min(15).max(480),
  subcalendarId: z.string().min(1).optional()
});

export const createGoalInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  horizon: goalHorizonEnum.optional().default('5-year'),
  category: goalCategoryEnum.optional().default('mastery'),
  goalType: goalTypeEnum.optional().default('standard'),
  parentId: z.string().min(1).nullable().optional().default(null),
  tags: z.array(z.string().min(1).max(50)).max(20).optional().default([]),
  targetDate: validCalendarDate.optional(),
  timeBlockConfig: timeBlockConfigSchema.optional()
});

export const updateGoalInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  horizon: goalHorizonEnum.optional(),
  category: goalCategoryEnum.optional(),
  goalType: goalTypeEnum.optional(),
  status: goalStatusEnum.optional(),
  parentId: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  targetDate: validCalendarDate.nullable().optional(),
  timeBlockConfig: timeBlockConfigSchema.nullable().optional()
});

export const addMilestoneInputSchema = z.object({
  title: z.string().min(1).max(200),
  targetDate: validCalendarDate.optional()
});

export const aiProviderInputSchema = z.object({
  providerId: z.string().min(1).optional(),
  model: z.string().min(1).optional()
});

export const generatePhasesInputSchema = aiProviderInputSchema;

export const acceptPhasesInputSchema = z.object({
  phases: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional().default(''),
    targetDate: validCalendarDate,
    order: z.number().int().min(0)
  })).min(1).max(20)
});

// --- Goal Progress Log Schemas ---

export const addProgressEntrySchema = z.object({
  date: validCalendarDate,
  note: z.string().min(1).max(1000),
  durationMinutes: z.number().int().min(1).max(1440).optional()
});

// --- Goal Todo Schemas ---

export const todoPriorityEnum = z.enum(['low', 'medium', 'high']);
export const todoStatusEnum = z.enum(['pending', 'in-progress', 'done']);

export const addTodoInputSchema = z.object({
  title: z.string().min(1).max(200),
  priority: todoPriorityEnum.optional().default('medium'),
  estimateMinutes: z.number().int().min(1).max(14400).optional()
});

export const updateTodoInputSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  status: todoStatusEnum.optional(),
  priority: todoPriorityEnum.optional(),
  estimateMinutes: z.number().int().min(1).max(14400).nullable().optional()
});

// --- Goal Progress Percentage Schema ---

export const updateProgressSchema = z.object({
  value: z.number().min(0).max(100)
});

// --- Goal-Activity Link Schemas ---

export const linkActivityInputSchema = z.object({
  activityName: z.string().min(1).max(200),
  requiredFrequency: z.number().positive().optional(),
  note: z.string().max(500).optional().default('')
});

// --- Goal-Calendar Link Schemas ---

export const linkCalendarInputSchema = z.object({
  subcalendarId: z.string().min(1),
  subcalendarName: z.string().min(1),
  matchPattern: z.string().max(200).optional().default('')
});

// --- Goal Organization Schemas ---

export const organizeGoalsInputSchema = aiProviderInputSchema;

export const checkInGoalInputSchema = aiProviderInputSchema;

export const applyOrganizationInputSchema = z.object({
  organization: z.array(z.object({
    id: z.string().min(1),
    goalType: goalTypeEnum.optional(),
    suggestedParentId: z.string().min(1).nullable().optional(),
    reasoning: z.string().optional()
  })).min(1)
});
