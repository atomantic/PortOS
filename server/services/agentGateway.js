/**
 * Agent Gateway Service
 *
 * Centralized communication hub for agent operations.
 * Provides request deduplication, caching, and coordination.
 */

import { cosEvents } from './cosEvents.js'

// Request deduplication cache
const pendingRequests = new Map()

// Response cache with TTL and size cap
const responseCache = new Map()
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_CACHE_SIZE = 1000

// Request history for analytics
const requestHistory = []
const MAX_HISTORY = 500

// Gateway statistics
const stats = {
  totalRequests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  deduplicatedRequests: 0,
  errors: 0
}

/**
 * Generate cache key for a request
 * @param {string} type - Request type
 * @param {Object} params - Request parameters
 * @returns {string} - Cache key
 */
function generateCacheKey(type, params) {
  const sortedParams = JSON.stringify(params, Object.keys(params).sort())
  return `${type}:${sortedParams}`
}

/**
 * Clean expired cache entries
 */
function cleanExpiredCache() {
  const now = Date.now()
  for (const [key, entry] of responseCache.entries()) {
    if (now > entry.expiresAt) {
      responseCache.delete(key)
    }
  }
}

/**
 * Route a request through the gateway
 * Handles deduplication and caching
 *
 * @param {string} type - Request type (e.g., 'embedding', 'completion', 'tool')
 * @param {Object} params - Request parameters
 * @param {Function} handler - Async function to execute if not cached
 * @param {Object} options - Gateway options
 * @returns {Promise<*>} - Request result
 */
async function routeRequest(type, params, handler, options = {}) {
  const {
    cacheable = true,
    ttlMs = CACHE_TTL_MS,
    deduplicateMs = 5000
  } = options

  stats.totalRequests++
  const cacheKey = generateCacheKey(type, params)
  const now = Date.now()

  // Check response cache first
  if (cacheable) {
    const cached = responseCache.get(cacheKey)
    if (cached && now < cached.expiresAt) {
      stats.cacheHits++
      return { ...cached.response, fromCache: true }
    }
    stats.cacheMisses++
  }

  // Check for pending duplicate request
  const pending = pendingRequests.get(cacheKey)
  if (pending && now - pending.startedAt < deduplicateMs) {
    stats.deduplicatedRequests++
    return pending.promise
  }

  // Execute the request
  const requestPromise = (async () => {
    const startTime = Date.now()
    let result
    let error = null

    try {
      result = await handler(params)

      // Cache successful response (evict oldest if at capacity)
      if (cacheable && result) {
        if (responseCache.size >= MAX_CACHE_SIZE) {
          // Evict oldest entry (first key in insertion order)
          const oldest = responseCache.keys().next().value
          responseCache.delete(oldest)
        }
        responseCache.set(cacheKey, {
          response: result,
          expiresAt: now + ttlMs,
          cachedAt: now
        })
      }
    } catch (err) {
      error = err
      stats.errors++
      throw err
    } finally {
      // Record in history
      requestHistory.unshift({
        type,
        cacheKey: cacheKey.substring(0, 50),
        startedAt: startTime,
        duration: Date.now() - startTime,
        success: !error,
        cached: false
      })

      // Trim history
      while (requestHistory.length > MAX_HISTORY) {
        requestHistory.pop()
      }

      // Clean up pending request
      pendingRequests.delete(cacheKey)
    }

    return result
  })()

  // Track pending request
  pendingRequests.set(cacheKey, {
    promise: requestPromise,
    startedAt: now
  })

  return requestPromise
}

/**
 * Invalidate cache entries matching a pattern
 * @param {string} typePrefix - Type prefix to match
 * @returns {number} - Number of entries invalidated
 */
function invalidateCache(typePrefix) {
  let invalidated = 0

  for (const key of responseCache.keys()) {
    if (key.startsWith(typePrefix)) {
      responseCache.delete(key)
      invalidated++
    }
  }

  if (invalidated > 0) {
    console.log(`🗑️ Invalidated ${invalidated} cache entries matching "${typePrefix}"`)
  }

  return invalidated
}

/**
 * Clear entire cache
 * @returns {number} - Number of entries cleared
 */
function clearCache() {
  const size = responseCache.size
  responseCache.clear()
  console.log(`🗑️ Cleared ${size} cache entries`)
  return size
}

/**
 * Get gateway statistics
 * @returns {Object} - Gateway stats
 */
function getStats() {
  cleanExpiredCache()

  return {
    ...stats,
    cacheSize: responseCache.size,
    pendingRequests: pendingRequests.size,
    cacheHitRate: stats.totalRequests > 0
      ? ((stats.cacheHits / stats.totalRequests) * 100).toFixed(1) + '%'
      : '0%',
    deduplicationRate: stats.totalRequests > 0
      ? ((stats.deduplicatedRequests / stats.totalRequests) * 100).toFixed(1) + '%'
      : '0%'
  }
}

/**
 * Get recent request history
 * @param {Object} options - Filter options
 * @returns {Array} - Request history
 */
function getRequestHistory(options = {}) {
  let history = [...requestHistory]

  if (options.type) {
    history = history.filter(r => r.type === options.type)
  }

  if (options.success !== undefined) {
    history = history.filter(r => r.success === options.success)
  }

  const limit = options.limit || 50
  return history.slice(0, limit)
}

/**
 * Pre-warm cache with common requests
 * @param {Array} requests - Array of {type, params, handler} to pre-warm
 * @returns {Promise<number>} - Number of requests cached
 */
async function prewarmCache(requests) {
  let cached = 0

  for (const { type, params, handler } of requests) {
    const cacheKey = generateCacheKey(type, params)

    // Skip if already cached
    if (responseCache.has(cacheKey)) continue

    try {
      await routeRequest(type, params, handler, { cacheable: true })
      cached++
    } catch (err) {
      console.error(`⚠️ Cache prewarm failed for ${type}: ${err.message}`)
    }
  }

  if (cached > 0) {
    console.log(`🔥 Pre-warmed cache with ${cached} entries`)
  }

  return cached
}

/**
 * Create a gateway-aware request function for a specific type
 * @param {string} type - Request type
 * @param {Function} handler - Request handler
 * @param {Object} defaultOptions - Default gateway options
 * @returns {Function} - Gateway-wrapped function
 */
function createGatewayRequest(type, handler, defaultOptions = {}) {
  return async function gatewayRequest(params, options = {}) {
    return routeRequest(type, params, handler, { ...defaultOptions, ...options })
  }
}

/**
 * Batch multiple requests through gateway
 * @param {Array<{type, params, handler}>} requests - Requests to batch
 * @param {Object} options - Batch options
 * @returns {Promise<Array>} - Results in same order
 */
async function batchRequests(requests, options = {}) {
  const { parallel = true, stopOnError = false } = options

  if (parallel) {
    const promises = requests.map(({ type, params, handler, options: reqOptions }) =>
      routeRequest(type, params, handler, reqOptions).catch(err => {
        if (stopOnError) throw err
        return { error: err.message }
      })
    )
    return Promise.all(promises)
  }

  const results = []
  for (const { type, params, handler, options: reqOptions } of requests) {
    try {
      const result = await routeRequest(type, params, handler, reqOptions)
      results.push(result)
    } catch (err) {
      if (stopOnError) throw err
      results.push({ error: err.message })
    }
  }

  return results
}

/**
 * Subscribe to gateway events
 * @param {string} event - Event name
 * @param {Function} callback - Event handler
 */
function subscribe(event, callback) {
  cosEvents.on(`gateway:${event}`, callback)
}

/**
 * Reset gateway statistics
 */
function resetStats() {
  stats.totalRequests = 0
  stats.cacheHits = 0
  stats.cacheMisses = 0
  stats.deduplicatedRequests = 0
  stats.errors = 0
}

// Periodic cache cleanup
setInterval(cleanExpiredCache, 60000).unref()

export {
  routeRequest,
  invalidateCache,
  clearCache,
  getStats,
  getRequestHistory,
  prewarmCache,
  createGatewayRequest,
  batchRequests,
  subscribe,
  resetStats,
  generateCacheKey
}
