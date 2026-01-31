/**
 * Execution Lanes Service
 *
 * Lane-based concurrency control for agent execution.
 * Lanes: critical (1), standard (2), background (3)
 */

import { cosEvents } from './cos.js'

// Lane configuration
const LANES = {
  critical: {
    name: 'critical',
    maxConcurrent: 1,
    priority: 1,
    description: 'High-priority user tasks, blocking operations'
  },
  standard: {
    name: 'standard',
    maxConcurrent: 2,
    priority: 2,
    description: 'Normal task execution'
  },
  background: {
    name: 'background',
    maxConcurrent: 3,
    priority: 3,
    description: 'Self-improvement, idle work, non-urgent tasks'
  }
}

// Lane occupancy tracking
const laneOccupancy = {
  critical: new Map(),  // agentId -> { taskId, startedAt, metadata }
  standard: new Map(),
  background: new Map()
}

// Queue for tasks waiting for lane availability
const waitingQueue = {
  critical: [],
  standard: [],
  background: []
}

// Statistics
const stats = {
  acquired: 0,
  released: 0,
  queued: 0,
  timeouts: 0,
  promotions: 0
}

/**
 * Get lane by name or determine from task priority
 * @param {string|Object} laneOrTask - Lane name or task object
 * @returns {string} - Lane name
 */
function determineLane(laneOrTask) {
  if (typeof laneOrTask === 'string') {
    return LANES[laneOrTask] ? laneOrTask : 'standard'
  }

  const task = laneOrTask
  const priority = task?.priority?.toUpperCase()

  switch (priority) {
    case 'URGENT':
    case 'CRITICAL':
      return 'critical'
    case 'HIGH':
    case 'MEDIUM':
      return 'standard'
    case 'LOW':
    case 'IDLE':
      return 'background'
    default:
      return task?.metadata?.isUserTask ? 'standard' : 'background'
  }
}

/**
 * Check if a lane has available capacity
 * @param {string} laneName - Lane name
 * @returns {boolean} - True if capacity available
 */
function hasCapacity(laneName) {
  const lane = LANES[laneName]
  if (!lane) return false

  const occupancy = laneOccupancy[laneName]
  return occupancy.size < lane.maxConcurrent
}

/**
 * Get current lane status
 * @param {string} laneName - Lane name
 * @returns {Object} - Lane status
 */
function getLaneStatus(laneName) {
  const lane = LANES[laneName]
  if (!lane) return null

  const occupancy = laneOccupancy[laneName]
  const queue = waitingQueue[laneName]

  return {
    name: lane.name,
    maxConcurrent: lane.maxConcurrent,
    currentOccupancy: occupancy.size,
    available: lane.maxConcurrent - occupancy.size,
    queueLength: queue.length,
    occupants: Array.from(occupancy.entries()).map(([agentId, data]) => ({
      agentId,
      taskId: data.taskId,
      startedAt: data.startedAt,
      runningMs: Date.now() - data.startedAt
    }))
  }
}

/**
 * Acquire a slot in a lane
 * @param {string} laneName - Lane name
 * @param {string} agentId - Agent identifier
 * @param {Object} metadata - Additional metadata (taskId, etc.)
 * @returns {Object} - Acquisition result
 */
function acquire(laneName, agentId, metadata = {}) {
  const lane = LANES[laneName]
  if (!lane) {
    return { success: false, error: `Unknown lane: ${laneName}` }
  }

  const occupancy = laneOccupancy[laneName]

  // Check if already in this lane
  if (occupancy.has(agentId)) {
    return { success: true, alreadyAcquired: true, lane: laneName }
  }

  // Check capacity
  if (occupancy.size >= lane.maxConcurrent) {
    return {
      success: false,
      error: 'Lane at capacity',
      lane: laneName,
      currentOccupancy: occupancy.size,
      maxConcurrent: lane.maxConcurrent
    }
  }

  // Acquire slot
  occupancy.set(agentId, {
    taskId: metadata.taskId,
    startedAt: Date.now(),
    metadata
  })

  stats.acquired++

  cosEvents.emit('lane:acquired', {
    lane: laneName,
    agentId,
    taskId: metadata.taskId,
    occupancy: occupancy.size
  })

  console.log(`🛤️ Lane acquired: ${agentId} → ${laneName} (${occupancy.size}/${lane.maxConcurrent})`)

  return {
    success: true,
    lane: laneName,
    position: occupancy.size
  }
}

/**
 * Release a lane slot
 * @param {string} agentId - Agent identifier
 * @returns {Object} - Release result
 */
function release(agentId) {
  for (const [laneName, occupancy] of Object.entries(laneOccupancy)) {
    if (occupancy.has(agentId)) {
      const data = occupancy.get(agentId)
      occupancy.delete(agentId)

      stats.released++

      const runningMs = Date.now() - data.startedAt

      cosEvents.emit('lane:released', {
        lane: laneName,
        agentId,
        taskId: data.taskId,
        runningMs,
        occupancy: occupancy.size
      })

      console.log(`🛤️ Lane released: ${agentId} ← ${laneName} (ran ${runningMs}ms)`)

      // Process waiting queue for this lane
      processWaitingQueue(laneName)

      return {
        success: true,
        lane: laneName,
        runningMs
      }
    }
  }

  return { success: false, error: 'Agent not in any lane' }
}

/**
 * Wait for lane availability (with timeout)
 * @param {string} laneName - Lane name
 * @param {string} agentId - Agent identifier
 * @param {Object} options - Wait options
 * @returns {Promise<Object>} - Acquisition result
 */
async function waitForLane(laneName, agentId, options = {}) {
  const { timeoutMs = 60000, metadata = {} } = options

  // Try immediate acquisition
  const immediate = acquire(laneName, agentId, metadata)
  if (immediate.success) return immediate

  // Add to waiting queue
  return new Promise((resolve) => {
    const queueEntry = {
      agentId,
      metadata,
      resolve,
      enqueuedAt: Date.now()
    }

    waitingQueue[laneName].push(queueEntry)
    stats.queued++

    console.log(`⏳ Queued for lane: ${agentId} → ${laneName} (position ${waitingQueue[laneName].length})`)

    // Set timeout
    const timeoutId = setTimeout(() => {
      const idx = waitingQueue[laneName].indexOf(queueEntry)
      if (idx !== -1) {
        waitingQueue[laneName].splice(idx, 1)
        stats.timeouts++
        resolve({
          success: false,
          error: 'Lane wait timeout',
          lane: laneName,
          waitedMs: timeoutMs
        })
      }
    }, timeoutMs)

    queueEntry.timeoutId = timeoutId
  })
}

/**
 * Process waiting queue when a lane slot becomes available
 * @param {string} laneName - Lane name
 */
function processWaitingQueue(laneName) {
  const queue = waitingQueue[laneName]
  if (queue.length === 0) return

  const lane = LANES[laneName]
  const occupancy = laneOccupancy[laneName]

  while (queue.length > 0 && occupancy.size < lane.maxConcurrent) {
    const entry = queue.shift()
    clearTimeout(entry.timeoutId)

    const result = acquire(laneName, entry.agentId, entry.metadata)
    if (result.success) {
      result.waitedMs = Date.now() - entry.enqueuedAt
      entry.resolve(result)
    } else {
      // Failed to acquire despite capacity - shouldn't happen
      entry.resolve(result)
    }
  }
}

/**
 * Promote a task to a higher priority lane
 * @param {string} agentId - Agent identifier
 * @param {string} targetLane - Target lane (must be higher priority)
 * @returns {Object} - Promotion result
 */
function promote(agentId, targetLane) {
  const targetLaneConfig = LANES[targetLane]
  if (!targetLaneConfig) {
    return { success: false, error: `Unknown lane: ${targetLane}` }
  }

  // Find current lane
  let currentLane = null
  for (const [laneName, occupancy] of Object.entries(laneOccupancy)) {
    if (occupancy.has(agentId)) {
      currentLane = laneName
      break
    }
  }

  if (!currentLane) {
    return { success: false, error: 'Agent not in any lane' }
  }

  // Check if promotion makes sense
  if (LANES[currentLane].priority <= targetLaneConfig.priority) {
    return { success: false, error: 'Target lane is not higher priority' }
  }

  // Check target capacity
  if (!hasCapacity(targetLane)) {
    return { success: false, error: 'Target lane at capacity' }
  }

  // Move agent
  const data = laneOccupancy[currentLane].get(agentId)
  laneOccupancy[currentLane].delete(agentId)
  laneOccupancy[targetLane].set(agentId, data)

  stats.promotions++

  console.log(`⬆️ Lane promotion: ${agentId} ${currentLane} → ${targetLane}`)

  // Process queue for old lane
  processWaitingQueue(currentLane)

  return {
    success: true,
    fromLane: currentLane,
    toLane: targetLane
  }
}

/**
 * Get overall lane statistics
 * @returns {Object} - Lane statistics
 */
function getStats() {
  const laneStats = {}

  for (const laneName of Object.keys(LANES)) {
    laneStats[laneName] = getLaneStatus(laneName)
  }

  const totalOccupancy = Object.values(laneOccupancy)
    .reduce((sum, map) => sum + map.size, 0)
  const totalCapacity = Object.values(LANES)
    .reduce((sum, lane) => sum + lane.maxConcurrent, 0)
  const totalQueued = Object.values(waitingQueue)
    .reduce((sum, queue) => sum + queue.length, 0)

  return {
    lanes: laneStats,
    totalOccupancy,
    totalCapacity,
    utilizationPercent: ((totalOccupancy / totalCapacity) * 100).toFixed(1) + '%',
    totalQueued,
    ...stats
  }
}

/**
 * Get agent's current lane
 * @param {string} agentId - Agent identifier
 * @returns {string|null} - Lane name or null
 */
function getAgentLane(agentId) {
  for (const [laneName, occupancy] of Object.entries(laneOccupancy)) {
    if (occupancy.has(agentId)) {
      return laneName
    }
  }
  return null
}

/**
 * Force release all agents from a lane (for emergencies)
 * @param {string} laneName - Lane name
 * @returns {number} - Number of agents released
 */
function clearLane(laneName) {
  const occupancy = laneOccupancy[laneName]
  if (!occupancy) return 0

  const count = occupancy.size
  const agents = Array.from(occupancy.keys())

  for (const agentId of agents) {
    release(agentId)
  }

  console.log(`🧹 Cleared lane ${laneName}: ${count} agents`)
  return count
}

/**
 * Update lane configuration dynamically
 * @param {string} laneName - Lane name
 * @param {Object} config - New configuration
 * @returns {Object} - Updated lane config
 */
function updateLaneConfig(laneName, config) {
  const lane = LANES[laneName]
  if (!lane) return null

  if (config.maxConcurrent !== undefined) {
    lane.maxConcurrent = config.maxConcurrent

    // Process queue if we increased capacity
    processWaitingQueue(laneName)
  }

  return { ...lane }
}

export {
  LANES,
  determineLane,
  hasCapacity,
  getLaneStatus,
  acquire,
  release,
  waitForLane,
  promote,
  getStats,
  getAgentLane,
  clearLane,
  updateLaneConfig
}
