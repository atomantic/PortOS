/**
 * CoS Runner — State persistence layer
 *
 * Owns the on-disk runner-state.json: atomic writes, serialized saves, and
 * loads. Kept self-contained (only fs + the shared fileUtils helpers) so the
 * isolated `portos-cos` PM2 process stays standalone.
 */

import { join } from 'path';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { atomicWrite, PATHS } from '../lib/fileUtils.js';

export const STATE_FILE = join(PATHS.cos, 'runner-state.json');

export const DEFAULT_STATE = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };

const freshState = () => ({ ...DEFAULT_STATE, agents: {}, stats: { ...DEFAULT_STATE.stats } });

// Serializes saves so concurrent writes can't interleave and corrupt the file.
let stateLock = Promise.resolve();

/**
 * Load runner state from disk
 */
export async function loadState() {
  if (!existsSync(STATE_FILE)) return freshState();

  const content = await readFile(STATE_FILE, 'utf-8');
  if (!content || !content.trim()) return freshState();

  return JSON.parse(content);
}

/**
 * Save runner state to disk (serialized with atomic writes to prevent corruption).
 * Delegates the temp-file-and-rename dance to the shared fileUtils.atomicWrite,
 * which also handles ensureDir, JSON stringification, and the Windows rename fallback.
 */
export function saveState(state) {
  // Swallow a prior write's rejection before chaining so one failed write can't
  // poison the lock and silently skip every subsequent save.
  stateLock = stateLock.catch(() => {}).then(() => atomicWrite(STATE_FILE, state));
  return stateLock;
}
