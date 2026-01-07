/**
 * Task Classifier Service
 *
 * Analyzes tasks and their outputs to determine if they can be auto-approved
 * or require user confirmation.
 */

// Classification categories with auto-approve rules
const CLASSIFICATION_RULES = {
  // Auto-approvable categories (small, safe changes)
  autoApprove: {
    'formatting': {
      patterns: [/format|lint|prettier|eslint|style/i],
      maxLines: 100,
      description: 'Code formatting and linting fixes'
    },
    'dry-violations': {
      patterns: [/dry|duplicate|extract.*function|refactor.*common/i],
      maxLines: 50,
      description: 'Removing code duplication'
    },
    'dead-code': {
      patterns: [/dead.*code|unused|remove.*unused/i],
      maxLines: 30,
      description: 'Removing unused code'
    },
    'typo-fix': {
      patterns: [/typo|spelling|grammar|comment/i],
      maxLines: 20,
      description: 'Fixing typos and comments'
    },
    'import-cleanup': {
      patterns: [/import|require|module.*cleanup/i],
      maxLines: 30,
      description: 'Cleaning up imports'
    },
    'documentation': {
      patterns: [/doc|readme|jsdoc|add.*comment/i],
      maxLines: 100,
      description: 'Documentation updates'
    }
  },

  // Always require approval (risky changes)
  requireApproval: {
    'security': {
      pattern: /security|auth|password|token|credential|secret|key|permission/i,
      reason: 'Security-related changes require manual review'
    },
    'database': {
      pattern: /database|migration|schema|sql|query|prisma/i,
      reason: 'Database changes require manual review'
    },
    'api-change': {
      pattern: /api.*change|endpoint.*change|route.*change|breaking.*change/i,
      reason: 'API changes may affect consumers'
    },
    'dependency': {
      pattern: /package\.json|dependency|upgrade.*version|npm.*install/i,
      reason: 'Dependency changes require verification'
    },
    'architecture': {
      pattern: /architect|restructure|rewrite|major.*refactor/i,
      reason: 'Architectural changes need approval'
    },
    'config': {
      pattern: /config.*change|environment|\.env|ecosystem\.config/i,
      reason: 'Configuration changes require review'
    },
    'deployment': {
      pattern: /deploy|production|release|publish/i,
      reason: 'Deployment changes need approval'
    }
  }
};

/**
 * Classify a task to determine if it can be auto-approved
 *
 * @param {Object} task - The task to classify
 * @param {Object} analysisResult - Optional analysis result with line counts
 * @param {Object} config - Config with autoFixThresholds
 * @returns {Object} Classification result
 */
export function classifyTask(task, analysisResult = null, config = null) {
  const description = (task.description || '').toLowerCase();
  const totalLines = analysisResult?.linesChanged || 0;
  const maxAllowedLines = config?.autoFixThresholds?.maxLinesChanged || 50;
  const allowedCategories = config?.autoFixThresholds?.allowedCategories || [];

  // Check for required approval patterns first (these always need approval)
  for (const [category, rule] of Object.entries(CLASSIFICATION_RULES.requireApproval)) {
    if (rule.pattern.test(description)) {
      return {
        autoApprove: false,
        category,
        reason: rule.reason,
        confidence: 'high'
      };
    }
  }

  // Check for auto-approvable patterns
  for (const [category, rule] of Object.entries(CLASSIFICATION_RULES.autoApprove)) {
    for (const pattern of rule.patterns) {
      if (pattern.test(description)) {
        // Check if category is in allowed list
        if (!allowedCategories.includes(category)) {
          return {
            autoApprove: false,
            category,
            reason: `Category '${category}' not in auto-approve list`,
            confidence: 'medium'
          };
        }

        // Check line count threshold
        const categoryMaxLines = Math.min(rule.maxLines, maxAllowedLines);
        if (totalLines > categoryMaxLines) {
          return {
            autoApprove: false,
            category,
            reason: `Changes exceed auto-approve limit (${totalLines} > ${categoryMaxLines} lines)`,
            confidence: 'medium'
          };
        }

        return {
          autoApprove: true,
          category,
          reason: rule.description,
          confidence: 'high',
          maxLines: categoryMaxLines
        };
      }
    }
  }

  // Default: require approval for unknown categories
  return {
    autoApprove: false,
    category: 'unknown',
    reason: 'Task does not match auto-approve patterns',
    confidence: 'low'
  };
}

/**
 * Classify findings from an idle code review
 *
 * @param {Array} findings - Array of findings from review
 * @param {Object} config - Config with autoFixThresholds
 * @returns {Array} Classified findings
 */
export function classifyReviewFindings(findings, config = null) {
  return findings.map(finding => {
    const classification = classifyTask(
      { description: finding.description || finding.title },
      { linesChanged: finding.estimatedLines || 0 },
      config
    );
    return {
      ...finding,
      ...classification
    };
  });
}

/**
 * Get classification rules for UI display
 */
export function getClassificationRules() {
  return {
    autoApprove: Object.entries(CLASSIFICATION_RULES.autoApprove).map(([key, value]) => ({
      category: key,
      patterns: value.patterns.map(p => p.toString()),
      maxLines: value.maxLines,
      description: value.description
    })),
    requireApproval: Object.entries(CLASSIFICATION_RULES.requireApproval).map(([key, value]) => ({
      category: key,
      pattern: value.pattern.toString(),
      reason: value.reason
    }))
  };
}

/**
 * Check if a task description suggests it's an idle review task
 */
export function isIdleReviewTask(task) {
  const description = (task.description || '').toLowerCase();
  return (
    description.includes('[idle review]') ||
    description.includes('autonomous code review') ||
    task.metadata?.reviewType === 'idle' ||
    task.metadata?.autoGenerated === true
  );
}

/**
 * Estimate complexity of a task based on description
 */
export function estimateTaskComplexity(task) {
  const description = (task.description || '').toLowerCase();

  // High complexity indicators
  const highComplexity = [
    /multiple.*file/i,
    /across.*codebase/i,
    /refactor.*entire/i,
    /restructure/i,
    /migration/i,
    /integration/i
  ];

  // Low complexity indicators
  const lowComplexity = [
    /single.*file/i,
    /one.*line/i,
    /simple/i,
    /typo/i,
    /comment/i,
    /rename/i
  ];

  for (const pattern of highComplexity) {
    if (pattern.test(description)) {
      return { level: 'high', reason: 'Task involves multiple files or significant changes' };
    }
  }

  for (const pattern of lowComplexity) {
    if (pattern.test(description)) {
      return { level: 'low', reason: 'Task is simple and localized' };
    }
  }

  return { level: 'medium', reason: 'Standard complexity task' };
}
