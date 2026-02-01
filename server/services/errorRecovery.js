/**
 * Error Recovery Service
 *
 * Analyzes errors and selects appropriate recovery strategies.
 * Provides structured error handling for agent operations.
 */

import { cosEvents } from './cosEvents.js'

// Recovery strategies
const STRATEGIES = {
  RETRY: 'retry',           // Simple retry with backoff
  ESCALATE: 'escalate',     // Use a more powerful model
  FALLBACK: 'fallback',     // Use fallback provider
  DECOMPOSE: 'decompose',   // Break task into smaller parts
  DEFER: 'defer',           // Reschedule for later
  INVESTIGATE: 'investigate', // Create investigation task
  SKIP: 'skip',             // Skip and move on
  MANUAL: 'manual'          // Require human intervention
}

// Error categories for pattern matching
const ERROR_PATTERNS = {
  // Rate limiting
  rateLimit: {
    patterns: [
      /rate.?limit/i,
      /too many requests/i,
      /429/,
      /quota exceeded/i,
      /throttl/i
    ],
    strategies: [STRATEGIES.DEFER, STRATEGIES.FALLBACK],
    cooldownMs: 60000
  },

  // Authentication
  auth: {
    patterns: [
      /unauthorized/i,
      /authentication/i,
      /invalid.*key/i,
      /403/,
      /401/,
      /api.?key/i
    ],
    strategies: [STRATEGIES.FALLBACK, STRATEGIES.MANUAL],
    cooldownMs: 0
  },

  // Model unavailable
  modelUnavailable: {
    patterns: [
      /model.*not.*found/i,
      /model.*unavailable/i,
      /model.*overloaded/i,
      /503/,
      /capacity/i
    ],
    strategies: [STRATEGIES.FALLBACK, STRATEGIES.DEFER],
    cooldownMs: 30000
  },

  // Context too long
  contextLength: {
    patterns: [
      /context.*length/i,
      /token.*limit/i,
      /maximum.*tokens/i,
      /too.*long/i,
      /input.*too.*large/i
    ],
    strategies: [STRATEGIES.DECOMPOSE],
    cooldownMs: 0
  },

  // Network issues
  network: {
    patterns: [
      /network/i,
      /timeout/i,
      /ECONNREFUSED/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
      /connection.*reset/i,
      /socket.*hang.*up/i
    ],
    strategies: [STRATEGIES.RETRY, STRATEGIES.DEFER],
    cooldownMs: 5000
  },

  // Content filtering
  contentFilter: {
    patterns: [
      /content.*filter/i,
      /safety/i,
      /refus/i,
      /cannot.*help/i,
      /inappropriate/i
    ],
    strategies: [STRATEGIES.INVESTIGATE, STRATEGIES.SKIP],
    cooldownMs: 0
  },

  // Resource exhaustion
  resource: {
    patterns: [
      /out of memory/i,
      /memory.*limit/i,
      /disk.*space/i,
      /no.*space/i
    ],
    strategies: [STRATEGIES.DEFER, STRATEGIES.MANUAL],
    cooldownMs: 300000
  },

  // Process errors
  process: {
    patterns: [
      /process.*exit/i,
      /killed/i,
      /signal/i,
      /zombie/i
    ],
    strategies: [STRATEGIES.RETRY, STRATEGIES.INVESTIGATE],
    cooldownMs: 10000
  }
}

// Recovery attempt tracking
const recoveryAttempts = new Map()
const MAX_RECOVERY_ATTEMPTS = 3
const ATTEMPT_RESET_MS = 3600000 // 1 hour

// Recovery history
const recoveryHistory = []
const MAX_HISTORY = 200

/**
 * Analyze an error to determine its category and recommended recovery
 * @param {Error|Object} error - Error to analyze
 * @param {Object} context - Additional context
 * @returns {Object} - Error analysis result
 */
function analyzeError(error, context = {}) {
  const errorMessage = error?.message || error?.error || String(error)
  const errorCode = error?.code || error?.status

  let category = 'unknown'
  let patterns = []
  let suggestedStrategies = [STRATEGIES.RETRY]
  let cooldownMs = 0

  // Match against known patterns
  for (const [cat, config] of Object.entries(ERROR_PATTERNS)) {
    for (const pattern of config.patterns) {
      if (pattern.test(errorMessage) || (errorCode && pattern.test(String(errorCode)))) {
        category = cat
        patterns = config.patterns.map(p => p.source)
        suggestedStrategies = config.strategies
        cooldownMs = config.cooldownMs
        break
      }
    }
    if (category !== 'unknown') break
  }

  return {
    category,
    message: errorMessage.substring(0, 500),
    code: errorCode,
    matchedPatterns: patterns,
    suggestedStrategies,
    cooldownMs,
    severity: getSeverity(category),
    recoverable: suggestedStrategies[0] !== STRATEGIES.MANUAL,
    context: {
      taskId: context.taskId,
      agentId: context.agentId,
      provider: context.provider,
      model: context.model
    }
  }
}

/**
 * Get severity level for error category
 * @param {string} category - Error category
 * @returns {string} - Severity level
 */
function getSeverity(category) {
  const severities = {
    rateLimit: 'medium',
    auth: 'high',
    modelUnavailable: 'medium',
    contextLength: 'low',
    network: 'medium',
    contentFilter: 'low',
    resource: 'high',
    process: 'medium',
    unknown: 'medium'
  }
  return severities[category] || 'medium'
}

/**
 * Select the best recovery strategy based on analysis and history
 * @param {Object} analysis - Error analysis from analyzeError()
 * @param {Object} options - Recovery options
 * @returns {Object} - Selected strategy with parameters
 */
function selectRecoveryStrategy(analysis, options = {}) {
  const { taskId, agentId, attemptNumber = 1 } = options

  // Check if max attempts reached
  const attemptKey = `${taskId || agentId || 'global'}`
  const attempts = getAttemptCount(attemptKey)

  if (attempts >= MAX_RECOVERY_ATTEMPTS) {
    return {
      strategy: STRATEGIES.MANUAL,
      reason: 'Maximum recovery attempts exceeded',
      params: { requiresApproval: true }
    }
  }

  // Get first viable strategy
  const strategy = analysis.suggestedStrategies[0] || STRATEGIES.RETRY

  // Calculate backoff for retries
  let params = {}
  if (strategy === STRATEGIES.RETRY || strategy === STRATEGIES.DEFER) {
    const baseDelay = analysis.cooldownMs || 5000
    const backoffDelay = baseDelay * Math.pow(2, attempts)
    params.delayMs = Math.min(backoffDelay, 300000) // Max 5 minutes
  }

  if (strategy === STRATEGIES.ESCALATE) {
    params.suggestHeavyModel = true
  }

  if (strategy === STRATEGIES.DECOMPOSE) {
    params.suggestSmallerContext = true
    params.maxChunkSize = 2000
  }

  if (strategy === STRATEGIES.FALLBACK) {
    params.useFallbackProvider = true
  }

  return {
    strategy,
    reason: `Error category: ${analysis.category}`,
    params,
    attemptNumber: attempts + 1,
    maxAttempts: MAX_RECOVERY_ATTEMPTS
  }
}

/**
 * Get recovery attempt count for a key
 * @param {string} key - Attempt tracking key
 * @returns {number} - Current attempt count
 */
function getAttemptCount(key) {
  const record = recoveryAttempts.get(key)
  if (!record) return 0

  // Reset if too old
  if (Date.now() - record.lastAttempt > ATTEMPT_RESET_MS) {
    recoveryAttempts.delete(key)
    return 0
  }

  return record.count
}

/**
 * Record a recovery attempt
 * @param {string} key - Attempt tracking key
 * @param {Object} data - Attempt data
 */
function recordAttempt(key, data = {}) {
  const record = recoveryAttempts.get(key) || { count: 0, history: [] }

  record.count++
  record.lastAttempt = Date.now()
  record.history.push({
    timestamp: Date.now(),
    strategy: data.strategy,
    success: data.success
  })

  // Keep only last 5 attempts in history
  if (record.history.length > 5) {
    record.history.shift()
  }

  recoveryAttempts.set(key, record)
}

/**
 * Execute a recovery strategy
 * @param {string} strategy - Strategy name
 * @param {Object} task - Original task
 * @param {Object} error - Original error
 * @param {Object} params - Strategy parameters
 * @returns {Promise<Object>} - Recovery result
 */
async function executeRecovery(strategy, task, error, params = {}) {
  const startTime = Date.now()
  const attemptKey = task?.id || 'global'

  recordAttempt(attemptKey, { strategy, success: null })

  let result = { success: false, strategy, action: null }

  switch (strategy) {
    case STRATEGIES.RETRY:
      if (params.delayMs) {
        await new Promise(resolve => setTimeout(resolve, params.delayMs))
      }
      result = {
        success: true,
        strategy,
        action: 'retry_now',
        message: `Retry after ${params.delayMs}ms delay`
      }
      break

    case STRATEGIES.DEFER:
      result = {
        success: true,
        strategy,
        action: 'reschedule',
        rescheduleAfterMs: params.delayMs || 60000,
        message: `Task rescheduled for ${params.delayMs}ms later`
      }
      break

    case STRATEGIES.FALLBACK:
      result = {
        success: true,
        strategy,
        action: 'use_fallback',
        useFallback: true,
        message: 'Switching to fallback provider'
      }
      break

    case STRATEGIES.ESCALATE:
      result = {
        success: true,
        strategy,
        action: 'escalate_model',
        useHeavyModel: true,
        message: 'Escalating to heavy model'
      }
      break

    case STRATEGIES.DECOMPOSE:
      result = {
        success: true,
        strategy,
        action: 'decompose_task',
        maxChunkSize: params.maxChunkSize || 2000,
        message: 'Breaking task into smaller chunks'
      }
      break

    case STRATEGIES.INVESTIGATE:
      result = {
        success: true,
        strategy,
        action: 'create_investigation',
        createInvestigationTask: true,
        originalError: error?.message,
        message: 'Creating investigation task'
      }
      break

    case STRATEGIES.SKIP:
      result = {
        success: true,
        strategy,
        action: 'skip_task',
        skipped: true,
        message: 'Task skipped due to unrecoverable error'
      }
      break

    case STRATEGIES.MANUAL:
      result = {
        success: false,
        strategy,
        action: 'require_manual',
        requiresManualIntervention: true,
        message: 'Manual intervention required'
      }
      break

    default:
      result = {
        success: false,
        strategy,
        action: 'unknown_strategy',
        message: `Unknown strategy: ${strategy}`
      }
  }

  // Update attempt record with result
  const record = recoveryAttempts.get(attemptKey)
  if (record && record.history.length > 0) {
    record.history[record.history.length - 1].success = result.success
  }

  // Add to history
  recoveryHistory.unshift({
    timestamp: Date.now(),
    taskId: task?.id,
    errorCategory: error?.category || 'unknown',
    strategy,
    success: result.success,
    durationMs: Date.now() - startTime
  })

  while (recoveryHistory.length > MAX_HISTORY) {
    recoveryHistory.pop()
  }

  // Emit event
  cosEvents.emit('recovery:executed', {
    taskId: task?.id,
    strategy,
    success: result.success,
    action: result.action
  })

  return result
}

/**
 * Get recovery statistics
 * @returns {Object} - Recovery stats
 */
function getStats() {
  const recent = recoveryHistory.slice(0, 100)
  const successCount = recent.filter(r => r.success).length

  const byStrategy = {}
  const byCategory = {}

  for (const record of recent) {
    byStrategy[record.strategy] = (byStrategy[record.strategy] || 0) + 1
    byCategory[record.errorCategory] = (byCategory[record.errorCategory] || 0) + 1
  }

  return {
    totalAttempts: recoveryHistory.length,
    recentAttempts: recent.length,
    successRate: recent.length > 0 ? ((successCount / recent.length) * 100).toFixed(1) + '%' : '0%',
    byStrategy,
    byCategory,
    activeAttemptKeys: recoveryAttempts.size
  }
}

/**
 * Get recovery history
 * @param {Object} options - Filter options
 * @returns {Array} - Recovery history
 */
function getHistory(options = {}) {
  let history = [...recoveryHistory]

  if (options.strategy) {
    history = history.filter(r => r.strategy === options.strategy)
  }

  if (options.success !== undefined) {
    history = history.filter(r => r.success === options.success)
  }

  const limit = options.limit || 50
  return history.slice(0, limit)
}

/**
 * Reset attempt counter for a key
 * @param {string} key - Attempt tracking key
 */
function resetAttempts(key) {
  recoveryAttempts.delete(key)
}

/**
 * Clear all attempt counters
 */
function clearAllAttempts() {
  recoveryAttempts.clear()
}

export {
  STRATEGIES,
  ERROR_PATTERNS,
  analyzeError,
  selectRecoveryStrategy,
  executeRecovery,
  recordAttempt,
  getAttemptCount,
  getStats,
  getHistory,
  resetAttempts,
  clearAllAttempts
}
