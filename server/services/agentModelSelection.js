/**
 * Agent Model Selection
 *
 * Resolves the model a task runs on from what the user EXPLICITLY asked for —
 * a model id or a capability tier on the task (or on an orchestration role) —
 * and otherwise the provider's own default. Nothing here picks a tier on the
 * user's behalf (#8149): the description-regex heuristics, the priority-driven
 * thinking-level mapping, and the learning store's tier substitution all used
 * to, which let a task configured for "default model" silently run on a
 * lighter model (#8148). The learning store's per-tier success rates are still
 * recorded and shown in the CoS Learning view as advice; they never apply here.
 */

import { MODEL_TIERS, resolveProviderModelTier } from '../lib/aiToolkit/constants.js';
import { ORCHESTRATION_ROLES, roleAssignment } from '../lib/orchestrationProfile.js';

const isModelTier = (value) => Object.values(MODEL_TIERS).includes(value);

/**
 * Select the model for ONE ROLE of an orchestrated run (#5992).
 *
 * An orchestration profile pins architect / implementer / reviewer separately so
 * the planning pass can run on a strong model while the mechanical editing runs
 * on a cheap one. A role that pins a model (id or tier) wins outright — it is a
 * user choice, exactly like `metadata.model`.
 *
 * Everything else falls through to `selectModelForTask`, so a `direct` task, an
 * unpinned role, or an unknown role all resolve exactly as they did before this
 * existed.
 *
 * @param {object} task
 * @param {string} role - one of ORCHESTRATION_ROLES
 * @param {object} provider - resolved provider config
 * @returns {Promise<object>} the same selection shape `selectModelForTask` returns
 */
export async function selectModelForRole(task, role, provider) {
  const assignment = ORCHESTRATION_ROLES.includes(role) ? roleAssignment(task, role) : null;
  if (assignment?.model) {
    const isTier = isModelTier(assignment.model);
    console.log(`🎼 Orchestrated ${role} model: ${assignment.model}`);
    return {
      model: isTier ? resolveProviderModelTier(provider, assignment.model) : assignment.model,
      tier: isTier ? assignment.model : 'user-specified',
      reason: `orchestration-role-${role}`,
      orchestrationRole: role,
      userProvider: assignment.provider || task.metadata?.provider || null,
      ...(assignment.effort ? { orchestrationEffort: assignment.effort } : {}),
    };
  }
  const selection = await selectModelForTask(task, provider);
  return assignment ? { ...selection, orchestrationRole: role, ...(assignment.effort ? { orchestrationEffort: assignment.effort } : {}) } : selection;
}

/**
 * Select the model for a task: an explicit `metadata.model` (a tier resolves on
 * THIS provider, so a fallback provider re-resolves it), else the provider's
 * `defaultModel`. Async so callers keep one await shape with the role variant.
 */
export async function selectModelForTask(task, provider) {
  const userModel = task.metadata?.model;
  if (userModel) {
    const isTier = isModelTier(userModel);
    console.log(`👤 User specified model: ${userModel}`);
    return {
      model: isTier ? resolveProviderModelTier(provider, userModel) : userModel,
      tier: isTier ? userModel : 'user-specified',
      reason: 'user-preference',
      userProvider: task.metadata?.provider || null
    };
  }
  return { model: provider.defaultModel, tier: 'default', reason: 'provider-default' };
}
