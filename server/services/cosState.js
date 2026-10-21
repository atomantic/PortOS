import { normalizePersistentMindMaintainer } from '../lib/persistentMindMaintainer.js';
/**
 * CoS State Module
 *
 * Shared state management for Chief of Staff services.
 */

import { readFile, readdir, rm, rename, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createEventLoopLagProbe, roundMs, systemClock } from '../lib/eventLoopLagProbe.js';
import { ensureDirs, safeJSONParse, readJSONFileStrict, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { isPlainObject } from '../lib/objects.js';
import { normalizeDomainAutonomy, getDomainMode } from '../lib/domainAutonomy.js';
import { normalizeDomainBudgets } from '../lib/domainBudgets.js';
import { createDefaultPersistentMindState, normalizePersistentMindState } from '../lib/persistentMind.js';
import { createDefaultPersistentMindCapabilities, normalizePersistentMindCapabilities } from '../lib/persistentMindCapabilities.js';
import { createDefaultPersistentMindProfile, normalizePersistentMindProfile } from '../lib/persistentMindProfile.js';
import { createDefaultPersistentMindPrompt, normalizePersistentMindPrompt } from '../lib/persistentMindPrompt.js';
import { createDefaultPersistentMindPlaybook, normalizePersistentMindPlaybook } from '../lib/persistentMindPlaybook.js';
import {
  createDefaultPersistentMindThinkingPresets,
  normalizePersistentMindThinkingPresets,
} from '../lib/persistentMindThinkingPresets.js';
import { cosEvents } from './cosEvents.js';
import { planAgentSave } from '../lib/cosAgentRows.js';
import { applyAgentSave, loadAgentRows } from './cosAgentRepository.js';
import { isFileBackend } from '../lib/pgFileFacade.js';
import { ServerError } from '../lib/errorHandler.js';
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
const stateQueue = createFileWriteQueue();

// Slow-operation diagnostics (#12329): only bounded numbers reach the log, and
// only for an operation at or above this duration. Each held operation's time
// is split into event-loop lag and the rest, so a stalled queue can be told
// apart from a busy host (see docs/TROUBLESHOOTING.md).
export const SLOW_STATE_OPERATION_MS = 1000;
let stateClock = systemClock;
let stateLagProbe = createEventLoopLagProbe({ clock: stateClock });

/** Inject a deterministic clock; `null` restores the system clock. */
export function __setCosStateDiagnosticsClockForTests(clock) {
  stateClock = clock ?? systemClock;
  stateLagProbe = createEventLoopLagProbe({ clock: stateClock });
}

export function withStateLock(fn) {
  const queuedAt = stateClock.now();
  return stateQueue(async () => {
    const waitMs = roundMs(stateClock.now() - queuedAt);
    const span = stateLagProbe.begin('hold');
    try {
      return await fn();
    } finally {
      const { totalMs, lagMs, lagMaxMs } = span.end();
      if (totalMs >= SLOW_STATE_OPERATION_MS) {
        console.warn(`🐢 CoS state queue slow hold heldMs=${totalMs} waitMs=${waitMs} loopLagMs=${lagMs} loopLagMaxMs=${lagMaxMs}`);
      }
    }
  });
}

// Config gets its OWN tail, so a settings read or write never queues behind the
// runtime-record writes that dominate state.json (#6182). Same
// `(fn) => Promise` contract as `withStateLock`.
export const withConfigLock = createFileWriteQueue();

export const DEFAULT_CONFIG = {
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
  // Start CoS with the server. FALSE is the shipped posture: an install that
  // has never been configured must not begin autonomous, LLM-backed work on its
  // own (AGENTS.md, "No cold-bootstrap LLM calls"), and every other work-
  // generation flag below defaults on. This used to read `true` and was masked
  // by a `data.reference/cos/config.json` seed seeding `false` over it; the
  // seed is gone (see scripts/migrations/340-cos-config-seed-repair.js), so the
  // default is now the only thing a fresh install reads.
  alwaysOn: false,
  appReviewCooldownMs: 1800000,
  idleReviewEnabled: true,
  idleReviewPriority: 'MEDIUM',
  autonomousJobsEnabled: true,
  // Investigation tasks normally hold only failure loops for a human. This
  // opt-in also admits those loop/storm investigations unattended.
  autoApproveInvestigations: false,
  // Persisting a profile is not consent to wake the mind. Fresh and upgraded
  // installs stay disabled until the user explicitly starts it.
  persistentMindMaintainer: normalizePersistentMindMaintainer(),
  persistentMindProfile: createDefaultPersistentMindProfile(),
  persistentMindThinkingPresets: createDefaultPersistentMindThinkingPresets(),
  persistentMindPrompt: createDefaultPersistentMindPrompt(),
  persistentMindPlaybook: createDefaultPersistentMindPlaybook(),
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
  delete persistedConfig.proactiveMode;

  return {
    ...DEFAULT_CONFIG,
    ...persistedConfig,
    persistentMindCapabilities: normalizePersistentMindCapabilities(persistedConfig.persistentMindCapabilities),
    persistentMindMaintainer: normalizePersistentMindMaintainer(persistedConfig.persistentMindMaintainer),
    persistentMindProfile: normalizePersistentMindProfile(persistedConfig.persistentMindProfile),
    persistentMindThinkingPresets: normalizePersistentMindThinkingPresets(persistedConfig.persistentMindThinkingPresets),
    persistentMindPrompt: normalizePersistentMindPrompt(persistedConfig.persistentMindPrompt),
    persistentMindPlaybook: normalizePersistentMindPlaybook(persistedConfig.persistentMindPlaybook),
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
let configLoad = null;
// Enumerable symbols survive a caller's shallow copy but never reach JSON.
// Reject delayed writeback of a pre-restore read, even if queued afterwards.
const RESTORE_GENERATION = Symbol('cosRestoreGeneration');
const WRITE_GENERATION = Symbol('cosWriteGeneration');
const stateRecovery = { generation: 0, required: false };
const configRecovery = { generation: 0, required: false };
let restoreGeneration = 0;
function stampGeneration(value, recovery) {
  value[RESTORE_GENERATION] = restoreGeneration;
  value[WRITE_GENERATION] = recovery.generation;
  return value;
}
function assertCurrentGeneration(value, recovery) {
  if (value[RESTORE_GENERATION] !== undefined && value[RESTORE_GENERATION] !== restoreGeneration) {
    throw new ServerError('CoS files were restored. Read the current state before retrying this change.', {
      status: 409, code: 'COS_RESTORE_STALE_WRITE',
    });
  }
  if (recovery.required || (value[WRITE_GENERATION] !== undefined && value[WRITE_GENERATION] !== recovery.generation)) {
    throw new ServerError('A CoS write failed. Read the current persisted state before retrying this change.', {
      status: 409, code: 'COS_PERSISTENCE_STALE_WRITE',
    });
  }
}

function invalidateFailedWrite(recovery) {
  recovery.generation += 1;
  recovery.required = true;
}

// After an uncertain write, never replace unreadable ownership/settings with
// defaults. Only a fresh trusted read may clear the recovery requirement.
async function readRecoveryFile(filePath) {
  const missing = Symbol('missing');
  const { ok, value } = await readJSONFileStrict(filePath, missing, { allowArray: false, logError: true });
  if (!ok || (value !== missing && !isPlainObject(value))) {
    throw new ServerError('CoS persistence recovery requires a readable state/config file. Repair the file before retrying.', {
      status: 503, code: 'COS_PERSISTENCE_RECOVERY_REQUIRED',
    });
  }
  return value === missing ? null : value;
}

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
  const { ok, value } = configRecovery.required
    ? { ok: true, value: await readRecoveryFile(CONFIG_FILE) }
    : await readJSONFileStrict(CONFIG_FILE, null, { allowArray: false, logError: true });
  if (ok && isPlainObject(value)) return { config: value, fromConfigFile: true };
  if (!ok) {
    console.log(`⚠️ Corrupted or empty config file at ${CONFIG_FILE}, falling back to legacy/default config`);
    const content = await readFile(CONFIG_FILE, 'utf-8').catch(() => '');
    await quarantineCorruptFile(CONFIG_FILE, content, 'CoS config', { remove: true });
  }
  // Back-compat read. Deliberately does NOT quarantine or rewrite state.json —
  // loadState() owns that file's recovery.
  if (!configRecovery.required && !existsSync(STATE_FILE)) return { config: null, fromConfigFile: false };
  const state = configRecovery.required
    ? await readRecoveryFile(STATE_FILE)
    : parseStateFile(await readFile(STATE_FILE, 'utf-8'), 'CoS state (legacy config)');
  const legacy = state?.config;
  return { config: isPlainObject(legacy) ? legacy : null, fromConfigFile: false };
}

/**
 * Load the durable user configuration.
 */
export async function loadConfig() {
  if (configCache) return configCache;
  // The legacy split writes during a read. Share its settlement so another
  // loader cannot overwrite a subsequent settings change with the legacy copy.
  if (configLoad) return configLoad;
  configLoad = readConfig();
  try {
    return await configLoad;
  } finally {
    configLoad = null;
  }
}

async function readConfig() {
  if (configCache) return configCache;
  const generation = configRecovery.generation;
  const restored = restoreGeneration;
  await ensureDirectories();
  const { config, fromConfigFile } = await readPersistedConfig();
  if (configCache || generation !== configRecovery.generation || restored !== restoreGeneration) return readConfig();
  const loaded = stampGeneration(mergeStoredConfig(config), configRecovery);
  // Recovering settings out of a legacy state.json is a READ; nothing has
  // written them to their own file yet. `saveState` strips `config` from
  // state.json on the very next runtime write, so leaving the recovery in
  // memory would destroy those settings on the next restart. Complete the split
  // here — migration 339's job, done lazily for the installs it cannot reach (a
  // restored pre-split backup on a machine that already recorded it as applied).
  if (config && !fromConfigFile) {
    console.log(`📦 Recovered CoS config from a legacy state.json — writing ${CONFIG_FILE}`);
    try {
      await atomicWrite(CONFIG_FILE, loaded);
    } catch (error) {
      configCache = null;
      invalidateFailedWrite(configRecovery);
      throw error;
    }
  }
  if (configCache || generation !== configRecovery.generation || restored !== restoreGeneration) return readConfig();
  configCache = loaded;
  configRecovery.required = false;
  if (stateCache) stateCache.config = configCache;
  return configCache;
}

/**
 * Persist the durable user configuration to its own file. Keeps any live
 * `loadState()` result pointing at the same object so a state reader taken
 * before the write does not go stale.
 */
export async function saveConfig(config) {
  assertCurrentGeneration(config, configRecovery);
  stampGeneration(config, configRecovery);
  try {
    await ensureDirectories();
    await atomicWrite(CONFIG_FILE, config);
  } catch (error) {
    // Callers may have mutated the shared object in place; a prior pointer is
    // not a rollback image. The write may also have reached disk before failing.
    configCache = null;
    invalidateFailedWrite(configRecovery);
    throw error;
  }
  configCache = stampGeneration(config, configRecovery);
  if (stateCache) stateCache.config = configCache;
  return configCache;
}

// In-memory state cache — avoids re-reading state.json from disk on every call.
// All mutations go through withStateLock, so the cache stays consistent.
let stateCache = null;
// What `cos_agents` holds for the cached `state.agents` (#12738): the store
// version and each record's stored JSON text, so a save writes only the rows
// whose serialization changed. `lastStatePayload` is the last state.json body
// written, so an agent-only save does not rewrite the file at all.
let agentStore = null;
let lastStatePayload = null;
let warnedLegacyAgents = false;

// db-migrations 020/021 move a legacy state.json `agents` map into cos_agents,
// but boot starts CoS before the database phase runs them. A read of a file that
// still carries the map would cache an empty agent set, and its next save would
// drop the map before 020 could import it. So that read waits for the boot to
// report the migrations settled (bounded, so an early awaited caller fails
// loudly instead of deadlocking the boot). Steady state never waits: the map is
// gone once 021 has run.
const AGENT_MIGRATION_WAIT_MS = 120_000;
let settleAgentMigrations;
let agentMigrationsSettled = false;
const agentMigrations = new Promise((resolve) => { settleAgentMigrations = resolve; });

/** Called by the boot once the DB migrations have run (or were skipped by the escape hatch). */
export function markCosAgentMigrationsSettled() {
  agentMigrationsSettled = true;
  settleAgentMigrations();
}

async function awaitAgentMigrations() {
  if (agentMigrationsSettled || isFileBackend()) return;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ServerError('CoS agent records are still being migrated into the database. Retry once startup finishes.', {
      status: 503, code: 'COS_AGENTS_MIGRATING',
    })), AGENT_MIGRATION_WAIT_MS);
    timer.unref?.();
  });
  try {
    await Promise.race([agentMigrations, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function dropRuntimeCaches() {
  stateCache = null;
  agentStore = null;
  lastStatePayload = null;
}

async function loadAgentStore() {
  const { version, rows } = await loadAgentRows();
  const persisted = new Map(rows.map((row) => [row.id, row.body]));
  const agents = Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.body)]));
  return { store: { version, persisted }, agents };
}

// atomicWrite's temp name is `<file>.<pid>.<ms>.<uuid>.tmp`; a process killed
// mid-write leaves one behind. Sweep once per process, never this process's own
// (it may be mid-write) and never one younger than a minute.
const STATE_TEMP = /^state\.json\.(\d+)\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
const STATE_TEMP_MIN_AGE_MS = 60_000;
let stateTempSweep = null;
function sweepStaleStateTempFiles() {
  stateTempSweep ??= (async () => {
    const now = Date.now();
    const names = await readdir(PATHS.cos).catch(() => []);
    let removed = 0;
    for (const name of names) {
      const match = STATE_TEMP.exec(name);
      if (!match || Number(match[1]) === process.pid) continue;
      const path = join(PATHS.cos, name);
      const info = await stat(path).catch(() => null);
      if (!info?.isFile() || now - info.mtimeMs < STATE_TEMP_MIN_AGE_MS) continue;
      if (await rm(path).then(() => true, () => false)) removed += 1;
    }
    if (removed > 0) console.log(`🧹 Removed ${removed} stale CoS state temp file(s) left by interrupted writes`);
    return removed;
  })();
  return stateTempSweep;
}

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
  // Config recovery must also repair a warm runtime cache's config view.
  const config = await loadConfig();
  if (stateCache) {
    stateCache.config = config;
    return stateCache;
  }

  const generation = stateRecovery.generation;
  const restored = restoreGeneration;
  await ensureDirectories();
  await sweepStaleStateTempFiles();
  let state;
  if (stateRecovery.required) {
    state = await readRecoveryFile(STATE_FILE);
  } else if (existsSync(STATE_FILE)) {
    const content = await readFile(STATE_FILE, 'utf-8');
    state = parseStateFile(content) ?? await recoverFromUnreadableState(content);
  }
  if (state && Object.hasOwn(state, 'agents') && !agentMigrationsSettled && !isFileBackend()) {
    await awaitAgentMigrations();
    return loadState();
  }
  const { store, agents } = await loadAgentStore();
  // A concurrent read/write or restore may have superseded this read.
  if (stateCache || generation !== stateRecovery.generation || restored !== restoreGeneration) return loadState();

  // Agent records live in cos_agents (db-migrations 020/021 moved them). A
  // state.json that still carries the map (a restored pre-migration file) is not
  // read: the database is the only source, and the next save drops the key.
  if (state && Object.hasOwn(state, 'agents') && !warnedLegacyAgents) {
    warnedLegacyAgents = true;
    console.warn(`⚠️ ${STATE_FILE} carries a legacy agents map; ignoring it — agent records are stored in cos_agents`);
  }
  agentStore = store;
  lastStatePayload = null;
  stateCache = state ? {
    ...DEFAULT_STATE,
    ...state,
    // Legacy state.json settings must never shadow the independent config file.
    config,
    stats: { ...DEFAULT_STATE.stats, ...state.stats },
    persistentMind: normalizePersistentMindState(state.persistentMind),
    agents
  } : Object.assign(structuredClone(DEFAULT_STATE), { config, agents });
  stateRecovery.required = false;
  return stampGeneration(stateCache, stateRecovery);
}

// Read the persisted state for safety checks, bypassing both the cache and
// loadState()'s defaulting. Unlike loadState(), this deliberately does not
// replace malformed JSON with defaults: a gate that authorizes a destructive
// action must distinguish "known empty" from "could not establish what is
// there". `trusted: false` means the file exists but could not be read as an
// object — every caller must treat that as "assume the worst", never as empty.
async function readStateForSafetyCheck({ onStage } = {}) {
  onStage?.('read');
  await ensureDirectories();
  if (!existsSync(STATE_FILE)) return { trusted: true, state: null };
  const content = await readFile(STATE_FILE, 'utf-8');
  onStage?.('parse');
  const state = parseStateFile(content);
  if (!state) return { trusted: false, state: null };
  return { trusted: true, state };
}

// The stored agent records, read from cos_agents rather than the cache. A store
// that cannot be read is `trusted: false`, never an empty map.
async function readStoredAgentsForSafetyCheck({ onStage } = {}) {
  onStage?.('agents');
  try {
    return { trusted: true, agents: (await loadAgentStore()).agents };
  } catch (error) {
    console.warn(`⚠️ CoS agent records could not be read for a safety check: ${error.message}`);
    return { trusted: false, agents: null };
  }
}

// Merge admission shares the runtime ownership store and its write queue.
// Missing leases are legacy empty state; malformed leases are never defaulted.
// `onStage('read'|'parse'|'agents')` marks each stage for slow-admission diagnostics.
export async function readMergeAdmissionStateForSafetyCheck({ onStage } = {}) {
  const { trusted, state } = await readStateForSafetyCheck({ onStage });
  const stored = await readStoredAgentsForSafetyCheck({ onStage });
  return {
    trusted: trusted && stored.trusted,
    agents: stored.agents,
    mergeAdmissions: state && Object.hasOwn(state, 'mergeAdmissions') ? state.mergeAdmissions : {},
  };
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
  return readStoredAgentsForSafetyCheck();
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
 *
 * `onStage` is called as each persistence stage begins (`prepare`, `serialize`,
 * `write`, `replace`, `dirSync`) for a caller's own slow-operation diagnostics.
 */
export async function saveState(state, { onStage } = {}) {
  assertCurrentGeneration(state, stateRecovery);
  stampGeneration(state, stateRecovery);
  const span = stateLagProbe.begin('prepare');
  const stage = (name) => { span.mark(name); onStage?.(name); };
  onStage?.('prepare');
  let bytes = 0;
  let outcome = 'failed';
  try {
    await ensureDirectories();
    state.config = await loadConfig();
    // A save with no cached read behind it goes through loadState first, so it
    // waits out a pending agent migration (and loads the store) like any read.
    if (!agentStore) await loadState();
    // Agent records are rows: write only those whose serialization changed, so
    // one agent's update never rewrites another's (#12738).
    stage('agents');
    const plan = planAgentSave({ persisted: agentStore.persisted, next: isPlainObject(state.agents) ? state.agents : {} });
    if (plan.upserts.length > 0 || plan.deletes.length > 0) {
      agentStore = { version: await applyAgentSave(plan, agentStore.version), persisted: plan.persisted };
      bytes += plan.upserts.reduce((sum, row) => sum + Buffer.byteLength(row.body), 0);
    }
    // Config lives in its own file and agents in cos_agents; never re-serialize
    // either onto the hot path. An unchanged remainder is not rewritten.
    const persisted = { ...state };
    delete persisted.config;
    delete persisted.agents;
    stage('serialize');
    const payload = JSON.stringify(persisted, null, 2);
    if (payload !== lastStatePayload) {
      bytes += Buffer.byteLength(payload);
      await atomicWrite(STATE_FILE, payload, { onStage: stage });
      lastStatePayload = payload;
    }
    outcome = 'saved';
  } catch (error) {
    dropRuntimeCaches();
    invalidateFailedWrite(stateRecovery);
    throw error;
  } finally {
    const summary = span.end();
    if (summary.totalMs >= SLOW_STATE_OPERATION_MS) {
      const ms = (name) => summary.phases[name]?.ms ?? 0;
      console.warn(`🐢 CoS state write slow outcome=${outcome} totalMs=${summary.totalMs} prepareMs=${ms('prepare')} agentsMs=${ms('agents')} serializeMs=${ms('serialize')} writeMs=${ms('write')} replaceMs=${ms('replace')} dirSyncMs=${ms('dirSync')} loopLagMs=${summary.lagMs} loopLagMaxMs=${summary.lagMaxMs} sizeKiB=${Math.round(bytes / 1024)}`);
    }
  }
  stateCache = stampGeneration(state, stateRecovery);
}

const legacyConfigSlice = (state) => (isPlainObject(state?.config) ? JSON.stringify(state.config) : null);

/**
 * A snapshot taken before the #6182 split keeps the CoS config inside
 * state.json and carries no config.json. Restored over an upgraded install, the
 * live config.json is newer than the snapshot yet wins every read (and migration
 * 339 no-ops on its presence), so the restored settings were silently discarded
 * and then stripped by the next saveState. After a transfer that completed and
 * installed the snapshot's slice, move config.json aside — kept for manual
 * recovery, never deleted — so readConfig() completes the split from the
 * restored slice. A failed transfer is left alone: the live state.json may
 * already hold the same slice without this restore having installed it.
 */
async function supersedeConfigForRestoredLegacySlice(snapshotLegacyConfig) {
  if (!existsSync(STATE_FILE) || !existsSync(CONFIG_FILE)) return;
  const restored = legacyConfigSlice(parseStateFile(await readFile(STATE_FILE, 'utf-8'), 'CoS state (restored legacy config)'));
  if (restored === null || restored !== JSON.stringify(snapshotLegacyConfig)) return;
  const parked = join(dirname(CONFIG_FILE), `config.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await rename(CONFIG_FILE, parked);
  console.log(`📦 Restored snapshot predates config.json; moved the newer CoS config aside to ${basename(parked)} and recovering settings from the restored state.json`);
}

/**
 * Drain config, then runtime mutations and keep both queues until transfer and
 * reload settle. This order matches config changes that consult runtime state;
 * never acquire the config queue from inside the state queue.
 * Callers must read their mutation's pre-image INSIDE its respective queue.
 * `snapshotLegacyConfig` is the config slice a pre-split snapshot installs, if
 * any (see supersedeConfigForRestoredLegacySlice).
 */
export function withLiveCosRestore(transfer, { snapshotLegacyConfig = null } = {}) {
  return withConfigLock(() => withStateLock(async () => {
    const persisted = await readStateForSafetyCheck();
    const stored = await readStoredAgentsForSafetyCheck();
    const states = [stateCache, persisted.state].filter(Boolean);
    const agentMaps = [stateCache?.agents, stored.agents].filter((agents) => agents != null);
    const unsafe = !persisted.trusted || !stored.trusted || isDaemonRunning() || states.some(state =>
      state.running || state.persistentMind?.started || state.persistentMind?.activeTurn)
      || agentMaps.some(agents => !isPlainObject(agents) || Object.values(agents).some(agent =>
        !['completed', 'failed', 'cancelled'].includes(agent?.status)));
    if (unsafe) {
      throw new ServerError('Stop the CoS daemon and Persistent Mind, and finish or stop active agents before restoring CoS files. Repair unreadable CoS state before retrying.', {
        status: 409, code: 'COS_RESTORE_BUSY',
      });
    }

    const [result] = await Promise.allSettled([Promise.resolve().then(transfer)]);
    restoreGeneration += 1;
    configCache = null;
    dropRuntimeCaches();
    const [reload] = await Promise.allSettled([(async () => {
      if (snapshotLegacyConfig && result.status === 'fulfilled') await supersedeConfigForRestoredLegacySlice(snapshotLegacyConfig);
      const { reloadAgentIndexAfterRestore } = await import('./cosAgentIndex.js');
      await reloadAgentIndexAfterRestore();
      const state = await loadState();
      cosEvents.emit('config:changed', state.config);
    })()]);
    if (result.status === 'rejected') {
      if (reload.status === 'rejected') {
        const error = new Error(`${result.reason.message}. CoS cache reload failed: ${reload.reason.message}. Restart PortOS before using CoS.`, { cause: result.reason });
        if (result.reason.code) error.code = result.reason.code;
        throw error;
      }
      throw result.reason;
    }
    if (reload.status === 'rejected') {
      throw new Error(`CoS cache reload failed: ${reload.reason.message}. Restart PortOS before using CoS.`, { cause: reload.reason });
    }
    return result.value;
  }));
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
