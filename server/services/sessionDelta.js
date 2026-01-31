/**
 * Session Delta Tracker
 *
 * Tracks changes (deltas) within agent sessions for efficient memory and context updates.
 * Inspired by OpenClaw's session delta tracking pattern.
 *
 * Tracks per session:
 * - pendingBytes: Bytes of data pending processing
 * - pendingMessages: Count of messages pending processing
 * - newMemories: Memories created this session
 * - modifiedMemories: Memories updated this session
 * - toolCalls: Tool calls made this session
 */

// In-memory session delta storage
const sessions = new Map()

// Session TTL (2 hours)
const SESSION_TTL_MS = 2 * 60 * 60 * 1000

// Cleanup interval (15 minutes)
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000

let cleanupTimer = null

/**
 * Create a new session delta tracker
 * @returns {Object} - Fresh session delta object
 */
function createSessionDelta() {
  return {
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    pendingBytes: 0,
    pendingMessages: 0,
    processedBytes: 0,
    processedMessages: 0,
    newMemories: [],
    modifiedMemories: [],
    toolCalls: [],
    events: []
  }
}

/**
 * Get or create session delta
 * @param {string} sessionId - Session identifier (usually agentId)
 * @returns {Object} - Session delta object
 */
function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSessionDelta())
  }
  const session = sessions.get(sessionId)
  session.lastActivityAt = Date.now()
  return session
}

/**
 * Add pending bytes to session
 * @param {string} sessionId - Session ID
 * @param {number} bytes - Bytes to add
 */
function addPendingBytes(sessionId, bytes) {
  const session = getSession(sessionId)
  session.pendingBytes += bytes
  session.pendingMessages++
}

/**
 * Mark bytes as processed
 * @param {string} sessionId - Session ID
 * @param {number} bytes - Bytes processed
 */
function markBytesProcessed(sessionId, bytes) {
  const session = getSession(sessionId)
  session.pendingBytes = Math.max(0, session.pendingBytes - bytes)
  session.pendingMessages = Math.max(0, session.pendingMessages - 1)
  session.processedBytes += bytes
  session.processedMessages++
}

/**
 * Record a new memory created in this session
 * @param {string} sessionId - Session ID
 * @param {string} memoryId - Memory ID
 * @param {string} type - Memory type
 */
function recordNewMemory(sessionId, memoryId, type) {
  const session = getSession(sessionId)
  session.newMemories.push({
    id: memoryId,
    type,
    createdAt: Date.now()
  })
}

/**
 * Record a memory modification in this session
 * @param {string} sessionId - Session ID
 * @param {string} memoryId - Memory ID
 * @param {string} changeType - Type of change (update, archive, etc.)
 */
function recordModifiedMemory(sessionId, memoryId, changeType) {
  const session = getSession(sessionId)
  session.modifiedMemories.push({
    id: memoryId,
    changeType,
    modifiedAt: Date.now()
  })
}

/**
 * Record a tool call in this session
 * @param {string} sessionId - Session ID
 * @param {string} toolName - Name of tool called
 * @param {Object} metadata - Optional metadata about the call
 */
function recordToolCall(sessionId, toolName, metadata = {}) {
  const session = getSession(sessionId)
  session.toolCalls.push({
    tool: toolName,
    calledAt: Date.now(),
    ...metadata
  })
}

/**
 * Record a custom event in this session
 * @param {string} sessionId - Session ID
 * @param {string} eventType - Event type
 * @param {Object} data - Event data
 */
function recordEvent(sessionId, eventType, data = {}) {
  const session = getSession(sessionId)
  session.events.push({
    type: eventType,
    timestamp: Date.now(),
    data
  })
}

/**
 * Get session summary
 * @param {string} sessionId - Session ID
 * @returns {Object} - Session summary
 */
function getSessionSummary(sessionId) {
  if (!sessions.has(sessionId)) {
    return null
  }

  const session = sessions.get(sessionId)
  return {
    sessionId,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    durationMs: session.lastActivityAt - session.createdAt,
    pending: {
      bytes: session.pendingBytes,
      messages: session.pendingMessages
    },
    processed: {
      bytes: session.processedBytes,
      messages: session.processedMessages
    },
    memories: {
      new: session.newMemories.length,
      modified: session.modifiedMemories.length
    },
    toolCalls: session.toolCalls.length,
    events: session.events.length
  }
}

/**
 * Get all pending data for a session
 * @param {string} sessionId - Session ID
 * @returns {Object} - Pending data
 */
function getPendingDelta(sessionId) {
  if (!sessions.has(sessionId)) {
    return { bytes: 0, messages: 0 }
  }

  const session = sessions.get(sessionId)
  return {
    bytes: session.pendingBytes,
    messages: session.pendingMessages
  }
}

/**
 * Get memories created in this session
 * @param {string} sessionId - Session ID
 * @returns {Array} - New memory references
 */
function getNewMemories(sessionId) {
  if (!sessions.has(sessionId)) return []
  return [...sessions.get(sessionId).newMemories]
}

/**
 * Get tool call history for this session
 * @param {string} sessionId - Session ID
 * @returns {Array} - Tool calls
 */
function getToolCalls(sessionId) {
  if (!sessions.has(sessionId)) return []
  return [...sessions.get(sessionId).toolCalls]
}

/**
 * End a session and return final summary
 * @param {string} sessionId - Session ID
 * @returns {Object} - Final session summary
 */
function endSession(sessionId) {
  const summary = getSessionSummary(sessionId)
  sessions.delete(sessionId)
  return summary
}

/**
 * Clean up expired sessions
 * @returns {number} - Number of sessions cleaned up
 */
function cleanupExpiredSessions() {
  const now = Date.now()
  let cleaned = 0

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      sessions.delete(sessionId)
      cleaned++
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Cleaned up ${cleaned} expired session deltas`)
  }

  return cleaned
}

/**
 * Start periodic cleanup
 */
function startCleanupTimer() {
  if (cleanupTimer) return

  cleanupTimer = setInterval(() => {
    cleanupExpiredSessions()
  }, CLEANUP_INTERVAL_MS)

  // Don't prevent process exit
  cleanupTimer.unref()
}

/**
 * Stop periodic cleanup
 */
function stopCleanupTimer() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer)
    cleanupTimer = null
  }
}

/**
 * Get all active sessions
 * @returns {Array<string>} - Active session IDs
 */
function getActiveSessions() {
  return Array.from(sessions.keys())
}

/**
 * Get total stats across all sessions
 * @returns {Object} - Aggregate statistics
 */
function getGlobalStats() {
  let totalPendingBytes = 0
  let totalPendingMessages = 0
  let totalProcessedBytes = 0
  let totalProcessedMessages = 0
  let totalNewMemories = 0
  let totalToolCalls = 0

  for (const session of sessions.values()) {
    totalPendingBytes += session.pendingBytes
    totalPendingMessages += session.pendingMessages
    totalProcessedBytes += session.processedBytes
    totalProcessedMessages += session.processedMessages
    totalNewMemories += session.newMemories.length
    totalToolCalls += session.toolCalls.length
  }

  return {
    activeSessions: sessions.size,
    pending: {
      bytes: totalPendingBytes,
      messages: totalPendingMessages
    },
    processed: {
      bytes: totalProcessedBytes,
      messages: totalProcessedMessages
    },
    totalNewMemories,
    totalToolCalls
  }
}

/**
 * Reset a session's pending counters
 * @param {string} sessionId - Session ID
 */
function resetPending(sessionId) {
  if (!sessions.has(sessionId)) return

  const session = sessions.get(sessionId)
  session.pendingBytes = 0
  session.pendingMessages = 0
}

// Start cleanup on module load
startCleanupTimer()

export {
  getSession,
  addPendingBytes,
  markBytesProcessed,
  recordNewMemory,
  recordModifiedMemory,
  recordToolCall,
  recordEvent,
  getSessionSummary,
  getPendingDelta,
  getNewMemories,
  getToolCalls,
  endSession,
  cleanupExpiredSessions,
  startCleanupTimer,
  stopCleanupTimer,
  getActiveSessions,
  getGlobalStats,
  resetPending
}
