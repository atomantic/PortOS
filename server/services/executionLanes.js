/**
 * Execution Lanes Service
 *
 * Lane-based tagging for agent execution (priority/observability only).
 * Lanes carry priority intent — they no longer gate concurrency.
 * Global slot caps and per-app caps live in cos.js (`maxConcurrentAgents`,
 * `maxConcurrentAgentsPerProject`); duplicating them here was shadowing the
 * user-configurable limits and is gone.
 */

import { cosEvents } from './cosEvents.js'

const LANES = {
  critical: {
    name: 'critical',
    priority: 1,
    description: 'High-priority user tasks, blocking operations'
  },
  standard: {
    name: 'standard',
    priority: 2,
    description: 'Normal task execution'
  },
  background: {
    name: 'background',
    priority: 3,
    description: 'Self-improvement, idle work, non-urgent tasks'
  }
}

const laneOccupancy = {
  critical: new Map(),  // agentId -> { taskId, startedAt, metadata }
  standard: new Map(),
  background: new Map()
}

const stats = {
  acquired: 0,
  released: 0,
  promotions: 0
}

/**
 * Get lane by name or determine from task priority.
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
 * Get current lane status (occupancy snapshot for observability).
 * @param {string} laneName - Lane name
 * @returns {Object|null}
 */
function getLaneStatus(laneName) {
  const lane = LANES[laneName]
  if (!lane) return null

  const occupancy = laneOccupancy[laneName]

  return {
    name: lane.name,
    priority: lane.priority,
    currentOccupancy: occupancy.size,
    occupants: Array.from(occupancy.entries()).map(([agentId, data]) => ({
      agentId,
      taskId: data.taskId,
      startedAt: data.startedAt,
      runningMs: Date.now() - data.startedAt
    }))
  }
}

/**
 * Tag an agent with a lane. Always succeeds for known lanes — capacity
 * gating happens upstream in cos.js, not here.
 */
function acquire(laneName, agentId, metadata = {}) {
  const lane = LANES[laneName]
  if (!lane) {
    return { success: false, error: `Unknown lane: ${laneName}` }
  }

  const occupancy = laneOccupancy[laneName]

  if (occupancy.has(agentId)) {
    return { success: true, alreadyAcquired: true, lane: laneName }
  }

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

  console.log(`🛤️ Lane acquired: ${agentId} → ${laneName} (${occupancy.size})`)

  return { success: true, lane: laneName }
}

/**
 * Release an agent's lane tag.
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

      return { success: true, lane: laneName, runningMs }
    }
  }

  return { success: false, error: 'Agent not in any lane' }
}

/**
 * Re-tag an agent into a higher-priority lane.
 */
function promote(agentId, targetLane) {
  const targetLaneConfig = LANES[targetLane]
  if (!targetLaneConfig) {
    return { success: false, error: `Unknown lane: ${targetLane}` }
  }

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

  if (LANES[currentLane].priority <= targetLaneConfig.priority) {
    return { success: false, error: 'Target lane is not higher priority' }
  }

  const data = laneOccupancy[currentLane].get(agentId)
  laneOccupancy[currentLane].delete(agentId)
  laneOccupancy[targetLane].set(agentId, data)

  stats.promotions++

  console.log(`⬆️ Lane promotion: ${agentId} ${currentLane} → ${targetLane}`)

  return { success: true, fromLane: currentLane, toLane: targetLane }
}

/**
 * Aggregate lane statistics for observability.
 */
function getStats() {
  const laneStats = {}
  for (const laneName of Object.keys(LANES)) {
    laneStats[laneName] = getLaneStatus(laneName)
  }

  const totalOccupancy = Object.values(laneOccupancy)
    .reduce((sum, map) => sum + map.size, 0)

  return {
    lanes: laneStats,
    totalOccupancy,
    ...stats
  }
}

function getAgentLane(agentId) {
  for (const [laneName, occupancy] of Object.entries(laneOccupancy)) {
    if (occupancy.has(agentId)) {
      return laneName
    }
  }
  return null
}

/**
 * Force-release every agent from a lane (test/recovery helper).
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

export {
  LANES,
  determineLane,
  getLaneStatus,
  acquire,
  release,
  promote,
  getStats,
  getAgentLane,
  clearLane
}
