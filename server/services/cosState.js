/**
 * CoS State Module
 *
 * Shared state management for Chief of Staff services.
 */

import { readFile, readdir, rm, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ensureDirs, safeJSONParse, readJSONFileStrict, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { normalizeDomainAutonomy, getDomainMode } from '../lib/domainAutonomy.js';
import { normalizeDomainBudgets } from '../lib/domainBudgets.js';
import { createDefaultPersistentMindState, normalizePersistentMindState } from '../lib/persistentMind.js';
import { createDefaultPersistentMindCapabilities, normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { createDefaultPersistentMindProfile, normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { createDefaultPersistentMindPrompt, normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { DEFAULT_ALWAYS_APPROVE_KINDS } from './taskLearning/safetyKind.js';

export const STATE_FILE = join(PATHS.cos, 'state.json');
// Durable user configuration lives in its own file (#6182). state.json is
// rewritten on every agent status change and every batched output flush; config
// is written only when the user changes a setting. Splitting them keeps the hot
// path from re-serializing ~180 KB of settings it never touched, and keeps
// damage to the runtime file away from settings that are near-impossible to
// reconstruct. This retires the `config.last-known-good.json` sidecar, which
// mirrored the config slice out of state.json precisely because the two shared
// a file — config.json IS the low-frequency copy now, so a second one would
// only add a way for the two to disagree. Migration 339 removes the sidecar.
export const CONFIG_FILE = join(PATHS.cos, 'config.json');
export const AGENTS_DIR = join(PATHS.cos, 'agents');
export const REPORTS_DIR = PATHS.reports;
export const SCRIPTS_DIR = PATHS.scripts;
export const ROOT_DIR = PATHS.root;

// Serialize every state.json read-merge-write on a single tail so two
// concurrent loadState→modify→saveState cycles can't interleave and clobber
// each other. Standardized on `createFileWriteQueue` — the documented
// single-JSON-file write-serialization convention (AGENTS.md; same mechanism
// settings.js and the issues/series/mediaCollections stores use) — instead of a
// bespoke async mutex. Identical `(fn) => Promise` contract, so the ~34 existing
// `withStateLock(...)` call sites are unchanged; the name is kept for that
// reason. The queue additionally silences its tail so one rejected write can't
// poison subsequent waiters (a strict improvement over the prior mutex).
export const withStateLock = createFileWriteQueue();

// Config gets its OWN tail, so a settings read or write never queues behind the
// runtime-record writes that dominate state.json (#6182). Same
// `(fn) => Promise` contract as `withStateLock`.
export const withConfigLock = createFileWriteQueue();

export const DEFAULT_CONFIG = {
  userTasksFile: 'data/TASKS.md',
  cosTasksFile: 'data/COS-TASKS.md',
  goalsFile: 'GOALS.md',
  healthCheckIntervalMs: 900000,
  maxConcurrentAgents: 3,
  maxConcurrentAgentsPerProject: 2,
  maxProcessMemoryMb: 2048,
  maxTotalProcesses: 50,
  mcpServers: [
    { name: 'filesystem', command: 'npx', args: ['-y', '@anthropic/mcp-server-filesystem'] },
    { name: 'puppeteer', command: 'npx', args: ['-y', '@anthropic/mcp-puppeteer', '--isolated'] }
  ],
  autoStart: false,
  selfImprovementEnabled: true,
  appImprovementEnabled: true,
  improvementEnabled: true,
  avatarStyle: 'svg',
  dynamicAvatar: true,
  alwaysOn: true,
  appReviewCooldownMs: 1800000,
  idleReviewEnabled: true,
  idleReviewPriority: 'MEDIUM',
  proactiveMode: true,
  autonomousJobsEnabled: true,
  // Investigation tasks normally hold only failure loops for a human. This
  // opt-in also admits those loop/storm investigations unattended.
  autoApproveInvestigations: false,
  // Persisting a profile is not consent to wake the mind. Fresh and upgraded
  // installs stay disabled until the user explicitly starts it.
  persistentMindProfile: createDefaultPersistentMindProfile(),
  persistentMindPrompt: createDefaultPersistentMindPrompt(),
  // Action grants are independent of the provider profile. Existing and fresh
  // conversation-only installs never gain task-creation authority on upgrade.
  persistentMindCapabilities: createDefaultPersistentMindCapabilities(),
  // Per-domain autonomy guardrails (#711). Each domain is off | dry-run | execute.
  // Default is `execute` for every domain, reproducing pre-#711 behavior so no
  // migration is needed — an install with no stored value reads `execute`.
  domainAutonomy: normalizeDomainAutonomy({}),
  // Per-domain daily autonomy budgets (#711). Each domain caps maxActionsPerDay
  // and maxMinutesPerDay; `null` = unlimited, which is the default for every
  // domain — so an install with no stored value enforces nothing (no migration).
  domainBudgets: normalizeDomainBudgets({}),
  rehabilitationGracePeriodDays: 7,
  completedAgentRetentionMs: 86400000,
  embeddingProviderId: 'lmstudio',
  embeddingModel: '',
  autoFixThresholds: {
    maxLinesChanged: 50,
    allowedCategories: [
      'formatting',
      'dry-violations',
      'dead-code',
      'typo-fix',
      'import-cleanup'
    ]
  },
  confidenceAutoApproval: {
    enabled: true,
    highThreshold: 80,
    lowThreshold: 50,
    minSamples: 5
  },
  // Safety axis orthogonal to confidence (#2440): outward-facing / irreversible
  // work always needs human sign-off regardless of success rate. Reversible
  // internal work keeps the confidence success-rate gate. Tune which kinds are
  // forced to approval via `alwaysApproveKinds`.
  safetyKindApproval: {
    enabled: true,
    alwaysApproveKinds: [...DEFAULT_ALWAYS_APPROVE_KINDS]
  }
};

export const DEFAULT_STATE = {
  running: false,
  paused: false,
  pausedAt: null,
  pauseReason: null,
  stats: {
    tasksCompleted: 0,
    totalRuntime: 0,
    agentsSpawned: 0,
    errors: 0,
    lastEvaluation: null,
    lastIdleReview: null
  },
  persistentMind: createDefaultPersistentMindState(),
  agents: {}
};

export async function ensureDirectories() {
  await ensureDirs([PATHS.data, PATHS.cos, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR]);
}

/**
 * Parse a persisted CoS state file, returning the object or `null` when the
 * bytes are not a JSON object.
 *
 * Never front this with a structural heuristic. The one this replaced rejected
 * any file containing the byte pair `}{` anywhere — a guess at a double-append
 * corruption that fires on perfectly VALID JSON as soon as a stored string
 * holds those two characters (an agent prompt quoting `{value}{ — project}`,
 * a diff carrying JSX). Each false positive discarded the whole file and
 * silently reset the user's config to DEFAULT_CONFIG. `JSON.parse` rejects a
 * genuine `{…}{…}` concatenation on its own, so the guess protected nothing.
 */
function parseStateFile(content, context = 'CoS state') {
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context });
  return isPlainObject(parsed) ? parsed : null;
}

/**
 * Apply the stored config over DEFAULT_CONFIG, running the legacy-key
 * migrations first. Shared by the normal load path and the corrupt-file
 * recovery path so a recovered config is normalized identically.
 */
function mergeStoredConfig(storedConfig) {
  // `isPlainObject` before the spread, not `|| {}`: spreading a string yields
  // one key per character, so a `"config": "…"` in a hand-edited state file
  // would merge character indices over DEFAULT_CONFIG instead of being ignored.
  const persistedConfig = isPlainObject(storedConfig) ? { ...storedConfig } : {};

  // Migrate legacy split flags before merging defaults — DEFAULT_CONFIG.improvementEnabled = true
  // would otherwise shadow a v1 file that only set selfImprovementEnabled/appImprovementEnabled.
  if (persistedConfig.improvementEnabled === undefined &&
      (persistedConfig.selfImprovementEnabled !== undefined || persistedConfig.appImprovementEnabled !== undefined)) {
    persistedConfig.improvementEnabled =
      persistedConfig.selfImprovementEnabled || persistedConfig.appImprovementEnabled;
  }

  // Drop the retired `evaluationIntervalMs` key on read. CoS evaluation became
  // event-driven (the periodic evaluateTasks() timer was removed), so the field
  // no longer exists in DEFAULT_CONFIG or the (strict) update schema. Upgraded
  // installs still carry it in state.json; stripping it here keeps GET /config
  // from re-emitting a key the strict PUT schema would now reject on a full
  // round-trip, and purges it from disk on the next saveState.
  delete persistedConfig.evaluationIntervalMs;
  // The global four-level autonomy preset was only a UI shortcut that rewrote
  // independent capacity/work-generation fields. Domain guardrails now own the
  // actual off/dry-run/execute policy, so do not keep re-emitting this inert key
  // from upgraded state files. Per-job autonomyLevel remains a separate contract.
  delete persistedConfig.autonomyLevel;
  delete persistedConfig.comprehensiveAppImprovement;
  delete persistedConfig.immediateExecution;

  return {
    ...DEFAULT_CONFIG,
    ...persistedConfig,
    persistentMindCapabilities: normalizePersistentMindCapabilities(persistedConfig.persistentMindCapabilities),
    persistentMindProfile: normalizePersistentMindProfile(persistedConfig.persistentMindProfile),
    persistentMindPrompt: normalizePersistentMindPrompt(persistedConfig.persistentMindPrompt),
  };
}

/**
 * Quarantine an unreadable JSON file next to itself and prune all but the three
 * most recent quarantined copies, so the lost bytes stay inspectable.
 *
 * `remove` moves the file instead of copying it, so it leaves the active path.
 * config.json needs that: it is written only when the user changes a setting,
 * so a copy would leave the corrupt original to be re-read, re-warned about,
 * and re-quarantined on every boot. state.json deliberately keeps the copy —
 * the next runtime write overwrites it within seconds, and
 * `readStateForSafetyCheck()` reports an unreadable file as `trusted: false`
 * ("could not establish what is there"); removing it would turn that into
 * "known empty" and let the update gate restart out from under a live agent.
 */
async function quarantineCorruptFile(filePath, content, label, { remove = false } = {}) {
  const backupPath = `${filePath}.corrupted.${Date.now()}`;
  const moved = remove && await rename(filePath, backupPath).then(() => true).catch(() => false);
  if (!moved) await atomicWrite(backupPath, content).catch(() => {});
  console.log(`📝 Backed up corrupted ${label} to ${backupPath}`);
  const dir = dirname(filePath);
  const prefix = `${basename(filePath)}.corrupted.`;
  const files = await readdir(dir).catch(() => []);
  const corrupted = files.filter(f => f.startsWith(prefix)).sort().reverse();
  for (const old of corrupted.slice(3)) {
    await rm(join(dir, old)).catch(() => {});
  }
  if (corrupted.length > 3) {
    console.log(`🗑️ Cleaned up ${corrupted.length - 3} old corrupted ${label} backups`);
  }
}

/**
 * Fall back to default runtime state after an unreadable state.json, backing
 * the bad bytes up first. Config is unaffected — it lives in its own file, so
 * there is nothing to recover here that state.json could have taken with it.
 */
async function recoverFromUnreadableState(content) {
  console.log(`⚠️ Corrupted or empty state file at ${STATE_FILE}, returning default state`);
  await quarantineCorruptFile(STATE_FILE, content, 'CoS state');
  return structuredClone(DEFAULT_STATE);
}

// In-memory config cache. Every mutation goes through `withConfigLock` +
// `saveConfig`, so the cache stays consistent.
let configCache = null;

/**
 * Read the raw persisted config object, and say where it came from.
 *
 * Prefers `data/cos/config.json`. `readJSONFileStrict` carries the Windows
 * swap-window retry, so a read landing between `atomicWrite`'s temp write and
 * its rename reports the real file rather than "absent" — reporting absent here
 * would fall through to the legacy path and, on an already-split install, hand
 * back DEFAULT_CONFIG. `ok: false` is present-but-unreadable, which is the only
 * case that quarantines.
 *
 * Falls back to the `config` slice a legacy `state.json` still carries (a peer
 * that has not upgraded, a restored pre-split backup) so an un-migrated install
 * never boots on bare defaults.
 */
async function readPersistedConfig() {
  const { ok, value } = await readJSONFileStrict(CONFIG_FILE, null, { allowArray: false, logError: true });
  if (ok && isPlainObject(value)) return { config: value, fromConfigFile: true };
  if (!ok) {
    console.log(`⚠️ Corrupted or empty config file at ${CONFIG_FILE}, falling back to legacy/default config`);
    const content = await readFile(CONFIG_FILE, 'utf-8').catch(() => '');
    await quarantineCorruptFile(CONFIG_FILE, content, 'CoS config', { remove: true });
  }
  // Back-compat read. Deliberately does NOT quarantine or rewrite state.json —
  // loadState() owns that file's recovery.
  if (!existsSync(STATE_FILE)) return { config: null, fromConfigFile: false };
  const stateContent = await readFile(STATE_FILE, 'utf-8');
  const state = parseStateFile(stateContent, 'CoS state (legacy config)');
  const legacy = state?.config;
  return { config: isPlainObject(legacy) ? legacy : null, fromConfigFile: false };
}

/**
 * Load the durable user configuration.
 */
export async function loadConfig() {
  if (configCache) return configCache;
  await ensureDirectories();
  const { config, fromConfigFile } = await readPersistedConfig();
  configCache = mergeStoredConfig(config);
  // Recovering settings out of a legacy state.json is a READ; nothing has
  // written them to their own file yet. `saveState` strips `config` from
  // state.json on the very next runtime write, so leaving the recovery in
  // memory would destroy those settings on the next restart. Complete the split
  // here — migration 339's job, done lazily for the installs it cannot reach (a
  // restored pre-split backup on a machine that already recorded it as applied).
  if (config && !fromConfigFile) {
    console.log(`📦 Recovered CoS config from a legacy state.json — writing ${CONFIG_FILE}`);
    await atomicWrite(CONFIG_FILE, configCache);
  }
  return configCache;
}

/**
 * Persist the durable user configuration to its own file. Keeps any live
 * `loadState()` result pointing at the same object so a state reader taken
 * before the write does not go stale.
 */
export async function saveConfig(config) {
  await ensureDirectories();
  configCache = config;
  if (stateCache) stateCache.config = config;
  await atomicWrite(CONFIG_FILE, config);
  return config;
}

// In-memory state cache — avoids re-reading state.json from disk on every call.
// All mutations go through withStateLock, so the cache stays consistent.
let stateCache = null;

// Master "Improve" flag with backward compat for the legacy split self/app flags.
// Falls through only when improvementEnabled is null/undefined — explicit `false` wins.
export function isImprovementEnabled(state) {
  return state.config.improvementEnabled ??
    (state.config.selfImprovementEnabled || state.config.appImprovementEnabled);
}

// Autonomous improvement-task QUEUING gate. Queuing mutates COS-TASKS.md with
// autonomous internal work, so it requires BOTH the idle-review flag AND the CoS
// auto-run domain in `execute` (off/dry-run are planning postures that withhold
// the queue mutation). Shared by the post-startup queue, the
// cos-improvement-check timer, and the perpetual drain-on-completion refill so
// the three gates can't drift apart.
export function canQueueImprovementTasks(state) {
  return Boolean(state.config.idleReviewEnabled) && getDomainMode(state.config, 'cos') === 'execute';
}

/**
 * Get current configuration. Reads the config file's own cache — it no longer
 * queues behind, or deserializes, the runtime records in state.json.
 */
export async function getConfig() {
  return loadConfig();
}

export async function loadState() {
  if (stateCache) return stateCache;

  await ensureDirectories();

  // Config is its own file now, so it survives every state.json failure path.
  const config = await loadConfig();

  if (!existsSync(STATE_FILE)) {
    stateCache = Object.assign(structuredClone(DEFAULT_STATE), { config });
    return stateCache;
  }

  const content = await readFile(STATE_FILE, 'utf-8');
  const state = parseStateFile(content);

  if (!state) {
    stateCache = Object.assign(await recoverFromUnreadableState(content), { config });
    return stateCache;
  }

  stateCache = {
    ...DEFAULT_STATE,
    ...state,
    // Always the config file's copy — a legacy `config` slice still sitting in
    // state.json was already folded in by `readPersistedConfig()`, and must
    // never shadow the (newer) config file on an install carrying both.
    config,
    stats: { ...DEFAULT_STATE.stats, ...state.stats },
    persistentMind: normalizePersistentMindState(state.persistentMind),
    agents: state.agents ?? {}
  };
  return stateCache;
}

// Read the persisted state for safety checks, bypassing both the cache and
// loadState()'s defaulting. Unlike loadState(), this deliberately does not
// replace malformed JSON with defaults: a gate that authorizes a destructive
// action must distinguish "known empty" from "could not establish what is
// there". `trusted: false` means the file exists but could not be read as an
// object — every caller must treat that as "assume the worst", never as empty.
async function readStateForSafetyCheck() {
  await ensureDirectories();
  if (!existsSync(STATE_FILE)) return { trusted: true, state: null };
  const content = await readFile(STATE_FILE, 'utf-8');
  const state = parseStateFile(content);
  if (!state) return { trusted: false, state: null };
  return { trusted: true, state };
}

// The Persistent Mind slice, for the update route's image-work gate.
export async function readPersistentMindStateForSafetyCheck() {
  const { trusted, state } = await readStateForSafetyCheck();
  return { trusted, persistentMind: trusted ? state?.persistentMind ?? null : null };
}

// The agent records, for the update route's live-agent gate. Same contract:
// `trusted: false` is "the records could not be established", which that gate
// must read as "an agent may be running", not as "no agents are running" —
// getting that backwards restarts PortOS out from under a live agent.
export async function readAgentsStateForSafetyCheck() {
  const { trusted, state } = await readStateForSafetyCheck();
  const agents = state?.agents;
  return {
    trusted,
    agents: trusted && isPlainObject(agents) ? agents : null,
  };
}

/**
 * Persist the runtime records. `config` is NOT this function's to write — it is
 * owned by `saveConfig()` / `updateConfig()` and lives in its own file.
 *
 * The cached state is re-anchored on the authoritative config object first, so
 * a caller that passed a state carrying a stale config (a shallow copy taken
 * before a concurrent `updateConfig`) or no config at all (a hand-built object)
 * can neither publish that copy nor leave `stateCache.config` undefined for the
 * next `state.config.…` reader. A caller wanting to CHANGE a setting must call
 * `updateConfig()`; `state.config` is a read-only view.
 */
export async function saveState(state) {
  await ensureDirectories();
  state.config = await loadConfig();
  stateCache = state;
  // Config lives in its own file; never re-serialize it onto the hot path.
  const persisted = { ...state };
  delete persisted.config;
  await atomicWrite(STATE_FILE, persisted);
}

// Resolve a single domain's autonomy mode (off | dry-run | execute) without
// importing cos.js (which would create circular deps). Domains gate their
// automatic behavior off this; an absent/invalid value resolves to `execute`.
export async function getDomainAutonomyMode(domainId) {
  const state = await loadState();
  return getDomainMode(state.config, domainId);
}

// Daemon state accessors — used by modules that need to check daemon status
// without importing cos.js (which would create circular deps)
let _daemonRunning = false;

export function isDaemonRunning() {
  return _daemonRunning;
}

export function setDaemonRunning(value) {
  _daemonRunning = value;
}
