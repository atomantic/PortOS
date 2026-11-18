/**
 * Orchestration profiles for CoS agent runs (#5992): architect/implementer/reviewer roles, modes, spec directives and per-step reasoning effort.
 *
 * Orchestrated CoS execution (#5992): `ORCHESTRATION_MODES` / `ORCHESTRATION_ROLES` (architect, implementer, reviewer), `normalizeOrchestrationProfile` / `normalizeOrchestrationMode`,
 * `isOrchestratedTask` / `roleAssignment` (both inert on a `direct` task, so a stored profile stays opt-in), the six-part `SPEC_PARTS` contract a delegated context-free lane needs, plus
 * `parseReasoningDirective` / `resolveStepEffort` (spec rung → role default → run effort; an unsupported rung is an error, never a silent downgrade).
 *
 * A task normally resolves ONE provider and model for the whole run, so strong planning reasoning also pays that rate for mechanical editing. A profile splits the run into three ROLES (architect plans and writes specs,
 * implementer executes one spec at a time, reviewer checks), each with its own provider/model, plus a per-step reasoning rung the architect names in the spec. Pure vocabulary + normalizer + directive grammar; the Zod surface is
 * `cosValidation.js`, model selection `services/agent/agentModelSelection.js`, doctrine `services/promptSections/orchestrationDoctrine.js`, all reading the definitions HERE. Opt-in: `direct` is the default and every accessor returns null for a profile-less task.
 */

import { EFFORT_LEVELS } from './provider/providerModels.js';
import { isPlainObject } from './objects.js';

/** Execution modes a CoS task can run under. `direct` is today's behavior. */
export const ORCHESTRATION_MODES = Object.freeze(['direct', 'orchestrated']);
export const DEFAULT_ORCHESTRATION_MODE = 'direct';

/** The roles a run is split into, ordered plan → build → check (also the doctrine section's render order). */
export const ORCHESTRATION_ROLES = Object.freeze(['architect', 'implementer', 'reviewer']);

/** The role a `direct`-mode run (and an orchestrated run's top-level agent) is dispatched as; with no profile the architect assignment is empty and selection is unchanged. */
export const PRIMARY_ORCHESTRATION_ROLE = 'architect';

/** Starter orchestration profiles shipped by default: distinct reasoning effort per role, leaving provider/model to install/task defaults. User-defined profiles can override or extend them. */
export const BUILT_IN_ORCHESTRATION_PROFILES = Object.freeze([
  Object.freeze({
    id: 'heavy-planner',
    name: 'Heavy Planning / Lean Execution',
    description: 'High reasoning effort for the architect pass, standard effort for implementer and reviewer.',
    profile: Object.freeze({
      architect: Object.freeze({ effort: 'high' }),
      implementer: Object.freeze({ effort: 'low' }),
      reviewer: Object.freeze({ effort: 'medium' }),
    }),
    isBuiltin: true,
  }),
  Object.freeze({
    id: 'max-deliberation',
    name: 'Max Deliberation',
    description: 'Maximum reasoning effort across all roles for complex architectural tasks.',
    profile: Object.freeze({
      architect: Object.freeze({ effort: 'max' }),
      implementer: Object.freeze({ effort: 'high' }),
      reviewer: Object.freeze({ effort: 'high' }),
    }),
    isBuiltin: true,
  }),
]);

const MAX_PROVIDER_ID_LENGTH = 120;
const MAX_MODEL_ID_LENGTH = 300;

/** The six parts every delegated unit of work must carry: a delegated lane shares NONE of the architect's context, so a spec missing one makes it guess. Rendered into the doctrine so the architect prompt and spec checks share one definition. */
export const SPEC_PARTS = Object.freeze([
  Object.freeze({ key: 'objective', label: 'OBJECTIVE', description: 'the single outcome this unit delivers, stated so it can be judged done or not' }),
  Object.freeze({ key: 'files', label: 'FILES', description: 'every path the unit may read or write, absolute or repo-relative' }),
  Object.freeze({ key: 'interfaces', label: 'INTERFACES', description: 'the exact signatures, schemas, and event names it must produce or consume' }),
  Object.freeze({ key: 'constraints', label: 'CONSTRAINTS', description: 'what it must not touch, plus the conventions it inherits' }),
  Object.freeze({ key: 'verification', label: 'VERIFICATION', description: 'one runnable command that proves the unit landed' }),
  Object.freeze({ key: 'reasoning', label: 'REASONING', description: `the effort rung for this step — one of ${EFFORT_LEVELS.join(', ')}` }),
]);

/** Directive line the architect writes to pin one step's reasoning effort. */
export const REASONING_DIRECTIVE_LABEL = 'REASONING';

const trimmedString = (value, maxLength) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
};

/** Normalize ONE role's assignment. Every field is optional: a role pinning only a model inherits the run's provider, and one pinning nothing normalizes to null (not an empty object that reads as a blank override). */
function normalizeRoleAssignment(raw) {
  if (!isPlainObject(raw)) return null;
  const provider = trimmedString(raw.provider, MAX_PROVIDER_ID_LENGTH);
  const model = trimmedString(raw.model, MAX_MODEL_ID_LENGTH);
  const effort = EFFORT_LEVELS.includes(raw.effort) ? raw.effort : null;
  if (!provider && !model && !effort) return null;
  return Object.freeze({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
  });
}

/** Normalize a whole profile to the persisted shape, or null when nothing usable survives. Unknown roles are dropped: the vocabulary is what doctrine and model selection can act on, so a typo mustn't persist as an inert assignment. */
export function normalizeOrchestrationProfile(raw) {
  if (!isPlainObject(raw)) return null;
  const profile = {};
  for (const role of ORCHESTRATION_ROLES) {
    const assignment = normalizeRoleAssignment(raw[role]);
    if (assignment) profile[role] = assignment;
  }
  return Object.keys(profile).length > 0 ? Object.freeze(profile) : null;
}

/** Normalize a mode string, falling back to `direct` for anything unrecognized. */
export function normalizeOrchestrationMode(raw) {
  return ORCHESTRATION_MODES.includes(raw) ? raw : DEFAULT_ORCHESTRATION_MODE;
}

/** Is this task running under the orchestrated contract? Requires BOTH the mode flag and a usable profile: with no role assignments every lane resolves to the same model, and per-lane specs would buy context loss for nothing. */
export function isOrchestratedTask(task) {
  return normalizeOrchestrationMode(task?.metadata?.orchestrationMode) === 'orchestrated'
    && normalizeOrchestrationProfile(task?.metadata?.orchestrationProfile) !== null;
}

/** The assignment for one role on a task, or null; null for every role on a `direct` task, the single gate keeping a stored-but-disabled profile inert. */
export function roleAssignment(task, role) {
  if (!ORCHESTRATION_ROLES.includes(role)) return null;
  if (!isOrchestratedTask(task)) return null;
  return normalizeOrchestrationProfile(task?.metadata?.orchestrationProfile)?.[role] ?? null;
}

/**
 * Parse a `REASONING: <rung>` directive out of spec text. NEVER rounds: an unsupported rung is an error, not a downgrade (the architect chose it deliberately; substituting the nearest level would run the step at
 * an unrequested effort while reporting success). Callers decide whether to reject the spec or surface the error; this only refuses to guess.
 *
 * @param {string} text - spec text (a full spec or a single directive line)
 * @returns {{ rung: string }|{ error: string }|null} null when no directive is present
 */
export function parseReasoningDirective(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(new RegExp(`^\\s*${REASONING_DIRECTIVE_LABEL}\\s*:\\s*(\\S+)\\s*$`, 'mi'));
  if (!match) return null;
  const rung = match[1];
  if (!EFFORT_LEVELS.includes(rung)) {
    return { error: `Unsupported reasoning rung "${rung}" — expected one of ${EFFORT_LEVELS.join(', ')}` };
  }
  return { rung };
}

/**
 * Resolve the reasoning effort for ONE DELEGATED STEP of an orchestrated run (#5992). Precedence: the `REASONING: <rung>` directive in this step's spec → the role's default from the profile → the run-level effort.
 * NEVER rounds: an unsupported rung returns `{ error }` so the caller can refuse the spec (silent substitution would run at an unchosen effort while reporting success).
 *
 * @param {object} options
 * @param {string} [options.spec] - the delegated step's spec text
 * @param {object} [options.task] - the task carrying the orchestration profile
 * @param {string} [options.role] - the role executing this step
 * @param {string|null} [options.runEffort] - the run-level effort already resolved
 * @returns {{ effort: string|null, source: string }|{ error: string }}
 */
export function resolveStepEffort({ spec = '', task = null, role = PRIMARY_ORCHESTRATION_ROLE, runEffort = null } = {}) {
  const directive = parseReasoningDirective(spec);
  if (directive?.error) return { error: directive.error };
  if (directive?.rung) return { effort: directive.rung, source: 'spec' };

  const roleDefault = roleAssignment(task, role)?.effort;
  if (roleDefault) return { effort: roleDefault, source: 'role' };

  return { effort: runEffort || null, source: runEffort ? 'run' : 'default' };
}
