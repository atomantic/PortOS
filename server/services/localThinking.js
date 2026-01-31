/**
 * Local Thinking Service
 *
 * Uses LM Studio for free local analysis and thinking.
 * Decides when to escalate to cloud providers.
 */

import * as lmStudio from './lmStudioManager.js'
import { cosEvents } from './cosEvents.js'

// Task complexity thresholds for escalation
const COMPLEXITY_THRESHOLDS = {
  simple: 0.3,   // Local model can handle
  medium: 0.6,   // Local might work, cloud preferred
  complex: 0.8,  // Cloud recommended
  advanced: 1.0  // Cloud required
}

// Keywords that suggest higher complexity
const COMPLEXITY_KEYWORDS = {
  high: [
    'refactor', 'architect', 'design', 'security', 'audit',
    'optimize', 'performance', 'migration', 'integrate',
    'test coverage', 'comprehensive', 'entire codebase'
  ],
  medium: [
    'implement', 'feature', 'fix bug', 'update', 'modify',
    'add functionality', 'improve', 'enhance'
  ],
  low: [
    'format', 'rename', 'typo', 'comment', 'simple',
    'minor', 'quick', 'small', 'straightforward'
  ]
}

// Usage tracking
const stats = {
  localAnalyses: 0,
  cloudEscalations: 0,
  localSuccesses: 0,
  localFailures: 0
}

/**
 * Analyze a task to determine complexity and requirements
 * @param {Object} task - Task to analyze
 * @returns {Promise<Object>} - Analysis result
 */
async function analyzeTask(task) {
  const description = task.description || ''

  // Quick keyword-based complexity estimate
  const keywordComplexity = estimateComplexityFromKeywords(description)

  // Check if LM Studio is available for deeper analysis
  const lmAvailable = await lmStudio.checkLMStudioAvailable()

  if (!lmAvailable) {
    return {
      complexity: keywordComplexity,
      escalateToCloud: keywordComplexity > COMPLEXITY_THRESHOLDS.medium,
      reason: 'LM Studio unavailable, using keyword analysis',
      localAnalysis: false,
      suggestions: []
    }
  }

  // Use local model for deeper analysis
  stats.localAnalyses++

  const analysisPrompt = `Analyze this task and respond with JSON only:
Task: ${description.substring(0, 500)}

Respond with:
{
  "complexity": 0.0-1.0 (how complex is this task),
  "requiresCodeUnderstanding": true/false,
  "requiresMultiFileChanges": true/false,
  "requiresArchitecturalDecisions": true/false,
  "suggestedApproach": "brief approach",
  "potentialRisks": ["risk1", "risk2"]
}`

  const result = await lmStudio.quickCompletion(analysisPrompt, {
    maxTokens: 256,
    temperature: 0.3,
    systemPrompt: 'You are a code analysis assistant. Respond only with valid JSON.'
  })

  if (!result.success) {
    stats.localFailures++
    return {
      complexity: keywordComplexity,
      escalateToCloud: keywordComplexity > COMPLEXITY_THRESHOLDS.medium,
      reason: `Local analysis failed: ${result.error}`,
      localAnalysis: false,
      suggestions: []
    }
  }

  stats.localSuccesses++

  // Parse local model response
  let analysis
  try {
    // Extract JSON from response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : null
  } catch (err) {
    analysis = null
  }

  if (!analysis) {
    return {
      complexity: keywordComplexity,
      escalateToCloud: keywordComplexity > COMPLEXITY_THRESHOLDS.medium,
      reason: 'Could not parse local analysis',
      localAnalysis: true,
      rawResponse: result.content,
      suggestions: []
    }
  }

  const complexity = analysis.complexity || keywordComplexity

  // Determine if cloud escalation is needed
  const needsCloud = shouldEscalateToCloud({
    complexity,
    requiresCodeUnderstanding: analysis.requiresCodeUnderstanding,
    requiresMultiFileChanges: analysis.requiresMultiFileChanges,
    requiresArchitecturalDecisions: analysis.requiresArchitecturalDecisions
  })

  if (needsCloud) {
    stats.cloudEscalations++
  }

  return {
    complexity,
    escalateToCloud: needsCloud,
    reason: needsCloud
      ? 'Task requires advanced reasoning'
      : 'Task suitable for local execution',
    localAnalysis: true,
    suggestedApproach: analysis.suggestedApproach,
    potentialRisks: analysis.potentialRisks || [],
    suggestions: analysis.potentialRisks || []
  }
}

/**
 * Estimate complexity from keywords
 * @param {string} text - Text to analyze
 * @returns {number} - Complexity score 0-1
 */
function estimateComplexityFromKeywords(text) {
  const lower = text.toLowerCase()

  let score = 0.5 // Default medium

  // Check high complexity keywords
  for (const keyword of COMPLEXITY_KEYWORDS.high) {
    if (lower.includes(keyword)) {
      score = Math.max(score, 0.8)
    }
  }

  // Check medium complexity keywords
  for (const keyword of COMPLEXITY_KEYWORDS.medium) {
    if (lower.includes(keyword)) {
      score = Math.max(score, 0.5)
    }
  }

  // Check low complexity keywords
  for (const keyword of COMPLEXITY_KEYWORDS.low) {
    if (lower.includes(keyword)) {
      score = Math.min(score, 0.3)
    }
  }

  // Length-based adjustment
  if (text.length > 500) score = Math.min(score + 0.1, 1)
  if (text.length > 1000) score = Math.min(score + 0.1, 1)

  return score
}

/**
 * Determine if a task should escalate to cloud
 * @param {Object} analysis - Task analysis
 * @returns {boolean} - True if should escalate
 */
function shouldEscalateToCloud(analysis) {
  // Always escalate very complex tasks
  if (analysis.complexity > COMPLEXITY_THRESHOLDS.complex) {
    return true
  }

  // Escalate if requires architectural decisions
  if (analysis.requiresArchitecturalDecisions) {
    return true
  }

  // Escalate if requires multi-file changes and is moderately complex
  if (analysis.requiresMultiFileChanges && analysis.complexity > COMPLEXITY_THRESHOLDS.medium) {
    return true
  }

  return false
}

/**
 * Classify a memory using local model
 * @param {string} content - Memory content
 * @returns {Promise<Object>} - Classification result
 */
async function classifyMemory(content) {
  const lmAvailable = await lmStudio.checkLMStudioAvailable()

  if (!lmAvailable) {
    return {
      success: false,
      error: 'LM Studio unavailable'
    }
  }

  const classifyPrompt = `Classify this memory into one of: fact, learning, preference, observation, decision, context.
Also extract relevant tags.

Memory: ${content.substring(0, 300)}

Respond with JSON only:
{
  "type": "fact|learning|preference|observation|decision|context",
  "category": "codebase|patterns|bugs|performance|other",
  "tags": ["tag1", "tag2"],
  "importance": 0.0-1.0
}`

  const result = await lmStudio.quickCompletion(classifyPrompt, {
    maxTokens: 128,
    temperature: 0.3,
    systemPrompt: 'You are a memory classification assistant. Respond only with valid JSON.'
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  try {
    const jsonMatch = result.content.match(/\{[\s\S]*\}/)
    const classification = jsonMatch ? JSON.parse(jsonMatch[0]) : null

    return {
      success: true,
      ...classification
    }
  } catch (err) {
    return {
      success: false,
      error: 'Could not parse classification',
      rawResponse: result.content
    }
  }
}

/**
 * Quick completion for simple local tasks
 * @param {string} prompt - Prompt
 * @param {Object} options - Options
 * @returns {Promise<Object>} - Completion result
 */
async function quickCompletion(prompt, options = {}) {
  return lmStudio.quickCompletion(prompt, options)
}

/**
 * Get thinking service statistics
 * @returns {Object} - Statistics
 */
function getStats() {
  const lmStats = {
    localAnalyses: stats.localAnalyses,
    cloudEscalations: stats.cloudEscalations,
    localSuccesses: stats.localSuccesses,
    localFailures: stats.localFailures,
    localSuccessRate: stats.localAnalyses > 0
      ? ((stats.localSuccesses / stats.localAnalyses) * 100).toFixed(1) + '%'
      : '0%',
    escalationRate: stats.localAnalyses > 0
      ? ((stats.cloudEscalations / stats.localAnalyses) * 100).toFixed(1) + '%'
      : '0%'
  }

  return lmStats
}

/**
 * Reset statistics
 */
function resetStats() {
  stats.localAnalyses = 0
  stats.cloudEscalations = 0
  stats.localSuccesses = 0
  stats.localFailures = 0
}

/**
 * Pre-analyze a batch of tasks
 * @param {Array} tasks - Tasks to analyze
 * @returns {Promise<Array>} - Analysis results
 */
async function analyzeTaskBatch(tasks) {
  const results = []

  for (const task of tasks) {
    const analysis = await analyzeTask(task)
    results.push({
      taskId: task.id,
      description: task.description?.substring(0, 50),
      ...analysis
    })
  }

  return results
}

export {
  analyzeTask,
  estimateComplexityFromKeywords,
  shouldEscalateToCloud,
  classifyMemory,
  quickCompletion,
  getStats,
  resetStats,
  analyzeTaskBatch,
  COMPLEXITY_THRESHOLDS
}
