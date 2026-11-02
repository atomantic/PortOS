import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './paths.js';
import { persistentMindImageWorkGuard } from './persistentMind.js';

/** Disk-only preflight also works while the API is offline. Never default corrupt state. */
export function assertUpdateImageSafety({ dataDir = PATHS.data, acknowledged = false } = {}) {
  let state;
  try { state = JSON.parse(readFileSync(join(dataDir, 'cos', 'state.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state !== undefined && (!state || typeof state !== 'object' || Array.isArray(state))) {
    throw new Error('Persistent Mind state could not be validated before updating');
  }
  const guard = persistentMindImageWorkGuard(state?.persistentMind);
  if (!guard.trusted) throw new Error('Persistent Mind state could not be validated before updating');
  if (!guard.safe && !acknowledged) throw Object.assign(new Error('Persistent Mind image work must drain or have its backup acknowledged before updating'), { code: 'UPDATE_IMAGE_WORK' });
}
