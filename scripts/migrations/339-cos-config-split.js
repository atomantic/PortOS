/**
 * Split the durable CoS user configuration out of `data/cos/state.json` into
 * its own `data/cos/config.json` (#6182).
 *
 * `state.json` is rewritten on every agent status change and every batched
 * output flush; `config` (concurrency caps, domain autonomy/budgets, the
 * Persistent Mind grants/profile/prompt) is written only when the user changes
 * a setting. Coupling them re-serialized ~180 KB of settings on every hot-path
 * write and put near-impossible-to-reconstruct settings at risk from any damage
 * to the runtime file.
 *
 * Idempotent: the lift is a no-op once `config.json` exists. `loadConfig()`
 * keeps a back-compat read of a legacy `config` slice, so an install that has
 * not run this migration (an un-upgraded peer, a restored pre-split backup)
 * still boots on its own settings rather than defaults.
 *
 * Also removes the `config.last-known-good.json` sidecar. That file mirrored the
 * config slice out of state.json precisely because the two shared a file;
 * config.json IS the low-frequency copy now, nothing reads the sidecar any more,
 * and leaving a stale "last known good config" on disk only invites someone to
 * restore settings from it that the live file has since moved past.
 */

import { readFile, rm } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileUtils.js';

const STATE_PATH = join('data', 'cos', 'state.json');
const CONFIG_PATH = join('data', 'cos', 'config.json');
const RETIRED_BACKUP_PATH = join('data', 'cos', 'config.last-known-good.json');

async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Best-effort removal of the retired sidecar; its absence is the normal case. */
async function removeRetiredBackup(rootDir) {
  const removed = await rm(join(rootDir, RETIRED_BACKUP_PATH)).then(() => true).catch(() => false);
  if (removed) console.log(`🧹 Removed retired ${RETIRED_BACKUP_PATH} — config.json owns the settings now`);
  return removed;
}

export default {
  async up({ rootDir }) {
    // Runs on every path below, including the already-split no-op: an install
    // that got config.json some other way still has the sidecar to clean up.
    const removedBackup = await removeRetiredBackup(rootDir);
    const configPath = join(rootDir, CONFIG_PATH);
    // Presence, not parseability, is the guard: a config.json that exists but
    // is unreadable belongs to the state loader's quarantine path, not to a
    // migration that would overwrite it with a stale copy from state.json.
    const alreadySplit = await readFile(configPath, 'utf-8').then(() => true).catch(() => false);
    if (alreadySplit) return { split: false, removedBackup, reason: 'config.json already exists' };

    const statePath = join(rootDir, STATE_PATH);
    const state = await readJson(statePath);
    // A missing/corrupt state.json is not this migration's problem — the state
    // loader quarantines and re-defaults it. Nothing to lift out, so record the
    // migration as applied and let the config file be created on first write.
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return { split: false, removedBackup, reason: 'no readable state.json' };
    }

    const config = state.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return { split: false, removedBackup, reason: 'state.json carries no config slice' };
    }

    // Write the config file FIRST. If the process dies between the two writes,
    // the settings exist in both places (config.json wins on read) rather than
    // in neither.
    await atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`);
    delete state.config;
    await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
    console.log(`📦 ${CONFIG_PATH}: lifted ${Object.keys(config).length} config keys out of ${STATE_PATH}`);
    return { split: true, removedBackup, keys: Object.keys(config).length };
  },
};
