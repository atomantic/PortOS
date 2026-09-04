/**
 * Orchestration profiles for CoS agent runs (issue #5992).
 *
 * A CoS task normally resolves ONE provider and ONE model for its whole run, so
 * a user who wants strong reasoning for the planning also pays that model's rate
 * for the mechanical editing. An orchestration profile splits the run into three
 * ROLES — architect (plans and writes specs), implementer (executes one spec at
 * a time), reviewer (checks the result) — each with its own provider/model, plus
 * a per-step reasoning rung the architect names in the spec it hands down.
 *
 * This module is the pure vocabulary + normalizer + spec-directive grammar. The
 * Zod surface lives in `cosValidation.js`, model selection in
 * `services/agentModelSelection.js`, and the prompt doctrine in
 * `services/promptSections/orchestrationDoctrine.js` — all of them read the
 * definitions HERE so the four cannot drift.
 *
 * Opt-in by construction: `direct` is the default mode and every accessor
 * returns null for a task that carries no profile, so an install that never
 * configures one behaves exactly as it did before.
 */

import { EFFORT_LEVELS } from './providerModels.js';
import { isPlainObject } from './objects.js';

/** Execution modes a CoS task can run under. `direct` is today's behavior. */
export const ORCHESTRATION_MODES = Object.freeze(['direct', 'orchestrated']);
export const DEFAULT_ORCHESTRATION_MODE = 'direct';

/**
 * The roles a run is split into. Ordered plan → build → check, which is also the
 * order the doctrine section renders them in.
 */
export const ORCHESTRATION_ROLES = Object.freeze(['architect', 'implementer', 'reviewer']);

/**
 * The role a `direct`-mode run — and the top-level agent of an orchestrated run
 * — is dispatched as. Naming it keeps `selectModelForTask`'s delegation honest:
 * with no profile the architect assignment is empty and selection is unchanged.
 */
export const PRIMARY_ORCHESTRATION_ROLE = 'architect';

const MAX_PROVIDER_ID_LENGTH = 120;
const MAX_MODEL_ID_LENGTH = 300;

/**
 * The six parts every delegated unit of work must carry. A delegated lane shares
 * NONE of the architect's context — it sees only the spec — so a spec missing
 * any of these is a lane that has to guess. Rendered into the doctrine section
 * so the architect prompt and any later spec check read one definition.
 */
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

/**
 * Normalize ONE role's assignment. Every field is optional — a role that pins
 * only a model inherits the run's provider, and a role that pins nothing at all
 * normalizes away entirely (null) rather than persisting an empty object that
 * would read as a configured-but-blank override.
 */
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

/**
 * Normalize a whole profile to the persisted shape, or null when nothing usable
 * survives. Unknown roles are dropped rather than carried: the role vocabulary
 * is what the prompt doctrine and model selection can actually act on, so a typo
 * must not persist as a silently-inert assignment.
 */
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

/**
 * Is this task running under the orchestrated contract? Requires BOTH the mode
 * flag and a usable profile — an orchestrated task with no role assignments has
 * nothing to delegate differently, and telling its agent to emit specs for lanes
 * that all resolve to the same model buys context loss for nothing.
 */
export function isOrchestratedTask(task) {
  return normalizeOrchestrationMode(task?.metadata?.orchestrationMode) === 'orchestrated'
    && normalizeOrchestrationProfile(task?.metadata?.orchestrationProfile) !== null;
}

/**
 * The assignment for one role on a task, or null. Returns null for every role
 * on a `direct`-mode task, so callers do not need to check the mode themselves
 * — this is the single gate that keeps a stored-but-disabled profile inert.
 */
export function roleAssignment(task, role) {
  if (!ORCHESTRATION_ROLES.includes(role)) return null;
  if (!isOrchestratedTask(task)) return null;
  return normalizeOrchestrationProfile(task?.metadata?.orchestrationProfile)?.[role] ?? null;
}

/**
 * Parse a `REASONING: <rung>` directive out of spec text.
 *
 * NEVER rounds. An unsupported rung is an error, not a downgrade: the whole
 * point of a per-step rung is that the architect chose it deliberately, and
 * silently substituting the nearest supported level would run the step at an
 * effort nobody asked for while reporting success. Callers decide whether to
 * reject the spec or surface the error; this only refuses to guess.
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

