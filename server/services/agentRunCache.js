/**
 * Agent Run Cache Service
 *
 * Caches agent outputs and tool results with 10-minute TTL.
 * Provides fast lookups for repeated operations.
 */

// Cache TTL (10 minutes)
const DEFAULT_TTL_MS = 10 * 60 * 1000

// Cache storage
const outputCache = new Map()
const toolResultCache = new Map()
const contextCache = new Map()

// Cache statistics
const stats = {
  outputHits: 0,
  outputMisses: 0,
  toolHits: 0,
  toolMisses: 0,
  contextHits: 0,
  contextMisses: 0,
  evictions: 0
}

/**
 * Create a cache entry with expiration
 * @param {*} value - Value to cache
 * @param {number} ttlMs - Time to live in milliseconds
 * @returns {Object} - Cache entry
 */
function createCacheEntry(value, ttlMs = DEFAULT_TTL_MS) {
  return {
    value,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    accessCount: 0,
    lastAccessedAt: null
  }
}

/**
 * Check if entry is expired
 * @param {Object} entry - Cache entry
 * @returns {boolean} - True if expired
 */
function isExpired(entry) {
  return Date.now() > entry.expiresAt
}

/**
 * Cache agent output
 * @param {string} agentId - Agent identifier
 * @param {*} output - Output to cache
 * @param {Object} options - Cache options
 */
function cacheOutput(agentId, output, options = {}) {
  const ttl = options.ttlMs || DEFAULT_TTL_MS
  outputCache.set(agentId, createCacheEntry(output, ttl))
}

/**
 * Get cached agent output
 * @param {string} agentId - Agent identifier
 * @returns {*} - Cached output or null
 */
function getOutput(agentId) {
  const entry = outputCache.get(agentId)

  if (!entry) {
    stats.outputMisses++
    return null
  }

  if (isExpired(entry)) {
    outputCache.delete(agentId)
    stats.evictions++
    stats.outputMisses++
    return null
  }

  entry.accessCount++
  entry.lastAccessedAt = Date.now()
  stats.outputHits++

  return entry.value
}

/**
 * Generate tool cache key
 * @param {string} toolId - Tool identifier
 * @param {Object} params - Tool parameters
 * @returns {string} - Cache key
 */
function generateToolKey(toolId, params) {
  const sortedParams = JSON.stringify(params, Object.keys(params || {}).sort())
  return `${toolId}:${sortedParams}`
}

/**
 * Cache tool result
 * @param {string} toolId - Tool identifier
 * @param {Object} params - Tool parameters
 * @param {*} result - Tool result
 * @param {Object} options - Cache options
 */
function cacheToolResult(toolId, params, result, options = {}) {
  const key = generateToolKey(toolId, params)
  const ttl = options.ttlMs || DEFAULT_TTL_MS
  toolResultCache.set(key, createCacheEntry(result, ttl))
}

/**
 * Get cached tool result
 * @param {string} toolId - Tool identifier
 * @param {Object} params - Tool parameters
 * @returns {*} - Cached result or null
 */
function getToolResult(toolId, params) {
  const key = generateToolKey(toolId, params)
  const entry = toolResultCache.get(key)

  if (!entry) {
    stats.toolMisses++
    return null
  }

  if (isExpired(entry)) {
    toolResultCache.delete(key)
    stats.evictions++
    stats.toolMisses++
    return null
  }

  entry.accessCount++
  entry.lastAccessedAt = Date.now()
  stats.toolHits++

  return entry.value
}

/**
 * Cache context/memory section
 * @param {string} taskId - Task identifier
 * @param {string} context - Context string
 * @param {Object} options - Cache options
 */
function cacheContext(taskId, context, options = {}) {
  const ttl = options.ttlMs || DEFAULT_TTL_MS
  contextCache.set(taskId, createCacheEntry(context, ttl))
}

/**
 * Get cached context
 * @param {string} taskId - Task identifier
 * @returns {string|null} - Cached context or null
 */
function getContext(taskId) {
  const entry = contextCache.get(taskId)

  if (!entry) {
    stats.contextMisses++
    return null
  }

  if (isExpired(entry)) {
    contextCache.delete(taskId)
    stats.evictions++
    stats.contextMisses++
    return null
  }

  entry.accessCount++
  entry.lastAccessedAt = Date.now()
  stats.contextHits++

  return entry.value
}

/**
 * Invalidate output cache for an agent
 * @param {string} agentId - Agent identifier
 * @returns {boolean} - True if entry was found and removed
 */
function invalidateOutput(agentId) {
  return outputCache.delete(agentId)
}

/**
 * Invalidate tool result cache
 * @param {string} toolId - Tool identifier
 * @param {Object} params - Tool parameters (optional, if null clears all for tool)
 * @returns {number} - Number of entries invalidated
 */
function invalidateToolResult(toolId, params = null) {
  if (params !== null) {
    const key = generateToolKey(toolId, params)
    return toolResultCache.delete(key) ? 1 : 0
  }

  // Clear all entries for this tool
  let count = 0
  for (const key of toolResultCache.keys()) {
    if (key.startsWith(`${toolId}:`)) {
      toolResultCache.delete(key)
      count++
    }
  }
  return count
}

/**
 * Invalidate context cache for a task
 * @param {string} taskId - Task identifier
 * @returns {boolean} - True if entry was found and removed
 */
function invalidateContext(taskId) {
  return contextCache.delete(taskId)
}

/**
 * Clear all caches
 * @returns {Object} - Number of entries cleared per cache
 */
function clearAll() {
  const counts = {
    outputs: outputCache.size,
    toolResults: toolResultCache.size,
    contexts: contextCache.size
  }

  outputCache.clear()
  toolResultCache.clear()
  contextCache.clear()

  console.log(`🗑️ Cache cleared: ${counts.outputs} outputs, ${counts.toolResults} tool results, ${counts.contexts} contexts`)

  return counts
}

/**
 * Clean up expired entries from all caches
 * @returns {number} - Total entries cleaned
 */
function cleanExpired() {
  let cleaned = 0

  for (const [key, entry] of outputCache.entries()) {
    if (isExpired(entry)) {
      outputCache.delete(key)
      cleaned++
    }
  }

  for (const [key, entry] of toolResultCache.entries()) {
    if (isExpired(entry)) {
      toolResultCache.delete(key)
      cleaned++
    }
  }

  for (const [key, entry] of contextCache.entries()) {
    if (isExpired(entry)) {
      contextCache.delete(key)
      cleaned++
    }
  }

  if (cleaned > 0) {
    stats.evictions += cleaned
  }

  return cleaned
}

/**
 * Get cache statistics
 * @returns {Object} - Cache statistics
 */
function getStats() {
  cleanExpired()

  const outputHitRate = (stats.outputHits + stats.outputMisses) > 0
    ? ((stats.outputHits / (stats.outputHits + stats.outputMisses)) * 100).toFixed(1) + '%'
    : '0%'

  const toolHitRate = (stats.toolHits + stats.toolMisses) > 0
    ? ((stats.toolHits / (stats.toolHits + stats.toolMisses)) * 100).toFixed(1) + '%'
    : '0%'

  const contextHitRate = (stats.contextHits + stats.contextMisses) > 0
    ? ((stats.contextHits / (stats.contextHits + stats.contextMisses)) * 100).toFixed(1) + '%'
    : '0%'

  return {
    outputs: {
      size: outputCache.size,
      hits: stats.outputHits,
      misses: stats.outputMisses,
      hitRate: outputHitRate
    },
    toolResults: {
      size: toolResultCache.size,
      hits: stats.toolHits,
      misses: stats.toolMisses,
      hitRate: toolHitRate
    },
    contexts: {
      size: contextCache.size,
      hits: stats.contextHits,
      misses: stats.contextMisses,
      hitRate: contextHitRate
    },
    totalEvictions: stats.evictions,
    totalSize: outputCache.size + toolResultCache.size + contextCache.size
  }
}

/**
 * Get or compute output with caching
 * @param {string} agentId - Agent identifier
 * @param {Function} computeFn - Function to compute output if not cached
 * @param {Object} options - Cache options
 * @returns {Promise<*>} - Output (cached or computed)
 */
async function getOrComputeOutput(agentId, computeFn, options = {}) {
  const cached = getOutput(agentId)
  if (cached !== null) {
    return { value: cached, fromCache: true }
  }

  const computed = await computeFn()
  cacheOutput(agentId, computed, options)
  return { value: computed, fromCache: false }
}

/**
 * Get or compute tool result with caching
 * @param {string} toolId - Tool identifier
 * @param {Object} params - Tool parameters
 * @param {Function} computeFn - Function to compute result if not cached
 * @param {Object} options - Cache options
 * @returns {Promise<*>} - Result (cached or computed)
 */
async function getOrComputeToolResult(toolId, params, computeFn, options = {}) {
  const cached = getToolResult(toolId, params)
  if (cached !== null) {
    return { value: cached, fromCache: true }
  }

  const computed = await computeFn()
  cacheToolResult(toolId, params, computed, options)
  return { value: computed, fromCache: false }
}

/**
 * Reset cache statistics
 */
function resetStats() {
  stats.outputHits = 0
  stats.outputMisses = 0
  stats.toolHits = 0
  stats.toolMisses = 0
  stats.contextHits = 0
  stats.contextMisses = 0
  stats.evictions = 0
}

// Periodic cleanup
setInterval(cleanExpired, 60000).unref()

export {
  cacheOutput,
  getOutput,
  cacheToolResult,
  getToolResult,
  cacheContext,
  getContext,
  invalidateOutput,
  invalidateToolResult,
  invalidateContext,
  clearAll,
  cleanExpired,
  getStats,
  getOrComputeOutput,
  getOrComputeToolResult,
  resetStats,
  DEFAULT_TTL_MS
}
