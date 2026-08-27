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
import {
  normalizePortosSemanticToolGrants,
  portosSemanticToolGrantsSchema,
} from './cosToolContracts.js';

export const PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION = 2;

// The persistent mind has a deliberately smaller surface than ordinary CoS
// agents. Keep this catalog beside the capability schema so the API and the UI
// describe the same grants instead of maintaining a second client-only list.
export const PERSISTENT_MIND_TOOL_CATALOG = Object.freeze([
  Object.freeze({
    id: 'cos.create-task',
    capability: 'createTasks',
    name: 'Queue CoS agent tasks',
    description: 'Request a bounded, typed CoS task for an app using a configured coding provider.',
    kind: 'typed-action',
    defaultEnabled: false,
    guardrails: [
      'Up to five requests per turn',
      'Configured app, provider, model, effort, mode, and completion policy are re-validated before queueing',
      'Implementation work runs through the normal isolated-worktree, autonomy, budget, review, CI, and PR gates',
      'Plan & File Issue requests use the existing issue-only planning contract',
    ],
  }),
  Object.freeze({
    id: 'portos.read',
    capability: 'readPortos',
    name: 'Read PortOS context',
    description: 'Use the bounded semantic catalog to inspect selected Brain, goals, journal, calendar, health, feed, catalog, and runtime context.',
    kind: 'semantic-tools',
    defaultEnabled: false,
    guardrails: [
      'Read-only adapters only',
      'No arbitrary URL, route, SQL, shell, or filesystem access',
      'Tool inputs and results are schema-validated and size-bounded',
    ],
  }),
  Object.freeze({
    id: 'portos.write',
    capability: 'writePortos',
    name: 'Update PortOS records',
    description: 'Use selected typed actions for Brain capture, journal, goals, health logs, and feed read state.',
    kind: 'semantic-tools',
    defaultEnabled: false,
    guardrails: [
      'No process control, arbitrary code execution, external messaging, or paid generation',
      'Every action is recorded in the persistent-mind trajectory',
      'Calls use stable request ids so retries within the bounded retention window cannot repeat an accepted action',
    ],
  }),
]);

export const PERSISTENT_MIND_TOOL_BOUNDARIES = Object.freeze([
  'No arbitrary shell or file-system access',
  'No raw HTTP proxy, browser controls, process control, paid generation, or external messaging',
  'No provider credentials or hidden reasoning tokens are exposed as tools',
]);

export const PERSISTENT_MIND_TASK_LIMITS = Object.freeze({
  maxPerTurn: 5,
  descriptionChars: 500,
  promptChars: 12_000,
  appIdChars: 128,
  providerIdChars: 100,
  modelChars: 200,
});

// These are the only workspace facts a task may promote from advisory
// visibility into a queueing gate. An omitted or empty list keeps the
// preflight informative without blocking docs-only/read-only work.
export const PERSISTENT_MIND_VALIDATION_CHECKS = Object.freeze([
  'dependencies',
  'engines',
  'submodules',
  'forge',
  'reviewers',
]);

export const persistentMindCapabilitiesSchema = portosSemanticToolGrantsSchema.extend({
  schemaVersion: z.literal(PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION).optional(),
  createTasks: z.boolean().optional(),
});

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
  // `planOnly` is the User Task form's issue-only mode. It deliberately does
  // not require a PR disposition because the task store forces the
  // no-worktree/no-PR posture for it. Implementation tasks still must choose a
  // disposition so the mind cannot silently inherit a different landing gate.
  // Keep absence meaningful for replay compatibility: adding a default here
  // would change the canonical fingerprint of an older implementation request
  // and could queue it twice after an install upgrades.
  planOnly: z.boolean().optional(),
  prCompletion: z.enum(PR_COMPLETION_VALUES).optional(),
  // Advisory by default. A task declares only the checks its acceptance
  // criteria require; this lets docs-only work proceed when code dependencies
  // are absent while still failing closed for required validation.
  requiredValidation: z.array(z.enum(PERSISTENT_MIND_VALIDATION_CHECKS)).max(PERSISTENT_MIND_VALIDATION_CHECKS.length).optional(),
}).strict().superRefine((value, context) => {
  if (!value.planOnly && !value.prCompletion) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['prCompletion'],
      message: 'Implementation tasks require a PR completion policy',
    });
  }
});

export function createDefaultPersistentMindCapabilities() {
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: false,
    readPortos: false,
    writePortos: false,
  };
}

export function normalizePersistentMindCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const semanticGrants = normalizePortosSemanticToolGrants(source);
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: source.createTasks === true,
    ...semanticGrants,
  };
}

export function mergePersistentMindCapabilities(previous, update) {
  const prior = normalizePersistentMindCapabilities(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindCapabilities({ ...prior, ...patch });
}
