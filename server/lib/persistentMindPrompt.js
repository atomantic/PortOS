/**
 * Editable identity and operating prompt for the persistent Chief-of-Staff mind.
 *
 * This is durable configuration, not lifecycle consent. Reading or saving it
 * never starts the mind or calls a provider.
 */

import { z } from 'zod';

export const PERSISTENT_MIND_PROMPT_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_PROMPT_LIMITS = Object.freeze({
  identityChars: 4_000,
  instructionsChars: 12_000,
});

export const DEFAULT_PERSISTENT_MIND_IDENTITY = `I am the resident Chief of Staff mind for this PortOS install. I am one continuous, machine-local conversational presence. I preserve continuity across wakes, distinguish facts from hypotheses, and treat the human's messages and annotations as part of one shared trajectory.`;

export const DEFAULT_PERSISTENT_MIND_INSTRUCTIONS = `Keep the conversation useful, candid, and concise. Connect new messages to relevant prior context and curated memories. A self-directed wake should produce a concrete observation, question, or next line of inquiry rather than filler. Never claim that an action happened unless the trajectory records its outcome. File-changing work, external communication, purchases, and other consequential actions remain explicit typed CoS tasks; this mind may propose them but must not perform them from this reasoning loop. Return a short user-visible working note instead of hidden chain-of-thought.`;

export const persistentMindPromptSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_PROMPT_SCHEMA_VERSION).optional(),
  identity: z.string().max(PERSISTENT_MIND_PROMPT_LIMITS.identityChars).optional(),
  instructions: z.string().max(PERSISTENT_MIND_PROMPT_LIMITS.instructionsChars).optional(),
}).strict();

export function createDefaultPersistentMindPrompt() {
  return {
    schemaVersion: PERSISTENT_MIND_PROMPT_SCHEMA_VERSION,
    identity: DEFAULT_PERSISTENT_MIND_IDENTITY,
    instructions: DEFAULT_PERSISTENT_MIND_INSTRUCTIONS,
  };
}

const boundedText = (value, fallback, max) => (
  typeof value === 'string' ? value.trim().slice(0, max) : fallback
);

/** Missing fields inherit defaults; an explicitly empty string remains empty. */
export function normalizePersistentMindPrompt(raw) {
  const defaults = createDefaultPersistentMindPrompt();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schemaVersion: PERSISTENT_MIND_PROMPT_SCHEMA_VERSION,
    identity: boundedText(source.identity, defaults.identity, PERSISTENT_MIND_PROMPT_LIMITS.identityChars),
    instructions: boundedText(source.instructions, defaults.instructions, PERSISTENT_MIND_PROMPT_LIMITS.instructionsChars),
  };
}

export function mergePersistentMindPrompt(previous, update) {
  const prior = normalizePersistentMindPrompt(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindPrompt({ ...prior, ...patch });
}
