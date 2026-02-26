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
