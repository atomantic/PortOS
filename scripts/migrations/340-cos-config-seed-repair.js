/**
 * Repair installs whose CoS settings were replaced by the shipped seed during
 * the #6182 config split.
 *
 * `update.sh` runs `scripts/setup-data.js` BEFORE `scripts/run-migrations.js`,
 * and setup-data copies every `data.reference/` file the install is missing.
 * The commit that introduced migration 339 (lift `config` out of
 * `data/cos/state.json` into `data/cos/config.json`) also added a
 * `data.reference/cos/config.json` seed — so on the one update that crossed
 * that commit, setup-data wrote the seed first, migration 339 saw config.json
 * "already exists" and no-opped, `loadConfig()` preferred the seed over its
 * legacy `state.json` read, and the next `saveState()` stripped the real config
 * slice off disk for good. An install that updated before or after that commit
 * never sees it.
 *
 * The seed set `alwaysOn: false` / `autoStart: false` while `DEFAULT_CONFIG`
 * shipped `alwaysOn: true`, so the visible symptom was CoS refusing to come
 * back after an update until the user started it by hand, on top of concurrency
 * caps and Persistent Mind grants reverting to defaults. (`alwaysOn` now
 * defaults to `false` too — see `server/services/cosState.js`.)
 *
 * Two rules keep this from recurring, both recorded in the root `AGENTS.md`:
 * a derive-from-existing-data migration ships no seed (declared in
 * `scripts/lib/migrationOwnedPaths.js`, which setup-data also honors), and such
 * a migration gates on the presence of its INPUT rather than the absence of its
 * output — 339 did the latter, which is what let a pre-existing output file
 * silence it.
 *
 * This migration cleans up the installs that already took the hit:
 *
 *   - config.json is the retired seed AND state.json still carries a `config`
 *     slice → redo migration 339's lift, recovering the real settings.
 *   - state.json was stripped but a quarantined `state.json.corrupted.*` copy
 *     still carries one → lift from the newest of those. On an install that
 *     took this hit, those backups are frequently the LAST copy of the real
 *     settings anywhere on disk.
 *   - nothing left to lift → delete config.json, so `loadConfig()` falls back
 *     to `DEFAULT_CONFIG`, one source of truth for the defaults.
 *
 * Every repair branch requires config.json to EQUAL the retired seed (deep
 * equality; key order is not the contract). That is the proof it was
 * machine-written: `saveConfig()` always persists the full merged
 * `DEFAULT_CONFIG` key set (34 keys), so a file deep-equal to the 13-key seed
 * cannot have come from a user saving settings. Anything else is left strictly
 * alone — but if a quarantined copy holds settings that config.json does not,
 * we still say so, because the user who reacted to the symptom by re-entering
 * their settings by hand lands exactly there.
 */

import { readdir, readFile, rm } from 'fs/promises';
import { isDeepStrictEqual } from 'util';
import { basename, dirname, join } from 'path';

import { writeJsonAtomic } from './_lib.js';

const STATE_PATH = join('data', 'cos', 'state.json');
const CONFIG_PATH = join('data', 'cos', 'config.json');

/**
 * `data.reference/cos/config.json` as it shipped between the #6182 split and
 * this repair — frozen here because the file no longer exists in the tree and
 * this migration's whole guard is equality with it. Exported for the test.
 */
export const RETIRED_SEED = {
  userTasksFile: 'data/TASKS.md',
  cosTasksFile: 'data/COS-TASKS.md',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  maxTotalProcesses: 50,
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] },
  ],
  autoStart: false,
  alwaysOn: false,
  selfImprovementEnabled: true,
  dynamicAvatar: true,
  persistentMindCapabilities: {
    schemaVersion: 5,
    createTasks: false,
    manageMind: false,
    manageEidoverse: false,
    callUser: false,
    readPortos: false,
    writePortos: false,
    taskModelAllowlist: [],
  },
};

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

async function readJson(path) {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * The config slice from the newest quarantined `state.json.corrupted.*`, or
 * `null`. `cosState.js` writes those copies when state.json fails to parse, and
 * their suffix is `Date.now()`. Read newest-first and stop at the first hit —
 * the newest is nearly always the answer, so reading the rest is wasted I/O.
 */
async function readQuarantinedConfig(stateDir) {
  const prefix = `${basename(STATE_PATH)}.corrupted.`;
  const names = await readdir(stateDir).catch(() => []);
  const backups = names
    .filter((name) => name.startsWith(prefix))
    .sort()
    .reverse();
  for (const name of backups) {
    const config = (await readJson(join(stateDir, name)))?.config;
    if (isPlainObject(config)) return { config, source: name };
  }
  return null;
}

export default {
  async up({ rootDir }) {
    const configPath = join(rootDir, CONFIG_PATH);
    const statePath = join(rootDir, STATE_PATH);
    const config = await readJson(configPath);
    // Absent (the normal case on a healthy or fresh install) or unreadable — an
    // unreadable config.json belongs to the state loader's quarantine path, not
    // to a migration that would delete it.
    if (config === null) return { repaired: false, reason: 'no readable config.json' };

    if (!isDeepStrictEqual(config, RETIRED_SEED)) {
      // Not ours to touch. But an install that re-entered its settings by hand
      // after the reset lands here with its ONLY pre-split copy sitting in a
      // quarantined backup, so point at it rather than saying nothing.
      const stranded = await readQuarantinedConfig(dirname(statePath));
      if (stranded) {
        console.log(`💡 ${CONFIG_PATH} carries real settings, so it was left alone — an older copy of ${Object.keys(stranded.config).length} CoS settings is still readable in ${join(dirname(STATE_PATH), stranded.source)} if anything looks missing`);
      }
      return { repaired: false, reason: 'config.json carries real settings' };
    }

    const state = await readJson(statePath);
    const legacyConfig = state?.config;
    if (isPlainObject(legacyConfig)) {
      // Config file first, same ordering as migration 339: a crash between the
      // two writes leaves the settings in both places, never in neither.
      await writeJsonAtomic(configPath, legacyConfig);
      delete state.config;
      await writeJsonAtomic(statePath, state);
      console.log(`📦 ${CONFIG_PATH}: replaced the shipped seed with the ${Object.keys(legacyConfig).length} settings still in ${STATE_PATH}`);
      return { repaired: 'lifted', keys: Object.keys(legacyConfig).length };
    }

    // state.json no longer carries the slice — the post-seed `saveState()`
    // already stripped it. A quarantined copy may still hold it.
    const quarantined = await readQuarantinedConfig(dirname(statePath));
    if (quarantined) {
      await writeJsonAtomic(configPath, quarantined.config);
      console.log(`📦 ${CONFIG_PATH}: recovered ${Object.keys(quarantined.config).length} settings from the quarantined ${quarantined.source}`);
      return { repaired: 'recovered', keys: Object.keys(quarantined.config).length, source: quarantined.source };
    }

    // force: an ENOENT here would propagate out of runMigrations() and fail
    // server boot, and "the file we were about to delete is already gone" is
    // exactly the outcome this branch wants anyway.
    await rm(configPath, { force: true });
    console.log(`🧹 Removed ${CONFIG_PATH} — it was the shipped seed, so CoS reads its in-code defaults again`);
    return { repaired: 'removed' };
  },
};
