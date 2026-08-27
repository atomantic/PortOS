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
});

export const persistentMindProfileSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_PROFILE_SCHEMA_VERSION).optional(),
  enabled: z.boolean().optional(),
  providerId: z.string().max(PERSISTENT_MIND_PROFILE_LIMITS.PROVIDER_ID_MAX).optional(),
  model: z.string().max(PERSISTENT_MIND_PROFILE_LIMITS.MODEL_MAX).optional(),
  // Empty is the UI's explicit "provider default" sentinel. It is stored as
  // empty rather than null because config is a mergeable settings object.
  effort: z.union([z.literal(''), z.enum(EFFORT_LEVELS)]).optional(),
  thinkingInterface: z.literal(PERSISTENT_MIND_THINKING_INTERFACE).optional(),
}).strict();

export function createDefaultPersistentMindProfile() {
  return {
    schemaVersion: PERSISTENT_MIND_PROFILE_SCHEMA_VERSION,
    enabled: false,
    providerId: '',
    model: '',
    effort: '',
    thinkingInterface: PERSISTENT_MIND_THINKING_INTERFACE,
  };
}

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

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
  };
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
