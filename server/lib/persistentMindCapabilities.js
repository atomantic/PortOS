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

export const PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION = 5;
// Every wire version this server still accepts on input. Installs upgrade on
// their own schedule, so a browser bundle (or a route caller) pinned at an
// older version must keep being able to toggle the grants it already knows
// about; normalization always writes the current version forward.
const ACCEPTED_CAPABILITIES_SCHEMA_VERSIONS = Object.freeze([2, 3, 4, 5]);

export const PERSISTENT_MIND_TASK_MODEL_ALLOWLIST_LIMITS = Object.freeze({
  MAX_ENTRIES: 200,
  PROVIDER_ID_CHARS: 100,
  MODEL_CHARS: 200,
});

const persistentMindTaskModelAllowlistEntrySchema = z.object({
  providerId: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_MODEL_ALLOWLIST_LIMITS.PROVIDER_ID_CHARS),
  model: z.string().trim().min(1).max(PERSISTENT_MIND_TASK_MODEL_ALLOWLIST_LIMITS.MODEL_CHARS),
}).strict();

export const PERSISTENT_MIND_CLEANUP_SCOPES = Object.freeze([
  'context',
  'history',
  'memories',
]);

// Ringing a phone is the loudest thing this install can do, so the budget is
// deliberately small and fixed rather than user-tunable: a mind that could
// raise its own call allowance would not really be capped. The counters live
// in durable mind state (server/lib/persistentMind.js) so a restart, a crash,
// or a supervisor rewire cannot hand back a fresh allowance.
export const PERSISTENT_MIND_CALL_LIMITS = Object.freeze({
  maxPerRollingDay: 3,
  rollingWindowMs: 24 * 60 * 60 * 1000,
  minGapMs: 30 * 60 * 1000,
  reasonChars: 200,
  openingLineChars: 400,
});

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
  Object.freeze({
    id: 'eidoverse.manage',
    capability: 'manageEidoverse',
    name: 'Manage the private Eidoverse world',
    description: 'Project PortOS resources, build bounded world content, manage local world roles, and speak as the persistent PortOS CoS identity.',
    kind: 'semantic-tools',
    defaultEnabled: false,
    guardrails: [
      'Applies only to this install\'s machine-local private Eidoverse world',
      'Uses the bounded Eidoverse operation schemas; no arbitrary runtime behavior, shell, filesystem, or source mutation',
      'Independent of generic PortOS record writes and disabled for fresh and upgraded installs',
    ],
  }),
  Object.freeze({
    id: 'mind.cleanup',
    capability: 'manageMind',
    name: 'Clean up mindspace',
    description: 'Archive mind-owned memories, clear conversation history, or rebuild the derived context cache.',
    kind: 'typed-action',
    defaultEnabled: false,
    guardrails: [
      'Only Persistent Mind-owned machine-local state is in scope',
      'Memory cleanup archives records instead of hard-deleting them',
      'History cleanup preserves the turn requesting it and resets derived rollups',
      'Every cleanup leaves a bounded maintenance record in the new trajectory',
    ],
  }),
  Object.freeze({
    id: 'voice.call-user',
    capability: 'callUser',
    name: 'Call the user on FaceTime Audio',
    description: 'Place a FaceTime Audio call to the identity configured in Settings > Voice when something needs the user and no browser tab can speak to them.',
    kind: 'typed-action',
    defaultEnabled: false,
    guardrails: [
      'Only the single handle configured in Settings > Voice > FaceTime Audio; the mind never chooses who to contact',
      'Honors voice quiet hours',
      `At most ${PERSISTENT_MIND_CALL_LIMITS.maxPerRollingDay} calls per rolling 24 hours and at least ${PERSISTENT_MIND_CALL_LIMITS.minGapMs / 60_000} minutes apart, counted in durable state so a restart cannot reset them`,
      'A reason is required, and the decision plus its outcome is recorded in the trajectory',
      'Never placed while a browser voice tab can deliver the message instead',
      'Requires the optional FaceTime feature and an attached call-host page',
    ],
  }),
]);

export const PERSISTENT_MIND_TOOL_BOUNDARIES = Object.freeze([
  'No arbitrary shell or file-system access',
  "No raw HTTP proxy, browser controls, process control, or paid generation, and no external messaging except the granted voice.call-user action to the user's own configured handle or the granted install-local eidoverse.say action",
  'No provider credentials or hidden reasoning tokens are exposed as tools',
]);

export const PERSISTENT_MIND_TASK_LIMITS = Object.freeze({
  maxPerTurn: 5,
  descriptionChars: 500,
  promptChars: 12_000,
  appIdChars: 128,
  maxAllowedAppIds: 50,
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
  // Accept every prior wire version so an older client can still change the
  // unrelated grants while this server normalizes the stored shape forward.
  schemaVersion: z.number().int()
    .refine((value) => ACCEPTED_CAPABILITIES_SCHEMA_VERSIONS.includes(value), 'unsupported persistent mind capabilities schema version')
    .optional(),
  createTasks: z.boolean().optional(),
  manageMind: z.boolean().optional(),
  callUser: z.boolean().optional(),
  // An empty list preserves the legacy unrestricted task catalog. Once any
  // entries are configured, requests must name one of these exact pairs.
  taskModelAllowlist: z.array(persistentMindTaskModelAllowlistEntrySchema)
    .max(PERSISTENT_MIND_TASK_MODEL_ALLOWLIST_LIMITS.MAX_ENTRIES).optional(),
  // Omitted preserves the legacy grant to every runnable managed app. An
  // explicit list lets the user narrow that grant without changing the typed
  // task capability itself.
  allowedAppIds: z.array(z.string().trim().min(1).max(PERSISTENT_MIND_TASK_LIMITS.appIdChars))
    .max(PERSISTENT_MIND_TASK_LIMITS.maxAllowedAppIds).optional(),
});

export const persistentMindCleanupRequestSchema = z.object({
  scopes: z.array(z.enum(PERSISTENT_MIND_CLEANUP_SCOPES))
    .min(1)
    .max(PERSISTENT_MIND_CLEANUP_SCOPES.length)
    .refine((scopes) => new Set(scopes).size === scopes.length, 'cleanup scopes must be unique'),
  reason: z.string().trim().min(1).max(300).optional(),
}).strict();

// The mind supplies only why it is calling and what it will open with. It
// never supplies a destination: the handle comes from voice configuration, so
// a compromised or confused turn cannot dial anyone but the user.
export const persistentMindCallRequestSchema = z.object({
  reason: z.string().trim().min(1).max(PERSISTENT_MIND_CALL_LIMITS.reasonChars),
  openingLine: z.string().trim().min(1).max(PERSISTENT_MIND_CALL_LIMITS.openingLineChars),
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
    manageMind: false,
    manageEidoverse: false,
    callUser: false,
    readPortos: false,
    writePortos: false,
    taskModelAllowlist: [],
  };
}

const normalizeTaskModelAllowlist = (value) => {
  if (value === undefined) return { entries: [], invalid: false };
  if (!Array.isArray(value) || value.length > PERSISTENT_MIND_TASK_MODEL_ALLOWLIST_LIMITS.MAX_ENTRIES) {
    return { entries: [], invalid: true };
  }
  const entries = [];
  const seen = new Set();
  for (const candidate of value) {
    const parsed = persistentMindTaskModelAllowlistEntrySchema.safeParse(candidate);
    if (!parsed.success) return { entries: [], invalid: true };
    const entry = parsed.data;
    const key = `${entry.providerId}\0${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return { entries, invalid: false };
};

export function isPersistentMindTaskModelAllowed(capabilities, providerId, model) {
  const normalized = normalizePersistentMindCapabilities(capabilities);
  if (normalized.taskModelAllowlistInvalid || capabilities?.taskModelAllowlistInvalid === true) return false;
  if (normalized.taskModelAllowlist.length === 0) return true;
  return normalized.taskModelAllowlist.some((entry) => (
    entry.providerId === providerId && entry.model === model
  ));
}

export function normalizePersistentMindCapabilities(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const semanticGrants = normalizePortosSemanticToolGrants(source);
  const taskModelAllowlist = source.taskModelAllowlistInvalid === true
    ? { entries: [], invalid: true }
    : normalizeTaskModelAllowlist(source.taskModelAllowlist);
  const allowedAppIds = Array.isArray(source.allowedAppIds)
    ? [...new Set(source.allowedAppIds
      .filter((id) => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean)
      .filter((id) => id.length <= PERSISTENT_MIND_TASK_LIMITS.appIdChars))]
      .slice(0, PERSISTENT_MIND_TASK_LIMITS.maxAllowedAppIds)
    : undefined;
  return {
    schemaVersion: PERSISTENT_MIND_CAPABILITIES_SCHEMA_VERSION,
    createTasks: source.createTasks === true,
    manageMind: source.manageMind === true,
    callUser: source.callUser === true,
    ...semanticGrants,
    taskModelAllowlist: taskModelAllowlist.entries,
    // A malformed hand-edited persisted policy must not silently become the
    // unrestricted empty-list policy. This internal marker is omitted from
    // route input schemas and only affects fail-closed admission/catalog code.
    ...(taskModelAllowlist.invalid ? { taskModelAllowlistInvalid: true } : {}),
    ...(allowedAppIds !== undefined ? { allowedAppIds } : {}),
  };
}

export function mergePersistentMindCapabilities(previous, update) {
  const prior = normalizePersistentMindCapabilities(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  const merged = { ...prior, ...patch };
  // A valid replacement repairs a malformed persisted policy; unrelated grant
  // updates must retain the fail-closed marker until that happens.
  if (patch.taskModelAllowlist !== undefined) {
    delete merged.taskModelAllowlistInvalid;
  } else if (prior.taskModelAllowlistInvalid) {
    delete merged.taskModelAllowlist;
  }
  return normalizePersistentMindCapabilities(merged);
}
