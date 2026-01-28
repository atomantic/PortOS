/**
 * File System Utilities
 *
 * Shared utilities for file operations used across services.
 */

import { mkdir } from 'fs/promises';
import { existsSync } from 'fs';
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
  agents: join(__lib_dirname, '../../data/cos/agents'),
  scripts: join(__lib_dirname, '../../data/cos/scripts'),
  reports: join(__lib_dirname, '../../data/cos/reports')
};

/**
 * Ensure a directory exists, creating it recursively if needed.
 *
 * @param {string} dir - Directory path to ensure exists
 * @returns {Promise<void>}
 *
 * @example
 * await ensureDir(PATHS.data);
 * await ensureDir('/custom/path/to/dir');
 */
export async function ensureDir(dir) {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
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
