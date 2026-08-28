/**
 * Durable provider profile for the persistent CoS mind.
 *
 * This is deliberately separate from persistentMind.js: that module owns
 * runtime wake state, while this one owns the user's stable, default-off
 * provider choice. A profile never implies that a mind is running.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';

export const PERSISTENT_MIND_PROFILE_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_THINKING_INTERFACE = 'text';

export const PERSISTENT_MIND_PROFILE_LIMITS = Object.freeze({
  PROVIDER_ID_MAX: 100,
  MODEL_MAX: 200,
  WAKE_INTERVAL_MINUTES_MIN: 5,
  WAKE_INTERVAL_MINUTES_MAX: 10_080,
});

export const DEFAULT_PERSISTENT_MIND_WAKE_INTERVAL_MINUTES = 30;

export const persistentMindProfileSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_PROFILE_SCHEMA_VERSION).optional(),
  enabled: z.boolean().optional(),
  providerId: z.string().max(PERSISTENT_MIND_PROFILE_LIMITS.PROVIDER_ID_MAX).optional(),
  model: z.string().max(PERSISTENT_MIND_PROFILE_LIMITS.MODEL_MAX).optional(),
  // Empty is the UI's explicit "provider default" sentinel. It is stored as
  // empty rather than null because config is a mergeable settings object.
  effort: z.union([z.literal(''), z.enum(EFFORT_LEVELS)]).optional(),
  thinkingInterface: z.literal(PERSISTENT_MIND_THINKING_INTERFACE).optional(),
  wakeIntervalMinutes: z.number()
    .int()
    .min(PERSISTENT_MIND_PROFILE_LIMITS.WAKE_INTERVAL_MINUTES_MIN)
    .max(PERSISTENT_MIND_PROFILE_LIMITS.WAKE_INTERVAL_MINUTES_MAX)
    .optional(),
}).strict();

export function createDefaultPersistentMindProfile() {
  return {
    schemaVersion: PERSISTENT_MIND_PROFILE_SCHEMA_VERSION,
    enabled: false,
    providerId: '',
    model: '',
    effort: '',
    thinkingInterface: PERSISTENT_MIND_THINKING_INTERFACE,
    wakeIntervalMinutes: DEFAULT_PERSISTENT_MIND_WAKE_INTERVAL_MINUTES,
  };
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

const wakeIntervalMinutes = (value) => (
  Number.isInteger(value)
    && value >= PERSISTENT_MIND_PROFILE_LIMITS.WAKE_INTERVAL_MINUTES_MIN
    && value <= PERSISTENT_MIND_PROFILE_LIMITS.WAKE_INTERVAL_MINUTES_MAX
    ? value
    : DEFAULT_PERSISTENT_MIND_WAKE_INTERVAL_MINUTES
);

/** Normalize legacy or hand-edited config without turning an invalid effort into a pin. */
export function normalizePersistentMindProfile(raw) {
  const defaults = createDefaultPersistentMindProfile();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const effort = text(source.effort, 20);
  return {
    ...defaults,
    enabled: source.enabled === true,
    providerId: text(source.providerId, PERSISTENT_MIND_PROFILE_LIMITS.PROVIDER_ID_MAX),
    model: text(source.model, PERSISTENT_MIND_PROFILE_LIMITS.MODEL_MAX),
    effort: EFFORT_LEVELS.includes(effort) ? effort : '',
    thinkingInterface: source.thinkingInterface === PERSISTENT_MIND_THINKING_INTERFACE
      ? source.thinkingInterface
      : PERSISTENT_MIND_THINKING_INTERFACE,
    wakeIntervalMinutes: wakeIntervalMinutes(source.wakeIntervalMinutes),
  };
}

/** Resolve the user's maximum quiet period to scheduler milliseconds. */
export function persistentMindWakeIntervalMs(raw) {
  return normalizePersistentMindProfile(raw).wakeIntervalMinutes * 60_000;
}

/**
 * Merge a partial update without carrying a model/effort chosen for another
 * provider. Changing providers always clears dependent selections unless the
 * caller supplies replacements in the same request.
 */
export function mergePersistentMindProfile(previous, update) {
  const prior = normalizePersistentMindProfile(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  const providerChanged = patch.providerId !== undefined && patch.providerId !== prior.providerId;
  return normalizePersistentMindProfile({
    ...prior,
    ...patch,
    ...(providerChanged && patch.model === undefined ? { model: '' } : {}),
    ...(providerChanged && patch.effort === undefined ? { effort: '' } : {}),
  });
}
