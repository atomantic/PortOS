/** Add local merge scheduling state without replacing live leases or turns. */
import { join } from 'node:path';
import { readJsonOrNull, writeJsonAtomic } from './_lib.js';

export default {
  async up({ rootDir }) {
    const statePath = join(rootDir, 'data', 'cos', 'state.json');
    const state = await readJsonOrNull(statePath);
    // Missing or malformed state never becomes fabricated empty ownership.
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { updated: 0, reason: 'no-readable-state' };
    if (Object.hasOwn(state, 'mergePreparations')) return { updated: 0, reason: 'already-present' };
    await writeJsonAtomic(statePath, { ...state, mergePreparations: {} });
    return { updated: 1 };
  },
};
