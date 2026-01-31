/**
 * Tool State Machine
 *
 * Manages tool execution lifecycle with defined states and transitions.
 * Provides structured error recovery and execution tracking.
 */

import { v4 as uuidv4 } from 'uuid'
import { cosEvents } from './cos.js'

// Tool execution states
const STATES = {
  IDLE: 'idle',
  START: 'start',
  RUNNING: 'running',
  UPDATE: 'update',
  END: 'end',
  ERROR: 'error',
  RECOVERED: 'recovered'
}

// Valid state transitions
const TRANSITIONS = {
  [STATES.IDLE]: [STATES.START],
  [STATES.START]: [STATES.RUNNING, STATES.ERROR],
  [STATES.RUNNING]: [STATES.UPDATE, STATES.END, STATES.ERROR],
  [STATES.UPDATE]: [STATES.RUNNING, STATES.END, STATES.ERROR],
  [STATES.END]: [],
  [STATES.ERROR]: [STATES.RECOVERED, STATES.END],
  [STATES.RECOVERED]: [STATES.RUNNING, STATES.ERROR]
}

// In-memory execution storage
const executions = new Map()

// Execution history (limited to last 1000)
const executionHistory = []
const MAX_HISTORY = 1000

/**
 * Create a new tool execution
 * @param {string} toolId - Tool identifier
 * @param {string} agentId - Agent running the tool
 * @param {Object} metadata - Additional execution metadata
 * @returns {Object} - Execution object
 */
function createToolExecution(toolId, agentId, metadata = {}) {
  const executionId = uuidv4()
  const now = Date.now()

  const execution = {
    id: executionId,
    toolId,
    agentId,
    state: STATES.IDLE,
    stateHistory: [{ state: STATES.IDLE, timestamp: now }],
    startedAt: null,
    completedAt: null,
    duration: null,
    input: metadata.input || null,
    output: null,
    error: null,
    recoveryAttempts: 0,
    metadata,
    createdAt: now
  }

  executions.set(executionId, execution)
  return execution
}

/**
 * Transition to a new state
 * @param {string} executionId - Execution ID
 * @param {string} newState - Target state
 * @param {Object} data - State-specific data
 * @returns {Object} - Updated execution or null if invalid
 */
function transitionState(executionId, newState, data = {}) {
  const execution = executions.get(executionId)
  if (!execution) return null

  const currentState = execution.state
  const validTransitions = TRANSITIONS[currentState] || []

  if (!validTransitions.includes(newState)) {
    console.error(`⚠️ Invalid state transition: ${currentState} → ${newState} for execution ${executionId}`)
    return null
  }

  const now = Date.now()

  // Update state
  execution.state = newState
  execution.stateHistory.push({ state: newState, timestamp: now, data })

  // Handle state-specific logic
  switch (newState) {
    case STATES.START:
      execution.startedAt = now
      break

    case STATES.RUNNING:
      if (data.input) execution.input = data.input
      break

    case STATES.UPDATE:
      if (data.progress) execution.progress = data.progress
      if (data.partialOutput) execution.partialOutput = data.partialOutput
      break

    case STATES.END:
      execution.completedAt = now
      execution.duration = now - (execution.startedAt || execution.createdAt)
      if (data.output !== undefined) execution.output = data.output
      archiveExecution(execution)
      break

    case STATES.ERROR:
      execution.error = {
        message: data.error?.message || data.message || 'Unknown error',
        code: data.error?.code || data.code,
        stack: data.error?.stack,
        timestamp: now
      }
      break

    case STATES.RECOVERED:
      execution.recoveryAttempts++
      execution.error = null
      break
  }

  // Emit state change event
  cosEvents.emit('tool:stateChange', {
    executionId,
    toolId: execution.toolId,
    agentId: execution.agentId,
    fromState: currentState,
    toState: newState,
    timestamp: now
  })

  return execution
}

/**
 * Start a tool execution
 * @param {string} executionId - Execution ID
 * @param {Object} input - Tool input
 * @returns {Object} - Updated execution
 */
function startExecution(executionId, input = null) {
  const started = transitionState(executionId, STATES.START)
  if (!started) return null

  return transitionState(executionId, STATES.RUNNING, { input })
}

/**
 * Update execution progress
 * @param {string} executionId - Execution ID
 * @param {Object} data - Progress data
 * @returns {Object} - Updated execution
 */
function updateExecution(executionId, data) {
  const execution = executions.get(executionId)
  if (!execution) return null

  // Only update if running
  if (execution.state !== STATES.RUNNING && execution.state !== STATES.UPDATE) {
    return execution
  }

  return transitionState(executionId, STATES.UPDATE, data)
}

/**
 * Complete a tool execution
 * @param {string} executionId - Execution ID
 * @param {*} output - Tool output
 * @returns {Object} - Completed execution
 */
function completeExecution(executionId, output = null) {
  const execution = executions.get(executionId)
  if (!execution) return null

  // Can complete from RUNNING, UPDATE, or ERROR states
  if (execution.state === STATES.ERROR) {
    // Completing from error state means we gave up
    return transitionState(executionId, STATES.END, { output, wasError: true })
  }

  if (execution.state === STATES.UPDATE) {
    // Go back to running first, then end
    transitionState(executionId, STATES.RUNNING)
  }

  return transitionState(executionId, STATES.END, { output })
}

/**
 * Mark execution as errored
 * @param {string} executionId - Execution ID
 * @param {Error|Object} error - Error details
 * @returns {Object} - Updated execution
 */
function errorExecution(executionId, error) {
  return transitionState(executionId, STATES.ERROR, { error })
}

/**
 * Attempt recovery from error state
 * @param {string} executionId - Execution ID
 * @param {string} strategy - Recovery strategy name
 * @returns {Object} - Recovered execution or null
 */
function recoverExecution(executionId, strategy) {
  const execution = executions.get(executionId)
  if (!execution || execution.state !== STATES.ERROR) return null

  const MAX_RECOVERY_ATTEMPTS = 3
  if (execution.recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
    console.log(`⚠️ Max recovery attempts (${MAX_RECOVERY_ATTEMPTS}) reached for ${executionId}`)
    return null
  }

  const recovered = transitionState(executionId, STATES.RECOVERED, { strategy })
  if (recovered) {
    transitionState(executionId, STATES.RUNNING)
  }

  return recovered
}

/**
 * Archive completed execution to history
 * @param {Object} execution - Completed execution
 */
function archiveExecution(execution) {
  // Add to history
  executionHistory.unshift({
    id: execution.id,
    toolId: execution.toolId,
    agentId: execution.agentId,
    startedAt: execution.startedAt,
    completedAt: execution.completedAt,
    duration: execution.duration,
    success: !execution.error,
    recoveryAttempts: execution.recoveryAttempts
  })

  // Trim history
  while (executionHistory.length > MAX_HISTORY) {
    executionHistory.pop()
  }

  // Remove from active executions after a delay
  setTimeout(() => {
    executions.delete(execution.id)
  }, 60000) // Keep for 1 minute for debugging
}

/**
 * Get execution by ID
 * @param {string} executionId - Execution ID
 * @returns {Object|null} - Execution object
 */
function getExecution(executionId) {
  return executions.get(executionId) || null
}

/**
 * Get all active executions for an agent
 * @param {string} agentId - Agent ID
 * @returns {Array} - Active executions
 */
function getAgentExecutions(agentId) {
  const results = []
  for (const execution of executions.values()) {
    if (execution.agentId === agentId) {
      results.push(execution)
    }
  }
  return results
}

/**
 * Get execution history
 * @param {Object} options - Filter options
 * @returns {Array} - Execution history
 */
function getExecutionHistory(options = {}) {
  let history = [...executionHistory]

  if (options.agentId) {
    history = history.filter(e => e.agentId === options.agentId)
  }

  if (options.toolId) {
    history = history.filter(e => e.toolId === options.toolId)
  }

  if (options.success !== undefined) {
    history = history.filter(e => e.success === options.success)
  }

  const limit = options.limit || 100
  return history.slice(0, limit)
}

/**
 * Get execution statistics
 * @returns {Object} - Statistics
 */
function getStats() {
  const active = Array.from(executions.values())
  const byState = {}

  for (const execution of active) {
    byState[execution.state] = (byState[execution.state] || 0) + 1
  }

  const recentHistory = executionHistory.slice(0, 100)
  const successCount = recentHistory.filter(e => e.success).length
  const avgDuration = recentHistory.length > 0
    ? recentHistory.reduce((sum, e) => sum + (e.duration || 0), 0) / recentHistory.length
    : 0

  return {
    activeExecutions: active.length,
    byState,
    historySize: executionHistory.length,
    recentSuccessRate: recentHistory.length > 0 ? successCount / recentHistory.length : 1,
    avgDurationMs: Math.round(avgDuration)
  }
}

/**
 * Clean up stale executions
 * @param {number} maxAgeMs - Maximum age in milliseconds
 * @returns {number} - Number of executions cleaned
 */
function cleanupStaleExecutions(maxAgeMs = 3600000) {
  const now = Date.now()
  let cleaned = 0

  for (const [id, execution] of executions.entries()) {
    const age = now - execution.createdAt
    if (age > maxAgeMs && execution.state !== STATES.END) {
      // Force complete stale executions
      transitionState(id, STATES.ERROR, { error: { message: 'Execution timeout' } })
      transitionState(id, STATES.END, { wasTimeout: true })
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned ${cleaned} stale tool executions`)
  }

  return cleaned
}

/**
 * Create a wrapped tool executor with state machine
 * @param {string} toolId - Tool identifier
 * @param {Function} toolFn - Actual tool function
 * @returns {Function} - Wrapped tool function
 */
function wrapToolWithStateMachine(toolId, toolFn) {
  return async function wrappedTool(agentId, input, metadata = {}) {
    const execution = createToolExecution(toolId, agentId, { ...metadata, input })

    const started = startExecution(execution.id, input)
    if (!started) {
      return { success: false, error: 'Failed to start execution' }
    }

    let result
    let lastError

    // Retry loop with recovery
    const maxAttempts = 3
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const current = getExecution(execution.id)
      if (!current || current.state === STATES.END) break

      try {
        result = await toolFn(input)
        completeExecution(execution.id, result)
        return { success: true, output: result, executionId: execution.id }
      } catch (error) {
        lastError = error
        errorExecution(execution.id, error)

        if (attempt < maxAttempts) {
          const recovered = recoverExecution(execution.id, 'retry')
          if (!recovered) break
          console.log(`🔄 Tool ${toolId} retry attempt ${attempt + 1}/${maxAttempts}`)
        }
      }
    }

    // Final failure
    completeExecution(execution.id, null)
    return {
      success: false,
      error: lastError?.message || 'Tool execution failed',
      executionId: execution.id
    }
  }
}

export {
  STATES,
  TRANSITIONS,
  createToolExecution,
  transitionState,
  startExecution,
  updateExecution,
  completeExecution,
  errorExecution,
  recoverExecution,
  getExecution,
  getAgentExecutions,
  getExecutionHistory,
  getStats,
  cleanupStaleExecutions,
  wrapToolWithStateMachine
}
