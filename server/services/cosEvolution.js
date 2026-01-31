/**
 * COS Evolution Service
 *
 * Enables COS to propose and execute self-modifications:
 * - Base model changes
 * - Threshold adjustments
 * - Model downloads
 *
 * Full autonomy - COS can evolve without user approval.
 * Changes are logged for transparency.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { cosEvents } from './cos.js'
import * as lmStudioManager from './lmStudioManager.js'

const DATA_DIR = path.join(process.cwd(), 'data', 'cos')
const EVOLUTION_FILE = path.join(DATA_DIR, 'evolution.json')

// Default evolution state
const DEFAULT_STATE = {
  currentBaseModel: 'gpt-oss-20b',
  currentThinkingThresholds: {
    contextLength: { low: 1000, medium: 3000, high: 6000 },
    complexity: { low: 0.4, medium: 0.6, high: 0.8 }
  },
  proposals: [],
  evolutionHistory: [],
  performanceBaseline: {
    successRate: 0.7,
    avgDurationMs: 60000,
    recordedAt: null
  },
  settings: {
    autoApproveModelChanges: true,  // Full autonomy
    autoApproveThresholdChanges: true,
    rollbackThreshold: 0.2,  // Rollback if success rate drops >20%
    minTasksBeforeEvaluation: 50  // Evaluate after 50 tasks
  }
}

// In-memory state
let evolutionState = null

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

/**
 * Load evolution state
 * @returns {Promise<Object>} - Evolution state
 */
async function loadState() {
  if (evolutionState) return evolutionState

  await ensureDataDir()

  const exists = await fs.access(EVOLUTION_FILE).then(() => true).catch(() => false)
  if (exists) {
    const content = await fs.readFile(EVOLUTION_FILE, 'utf-8')
    evolutionState = JSON.parse(content)
  } else {
    evolutionState = { ...DEFAULT_STATE }
  }

  return evolutionState
}

/**
 * Save evolution state
 */
async function saveState() {
  await ensureDataDir()
  await fs.writeFile(EVOLUTION_FILE, JSON.stringify(evolutionState, null, 2))
}

/**
 * Get current evolution state
 * @returns {Promise<Object>} - Current state
 */
async function getState() {
  return loadState()
}

/**
 * Propose a base model change
 * With full autonomy, this executes immediately.
 *
 * @param {string} newModel - New model identifier
 * @param {string} reasoning - Reasoning for change
 * @returns {Promise<Object>} - Proposal result
 */
async function proposeBaseModelChange(newModel, reasoning) {
  const state = await loadState()
  const proposal = {
    id: uuidv4(),
    type: 'base-model-change',
    currentModel: state.currentBaseModel,
    proposedModel: newModel,
    reasoning,
    createdAt: new Date().toISOString(),
    status: 'approved',  // Auto-approved with full autonomy
    executedAt: null,
    result: null
  }

  state.proposals.push(proposal)

  // Execute immediately (full autonomy)
  const result = await executeBaseModelChange(proposal.id)

  await saveState()

  console.log(`🧬 Evolution: Base model changed ${proposal.currentModel} → ${newModel}`)
  cosEvents.emit('evolution:modelChanged', {
    from: proposal.currentModel,
    to: newModel,
    reasoning
  })

  return result
}

/**
 * Execute a base model change
 * @param {string} proposalId - Proposal to execute
 * @returns {Promise<Object>} - Execution result
 */
async function executeBaseModelChange(proposalId) {
  const state = await loadState()
  const proposal = state.proposals.find(p => p.id === proposalId)

  if (!proposal) {
    return { success: false, error: 'Proposal not found' }
  }

  // Record the change
  const previousModel = state.currentBaseModel
  state.currentBaseModel = proposal.proposedModel
  proposal.executedAt = new Date().toISOString()
  proposal.status = 'executed'

  // Record in history
  state.evolutionHistory.push({
    type: 'base-model-change',
    from: previousModel,
    to: proposal.proposedModel,
    reasoning: proposal.reasoning,
    executedAt: proposal.executedAt
  })

  await saveState()

  return {
    success: true,
    previousModel,
    newModel: proposal.proposedModel
  }
}

/**
 * Request a model download
 * @param {string} modelId - Model to download
 * @param {string} purpose - Why this model is needed
 * @returns {Promise<Object>} - Download result
 */
async function requestModelDownload(modelId, purpose) {
  const state = await loadState()

  // Record the request
  state.evolutionHistory.push({
    type: 'model-download-request',
    modelId,
    purpose,
    requestedAt: new Date().toISOString()
  })

  await saveState()

  // Attempt download via LM Studio
  const result = await lmStudioManager.downloadModel(modelId)

  console.log(`📥 Evolution: Model download requested - ${modelId}`)
  cosEvents.emit('evolution:downloadRequested', { modelId, purpose, result })

  return result
}

/**
 * Adjust thinking thresholds
 * @param {string} thresholdType - 'contextLength' or 'complexity'
 * @param {Object} newValues - New threshold values
 * @param {string} reasoning - Reasoning for change
 * @returns {Promise<Object>} - Adjustment result
 */
async function adjustThinkingThreshold(thresholdType, newValues, reasoning) {
  const state = await loadState()

  if (!state.currentThinkingThresholds[thresholdType]) {
    return { success: false, error: 'Unknown threshold type' }
  }

  const previousValues = { ...state.currentThinkingThresholds[thresholdType] }

  // Apply new values
  Object.assign(state.currentThinkingThresholds[thresholdType], newValues)

  // Record in history
  state.evolutionHistory.push({
    type: 'threshold-adjustment',
    thresholdType,
    from: previousValues,
    to: state.currentThinkingThresholds[thresholdType],
    reasoning,
    executedAt: new Date().toISOString()
  })

  await saveState()

  console.log(`🎚️ Evolution: Threshold ${thresholdType} adjusted`)
  cosEvents.emit('evolution:thresholdAdjusted', {
    thresholdType,
    from: previousValues,
    to: state.currentThinkingThresholds[thresholdType],
    reasoning
  })

  return {
    success: true,
    thresholdType,
    previousValues,
    newValues: state.currentThinkingThresholds[thresholdType]
  }
}

/**
 * Record performance metrics for baseline comparison
 * @param {Object} metrics - Current performance metrics
 */
async function recordPerformanceMetrics(metrics) {
  const state = await loadState()

  const previous = { ...state.performanceBaseline }

  state.performanceBaseline = {
    successRate: metrics.successRate,
    avgDurationMs: metrics.avgDurationMs,
    taskCount: metrics.taskCount || 0,
    recordedAt: new Date().toISOString()
  }

  // Check for significant drop requiring rollback
  if (previous.successRate && metrics.successRate) {
    const drop = previous.successRate - metrics.successRate
    if (drop > state.settings.rollbackThreshold) {
      console.log(`⚠️ Evolution: Performance drop detected (${(drop * 100).toFixed(1)}%)`)
      cosEvents.emit('evolution:performanceDrop', {
        previousRate: previous.successRate,
        currentRate: metrics.successRate,
        dropPercent: drop * 100
      })
      // Could trigger automatic rollback here
    }
  }

  await saveState()
}

/**
 * Rollback to previous base model
 * @param {string} reason - Reason for rollback
 * @returns {Promise<Object>} - Rollback result
 */
async function rollbackBaseModel(reason) {
  const state = await loadState()

  // Find the previous model change in history
  const modelChanges = state.evolutionHistory
    .filter(e => e.type === 'base-model-change')
    .reverse()

  if (modelChanges.length < 2) {
    return { success: false, error: 'No previous model to rollback to' }
  }

  const previousChange = modelChanges[1]
  const currentModel = state.currentBaseModel
  const rollbackTo = previousChange.from

  state.currentBaseModel = rollbackTo

  state.evolutionHistory.push({
    type: 'rollback',
    from: currentModel,
    to: rollbackTo,
    reason,
    executedAt: new Date().toISOString()
  })

  await saveState()

  console.log(`⏪ Evolution: Rolled back to ${rollbackTo}`)
  cosEvents.emit('evolution:rollback', {
    from: currentModel,
    to: rollbackTo,
    reason
  })

  return {
    success: true,
    previousModel: currentModel,
    restoredModel: rollbackTo
  }
}

/**
 * Get evolution history
 * @param {Object} options - Filter options
 * @returns {Promise<Array>} - Evolution history
 */
async function getHistory(options = {}) {
  const state = await loadState()
  let history = [...state.evolutionHistory]

  if (options.type) {
    history = history.filter(e => e.type === options.type)
  }

  // Sort by date descending
  history.sort((a, b) =>
    new Date(b.executedAt || b.requestedAt).getTime() -
    new Date(a.executedAt || a.requestedAt).getTime()
  )

  const limit = options.limit || 50
  return history.slice(0, limit)
}

/**
 * Get pending proposals (for display, though auto-approved)
 * @returns {Promise<Array>} - Pending proposals
 */
async function getPendingProposals() {
  const state = await loadState()
  return state.proposals.filter(p => p.status === 'pending')
}

/**
 * Get evolution statistics
 * @returns {Promise<Object>} - Evolution stats
 */
async function getStats() {
  const state = await loadState()

  const byType = {}
  for (const entry of state.evolutionHistory) {
    byType[entry.type] = (byType[entry.type] || 0) + 1
  }

  return {
    currentBaseModel: state.currentBaseModel,
    currentThresholds: state.currentThinkingThresholds,
    performanceBaseline: state.performanceBaseline,
    totalEvolutions: state.evolutionHistory.length,
    byType,
    pendingProposals: state.proposals.filter(p => p.status === 'pending').length,
    settings: state.settings
  }
}

/**
 * Update evolution settings
 * @param {Object} newSettings - Settings to update
 * @returns {Promise<Object>} - Updated settings
 */
async function updateSettings(newSettings) {
  const state = await loadState()

  Object.assign(state.settings, newSettings)
  await saveState()

  return state.settings
}

/**
 * Invalidate cache
 */
function invalidateCache() {
  evolutionState = null
}

export {
  getState,
  proposeBaseModelChange,
  requestModelDownload,
  adjustThinkingThreshold,
  recordPerformanceMetrics,
  rollbackBaseModel,
  getHistory,
  getPendingProposals,
  getStats,
  updateSettings,
  invalidateCache
}
