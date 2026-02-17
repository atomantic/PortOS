/**
 * Goal Progress Service
 *
 * Tracks progress toward user goals defined in COS-GOALS.md by analyzing
 * completed CoS tasks and mapping them to goal categories.
 *
 * Goals are extracted from COS-GOALS.md's Active Goals section.
 * Task completions are categorized by keywords and mapped to goal progress.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { readJSONFile, PATHS } from '../lib/fileUtils.js'

const GOALS_FILE = join(PATHS.data, 'COS-GOALS.md')
const LEARNING_FILE = join(PATHS.cos, 'learning.json')

/**
 * Goal category mappings - maps goal names to task type patterns
 * Each goal has keywords that match against task types and descriptions
 */
const GOAL_MAPPINGS = {
  'Codebase Quality': {
    icon: '🔧',
    color: 'emerald',
    keywords: ['security', 'audit', 'mobile', 'responsive', 'dry', 'dead-code', 'test', 'coverage', 'console', 'lint', 'refactor'],
    taskTypes: ['self-improve:security-audit', 'self-improve:mobile-responsive', 'self-improve:feature', 'app-improve:security', 'app-improve:mobile']
  },
  'Self-Improvement': {
    icon: '🧠',
    color: 'purple',
    keywords: ['capability', 'improvement', 'learn', 'analysis', 'error', 'retry', 'prioritization', 'a11y', 'i18n', 'seo'],
    taskTypes: ['self-improve:general', 'self-improve:brainstorm', 'idle-review']
  },
  'Documentation': {
    icon: '📚',
    color: 'blue',
    keywords: ['document', 'docs', 'readme', 'plan', 'report', 'summary', 'changelog'],
    taskTypes: ['self-improve:documentation', 'app-improve:documentation']
  },
  'User Engagement': {
    icon: '💬',
    color: 'pink',
    keywords: ['feedback', 'suggest', 'goal', 'status', 'clarify', 'user', 'engagement'],
    taskTypes: ['user-task']
  },
  'System Health': {
    icon: '💚',
    color: 'green',
    keywords: ['health', 'pm2', 'memory', 'performance', 'monitor', 'alert', 'process', 'service'],
    taskTypes: ['auto-fix', 'internal-task']
  }
}

/**
 * Parse COS-GOALS.md to extract active goals
 * @returns {Promise<Array>} Parsed goals with titles and items
 */
async function parseGoalsFile() {
  const content = await readFile(GOALS_FILE, 'utf-8').catch(() => null)
  if (!content) return []

  const goals = []
  const lines = content.split('\n')
  let inActiveGoals = false
  let currentGoal = null

  for (const line of lines) {
    // Detect Active Goals section
    if (line.startsWith('## Active Goals')) {
      inActiveGoals = true
      continue
    }

    // Stop at next major section
    if (inActiveGoals && line.startsWith('## ') && !line.includes('Active Goals')) {
      inActiveGoals = false
      continue
    }

    if (!inActiveGoals) continue

    // Parse goal headers (### Goal N: Name)
    const goalMatch = line.match(/^### Goal \d+:\s*(.+)/)
    if (goalMatch) {
      if (currentGoal) goals.push(currentGoal)
      const name = goalMatch[1].trim()
      currentGoal = {
        name,
        items: [],
        mapping: GOAL_MAPPINGS[name] || { icon: '🎯', color: 'gray', keywords: [], taskTypes: [] }
      }
      continue
    }

    // Parse goal items (- item text)
    if (currentGoal && line.match(/^- /)) {
      currentGoal.items.push(line.replace(/^- /, '').trim())
    }
  }

  if (currentGoal) goals.push(currentGoal)
  return goals
}

/**
 * Get task completion statistics from learning data
 * @returns {Promise<Object>} Task completion stats by type
 */
async function getTaskStats() {
  const learning = await readJSONFile(LEARNING_FILE, null)
  if (!learning?.byTaskType) return {}
  return learning.byTaskType
}

/**
 * Calculate progress for each goal based on completed tasks
 * @param {Array} goals - Parsed goals from COS-GOALS.md
 * @param {Object} taskStats - Task completion statistics
 * @returns {Array} Goals with progress metrics
 */
function calculateGoalProgress(goals, taskStats) {
  return goals.map(goal => {
    let totalTasks = 0
    let succeededTasks = 0

    // Sum up tasks matching this goal's task types
    for (const taskType of goal.mapping.taskTypes) {
      const stats = taskStats[taskType]
      if (stats) {
        totalTasks += stats.completed || 0
        succeededTasks += stats.succeeded || 0
      }
    }

    // Also check for keyword matches in other task types
    for (const [taskType, stats] of Object.entries(taskStats)) {
      // Skip if already counted by taskTypes
      if (goal.mapping.taskTypes.includes(taskType)) continue

      // Check if task type contains any of this goal's keywords
      const hasKeyword = goal.mapping.keywords.some(kw =>
        taskType.toLowerCase().includes(kw.toLowerCase())
      )
      if (hasKeyword) {
        totalTasks += stats.completed || 0
        succeededTasks += stats.succeeded || 0
      }
    }

    // Calculate success rate
    const successRate = totalTasks > 0 ? Math.round((succeededTasks / totalTasks) * 100) : null

    // Estimate engagement level (low/medium/high based on task count)
    let engagement = 'low'
    if (totalTasks >= 20) engagement = 'high'
    else if (totalTasks >= 5) engagement = 'medium'

    return {
      name: goal.name,
      icon: goal.mapping.icon,
      color: goal.mapping.color,
      itemCount: goal.items.length,
      metrics: {
        totalTasks,
        succeededTasks,
        successRate,
        engagement
      }
    }
  })
}

/**
 * Get goal progress summary for dashboard display
 * @returns {Promise<Object>} Goal progress data
 */
async function getGoalProgress() {
  const [goals, taskStats] = await Promise.all([
    parseGoalsFile(),
    getTaskStats()
  ])

  const goalsWithProgress = calculateGoalProgress(goals, taskStats)

  // Calculate overall stats
  const totalTasks = goalsWithProgress.reduce((sum, g) => sum + g.metrics.totalTasks, 0)
  const totalSucceeded = goalsWithProgress.reduce((sum, g) => sum + g.metrics.succeededTasks, 0)

  // Find most and least engaged goals
  const sorted = [...goalsWithProgress].sort((a, b) => b.metrics.totalTasks - a.metrics.totalTasks)
  const mostActive = sorted[0]?.name || null
  const leastActive = sorted[sorted.length - 1]?.name || null

  return {
    goals: goalsWithProgress,
    summary: {
      totalGoals: goals.length,
      totalTasks,
      totalSucceeded,
      overallSuccessRate: totalTasks > 0 ? Math.round((totalSucceeded / totalTasks) * 100) : null,
      mostActive,
      leastActive: leastActive !== mostActive ? leastActive : null
    },
    updatedAt: new Date().toISOString()
  }
}

/**
 * Get a brief summary suitable for dashboard widget
 * @returns {Promise<Object>} Compact goal progress summary
 */
async function getGoalProgressSummary() {
  const progress = await getGoalProgress()

  // Return top 5 goals by activity for compact display
  const topGoals = progress.goals
    .sort((a, b) => b.metrics.totalTasks - a.metrics.totalTasks)
    .slice(0, 5)
    .map(g => ({
      name: g.name,
      icon: g.icon,
      color: g.color,
      tasks: g.metrics.totalTasks,
      successRate: g.metrics.successRate,
      engagement: g.metrics.engagement
    }))

  return {
    goals: topGoals,
    summary: progress.summary,
    updatedAt: progress.updatedAt
  }
}

export {
  getGoalProgress,
  getGoalProgressSummary,
  parseGoalsFile,
  GOAL_MAPPINGS
}
