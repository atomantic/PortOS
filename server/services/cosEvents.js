/**
 * CoS Events Module
 *
 * Centralized event emitter for Chief of Staff services.
 * Separated to avoid circular dependencies between cos.js and other modules.
 */

import { EventEmitter } from 'events'

// Event emitter for CoS events
export const cosEvents = new EventEmitter()

/**
 * Emit a log event for UI display
 * @param {string} level - Log level: 'info', 'warn', 'error', 'success', 'debug'
 * @param {string} message - Log message
 * @param {Object} data - Additional data to include in log entry
 * @param {string} prefix - Optional prefix for console output (e.g., 'SelfImprovement')
 */
export function emitLog(level, message, data = {}, prefix = '') {
  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data
  }
  // Debug messages go to socket only (UI), not console — set COS_LOG_LEVEL=debug to include them
  if (level !== 'debug' || process.env.COS_LOG_LEVEL === 'debug') {
    const emoji = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : level === 'debug' ? '🔍' : 'ℹ️'
    const prefixStr = prefix ? ` ${prefix}` : ''
    console.log(`${emoji}${prefixStr} ${message}`)
  }
  cosEvents.emit('log', logEntry)
}
