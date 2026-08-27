/**
 * Opt-in action capabilities for the persistent Chief-of-Staff mind.
 *
 * Provider/profile configuration controls inference. This separate slice
 * controls which typed side effects a completed mind turn may request, so an
 * existing conversation-only install never gains new authority on upgrade.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './providerModels.js';
import { PR_COMPLETION_VALUES } from './prDisposition.js';

export const PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_TASK_LIMITS = Object.freeze({
  maxPerTurn: 5,
  descriptionChars: 500,
  promptChars: 12_000,
  appIdChars: 128,
  providerIdChars: 100,
  modelChars: 200,
});

export const persistentMindCapabilitiesSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION).optional(),
  createTasks: z.boolean().optional(),
}).strict();

export const persistentMindTaskRequestSchema = z.object({
  description: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.descriptionChars),
  prompt: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.promptChars),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional().default('MEDIUM'),
  appId: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.appIdChars),
  providerId: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.providerIdChars),
  // Empty means "use this provider's configured default" — a real choice for
  // providers whose CLI owns model selection and publishes no concrete ids.
  model: z.string().trim().max(PERSISTENT_MIND_TASK_LIMITS.modelChars),
  effort: z.union([z.literal(''), z.enum(EFFORT_LEVELS)]).optional().default(''),
  prCompletion: z.enum(PR_COMPLETION_VALUES),
}).strict();

export function createDefaultPersistentMindCapabilities() {
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: false,
  };
}

export function normalizePersistentMindCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: source.createTasks === true,
  };
}

export function mergePersistentMindCapabilities(previous, update) {
  const prior = normalizePersistentMindCapabilities(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindCapabilities({ ...prior, ...patch });
}
