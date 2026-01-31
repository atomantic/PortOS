/**
 * Context Upgrader Service
 *
 * Analyzes if a task needs more context or a heavier model.
 * Provides recommendations for model/context upgrades.
 */

import * as thinkingLevels from './thinkingLevels.js'
import * as localThinking from './localThinking.js'
import { cosEvents } from './cos.js'

// Upgrade triggers
const UPGRADE_TRIGGERS = {
  // Context-based triggers
  longContext: {
    threshold: 5000,
    suggestUpgrade: true,
    suggestHeavyModel: true
  },
  multiFileChange: {
    fileCount: 3,
    suggestUpgrade: true,
    suggestHeavyModel: false
  },

  // Complexity-based triggers
  highComplexity: {
    threshold: 0.7,
    suggestUpgrade: true,
    suggestHeavyModel: true
  },
  architecturalChange: {
    suggestUpgrade: true,
    suggestHeavyModel: true
  },

  // Error-based triggers
  previousFailure: {
    suggestUpgrade: true,
    suggestHeavyModel: true
  },
  consecutiveFailures: {
    threshold: 2,
    suggestUpgrade: true,
    suggestHeavyModel: true
  }
}

// Upgrade history tracking
const upgradeHistory = []
const MAX_HISTORY = 200

/**
 * Analyze if a task needs context or model upgrade
 *
 * @param {Object} task - Task to analyze
 * @param {Object} context - Current context
 * @returns {Promise<Object>} - Upgrade recommendations
 */
async function analyzeTaskNeedsUpgrade(task, context = {}) {
  const recommendations = {
    needsUpgrade: false,
    suggestHeavyModel: false,
    suggestMoreContext: false,
    currentLevel: context.thinkingLevel || 'medium',
    suggestedLevel: null,
    reasons: [],
    confidence: 0
  }

  // Check context length
  const contextLength = context.contextLength || (task.description?.length || 0)
  if (contextLength > UPGRADE_TRIGGERS.longContext.threshold) {
    recommendations.needsUpgrade = true
    recommendations.suggestHeavyModel = true
    recommendations.reasons.push(`Context length (${contextLength}) exceeds threshold`)
  }

  // Check for multi-file changes (from task metadata or keywords)
  const fileReferences = countFileReferences(task.description || '')
  if (fileReferences >= UPGRADE_TRIGGERS.multiFileChange.fileCount) {
    recommendations.needsUpgrade = true
    recommendations.reasons.push(`Multiple file changes detected (${fileReferences} files)`)
  }

  // Get local complexity analysis if available
  const analysis = await localThinking.analyzeTask(task)
  if (analysis.complexity > UPGRADE_TRIGGERS.highComplexity.threshold) {
    recommendations.needsUpgrade = true
    recommendations.suggestHeavyModel = true
    recommendations.reasons.push(`High complexity score (${analysis.complexity.toFixed(2)})`)
  }

  // Check for architectural keywords
  if (hasArchitecturalKeywords(task.description || '')) {
    recommendations.needsUpgrade = true
    recommendations.suggestHeavyModel = true
    recommendations.reasons.push('Architectural change detected')
  }

  // Check for previous failures
  if (context.previousAttempts > 0 && context.previousSuccess === false) {
    recommendations.needsUpgrade = true
    recommendations.suggestHeavyModel = true
    recommendations.reasons.push('Previous attempt failed')
  }

  if (context.consecutiveFailures >= UPGRADE_TRIGGERS.consecutiveFailures.threshold) {
    recommendations.needsUpgrade = true
    recommendations.suggestHeavyModel = true
    recommendations.reasons.push(`${context.consecutiveFailures} consecutive failures`)
  }

  // Determine suggested level
  if (recommendations.needsUpgrade) {
    const suggestedLevel = thinkingLevels.suggestLevel(analysis)
    const currentLevelIndex = Object.keys(thinkingLevels.THINKING_LEVELS).indexOf(recommendations.currentLevel)
    const suggestedLevelIndex = Object.keys(thinkingLevels.THINKING_LEVELS).indexOf(suggestedLevel)

    if (suggestedLevelIndex > currentLevelIndex) {
      recommendations.suggestedLevel = suggestedLevel
    } else if (recommendations.suggestHeavyModel) {
      recommendations.suggestedLevel = thinkingLevels.upgradeLevel(recommendations.currentLevel)
    }

    recommendations.confidence = calculateConfidence(recommendations.reasons.length)
  }

  // Record analysis
  recordUpgradeAnalysis(task.id, recommendations)

  return recommendations
}

/**
 * Count file references in text
 * @param {string} text - Text to analyze
 * @returns {number} - Number of file references
 */
function countFileReferences(text) {
  const filePatterns = [
    /\.(js|ts|jsx|tsx|py|go|rs|java|c|cpp|h|hpp)(?:\s|$|,|:)/g,
    /(?:file|component|module|service|route|model)s?\s*:/gi,
    /(?:create|modify|update|edit|change)\s+(?:the\s+)?(?:file|component)/gi
  ]

  let count = 0
  for (const pattern of filePatterns) {
    const matches = text.match(pattern)
    if (matches) count += matches.length
  }

  return count
}

/**
 * Check for architectural change keywords
 * @param {string} text - Text to analyze
 * @returns {boolean} - True if architectural keywords found
 */
function hasArchitecturalKeywords(text) {
  const keywords = [
    'architect', 'restructure', 'redesign', 'migration',
    'refactor entire', 'overhaul', 'rewrite', 'new system',
    'database schema', 'api design', 'infrastructure'
  ]

  const lower = text.toLowerCase()
  return keywords.some(k => lower.includes(k))
}

/**
 * Calculate confidence score based on trigger count
 * @param {number} triggerCount - Number of triggers hit
 * @returns {number} - Confidence 0-1
 */
function calculateConfidence(triggerCount) {
  if (triggerCount === 0) return 0
  if (triggerCount === 1) return 0.6
  if (triggerCount === 2) return 0.8
  return 0.95
}

/**
 * Record upgrade analysis for learning
 * @param {string} taskId - Task identifier
 * @param {Object} recommendations - Upgrade recommendations
 */
function recordUpgradeAnalysis(taskId, recommendations) {
  upgradeHistory.unshift({
    taskId,
    timestamp: Date.now(),
    needsUpgrade: recommendations.needsUpgrade,
    suggestedLevel: recommendations.suggestedLevel,
    reasons: recommendations.reasons,
    confidence: recommendations.confidence
  })

  while (upgradeHistory.length > MAX_HISTORY) {
    upgradeHistory.pop()
  }
}

/**
 * Record upgrade outcome for learning
 * @param {string} taskId - Task identifier
 * @param {boolean} wasSuccessful - Whether upgrade led to success
 */
function recordUpgradeOutcome(taskId, wasSuccessful) {
  const entry = upgradeHistory.find(h => h.taskId === taskId)
  if (entry) {
    entry.outcome = wasSuccessful ? 'success' : 'failure'
    entry.resolvedAt = Date.now()
  }

  cosEvents.emit('upgrade:outcomeRecorded', { taskId, wasSuccessful })
}

/**
 * Get upgrade statistics
 * @returns {Object} - Upgrade statistics
 */
function getStats() {
  const recent = upgradeHistory.filter(h => h.outcome)
  const upgradedTasks = recent.filter(h => h.needsUpgrade)
  const successfulUpgrades = upgradedTasks.filter(h => h.outcome === 'success')

  return {
    totalAnalyses: upgradeHistory.length,
    upgradesRecommended: upgradeHistory.filter(h => h.needsUpgrade).length,
    upgradeSuccessRate: upgradedTasks.length > 0
      ? ((successfulUpgrades.length / upgradedTasks.length) * 100).toFixed(1) + '%'
      : 'N/A',
    commonReasons: getCommonReasons(),
    recentUpgrades: upgradeHistory.slice(0, 10).map(h => ({
      taskId: h.taskId,
      suggestedLevel: h.suggestedLevel,
      outcome: h.outcome || 'pending'
    }))
  }
}

/**
 * Get most common upgrade reasons
 * @returns {Object} - Reason counts
 */
function getCommonReasons() {
  const reasons = {}

  for (const entry of upgradeHistory) {
    if (!entry.needsUpgrade) continue

    for (const reason of entry.reasons) {
      // Normalize reason
      const normalized = reason.split('(')[0].trim()
      reasons[normalized] = (reasons[normalized] || 0) + 1
    }
  }

  return reasons
}

/**
 * Should upgrade based on quick heuristics (no async)
 * @param {Object} task - Task to check
 * @param {Object} context - Current context
 * @returns {boolean} - True if upgrade likely needed
 */
function quickCheckNeedsUpgrade(task, context = {}) {
  const description = task.description || ''

  // Quick length check
  if (description.length > UPGRADE_TRIGGERS.longContext.threshold) {
    return true
  }

  // Quick keyword check
  if (hasArchitecturalKeywords(description)) {
    return true
  }

  // Priority check
  const priority = task.priority?.toUpperCase()
  if (priority === 'URGENT' || priority === 'CRITICAL') {
    return true
  }

  // Failure check
  if (context.previousSuccess === false) {
    return true
  }

  return false
}

/**
 * Get upgrade history
 * @param {Object} options - Filter options
 * @returns {Array} - Upgrade history
 */
function getHistory(options = {}) {
  let history = [...upgradeHistory]

  if (options.needsUpgrade !== undefined) {
    history = history.filter(h => h.needsUpgrade === options.needsUpgrade)
  }

  if (options.outcome) {
    history = history.filter(h => h.outcome === options.outcome)
  }

  const limit = options.limit || 50
  return history.slice(0, limit)
}

/**
 * Clear upgrade history
 */
function clearHistory() {
  upgradeHistory.length = 0
}

export {
  analyzeTaskNeedsUpgrade,
  recordUpgradeOutcome,
  getStats,
  getHistory,
  clearHistory,
  quickCheckNeedsUpgrade,
  UPGRADE_TRIGGERS
}
