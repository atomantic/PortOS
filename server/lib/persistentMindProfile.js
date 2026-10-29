/**
 * Durable provider profile for the persistent CoS mind.
 *
 * This is deliberately separate from persistentMind.js: that module owns
 * runtime wake state, while this one owns the user's stable, default-off
 * provider choice. A profile never implies that a mind is running.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { isToolFreeOneShotProvider } from './providerVendors.js';
import { trimTo } from './textUtils.js';

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
  const effort = trimTo(source.effort, 20);
  return {
    ...defaults,
    enabled: source.enabled === true,
    providerId: trimTo(source.providerId, PERSISTENT_MIND_PROFILE_LIMITS.PROVIDER_ID_MAX),
    model: trimTo(source.model, PERSISTENT_MIND_PROFILE_LIMITS.MODEL_MAX),
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

/**
 * The reason a provider cannot back the mind, or null when it can. The mind
 * wakes unattended and reads text other people wrote (feeds, invitations,
 * public issues, peer chat), so a vendor shell/file toolset — which no semantic
 * grant governs — is never available to it. Only an API provider or a headless
 * CLI with an enforced tool-free mode qualifies; there is no operator escape
 * hatch because no operator is present for a wake.
 */
export function persistentMindToolFreeRefusal(provider) {
  if (!provider || isToolFreeOneShotProvider(provider)) return null;
  const label = provider.id || provider.command || 'unknown';
  const lane = provider.type === 'tui' ? 'an interactive TUI' : `a ${provider.type || 'unknown'} provider`;
  return `Persistent Mind cannot use provider "${label}": it is ${lane} that cannot run without host shell and file tools, and the mind reads third-party text unattended. Choose an API provider or a tool-free CLI such as Claude Code or Grok.`;
}
