import { z } from 'zod';
import { FEATURE_AREA_IDS } from './goalFeatureMap.js';

// Per-goal feature-area override (issue #2666): an ordered list of feature-area
// ids the Daily Driver deep-links to for this goal, overriding the category
// default. Absent/empty → the goal falls back to its category's default map.
//
// Two schemas, because create and update have different forward-compat needs
// (issue #2679):
//   - CREATE stays strict (`z.enum(FEATURE_AREA_IDS)`): a brand-new goal is
//     authored on THIS install, so an id outside this version's set is a typo or
//     a bug worth rejecting — `getGoalFeatureAreas` would silently discard it.
//   - UPDATE is lenient (any non-empty string): goals sync between federated
//     peers as whole records (no schema-version gate), so an older install can
//     receive — and store, via dataSync's direct file write which bypasses this
//     route validation — a goal carrying a feature-area id a newer peer
//     introduced. If the edit path rejected those ids, saving that goal would
//     400; so we accept unknown ids on update and let `getGoalFeatureAreas`
//     filter ids this install doesn't know at read time (preserved in storage,
//     ignored when resolving areas). The cap stays generous (not tied to this
//     install's FEATURE_AREA_IDS.length) so a goal pinning more areas than this
//     version knows still validates.
const createFeatureAreasSchema = z.array(z.enum(FEATURE_AREA_IDS)).max(FEATURE_AREA_IDS.length);
const updateFeatureAreasSchema = z.array(z.string().min(1)).max(64);

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
  timeBlockConfig: timeBlockConfigSchema.optional(),
  featureAreas: createFeatureAreasSchema.optional()
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
  timeBlockConfig: timeBlockConfigSchema.nullable().optional(),
  featureAreas: updateFeatureAreasSchema.optional()
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

// --- Goal Decomposition Schemas (milestones pre-populated with tasks) ---

export const decomposeGoalInputSchema = aiProviderInputSchema;

// Mirrors addTodoInputSchema; estimateMinutes optional — tolerate the explicit
// `null` an LLM commonly emits (the service normalizes it to null anyway).
export const decomposedTaskSchema = z.object({
  title: z.string().min(1).max(200),
  priority: z.enum(['low', 'medium', 'high']).optional().default('medium'),
  estimateMinutes: z.number().int().min(1).max(14400).nullable().optional()
});

export const acceptDecompositionInputSchema = z.object({
  milestones: z.array(z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional().default(''),
    // targetDate optional/nullable — decomposition works without a goal target
    // date, and the LLM may emit an explicit `null` for a dateless milestone.
    targetDate: validCalendarDate.nullable().optional(),
    order: z.number().int().min(0),
    tasks: z.array(decomposedTaskSchema).max(20).optional().default([])
  })).min(1).max(20)
});

// --- Goal Proposal Schemas (generation-time validation of raw LLM output) ---
//
// generateGoalPhases / decomposeGoal return the LLM proposal to the review UI
// WITHOUT persisting it, so the user can edit before accept. These schemas
// validate/coerce that raw output at generation time and fail fast with a clear
// AI_PARSE_ERROR instead of passing a malformed shape (non-object element,
// missing title, wrong-typed tasks) downstream to only blow up at accept-time.
//
// Intentionally looser than the accept schemas: `targetDate` is a free string
// here (the LLM commonly emits a near-miss date the user fixes in review; the
// strict validCalendarDate check still runs at accept) and unknown keys are
// stripped. The strictness is on structural shape — title present, tasks
// well-formed. `order` is optional on each element but the array-level transform
// below stamps it from the index when absent, so the proposal the review UI
// hands back always satisfies the accept route's required `order` field.
export const goalPhaseProposalSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional().default(''),
  targetDate: z.string().max(40).nullable().optional(),
  order: z.number().int().min(0).optional()
});

// Fill a missing `order` from the array index so generation output is always
// accept-ready (the accept route requires `order`); an LLM-supplied order wins.
const stampOrder = (arr) => arr.map((el, i) => ({ ...el, order: el.order ?? i }));

export const goalPhasesProposalSchema = z.array(goalPhaseProposalSchema).min(1).max(50).transform(stampOrder);

export const goalDecompositionMilestoneProposalSchema = goalPhaseProposalSchema.extend({
  tasks: z.array(decomposedTaskSchema).max(50).optional().default([])
});

export const goalDecompositionProposalSchema = z.array(goalDecompositionMilestoneProposalSchema).min(1).max(50).transform(stampOrder);

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
