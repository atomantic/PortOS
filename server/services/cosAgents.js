/**
 * CoS Agents Module
 *
 * Agent lifecycle management extracted from cos.js.
 * Handles agent registration, state tracking, output capture,
 * date-bucketed archival, zombie cleanup, feedback, and index management.
 */

import { readFile, writeFile, rename, readdir, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { cosEvents } from './cosEvents.js'
import { emitLog } from './cosEvents.js'
import { loadState, saveState, withStateLock, AGENTS_DIR, ensureDirectories } from './cosState.js'
import { ensureDir, safeJSONParse } from '../lib/fileUtils.js'

const INDEX_FILE = join(AGENTS_DIR, 'index.json')

// Lightweight index mapping agentId → YYYY-MM-DD date bucket (~50KB vs 16MB full cache)
// Lazy-loaded from data/cos/agents/index.json on first access
let agentIndex = null
let agentIndexPromise = null

// Load agent index from disk (lazy init, singleton promise prevents concurrent migrations)
export async function loadAgentIndex() {
  if (agentIndex) return agentIndex
  if (agentIndexPromise) return agentIndexPromise

  agentIndexPromise = (async () => {
    if (!existsSync(AGENTS_DIR)) {
      await ensureDir(AGENTS_DIR)
    }

    if (existsSync(INDEX_FILE)) {
      const content = await readFile(INDEX_FILE, 'utf-8').catch(() => '{}')
      const parsed = safeJSONParse(content, {})
      agentIndex = new Map(Object.entries(parsed))
      console.log(`📂 Loaded agent index: ${agentIndex.size} entries`)
    } else {
      // No index yet — run migration from flat dirs to date buckets
      agentIndex = await migrateAgentsToDateBuckets()
    }

    return agentIndex
  })().catch(err => {
    agentIndexPromise = null
    throw err
  })

  return agentIndexPromise
}

// Persist agent index to disk (atomic write via temp file + rename)
async function saveAgentIndex() {
  if (!agentIndex) return
  const obj = Object.fromEntries(agentIndex)
  const tmpFile = `${INDEX_FILE}.tmp`
  await writeFile(tmpFile, JSON.stringify(obj)).catch(err => {
    console.error(`❌ Failed to save agent index: ${err.message}`)
  })
  await rename(tmpFile, INDEX_FILE).catch(err => {
    console.error(`❌ Failed to rename agent index: ${err.message}`)
  })
}

// Resolve the correct directory for an agent (running = flat, completed = date bucket)
function getAgentDir(agentId, dateString) {
  if (dateString) return join(AGENTS_DIR, dateString, agentId)
  // Check index for date bucket
  const date = agentIndex?.get(agentId)
  if (date) return join(AGENTS_DIR, date, agentId)
  // Fallback to flat dir (running agents or pre-migration)
  return join(AGENTS_DIR, agentId)
}

// Migrate flat agent-* directories into YYYY-MM-DD date buckets
// Runs once when index.json doesn't exist. Idempotent — no-op if already migrated.
async function migrateAgentsToDateBuckets() {
  const index = new Map()

  if (!existsSync(AGENTS_DIR)) {
    await ensureDir(AGENTS_DIR)
    await writeFile(INDEX_FILE, '{}')
    console.log('📂 Created empty agent index (no agents to migrate)')
    return index
  }

  const entries = await readdir(AGENTS_DIR, { withFileTypes: true })

  // Also scan existing date-bucket dirs to include them in the index
  const dateDirPattern = /^\d{4}-\d{2}-\d{2}$/
  for (const entry of entries) {
    if (!entry.isDirectory() || !dateDirPattern.test(entry.name)) continue
    const dateStr = entry.name
    const dateDir = join(AGENTS_DIR, dateStr)
    const agentDirs = await readdir(dateDir, { withFileTypes: true }).catch(() => [])
    for (const agentEntry of agentDirs) {
      if (agentEntry.isDirectory() && agentEntry.name.startsWith('agent-')) {
        index.set(agentEntry.name, dateStr)
      }
    }
  }

  // Find flat agent-* dirs that need migration
  const flatAgentDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('agent-'))

  if (flatAgentDirs.length === 0) {
    await writeFile(INDEX_FILE, JSON.stringify(Object.fromEntries(index)))
    console.log(`📂 Agent index built: ${index.size} entries (no flat dirs to migrate)`)
    return index
  }

  console.log(`📦 Migrating ${flatAgentDirs.length} agents into date buckets...`)
  let migrated = 0
  let skipped = 0

  for (const entry of flatAgentDirs) {
    const agentId = entry.name
    const agentDir = join(AGENTS_DIR, agentId)
    const metaPath = join(agentDir, 'metadata.json')

    let dateStr = null

    // Try to get date from metadata
    if (existsSync(metaPath)) {
      const content = await readFile(metaPath, 'utf-8').catch(() => null)
      if (content) {
        const raw = safeJSONParse(content, null)
        if (raw?.completedAt) {
          dateStr = raw.completedAt.slice(0, 10) // YYYY-MM-DD
        }
      }
    }

    // Fallback: directory mtime
    if (!dateStr) {
      const dirStat = await stat(agentDir).catch(() => null)
      if (dirStat?.mtime) {
        dateStr = dirStat.mtime.toISOString().slice(0, 10)
      }
    }

    if (!dateStr) {
      console.log(`⚠️ Cannot determine date for ${agentId}, skipping`)
      skipped++
      continue
    }

    // Move into date bucket
    const bucketDir = join(AGENTS_DIR, dateStr)
    await ensureDir(bucketDir)
    const targetDir = join(bucketDir, agentId)

    // If target already exists (partial previous migration), skip
    if (existsSync(targetDir)) {
      index.set(agentId, dateStr)
      migrated++
      continue
    }

    await rename(agentDir, targetDir).catch(async (renameErr) => {
      // rename can fail across filesystems — fall back to copy+delete
      console.log(`⚠️ Rename failed for ${agentId}, using copy: ${renameErr.message}`)
      try {
        await ensureDir(targetDir)
        const files = await readdir(agentDir)
        for (const file of files) {
          const content = await readFile(join(agentDir, file))
          await writeFile(join(targetDir, file), content)
        }
        await rm(agentDir, { recursive: true })
      } catch (copyErr) {
        console.error(`❌ Copy fallback failed for ${agentId}: ${copyErr.message}`)
        // Clean up partially-created target to avoid skipping on next startup
        await rm(targetDir, { recursive: true, force: true }).catch(() => {})
        throw copyErr
      }
    })

    index.set(agentId, dateStr)
    migrated++
  }

  // Persist index
  await writeFile(INDEX_FILE, JSON.stringify(Object.fromEntries(index)))
  const uniqueDates = new Set(index.values()).size
  const parts = [`📦 Migrated ${migrated} agents into date buckets (${uniqueDates} unique dates)`]
  if (skipped > 0) parts.push(`skipped ${skipped} undatable`)
  console.log(parts.join(', '))

  return index
}

// Prune agent archive date buckets older than retentionDays (default 90).
// Removes directories + their index entries. Runs after migration on startup.
export async function pruneOldAgentArchives(retentionDays = 90) {
  const idx = await loadAgentIndex()
  if (!idx || idx.size === 0) return

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - retentionDays)
  const cutoffStr = cutoff.toISOString().slice(0, 10)

  const dateDirPattern = /^\d{4}-\d{2}-\d{2}$/
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true }).catch(() => [])
  const oldDates = entries
    .filter(e => e.isDirectory() && dateDirPattern.test(e.name) && e.name < cutoffStr)
    .map(e => e.name)

  if (oldDates.length === 0) return

  let pruned = 0
  for (const dateStr of oldDates) {
    await rm(join(AGENTS_DIR, dateStr), { recursive: true }).catch(() => {})
    // Remove index entries for this date
    for (const [agentId, date] of idx.entries()) {
      if (date === dateStr) { idx.delete(agentId); pruned++ }
    }
  }

  await saveAgentIndex()
  console.log(`🗑️ Pruned ${pruned} archived agents older than ${retentionDays} days (${oldDates.length} date buckets)`)
}

export async function registerAgent(agentId, taskId, metadata = {}) {
  return withStateLock(async () => {
    const state = await loadState()

    state.agents[agentId] = {
      id: agentId,
      taskId,
      status: 'running',
      startedAt: new Date().toISOString(),
      metadata,
      output: []
    }

    state.stats.agentsSpawned++
    await saveState(state)

    cosEvents.emit('agent:spawned', state.agents[agentId])
    return state.agents[agentId]
  })
}

export async function updateAgent(agentId, updates) {
  return withStateLock(async () => {
    const state = await loadState()

    if (!state.agents[agentId]) {
      return null
    }

    // Merge metadata if present in updates
    if (updates.metadata) {
      state.agents[agentId] = {
        ...state.agents[agentId],
        ...updates,
        metadata: { ...state.agents[agentId].metadata, ...updates.metadata }
      }
    } else {
      state.agents[agentId] = { ...state.agents[agentId], ...updates }
    }
    await saveState(state)

    cosEvents.emit('agent:updated', state.agents[agentId])
    return state.agents[agentId]
  })
}

export async function completeAgent(agentId, result = {}) {
  return withStateLock(async () => {
    const state = await loadState()

    if (!state.agents[agentId]) {
      return null
    }

    state.agents[agentId] = {
      ...state.agents[agentId],
      status: 'completed',
      completedAt: new Date().toISOString(),
      result
    }

    if (result.success) {
      state.stats.tasksCompleted++
    } else {
      state.stats.errors = (state.stats.errors || 0) + 1
    }

    await saveState(state)
    cosEvents.emit('agent:completed', state.agents[agentId])
    cosEvents.emit('agent:updated', state.agents[agentId])

    // Determine date bucket from completedAt
    const dateStr = state.agents[agentId].completedAt.slice(0, 10)
    const bucketDir = join(AGENTS_DIR, dateStr)
    await ensureDir(bucketDir)

    // Write metadata to flat dir first (may already have output.txt/prompt.txt there)
    const flatDir = join(AGENTS_DIR, agentId)
    if (!existsSync(flatDir)) {
      await ensureDir(flatDir)
    }
    const { output: _output, ...agentWithoutOutput } = state.agents[agentId]
    await writeFile(join(flatDir, 'metadata.json'), JSON.stringify(agentWithoutOutput, null, 2))

    // Move entire agent dir into date bucket (atomic on same filesystem)
    const targetDir = join(bucketDir, agentId)
    if (!existsSync(targetDir)) {
      await rename(flatDir, targetDir).catch(async () => {
        // Fallback for cross-filesystem: copy files then remove
        await ensureDir(targetDir)
        const files = await readdir(flatDir)
        for (const file of files) {
          const content = await readFile(join(flatDir, file))
          await writeFile(join(targetDir, file), content)
        }
        await rm(flatDir, { recursive: true })
      })
    }

    // Update index
    const idx = await loadAgentIndex()
    idx.set(agentId, dateStr)
    await saveAgentIndex()

    return state.agents[agentId]
  })
}

export async function appendAgentOutput(agentId, line) {
  const result = await withStateLock(async () => {
    const state = await loadState()

    if (!state.agents[agentId]) {
      return null
    }

    state.agents[agentId].output.push({
      timestamp: new Date().toISOString(),
      line
    })

    // Trim to last 1000 lines in state
    if (state.agents[agentId].output.length > 1000) {
      state.agents[agentId].output = state.agents[agentId].output.slice(-1000)
    }

    await saveState(state)
    return state.agents[agentId]
  })

  if (result) {
    cosEvents.emit('agent:output', { agentId, line })
  }

  return result
}

// Get running agents from state (completed agents loaded on-demand via getAgentsByDate)
export async function getAgents() {
  const state = await loadState()
  return Object.values(state.agents)
}

// Get available agent date buckets with counts, sorted descending
export async function getAgentDates() {
  const idx = await loadAgentIndex()
  const dateCounts = {}
  for (const date of idx.values()) {
    dateCounts[date] = (dateCounts[date] || 0) + 1
  }
  return Object.entries(dateCounts)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => b.date.localeCompare(a.date))
}

// Get completed agents for a specific date bucket
export async function getAgentsByDate(date) {
  const dateDir = join(AGENTS_DIR, date)
  if (!existsSync(dateDir)) return []

  const entries = await readdir(dateDir, { withFileTypes: true })
  const agentDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('agent-'))
  const agents = []

  // Batch reads in chunks of 50 to avoid fd exhaustion on large date buckets
  const BATCH_SIZE = 50
  for (let i = 0; i < agentDirs.length; i += BATCH_SIZE) {
    const batch = agentDirs.slice(i, i + BATCH_SIZE)
    const reads = batch.map(async (entry) => {
      const metaPath = join(dateDir, entry.name, 'metadata.json')
      const content = await readFile(metaPath, 'utf-8').catch(() => null)
      if (!content) return
      const raw = safeJSONParse(content, null)
      if (!raw) return
      const id = raw.id || raw.agentId || entry.name
      const { output, ...rest } = raw
      agents.push({ ...rest, id, status: raw.status || 'completed' })
    })
    await Promise.allSettled(reads)
  }

  return agents.sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
}

// Get agent by ID with full output from file
export async function getAgent(agentId) {
  const state = await loadState()
  let agent = state.agents[agentId]

  // Fall back to disk metadata via index if not in state
  if (!agent) {
    const idx = await loadAgentIndex()
    const dateStr = idx.get(agentId)
    if (dateStr) {
      const metaPath = join(AGENTS_DIR, dateStr, agentId, 'metadata.json')
      const content = await readFile(metaPath, 'utf-8').catch(() => null)
      if (content) {
        const raw = safeJSONParse(content, null)
        if (raw) {
          const { output, ...rest } = raw
          agent = { ...rest, id: raw.id || raw.agentId || agentId, status: raw.status || 'completed' }
        }
      }
    }
  }
  if (!agent) return null

  // For completed agents, read full output from file
  if (agent.status === 'completed') {
    const dateStr = agent.completedAt?.slice(0, 10)
    const agentDir = dateStr ? getAgentDir(agentId, dateStr) : getAgentDir(agentId)
    const outputFile = join(agentDir, 'output.txt')
    if (existsSync(outputFile)) {
      const fullOutput = await readFile(outputFile, 'utf-8')
      const lines = fullOutput.split('\n').filter(line => line.trim())
      return {
        ...agent,
        output: lines.map(line => ({ line, timestamp: agent.completedAt }))
      }
    }
  }

  return agent
}

// Terminate an agent (will be handled by spawner)
export async function terminateAgent(agentId) {
  // Emit event to kill the process FIRST
  cosEvents.emit('agent:terminate', agentId)
  // The spawner will handle marking the agent as completed after termination
  return { success: true, agentId }
}

// Force kill an agent with SIGKILL (immediate, no graceful shutdown)
export async function killAgent(agentId) {
  const { killAgent: killAgentFromSpawner } = await import('./subAgentSpawner.js')
  return killAgentFromSpawner(agentId)
}

// Send a BTW (additional context) message to a running agent
export async function sendBtwToAgent(agentId, message) {
  // Single locked read to validate agent and extract workspacePath
  const agentInfo = await withStateLock(async () => {
    const state = await loadState()
    const agent = state.agents[agentId]
    if (!agent) return { error: 'Agent not found' }
    if (agent.status !== 'running') return { error: 'Agent is not running' }
    if (!agent.metadata?.workspacePath) return { error: 'Agent has no workspace path' }
    return { workspacePath: agent.metadata.workspacePath }
  })

  if (agentInfo.error) return agentInfo

  // Send to runner to write the BTW.md file
  const { sendBtwToAgent: sendViaRunner } = await import('./cosRunnerClient.js')
  const result = await sendViaRunner(agentId, message)

  // Track in agent state (cap at 50 messages)
  const timestamp = new Date().toISOString()
  await withStateLock(async () => {
    const state = await loadState()
    if (!state.agents[agentId]) return
    if (!state.agents[agentId].btwMessages) {
      state.agents[agentId].btwMessages = []
    }
    state.agents[agentId].btwMessages.push({ message, timestamp })
    if (state.agents[agentId].btwMessages.length > 50) {
      state.agents[agentId].btwMessages = state.agents[agentId].btwMessages.slice(-50)
    }
    await saveState(state)
  })

  cosEvents.emit('agent:btw', { agentId, message, timestamp })
  return { success: true, ...result }
}

// Get process stats for an agent (CPU, memory)
export async function getAgentProcessStats(agentId) {
  const { getAgentProcessStats: getStatsFromSpawner } = await import('./subAgentSpawner.js')
  return getStatsFromSpawner(agentId)
}

// Check if a PID is still running
async function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Cleanup zombie agents - agents marked as running but whose process is dead
export async function cleanupZombieAgents() {
  // Check local tracking maps
  const { getActiveAgentIds } = await import('./subAgentSpawner.js')
  const activeIds = getActiveAgentIds()

  // Also check with the CoS runner for agents it's actively tracking
  const { getActiveAgentsFromRunner } = await import('./cosRunnerClient.js')
  const runnerAgents = await getActiveAgentsFromRunner().catch(() => [])
  const runnerAgentIds = new Set(runnerAgents.map(a => a.id))

  return withStateLock(async () => {
    const state = await loadState()
    const runningAgents = Object.values(state.agents).filter(a => a.status === 'running')
    const cleaned = []

    for (const agent of runningAgents) {
      // Skip if tracked in local maps or runner
      if (activeIds.includes(agent.id) || runnerAgentIds.has(agent.id)) {
        continue
      }

      // If agent has a PID, verify the process is actually dead
      if (agent.pid) {
        const alive = await isPidAlive(agent.pid)
        if (alive) continue
      } else {
        // No PID yet - agent might still be initializing
        // Give it a 30 second grace period before marking as zombie
        const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : 0
        const ageMs = Date.now() - startedAt
        if (ageMs < 30000) continue
      }

      // Agent is not tracked anywhere and process is dead — it's a zombie
      console.log(`🧟 Zombie agent detected: ${agent.id} (PID ${agent.pid || 'unknown'} not running)`)
      state.agents[agent.id] = {
        ...agent,
        status: 'completed',
        completedAt: new Date().toISOString(),
        result: { success: false, error: 'Agent process terminated unexpectedly' }
      }
      cleaned.push(agent.id)
    }

    if (cleaned.length > 0) {
      await saveState(state)

      // Persist zombie-cleaned agents to date-bucketed dirs and update index
      const idx = await loadAgentIndex()
      for (const agentId of cleaned) {
        const agent = state.agents[agentId]
        const dateStr = agent.completedAt?.slice(0, 10)
        if (!dateStr) continue
        const bucketDir = join(AGENTS_DIR, dateStr)
        await ensureDir(bucketDir)

        const flatDir = join(AGENTS_DIR, agentId)
        const { output, ...agentWithoutOutput } = agent

        // Ensure metadata is written before move
        if (!existsSync(flatDir)) await ensureDir(flatDir)
        await writeFile(join(flatDir, 'metadata.json'), JSON.stringify(agentWithoutOutput, null, 2)).catch(() => {})

        // Move to date bucket
        const targetDir = join(bucketDir, agentId)
        if (!existsSync(targetDir)) {
          await rename(flatDir, targetDir).catch(async () => {
            await ensureDir(targetDir)
            const files = await readdir(flatDir)
            for (const file of files) {
              const content = await readFile(join(flatDir, file))
              await writeFile(join(targetDir, file), content)
            }
            await rm(flatDir, { recursive: true })
          })
        }

        idx.set(agentId, dateStr)
      }
      await saveAgentIndex()

      console.log(`🧹 Cleaned up ${cleaned.length} zombie agents: ${cleaned.join(', ')}`)
      cosEvents.emit('agents:changed', { action: 'zombie-cleanup', cleaned })
    }

    return { cleaned, count: cleaned.length }
  })
}

// Delete a single agent from state and disk
export async function deleteAgent(agentId) {
  return withStateLock(async () => {
    const state = await loadState()
    const idx = await loadAgentIndex()

    const inState = !!state.agents[agentId]
    const inIndex = idx.has(agentId)
    if (!inState && !inIndex) {
      return { error: 'Agent not found' }
    }

    delete state.agents[agentId]
    await saveState(state)

    // Remove from disk (date-bucketed or flat)
    const agentDir = getAgentDir(agentId)
    if (existsSync(agentDir)) {
      await rm(agentDir, { recursive: true }).catch(() => {})
    }

    // Remove from index
    idx.delete(agentId)
    await saveAgentIndex()

    cosEvents.emit('agents:changed', { action: 'deleted', agentId })
    return { success: true, agentId }
  })
}

// Submit feedback for a completed agent
export async function submitAgentFeedback(agentId, feedback) {
  return withStateLock(async () => {
    const state = await loadState()
    const feedbackData = {
      rating: feedback.rating,
      comment: feedback.comment || null,
      submittedAt: new Date().toISOString()
    }

    // Try state first (recently completed agents still in state)
    if (state.agents[agentId]) {
      const agent = state.agents[agentId]
      if (agent.status !== 'completed') {
        return { error: 'Can only submit feedback for completed agents' }
      }
      state.agents[agentId].feedback = feedbackData
      await saveState(state)

      // Also update on-disk metadata
      const agentDir = getAgentDir(agentId)
      const metaPath = join(agentDir, 'metadata.json')
      if (existsSync(metaPath)) {
        const content = await readFile(metaPath, 'utf-8').catch(() => null)
        if (content) {
          const raw = safeJSONParse(content, null)
          if (raw) {
            raw.feedback = feedbackData
            await writeFile(metaPath, JSON.stringify(raw, null, 2)).catch(() => {})
          }
        }
      }

      emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating })
      cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData })
      return { success: true, agent: state.agents[agentId] }
    }

    // Agent not in state — look up from disk via index
    const idx = await loadAgentIndex()
    const dateStr = idx.get(agentId)
    if (!dateStr) return { error: 'Agent not found' }

    const metaPath = join(AGENTS_DIR, dateStr, agentId, 'metadata.json')
    const content = await readFile(metaPath, 'utf-8').catch(() => null)
    if (!content) return { error: 'Agent not found' }

    const raw = safeJSONParse(content, null)
    if (!raw) return { error: 'Agent not found' }

    raw.feedback = feedbackData
    await writeFile(metaPath, JSON.stringify(raw, null, 2))

    emitLog('info', `Feedback received for agent ${agentId}: ${feedback.rating}`, { agentId, rating: feedback.rating })
    cosEvents.emit('agent:feedback', { agentId, feedback: feedbackData })
    return { success: true, agent: { ...raw, id: agentId } }
  })
}

// Get aggregated feedback statistics
export async function getFeedbackStats() {
  const state = await loadState()
  const agents = Object.values(state.agents)

  const withFeedback = agents.filter(a => a.feedback)
  const positive = withFeedback.filter(a => a.feedback.rating === 'positive').length
  const negative = withFeedback.filter(a => a.feedback.rating === 'negative').length
  const neutral = withFeedback.filter(a => a.feedback.rating === 'neutral').length

  // Group by task type
  const byTaskType = {}
  withFeedback.forEach(a => {
    const taskType = extractTaskType(a.metadata?.taskDescription)
    if (!byTaskType[taskType]) {
      byTaskType[taskType] = { positive: 0, negative: 0, neutral: 0, total: 0 }
    }
    byTaskType[taskType][a.feedback.rating]++
    byTaskType[taskType].total++
  })

  // Recent feedback (last 10 with comments)
  const recentWithComments = withFeedback
    .filter(a => a.feedback.comment)
    .sort((a, b) => new Date(b.feedback.submittedAt) - new Date(a.feedback.submittedAt))
    .slice(0, 10)
    .map(a => ({
      agentId: a.id,
      taskDescription: a.metadata?.taskDescription,
      rating: a.feedback.rating,
      comment: a.feedback.comment,
      submittedAt: a.feedback.submittedAt
    }))

  const satisfactionRate = withFeedback.length > 0
    ? Math.round((positive / withFeedback.length) * 100)
    : null

  return {
    total: withFeedback.length,
    positive,
    negative,
    neutral,
    satisfactionRate,
    byTaskType,
    recentWithComments
  }
}

// Helper to extract task type from description (mirrors client-side logic)
export function extractTaskType(description) {
  if (!description) return 'general'
  const d = description.toLowerCase()
  if (d.includes('fix') || d.includes('bug') || d.includes('error') || d.includes('issue')) return 'bug-fix'
  if (d.includes('refactor') || d.includes('clean up') || d.includes('improve') || d.includes('optimize')) return 'refactor'
  if (d.includes('test')) return 'testing'
  if (d.includes('document') || d.includes('readme') || d.includes('docs')) return 'documentation'
  if (d.includes('review') || d.includes('audit')) return 'code-review'
  if (d.includes('mobile') || d.includes('responsive')) return 'mobile-responsive'
  if (d.includes('security') || d.includes('vulnerability')) return 'security'
  if (d.includes('performance') || d.includes('speed')) return 'performance'
  if (d.includes('ui') || d.includes('ux') || d.includes('design') || d.includes('style')) return 'ui-ux'
  if (d.includes('api') || d.includes('endpoint') || d.includes('route')) return 'api'
  if (d.includes('database') || d.includes('migration')) return 'database'
  if (d.includes('deploy') || d.includes('ci') || d.includes('cd')) return 'devops'
  if (d.includes('investigate') || d.includes('debug')) return 'investigation'
  if (d.includes('self-improvement') || d.includes('feature idea')) return 'self-improvement'
  return 'feature'
}

// Archive stale completed agents from state.json.
// Completed agents are already persisted to per-agent metadata files on disk
// (metadata.json) by completeAgent(), so removing them from state.json only
// reduces the size of the in-memory state and the state.json file.
export async function archiveStaleAgents() {
  return withStateLock(async () => {
    const state = await loadState()
    const retentionMs = state.config.completedAgentRetentionMs ?? 86400000
    const cutoff = Date.now() - retentionMs

    const staleIds = Object.keys(state.agents).filter(id => {
      const agent = state.agents[id]
      if (agent.status !== 'completed') return false
      const completedAt = agent.completedAt ? new Date(agent.completedAt).getTime() : 0
      return completedAt > 0 && completedAt < cutoff
    })

    if (staleIds.length === 0) return { archived: 0 }

    const idx = await loadAgentIndex()

    for (const id of staleIds) {
      // Ensure agent is persisted to date-bucketed disk before removing from state
      if (!idx.has(id)) {
        const agent = state.agents[id]
        const dateStr = agent.completedAt?.slice(0, 10)
        if (!dateStr) continue
        const bucketDir = join(AGENTS_DIR, dateStr)
        await ensureDir(bucketDir)

        const { output, ...agentWithoutOutput } = agent
        const flatDir = join(AGENTS_DIR, id)
        const targetDir = join(bucketDir, id)

        if (existsSync(flatDir) && !existsSync(targetDir)) {
          // Write metadata then move (with cross-filesystem fallback)
          await writeFile(join(flatDir, 'metadata.json'), JSON.stringify(agentWithoutOutput, null, 2)).catch(() => {})
          await rename(flatDir, targetDir).catch(async () => {
            await ensureDir(targetDir)
            const files = await readdir(flatDir).catch(() => [])
            for (const file of files) {
              const content = await readFile(join(flatDir, file)).catch(() => null)
              if (content !== null) await writeFile(join(targetDir, file), content)
            }
            await rm(flatDir, { recursive: true }).catch(() => {})
          })
          if (!existsSync(targetDir)) continue // Skip index update if move failed
        } else if (!existsSync(targetDir)) {
          await ensureDir(targetDir)
          await writeFile(join(targetDir, 'metadata.json'), JSON.stringify(agentWithoutOutput, null, 2)).catch(() => {})
        }

        idx.set(id, dateStr)
      }

      delete state.agents[id]
    }

    await saveState(state)
    await saveAgentIndex()
    console.log(`📦 Archived ${staleIds.length} stale agents from state.json (retained on disk)`)
    cosEvents.emit('agents:changed', { action: 'auto-archive', archived: staleIds.length })
    return { archived: staleIds.length }
  })
}

// Clear completed agents from state, cache, and disk
export async function clearCompletedAgents() {
  return withStateLock(async () => {
    const state = await loadState()
    const idx = await loadAgentIndex()

    // Remove completed agents from state
    const stateCompleted = Object.keys(state.agents).filter(
      id => state.agents[id].status === 'completed'
    )
    for (const id of stateCompleted) {
      delete state.agents[id]
    }
    await saveState(state)

    // Collect all unique dates from index, then remove date bucket dirs
    const dates = new Set(idx.values())
    const totalCleared = idx.size + stateCompleted.filter(id => !idx.has(id)).length

    const removals = [...dates].map(date => {
      const dateDir = join(AGENTS_DIR, date)
      return existsSync(dateDir)
        ? rm(dateDir, { recursive: true }).catch(() => {})
        : Promise.resolve()
    })
    await Promise.all(removals)

    // Clear index
    idx.clear()
    await saveAgentIndex()

    return { cleared: totalCleared }
  })
}
