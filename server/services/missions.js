/**
 * Missions Service
 *
 * Long-term goals with sub-tasks and app ownership.
 * Enables proactive task generation when user queue is empty.
 */

import { promises as fs } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import { cosEvents } from './cosEvents.js'
import { safeJSONParse } from '../lib/fileUtils.js'

const DATA_DIR = path.join(process.cwd(), 'data', 'cos', 'missions')

// In-memory cache
let missionsCache = null

/**
 * Ensure data directory exists
 */
async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true })
}

/**
 * Load all missions
 * @returns {Promise<Array>} - All missions
 */
async function loadMissions() {
  if (missionsCache) return missionsCache

  await ensureDataDir()

  const files = await fs.readdir(DATA_DIR).catch(() => [])
  const missions = []

  for (const file of files) {
    if (!file.endsWith('.json')) continue

    const filePath = path.join(DATA_DIR, file)
    const content = await fs.readFile(filePath, 'utf-8').catch(() => null)
    if (content) {
      const mission = safeJSONParse(content, null, { context: `mission:${file}` })
      if (mission) missions.push(mission)
    }
  }

  missionsCache = missions
  return missions
}

/**
 * Save a mission to disk
 * @param {Object} mission - Mission object
 */
async function saveMission(mission) {
  await ensureDataDir()
  const filePath = path.join(DATA_DIR, `${mission.id}.json`)
  await fs.writeFile(filePath, JSON.stringify(mission, null, 2))

  // Update cache
  if (missionsCache) {
    const idx = missionsCache.findIndex(m => m.id === mission.id)
    if (idx !== -1) {
      missionsCache[idx] = mission
    } else {
      missionsCache.push(mission)
    }
  }
}

/**
 * Create a new mission
 * @param {Object} data - Mission data
 * @returns {Promise<Object>} - Created mission
 */
async function createMission(data) {
  const now = new Date().toISOString()

  const mission = {
    id: data.id || uuidv4(),
    appId: data.appId,
    name: data.name,
    description: data.description || '',
    goals: data.goals || [],
    subTasks: data.subTasks || [],
    progress: 0,
    status: 'active', // active, paused, completed, archived
    priority: data.priority || 'medium',
    autonomyLevel: data.autonomyLevel || 'full', // full, notify, approval-required
    createdAt: now,
    updatedAt: now,
    lastReviewedAt: null,
    completedAt: null,
    metrics: {
      tasksGenerated: 0,
      tasksCompleted: 0,
      successRate: 0
    }
  }

  await saveMission(mission)

  console.log(`🎯 Mission created: ${mission.name} (${mission.appId})`)
  cosEvents.emit('mission:created', { id: mission.id, appId: mission.appId })

  return mission
}

/**
 * Get mission by ID
 * @param {string} id - Mission ID
 * @returns {Promise<Object|null>} - Mission or null
 */
async function getMission(id) {
  const missions = await loadMissions()
  return missions.find(m => m.id === id) || null
}

/**
 * Get missions for an app
 * @param {string} appId - App identifier
 * @returns {Promise<Array>} - App missions
 */
async function getMissionsForApp(appId) {
  const missions = await loadMissions()
  return missions.filter(m => m.appId === appId && m.status === 'active')
}

/**
 * Get all active missions
 * @returns {Promise<Array>} - Active missions
 */
async function getActiveMissions() {
  const missions = await loadMissions()
  return missions.filter(m => m.status === 'active')
}

/**
 * Update a mission
 * @param {string} id - Mission ID
 * @param {Object} updates - Updates to apply
 * @returns {Promise<Object|null>} - Updated mission or null
 */
async function updateMission(id, updates) {
  const mission = await getMission(id)
  if (!mission) return null

  const updatableFields = [
    'name', 'description', 'goals', 'subTasks', 'progress',
    'status', 'priority', 'autonomyLevel', 'lastReviewedAt',
    'completedAt', 'metrics'
  ]

  for (const field of updatableFields) {
    if (updates[field] !== undefined) {
      mission[field] = updates[field]
    }
  }

  mission.updatedAt = new Date().toISOString()
  await saveMission(mission)

  cosEvents.emit('mission:updated', { id: mission.id, updates })
  return mission
}

/**
 * Add a sub-task to a mission
 * @param {string} missionId - Mission ID
 * @param {Object} subTask - Sub-task data
 * @returns {Promise<Object|null>} - Updated mission or null
 */
async function addSubTask(missionId, subTask) {
  const mission = await getMission(missionId)
  if (!mission) return null

  const task = {
    id: uuidv4(),
    description: subTask.description,
    status: 'pending', // pending, in_progress, completed, failed
    priority: subTask.priority || 'medium',
    createdAt: new Date().toISOString(),
    completedAt: null,
    result: null
  }

  mission.subTasks.push(task)
  mission.metrics.tasksGenerated++
  mission.updatedAt = new Date().toISOString()

  await saveMission(mission)
  return mission
}

/**
 * Complete a sub-task
 * @param {string} missionId - Mission ID
 * @param {string} subTaskId - Sub-task ID
 * @param {Object} result - Task result
 * @returns {Promise<Object|null>} - Updated mission or null
 */
async function completeSubTask(missionId, subTaskId, result = {}) {
  const mission = await getMission(missionId)
  if (!mission) return null

  const subTask = mission.subTasks.find(t => t.id === subTaskId)
  if (!subTask) return null

  subTask.status = result.success === false ? 'failed' : 'completed'
  subTask.completedAt = new Date().toISOString()
  subTask.result = result

  // Update metrics
  if (subTask.status === 'completed') {
    mission.metrics.tasksCompleted++
  }
  mission.metrics.successRate = mission.metrics.tasksGenerated > 0
    ? (mission.metrics.tasksCompleted / mission.metrics.tasksGenerated) * 100
    : 0

  // Calculate progress
  const completed = mission.subTasks.filter(t => t.status === 'completed').length
  const total = mission.subTasks.length
  mission.progress = total > 0 ? (completed / total) * 100 : 0

  // Check if mission is complete
  if (mission.progress >= 100 && mission.goals.length > 0) {
    mission.status = 'completed'
    mission.completedAt = new Date().toISOString()
    console.log(`🎉 Mission completed: ${mission.name}`)
    cosEvents.emit('mission:completed', { id: mission.id })
  }

  mission.updatedAt = new Date().toISOString()
  await saveMission(mission)

  return mission
}

/**
 * Generate a task from a mission (for proactive execution)
 * @param {string} missionId - Mission ID
 * @returns {Promise<Object|null>} - Generated task or null
 */
async function generateMissionTask(missionId) {
  const mission = await getMission(missionId)
  if (!mission || mission.status !== 'active') return null

  // Find pending sub-tasks
  const pendingSubTasks = mission.subTasks.filter(t => t.status === 'pending')

  if (pendingSubTasks.length > 0) {
    // Return first pending sub-task as a COS task
    const subTask = pendingSubTasks[0]
    subTask.status = 'in_progress'
    await saveMission(mission)

    return {
      id: `mission-${mission.id}-${subTask.id}`,
      description: subTask.description,
      metadata: {
        missionId: mission.id,
        missionName: mission.name,
        subTaskId: subTask.id,
        appId: mission.appId,
        autonomyLevel: mission.autonomyLevel,
        isMissionTask: true
      },
      priority: subTask.priority,
      autoApprove: mission.autonomyLevel === 'full'
    }
  }

  // No pending sub-tasks - might need to generate new ones based on goals
  // This would typically involve AI analysis of the mission goals
  return null
}

/**
 * Generate proactive tasks from all active missions
 * @param {Object} options - Generation options
 * @returns {Promise<Array>} - Generated tasks
 */
async function generateProactiveTasks(options = {}) {
  const { maxTasks = 3 } = options
  const missions = await getActiveMissions()
  const tasks = []

  for (const mission of missions) {
    if (tasks.length >= maxTasks) break

    // Skip recently reviewed missions
    if (mission.lastReviewedAt) {
      const lastReview = new Date(mission.lastReviewedAt).getTime()
      const hoursSinceReview = (Date.now() - lastReview) / (1000 * 60 * 60)
      if (hoursSinceReview < 1) continue // Wait at least 1 hour between reviews
    }

    const task = await generateMissionTask(mission.id)
    if (task) {
      tasks.push(task)
    }
  }

  return tasks
}

/**
 * Record mission review (updates lastReviewedAt)
 * @param {string} missionId - Mission ID
 * @returns {Promise<Object|null>} - Updated mission or null
 */
async function recordMissionReview(missionId) {
  return updateMission(missionId, {
    lastReviewedAt: new Date().toISOString()
  })
}

/**
 * Get mission statistics
 * @returns {Promise<Object>} - Mission statistics
 */
async function getStats() {
  const missions = await loadMissions()

  const byStatus = {}
  let totalProgress = 0
  let totalTasks = 0
  let completedTasks = 0

  for (const mission of missions) {
    byStatus[mission.status] = (byStatus[mission.status] || 0) + 1
    totalProgress += mission.progress
    totalTasks += mission.subTasks.length
    completedTasks += mission.subTasks.filter(t => t.status === 'completed').length
  }

  return {
    totalMissions: missions.length,
    byStatus,
    averageProgress: missions.length > 0
      ? (totalProgress / missions.length).toFixed(1) + '%'
      : '0%',
    totalSubTasks: totalTasks,
    completedSubTasks: completedTasks,
    overallCompletion: totalTasks > 0
      ? ((completedTasks / totalTasks) * 100).toFixed(1) + '%'
      : '0%'
  }
}

/**
 * Delete a mission
 * @param {string} id - Mission ID
 * @returns {Promise<boolean>} - True if deleted
 */
async function deleteMission(id) {
  const filePath = path.join(DATA_DIR, `${id}.json`)
  await fs.unlink(filePath).catch(() => {})

  if (missionsCache) {
    missionsCache = missionsCache.filter(m => m.id !== id)
  }

  console.log(`🗑️ Mission deleted: ${id}`)
  cosEvents.emit('mission:deleted', { id })
  return true
}

/**
 * Archive completed missions
 * @returns {Promise<number>} - Number of missions archived
 */
async function archiveCompletedMissions() {
  const missions = await loadMissions()
  let archived = 0

  for (const mission of missions) {
    if (mission.status === 'completed' && mission.completedAt) {
      const completedDate = new Date(mission.completedAt).getTime()
      const daysSinceCompletion = (Date.now() - completedDate) / (1000 * 60 * 60 * 24)

      if (daysSinceCompletion > 7) {
        await updateMission(mission.id, { status: 'archived' })
        archived++
      }
    }
  }

  if (archived > 0) {
    console.log(`📦 Archived ${archived} completed missions`)
  }

  return archived
}

/**
 * Invalidate cache (call after external changes)
 */
function invalidateCache() {
  missionsCache = null
}

export {
  createMission,
  getMission,
  getMissionsForApp,
  getActiveMissions,
  updateMission,
  addSubTask,
  completeSubTask,
  generateMissionTask,
  generateProactiveTasks,
  recordMissionReview,
  getStats,
  deleteMission,
  archiveCompletedMissions,
  invalidateCache
}
