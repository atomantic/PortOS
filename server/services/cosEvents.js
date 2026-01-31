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

  // Emit for UI
  cosEvents.emit('log', logEntry)

  // Also log to console with appropriate emoji
  const levelEmojis = {
    info: 'i',
    warn: '!',
    error: 'x',
    success: '+',
    debug: '.'
  }
  const emoji = levelEmojis[level] || 'i'
  const prefixStr = prefix ? `${prefix}: ` : ''
  console.log(`[${logEntry.timestamp}] ${emoji} ${prefixStr}${message}`)
}
