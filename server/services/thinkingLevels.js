/**
 * Thinking Levels Service
 *
 * Dynamic model selection based on thinking levels.
 * Hierarchy: task → hooks → agent → provider defaults
 */

import { cosEvents } from './cosEvents.js'

// Thinking level definitions
const THINKING_LEVELS = {
  off: {
    name: 'off',
    model: null,
    maxTokens: 0,
    description: 'No extended thinking, use defaults'
  },
  minimal: {
    name: 'minimal',
    model: 'local-small',
    maxTokens: 256,
    localPreferred: true,
    description: 'Quick local analysis only'
  },
  low: {
    name: 'low',
    model: 'local-medium',
    maxTokens: 1024,
    localPreferred: true,
    description: 'Basic reasoning with local model'
  },
  medium: {
    name: 'medium',
    model: 'provider-default',
    maxTokens: 4096,
    localPreferred: false,
    description: 'Standard cloud model thinking'
  },
  high: {
    name: 'high',
    model: 'provider-heavy',
    maxTokens: 8192,
    localPreferred: false,
    description: 'Advanced reasoning with heavy model'
  },
  xhigh: {
    name: 'xhigh',
    model: 'opus',
    maxTokens: 16384,
    localPreferred: false,
    description: 'Maximum reasoning with Opus'
  }
}

// Default thresholds for automatic level selection
const AUTO_THRESHOLDS = {
  contextLength: {
    minimal: 500,
    low: 1000,
    medium: 3000,
    high: 6000,
    xhigh: 10000
  },
  complexity: {
    minimal: 0.2,
    low: 0.4,
    medium: 0.6,
    high: 0.8,
    xhigh: 0.95
  }
}

// Task type to default level mapping
const TASK_TYPE_LEVELS = {
  // Simple tasks
  'format': 'minimal',
  'rename': 'minimal',
  'typo': 'minimal',
  'comment': 'low',

  // Medium tasks
  'fix-bug': 'medium',
  'implement': 'medium',
  'update': 'medium',

  // Complex tasks
  'refactor': 'high',
  'security': 'high',
  'optimize': 'high',
  'architect': 'xhigh',
  'audit': 'xhigh',
  'migration': 'xhigh'
}

// Usage tracking
const levelUsage = {
  off: 0,
  minimal: 0,
  low: 0,
  medium: 0,
  high: 0,
  xhigh: 0
}

/**
 * Resolve thinking level for a task
 * Checks hierarchy: task metadata → hooks → agent config → provider defaults
 *
 * @param {Object} task - Task object
 * @param {Object} agent - Agent configuration
 * @param {Object} provider - Provider configuration
 * @returns {Object} - Resolved thinking level configuration
 */
function resolveThinkingLevel(task, agent = {}, provider = {}) {
  let level = 'medium' // Default

  // 1. Check task metadata for explicit level
  if (task?.metadata?.thinkingLevel) {
    level = task.metadata.thinkingLevel
  }
  // 2. Check task priority
  else if (task?.priority) {
    const priority = task.priority.toUpperCase()
    if (priority === 'URGENT' || priority === 'CRITICAL') {
      level = 'high'
    } else if (priority === 'LOW' || priority === 'IDLE') {
      level = 'low'
    }
  }
  // 3. Check task type
  else if (task?.metadata?.taskType) {
    level = TASK_TYPE_LEVELS[task.metadata.taskType] || level
  }
  // 4. Check agent default
  else if (agent?.defaultThinkingLevel) {
    level = agent.defaultThinkingLevel
  }
  // 5. Check provider default
  else if (provider?.defaultThinkingLevel) {
    level = provider.defaultThinkingLevel
  }

  // Validate level
  if (!THINKING_LEVELS[level]) {
    level = 'medium'
  }

  // Track usage
  levelUsage[level]++

  const config = THINKING_LEVELS[level]

  cosEvents.emit('thinking:levelResolved', {
    taskId: task?.id,
    level,
    model: config.model,
    source: determineSource(task, agent, provider)
  })

  return {
    level,
    ...config,
    resolvedFrom: determineSource(task, agent, provider)
  }
}

/**
 * Determine where the level was resolved from
 */
function determineSource(task, agent, provider) {
  if (task?.metadata?.thinkingLevel) return 'task'
  if (task?.priority) return 'priority'
  if (task?.metadata?.taskType) return 'taskType'
  if (agent?.defaultThinkingLevel) return 'agent'
  if (provider?.defaultThinkingLevel) return 'provider'
  return 'default'
}

/**
 * Suggest thinking level based on task analysis
 * @param {Object} analysis - Task analysis from localThinking
 * @returns {string} - Suggested level
 */
function suggestLevel(analysis) {
  const complexity = analysis.complexity || 0.5

  // Find appropriate level based on complexity
  for (const [level, threshold] of Object.entries(AUTO_THRESHOLDS.complexity).reverse()) {
    if (complexity >= threshold) {
      return level
    }
  }

  return 'minimal'
}

/**
 * Suggest thinking level based on context length
 * @param {number} contextLength - Context length in characters
 * @returns {string} - Suggested level
 */
function suggestLevelFromContext(contextLength) {
  for (const [level, threshold] of Object.entries(AUTO_THRESHOLDS.contextLength).reverse()) {
    if (contextLength >= threshold) {
      return level
    }
  }

  return 'minimal'
}

/**
 * Get model for a thinking level
 * @param {string} level - Thinking level name
 * @param {Object} provider - Provider config for model mapping
 * @returns {string|null} - Model identifier
 */
function getModelForLevel(level, provider = {}) {
  const config = THINKING_LEVELS[level]
  if (!config) return null

  const modelKey = config.model

  switch (modelKey) {
    case null:
      return provider.defaultModel || null
    case 'local-small':
      return 'lmstudio' // Will use LM Studio
    case 'local-medium':
      return 'lmstudio'
    case 'provider-default':
      return provider.defaultModel || 'claude-3-5-sonnet-20241022'
    case 'provider-heavy':
      return provider.heavyModel || 'claude-3-5-sonnet-20241022'
    case 'opus':
      return 'claude-opus-4-20250514'
    default:
      return modelKey
  }
}

/**
 * Check if level prefers local execution
 * @param {string} level - Thinking level
 * @returns {boolean} - True if local preferred
 */
function isLocalPreferred(level) {
  const config = THINKING_LEVELS[level]
  return config?.localPreferred || false
}

/**
 * Upgrade thinking level by one step
 * @param {string} currentLevel - Current level
 * @returns {string} - Upgraded level
 */
function upgradeLevel(currentLevel) {
  const levels = Object.keys(THINKING_LEVELS)
  const currentIndex = levels.indexOf(currentLevel)

  if (currentIndex === -1) return 'medium'
  if (currentIndex >= levels.length - 1) return currentLevel

  return levels[currentIndex + 1]
}

/**
 * Downgrade thinking level by one step
 * @param {string} currentLevel - Current level
 * @returns {string} - Downgraded level
 */
function downgradeLevel(currentLevel) {
  const levels = Object.keys(THINKING_LEVELS)
  const currentIndex = levels.indexOf(currentLevel)

  if (currentIndex === -1) return 'medium'
  if (currentIndex <= 0) return currentLevel

  return levels[currentIndex - 1]
}

/**
 * Get thinking level statistics
 * @returns {Object} - Usage statistics
 */
function getStats() {
  const total = Object.values(levelUsage).reduce((a, b) => a + b, 0)

  return {
    usage: { ...levelUsage },
    total,
    distribution: Object.entries(levelUsage).reduce((acc, [level, count]) => {
      acc[level] = total > 0 ? ((count / total) * 100).toFixed(1) + '%' : '0%'
      return acc
    }, {}),
    levels: Object.keys(THINKING_LEVELS),
    thresholds: AUTO_THRESHOLDS
  }
}

/**
 * Reset usage statistics
 */
function resetStats() {
  for (const level of Object.keys(levelUsage)) {
    levelUsage[level] = 0
  }
}

/**
 * Update auto thresholds
 * @param {string} thresholdType - 'contextLength' or 'complexity'
 * @param {Object} newThresholds - New threshold values
 */
function updateThresholds(thresholdType, newThresholds) {
  if (AUTO_THRESHOLDS[thresholdType]) {
    Object.assign(AUTO_THRESHOLDS[thresholdType], newThresholds)
  }
}

/**
 * Get all thinking levels
 * @returns {Object} - All level configurations
 */
function getLevels() {
  return { ...THINKING_LEVELS }
}

export {
  THINKING_LEVELS,
  AUTO_THRESHOLDS,
  TASK_TYPE_LEVELS,
  resolveThinkingLevel,
  suggestLevel,
  suggestLevelFromContext,
  getModelForLevel,
  isLocalPreferred,
  upgradeLevel,
  downgradeLevel,
  getStats,
  resetStats,
  updateThresholds,
  getLevels
}
