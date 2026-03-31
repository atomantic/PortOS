/**
 * Agent Model Selection
 *
 * Handles task type key extraction and optimal model selection based on
 * task complexity, thinking levels, and historical performance data.
 */

import { resolveThinkingLevel, getModelForLevel, isLocalPreferred } from './thinkingLevels.js';
import { suggestModelTier } from './taskLearning.js';

/**
 * Extract task type key for learning lookup.
 * Matches the format used in taskLearning.js for consistency.
 */
export function extractTaskTypeKey(task) {
  if (task?.metadata?.analysisType) {
    return `self-improve:${task.metadata.analysisType}`;
  }
  if (task?.metadata?.reviewType === 'idle') {
    return 'idle-review';
  }
  const desc = (task?.description || '').toLowerCase();
  if (desc.includes('[self-improvement]')) {
    const typeMatch = desc.match(/\[self-improvement\]\s*(\w+)/i);
    if (typeMatch) return `self-improve:${typeMatch[1]}`;
  }
  if (task?.taskType === 'user') return 'user-task';
  return 'unknown';
}

/**
 * Select optimal model for a task based on complexity analysis and historical performance.
 * User can override by specifying Model: and/or Provider: in task metadata.
 *
 * Enhanced with:
 * - Thinking levels hierarchy (task → agent → provider)
 * - Learning-based model suggestions from historical success rates
 * - Automatic upgrades when task type has <60% success rate
 */
export async function selectModelForTask(task, provider, agent = {}) {
  const desc = (task.description || '').toLowerCase();
  const context = task.metadata?.context || '';
  const contextLen = context.length;
  const priority = task.priority || 'MEDIUM';

  // Check for user-specified model preference (highest priority)
  const userModel = task.metadata?.model;
  const userProvider = task.metadata?.provider;

  if (userModel) {
    console.log(`👤 User specified model: ${userModel}`);
    return {
      model: userModel,
      tier: 'user-specified',
      reason: 'user-preference',
      userProvider: userProvider || null
    };
  }

  // Check thinking level hierarchy (task → agent → provider)
  const thinkingResult = resolveThinkingLevel(task, agent, provider);
  if (thinkingResult.resolvedFrom !== 'default') {
    const modelFromLevel = getModelForLevel(thinkingResult.level, provider);
    if (modelFromLevel) {
      const isLocal = isLocalPreferred(thinkingResult.level);
      console.log(`🧠 Thinking level: ${thinkingResult.level} → ${modelFromLevel} (from ${thinkingResult.resolvedFrom}${isLocal ? ', local-preferred' : ''})`);
      return {
        model: modelFromLevel,
        tier: thinkingResult.level,
        reason: `thinking-level-${thinkingResult.resolvedFrom}`,
        thinkingLevel: thinkingResult.level,
        localPreferred: isLocal
      };
    }
  }

  // Image/visual analysis → would route to gemini if available
  if (/image|screenshot|visual|photo|picture/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'visual-analysis' };
  }

  // Critical priority → always use opus/heavy
  if (priority === 'CRITICAL') {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'critical-priority' };
  }

  // Complex reasoning tasks → opus/heavy
  if (/architect|refactor|design|complex|optimize|security|audit|review.*code|performance/.test(desc)) {
    return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'complex-task' };
  }

  // Long context → needs more capable model
  if (contextLen > 500) {
    return { model: provider.heavyModel || provider.mediumModel || provider.defaultModel, tier: 'heavy', reason: 'long-context' };
  }

  // Detect coding/development tasks - these should NEVER use light model.
  // Intentionally inclusive: if a task mentions any coding-related term (even in
  // broader context like "bug report template"), we err on the side of using
  // a stronger model since misclassifying a coding task is more costly than
  // over-allocating resources for a documentation task.
  const isCodingTask = /\b(fix|bug|implement|develop|code|refactor|test|feature|function|class|module|api|endpoint|component|service|route|schema|migration|script|build|deploy|debug|error|exception|crash|issue|patch)\b/.test(desc);

  // Simple/quick tasks → haiku/light (ONLY for non-coding tasks)
  // Light model is reserved for documentation, text updates, and formatting only
  if (!isCodingTask && /fix typo|update text|update docs|edit readme|update readme|write docs|documentation only|format text/.test(desc)) {
    return { model: provider.lightModel || provider.defaultModel, tier: 'light', reason: 'documentation-task' };
  }

  // Check historical performance for this task type and select optimal model tier
  const taskTypeKey = extractTaskTypeKey(task);
  const learningSuggestion = await suggestModelTier(taskTypeKey).catch(() => null);

  if (learningSuggestion) {
    const { suggested, avoidTiers = [], reason: learningReason } = learningSuggestion;

    // Map tier names to provider model keys
    const tierToModel = {
      heavy: provider.heavyModel,
      medium: provider.mediumModel || provider.defaultModel,
      default: provider.defaultModel,
      light: provider.lightModel
    };

    // If we have a specific tier suggestion, use it
    if (suggested && tierToModel[suggested]) {
      console.log(`📊 Learning-based selection: ${taskTypeKey} → ${suggested} (${learningReason})`);
      return {
        model: tierToModel[suggested],
        tier: suggested,
        reason: 'learning-suggested',
        learningReason,
        avoidedTiers: avoidTiers.length > 0 ? avoidTiers : undefined
      };
    }

    // If no specific suggestion but we have tiers to avoid, pick the best available tier
    if (avoidTiers.length > 0) {
      // Try tiers in order of preference: heavy → medium → default → light
      // Skip any that are in avoidTiers
      const tierPreference = ['heavy', 'medium', 'default', 'light'];
      for (const tier of tierPreference) {
        if (!avoidTiers.includes(tier) && tierToModel[tier]) {
          console.log(`📊 Learning-based avoidance: ${taskTypeKey} → ${tier} (avoiding ${avoidTiers.join(', ')})`);
          return {
            model: tierToModel[tier],
            tier,
            reason: 'learning-avoid-bad-tier',
            learningReason,
            avoidedTiers: avoidTiers
          };
        }
      }
    }
  }

  // Standard tasks → use provider's default model
  return { model: provider.defaultModel, tier: 'default', reason: 'standard-task' };
}
