/**
 * Task Learning — prompt improvement recommendations
 *
 * Turns per-task-type failure history and error patterns into actionable
 * prompt-improvement suggestions and hints. Read-only over the learning
 * store.
 */

import { loadLearningData, summarizeFailureSignatures } from './store.js';

/**
 * Generate prompt improvement recommendations for a specific task type
 * based on error patterns and failure history.
 *
 * This helps CoS learn from its mistakes and provides actionable suggestions
 * for improving task prompts to increase success rates.
 *
 * @param {string} taskType - The task type to analyze (e.g., 'self-improve:ui-bugs')
 * @returns {Object} Recommendations object with suggestions and insights
 */
export async function getPromptImprovementRecommendations(taskType) {
  const data = await loadLearningData();
  const metrics = data.byTaskType[taskType];

  const recommendations = {
    taskType,
    hasData: !!metrics,
    successRate: metrics?.successRate || null,
    completed: metrics?.completed || 0,
    suggestions: [],
    errorInsights: [],
    promptHints: [],
    failureSignatures: []
  };

  // Not enough data to make recommendations
  if (!metrics || metrics.completed < 3) {
    recommendations.status = 'insufficient-data';
    recommendations.message = `Only ${metrics?.completed || 0} completions - need at least 3 for recommendations`;
    return recommendations;
  }

  // Analyze error patterns specific to this task type. The percentage is each
  // category's share of ALL failures recorded for this type: `metrics.failed`
  // (every non-environmental failure, categorized or not — a validation miss
  // has no errorPatterns entry but is still a failure) plus this type's
  // environmental count (issue #2618: those still record into errorPatterns but
  // no longer count into `failed`, so dividing by `failed` alone could yield
  // Infinity or >100% shares).
  const environmentalTypeErrors = Object.values(data.environmentalFailures || {})
    .reduce((sum, bucket) => sum + (bucket.taskTypes?.[taskType] || 0), 0);
  const totalTypeErrors = (metrics.failed || 0) + environmentalTypeErrors;
  const taskErrors = [];
  for (const [category, pattern] of Object.entries(data.errorPatterns)) {
    const taskTypeCount = pattern.taskTypes[taskType] || 0;
    if (taskTypeCount > 0) {
      taskErrors.push({
        category,
        count: taskTypeCount,
        percentage: totalTypeErrors > 0 ? Math.round((taskTypeCount / totalTypeErrors) * 100) : 0
      });
    }
  }
  taskErrors.sort((a, b) => b.count - a.count);

  // Generate error-specific insights and prompt hints
  for (const error of taskErrors) {
    const insight = generateErrorInsight(error.category, error.percentage);
    if (insight) {
      recommendations.errorInsights.push(insight);
    }

    const hint = generatePromptHint(error.category, taskType);
    if (hint) {
      recommendations.promptHints.push(hint);
    }
  }

  // Generate success rate-based suggestions
  if (metrics.successRate < 30) {
    recommendations.status = 'critical';
    recommendations.suggestions.push({
      priority: 'high',
      type: 'major-revision',
      message: `Task type has only ${metrics.successRate}% success rate - prompt needs major revision`,
      action: 'Consider breaking this task into smaller, more focused subtasks'
    });
  } else if (metrics.successRate < 50) {
    recommendations.status = 'needs-improvement';
    recommendations.suggestions.push({
      priority: 'medium',
      type: 'clarification',
      message: `Success rate of ${metrics.successRate}% indicates unclear instructions`,
      action: 'Add more specific acceptance criteria and examples to the prompt'
    });
  } else if (metrics.successRate < 75) {
    recommendations.status = 'moderate';
    recommendations.suggestions.push({
      priority: 'low',
      type: 'optimization',
      message: `Success rate of ${metrics.successRate}% is acceptable but could be improved`,
      action: 'Consider adding edge case handling instructions'
    });
  } else {
    recommendations.status = 'good';
    recommendations.suggestions.push({
      priority: 'info',
      type: 'maintain',
      message: `Success rate of ${metrics.successRate}% is good - prompt is working well`,
      action: 'No changes needed, but monitor for regressions'
    });
  }

  // Duration-based suggestions
  const avgDurationMin = Math.round(metrics.avgDurationMs / 60000);
  if (avgDurationMin > 30) {
    recommendations.suggestions.push({
      priority: 'medium',
      type: 'scope',
      message: `Average duration of ${avgDurationMin} minutes is high`,
      action: 'Consider narrowing the task scope or splitting into phases'
    });
  }

  // Deeper failure-signature consumption (issue #2333): the enriched
  // failureSignatures map names WHICH provider/model recently failed for this
  // task type and how many missed a declared success criterion — attribution the
  // coarse errorPatterns count above can't express. Surface the structured data
  // plus an actionable "route away" suggestion the self-improvement loop can act on.
  const failureSignatures = summarizeFailureSignatures(data.failureSignatures, { taskType });
  recommendations.failureSignatures = failureSignatures;
  for (const sig of failureSignatures) {
    const topProvider = sig.providers[0];
    if (!topProvider || topProvider.count < 2) continue;
    recommendations.suggestions.push({
      priority: sig.validationMissed > 0 ? 'high' : 'medium',
      type: 'failure-signature',
      message: `${topProvider.count} recent "${sig.category}" failures for this task type via ${topProvider.key}${sig.validationMissed > 0 ? ` (${sig.validationMissed} missed declared success criteria)` : ''}`,
      action: sig.validationMissed > 0
        ? `Tighten acceptance criteria or route this task type away from ${topProvider.key}`
        : `Consider routing this task type away from ${topProvider.key} or adding guidance for the "${sig.category}" failure mode`
    });
  }

  // Add general best practices based on task type category
  const generalHints = getGeneralPromptHints(taskType);
  recommendations.promptHints.push(...generalHints);

  return recommendations;
}

/**
 * Generate insight message based on error category
 */
function generateErrorInsight(category, percentage) {
  const insights = {
    'model-not-available': {
      message: `${percentage}% of failures due to model unavailability`,
      implication: 'Consider adding fallback model specification to the prompt'
    },
    'usage-limit': {
      message: `${percentage}% of failures due to API usage limits`,
      implication: 'Task may be too token-heavy; consider breaking into smaller chunks'
    },
    'rate-limit': {
      message: `${percentage}% of failures due to rate limiting`,
      implication: 'Task triggers too many API calls; add pacing instructions'
    },
    'context-length': {
      message: `${percentage}% of failures due to context length exceeded`,
      implication: 'Prompt or codebase references are too large; be more specific about which files to analyze'
    },
    'tool-error': {
      message: `${percentage}% of failures due to tool execution errors`,
      implication: 'Add explicit error handling instructions for tool usage'
    },
    'startup-failure': {
      message: `${percentage}% of failures due to agent startup failure`,
      implication: 'Agents failing immediately - check provider availability and system resources'
    },
    'turn-limit': {
      message: `${percentage}% of failures due to agent turn limit`,
      implication: 'Tasks are too large for the turn budget; break into smaller subtasks'
    },
    'billing-error': {
      message: `${percentage}% of failures due to billing/subscription issues`,
      implication: 'Provider account needs attention - check subscription status'
    },
    'unknown': {
      message: `${percentage}% of failures have unknown causes`,
      implication: 'Review agent output logs for patterns not yet categorized'
    }
  };

  return insights[category] || null;
}

/**
 * Generate prompt improvement hint based on error category and task type
 */
function generatePromptHint(category, taskType) {
  const hints = {
    'model-not-available': {
      hint: 'Add fallback model instruction',
      example: 'Use model: claude-opus-4-5-20251101 (fallback to claude-sonnet-4-20250514 if unavailable)'
    },
    'context-length': {
      hint: 'Reduce scope of file analysis',
      example: 'Focus analysis on files matching: server/services/*.js (not entire codebase)'
    },
    'tool-error': {
      hint: 'Add explicit tool usage guidance',
      example: 'If Playwright navigation fails, verify the dev server is running on port 5555'
    },
    'rate-limit': {
      hint: 'Add pacing instructions',
      example: 'Analyze routes one at a time, waiting for each to complete before proceeding'
    },
    'spawn-error': {
      hint: 'Add environment prerequisites',
      example: 'Prerequisites: Ensure npm install has been run and dev server is started'
    },
    'startup-failure': {
      hint: 'Add provider availability check',
      example: 'Before starting work, verify the AI provider responds to a simple test prompt'
    },
    'turn-limit': {
      hint: 'Reduce task scope to fit within turn budget',
      example: 'Focus on ONE specific file or component per task instead of broad analysis'
    },
    'usage-limit': {
      hint: 'Use a lighter model or reduce token consumption',
      example: 'Use targeted file reads instead of full codebase scans to reduce token usage'
    }
  };

  return hints[category] || null;
}

/**
 * Generate general prompt hints based on task type category
 */
function getGeneralPromptHints(taskType) {
  const hints = [];

  if (taskType.includes('ui-bugs') || taskType.includes('mobile') || taskType.includes('console')) {
    hints.push({
      hint: 'Add visual verification step',
      example: 'After fixing, take a new browser_snapshot to verify the fix worked'
    });
  }

  if (taskType.includes('security') || taskType.includes('audit')) {
    hints.push({
      hint: 'Add severity classification',
      example: 'Classify findings as CRITICAL/HIGH/MEDIUM/LOW and prioritize fixes accordingly'
    });
  }

  if (taskType.includes('code-quality') || taskType.includes('refactor')) {
    hints.push({
      hint: 'Add rollback safety',
      example: 'Make small, atomic commits that can be individually reverted if needed'
    });
  }

  if (taskType.includes('test')) {
    hints.push({
      hint: 'Add test verification',
      example: 'Run npm test after adding each test file to ensure it passes'
    });
  }

  if (taskType.includes('enhancement') || taskType.includes('feature')) {
    hints.push({
      hint: 'Add scope limitation',
      example: 'Implement only ONE feature per task - avoid scope creep'
    });
  }

  return hints;
}

/**
 * Get prompt improvement recommendations for all task types
 * Returns a summary suitable for display in the Learning tab
 */
export async function getAllPromptRecommendations() {
  const data = await loadLearningData();
  const allRecommendations = [];

  for (const taskType of Object.keys(data.byTaskType)) {
    const recommendations = await getPromptImprovementRecommendations(taskType);
    if (recommendations.hasData && recommendations.completed >= 3) {
      allRecommendations.push({
        taskType,
        status: recommendations.status,
        successRate: recommendations.successRate,
        completed: recommendations.completed,
        topSuggestion: recommendations.suggestions[0] || null,
        errorCount: recommendations.errorInsights.length,
        hintCount: recommendations.promptHints.length,
        failureSignatureCount: recommendations.failureSignatures.length
      });
    }
  }

  // Sort by priority (critical first, then needs-improvement, etc.)
  const priorityOrder = { critical: 0, 'needs-improvement': 1, moderate: 2, good: 3, 'insufficient-data': 4 };
  // Use ?? not || so the highest-priority status (`critical`, value 0) isn't
  // treated as falsy and bumped to the catch-all 5 — that would sort the most
  // urgent recommendations LAST, inverting the intended "critical first" order.
  allRecommendations.sort((a, b) => (priorityOrder[a.status] ?? 5) - (priorityOrder[b.status] ?? 5));

  return allRecommendations;
}
