/**
 * File System Utilities
 *
 * Shared utilities for file operations used across services.
 */

import { mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Cache __dirname calculation for services importing this module
const __lib_filename = fileURLToPath(import.meta.url);
const __lib_dirname = dirname(__lib_filename);

/**
 * Base directories relative to project root
 */
export const PATHS = {
  root: join(__lib_dirname, '../..'),
  data: join(__lib_dirname, '../../data'),
  cos: join(__lib_dirname, '../../data/cos'),
  brain: join(__lib_dirname, '../../data/brain'),
  digitalTwin: join(__lib_dirname, '../../data/digital-twin'),
  runs: join(__lib_dirname, '../../data/runs'),
  memory: join(__lib_dirname, '../../data/cos/memory'),
  cosAgents: join(__lib_dirname, '../../data/cos/agents'),  // CoS sub-agents
  scripts: join(__lib_dirname, '../../data/cos/scripts'),
  reports: join(__lib_dirname, '../../data/cos/reports'),
  // AI Agent Personalities data
  agentPersonalities: join(__lib_dirname, '../../data/agents')
};

/**
 * Ensure a directory exists, creating it recursively if needed.
 * Uses mkdir with recursive: true which is idempotent and avoids TOCTOU races.
 *
 * @param {string} dir - Directory path to ensure exists
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDir(PATHS.data);
 * await ensureDir('/custom/path/to/dir');
 */
export async function ensureDir(dir) {
  // mkdir with recursive: true is idempotent - it succeeds if dir exists
  await mkdir(dir, { recursive: true });
}

/**
 * Ensure multiple directories exist.
 *
 * @param {string[]} dirs - Array of directory paths to ensure exist
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDirs([PATHS.data, PATHS.cos, PATHS.memory]);
 */
export async function ensureDirs(dirs) {
  for (const dir of dirs) {
    await ensureDir(dir);
  }
}

/**
 * Get a path relative to the data directory.
 *
 * @param {...string} segments - Path segments to join
 * @returns {string} Full path under data directory
 *
 * @example
 * const filePath = dataPath('cos', 'state.json');
 * // Returns: /path/to/project/data/cos/state.json
 */
export function dataPath(...segments) {
  return join(PATHS.data, ...segments);
}

/**
 * Get a path relative to the project root.
 *
 * @param {...string} segments - Path segments to join
 * @returns {string} Full path under project root
 *
 * @example
 * const filePath = rootPath('data', 'TASKS.md');
 * // Returns: /path/to/project/data/TASKS.md
 */
export function rootPath(...segments) {
  return join(PATHS.root, ...segments);
}

/**
 * Check if a string is potentially valid JSON.
 * Performs quick structural validation before parsing.
 *
 * @param {string} str - String to validate
 * @param {Object} options - Validation options
 * @param {boolean} [options.allowArray=true] - Allow array JSON (default: true)
 * @returns {boolean} True if the string appears to be valid JSON
 *
 * @example
 * isValidJSON('{"key": "value"}') // true
 * isValidJSON('[1, 2, 3]') // true
 * isValidJSON('') // false
 * isValidJSON('{"incomplete":') // false
 */
export function isValidJSON(str, { allowArray = true } = {}) {
  if (!str || !str.trim()) return false;
  const trimmed = str.trim();

  // Check for basic JSON structure (object or array)
  const isObject = trimmed.startsWith('{') && trimmed.endsWith('}');
  const isArray = trimmed.startsWith('[') && trimmed.endsWith(']');

  if (!isObject && !(allowArray && isArray)) return false;

  return true;
}

/**
 * Extract JSON array from string that may contain ANSI codes or other noise.
 * Useful for parsing pm2 jlist output which may include warnings before the JSON.
 *
 * @param {string} str - String potentially containing JSON array
 * @returns {string} Extracted JSON or '[]' if not found
 */
export function extractJSONArray(str) {
  if (!str) return '[]';
  // Look for '[{' (array with objects) first
  let jsonStart = str.indexOf('[{');
  if (jsonStart < 0) {
    // Check for empty array - find '[]' that's not part of ANSI codes like [31m
    const emptyMatch = str.match(/\[\](?![0-9])/);
    jsonStart = emptyMatch ? str.indexOf(emptyMatch[0]) : -1;
  }
  return jsonStart >= 0 ? str.slice(jsonStart) : '[]';
}

/**
 * Safely parse JSON with validation and fallback.
 * Avoids "Unexpected end of JSON input" errors from empty/corrupted files.
 * For arrays, automatically extracts JSON from strings with ANSI codes/noise (e.g., pm2 output).
 *
 * @param {string} str - JSON string to parse
 * @param {*} defaultValue - Default value if parsing fails (default: null)
 * @param {Object} options - Parse options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=false] - Log parsing errors
 * @param {string} [options.context=''] - Context for error logging
 * @returns {*} Parsed JSON or default value
 *
 * @example
 * safeJSONParse('{"key": "value"}', {}) // { key: "value" }
 * safeJSONParse('', {}) // {}
 * safeJSONParse('invalid', []) // []
 * safeJSONParse(null, { default: true }) // { default: true }
 */
export function safeJSONParse(str, defaultValue = null, { allowArray = true, logError = false, context = '' } = {}) {
  // For arrays, try to extract JSON from noisy output (e.g., pm2 with ANSI codes)
  if (allowArray && Array.isArray(defaultValue) && str && !str.trim().startsWith('[')) {
    str = extractJSONArray(str);
  }

  if (!isValidJSON(str, { allowArray })) {
    if (logError && str) {
      console.warn(`Invalid JSON${context ? ` in ${context}` : ''}: empty or malformed content`);
    }
    return defaultValue;
  }

  // Attempt actual parse - the validation above catches structural issues
  // but syntax errors like trailing commas still need handling
  try {
    return JSON.parse(str);
  } catch (err) {
    if (logError) {
      console.warn(`Failed to parse JSON${context ? ` in ${context}` : ''}: ${err.message}`);
    }
    return defaultValue;
  }
}

/**
 * Read a JSON file safely with validation and default fallback.
 * Combines file reading with safe JSON parsing.
 *
 * @param {string} filePath - Path to JSON file
 * @param {*} defaultValue - Default value if file doesn't exist or is invalid
 * @param {Object} options - Options
 * @param {boolean} [options.allowArray=true] - Allow array JSON
 * @param {boolean} [options.logError=true] - Log errors
 * @returns {Promise<*>} Parsed JSON or default value
 *
 * @example
 * const config = await readJSONFile('./config.json', { port: 3000 });
 * const items = await readJSONFile('./items.json', []);
 */
export async function readJSONFile(filePath, defaultValue = null, { allowArray = true, logError = true } = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT = file doesn't exist, return default silently
    if (err.code === 'ENOENT') {
      return defaultValue;
    }
    // Log other I/O errors if requested
    if (logError) {
      console.warn(`Failed to read file ${filePath}: ${err.message}`);
    }
    return defaultValue;
  }
  return safeJSONParse(content, defaultValue, { allowArray, logError, context: filePath });
}

/**
 * Parse JSONL (JSON Lines) content safely.
 * Handles empty lines, whitespace, and malformed lines gracefully.
 *
 * @param {string} content - JSONL content (newline-separated JSON objects)
 * @param {Object} options - Options
 * @param {boolean} [options.logErrors=false] - Log individual line parsing errors
 * @param {string} [options.context=''] - Context for error logging
 * @returns {Array} Array of parsed objects (invalid lines are skipped)
 *
 * @example
 * const lines = safeJSONLParse('{"a":1}\n{"b":2}\n'); // [{ a: 1 }, { b: 2 }]
 * const lines = safeJSONLParse('{"a":1}\ninvalid\n{"b":2}'); // [{ a: 1 }, { b: 2 }]
 */
export function safeJSONLParse(content, { logErrors = false, context = '' } = {}) {
  if (!content || !content.trim()) return [];

  // Split on CRLF or LF to handle both Windows and Unix line endings
  const lines = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  const results = [];

  for (const line of lines) {
    const parsed = safeJSONParse(line, null, { allowArray: false, logError: logErrors, context });
    if (parsed !== null) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Read a JSONL file safely.
 *
 * @param {string} filePath - Path to JSONL file
 * @param {Object} options - Options
 * @param {boolean} [options.logErrors=false] - Log individual line parsing errors
 * @returns {Promise<Array>} Array of parsed objects
 *
 * @example
 * const entries = await readJSONLFile('./logs.jsonl');
 */
export async function readJSONLFile(filePath, { logErrors = false } = {}) {
  let content;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    // ENOENT = file doesn't exist, return empty array silently
    if (err.code === 'ENOENT') {
      return [];
    }
    // Log other I/O errors if requested
    if (logErrors) {
      console.warn(`Failed to read file ${filePath}: ${err.message}`);
    }
    return [];
  }
  return safeJSONLParse(content, { logErrors, context: filePath });
}

/**
 * Format a duration in milliseconds to a human-readable string.
 * Outputs the most appropriate unit (minutes, hours, days) based on size.
 *
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration (e.g., "5m", "2h 30m", "3d 5h")
 *
 * @example
 * formatDuration(30000)    // "0m"
 * formatDuration(300000)   // "5m"
 * formatDuration(7200000)  // "2h 0m"
 * formatDuration(90000000) // "1d 1h"
 */
export function formatDuration(ms) {
  if (!ms) return '0m';
  const mins = Math.floor(ms / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    const remainingMins = mins % 60;
    return `${hours}h ${remainingMins}m`;
  }
  return `${mins}m`;
}
