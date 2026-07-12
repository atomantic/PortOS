/**
 * CoS State Module
 *
 * Shared state management for Chief of Staff services.
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { ensureDirs, safeJSONParse, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { normalizeDomainAutonomy, getDomainMode } from '../lib/domainAutonomy.js';
import { normalizeDomainBudgets } from '../lib/domainBudgets.js';
import { DEFAULT_ALWAYS_APPROVE_KINDS } from './taskLearning/safetyKind.js';

export const STATE_FILE = join(PATHS.cos, 'state.json');
export const AGENTS_DIR = join(PATHS.cos, 'agents');
export const REPORTS_DIR = PATHS.reports;
export const SCRIPTS_DIR = PATHS.scripts;
export const ROOT_DIR = PATHS.root;

// Serialize every state.json read-merge-write on a single tail so two
// concurrent loadState→modify→saveState cycles can't interleave and clobber
// each other. Standardized on `createFileWriteQueue` — the documented
// single-JSON-file write-serialization convention (CLAUDE.md; same mechanism
// settings.js and the issues/series/mediaCollections stores use) — instead of a
// bespoke async mutex. Identical `(fn) => Promise` contract, so the ~34 existing
// `withStateLock(...)` call sites are unchanged; the name is kept for that
// reason. The queue additionally silences its tail so one rejected write can't
// poison subsequent waiters (a strict improvement over the prior mutex).
export const withStateLock = createFileWriteQueue();

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
  comprehensiveAppImprovement: true,
  immediateExecution: true,
  proactiveMode: true,
  autonomousJobsEnabled: true,
  autonomyLevel: 'standby',
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
  config: DEFAULT_CONFIG,
  stats: {
    tasksCompleted: 0,
    totalRuntime: 0,
    agentsSpawned: 0,
    errors: 0,
    lastEvaluation: null,
    lastIdleReview: null
  },
  agents: {}
};

export async function ensureDirectories() {
  await ensureDirs([PATHS.data, PATHS.cos, AGENTS_DIR, REPORTS_DIR, SCRIPTS_DIR]);
}

function isValidJSON(str) {
  if (!str || !str.trim()) return false;
  const trimmed = str.trim();
  if (!(trimmed.startsWith('{') && trimmed.endsWith('}'))) return false;
  if (trimmed.includes('}{')) return false;
  return true;
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

export async function loadState() {
  if (stateCache) return stateCache;

  await ensureDirectories();

  if (!existsSync(STATE_FILE)) {
    stateCache = structuredClone(DEFAULT_STATE);
    return stateCache;
  }

  const content = await readFile(STATE_FILE, 'utf-8');

  if (!isValidJSON(content)) {
    console.log(`⚠️ Corrupted or empty state file at ${STATE_FILE}, returning default state`);
    const backupPath = `${STATE_FILE}.corrupted.${Date.now()}`;
    await writeFile(backupPath, content).catch(() => {});
    console.log(`📝 Backed up corrupted state to ${backupPath}`);
    // Cleanup old corrupted backups (keep only 3 most recent)
    const cosDir = dirname(STATE_FILE);
    const files = await readdir(cosDir).catch(() => []);
    const corrupted = files
      .filter(f => f.startsWith('state.json.corrupted.'))
      .sort()
      .reverse();
    for (const old of corrupted.slice(3)) {
      await rm(join(cosDir, old)).catch(() => {});
    }
    if (corrupted.length > 3) {
      console.log(`🗑️ Cleaned up ${corrupted.length - 3} old corrupted state backups`);
    }
    stateCache = structuredClone(DEFAULT_STATE);
    return stateCache;
  }

  const state = safeJSONParse(content, null, { logError: true, context: 'CoS state' });
  if (!state) {
    stateCache = structuredClone(DEFAULT_STATE);
    return stateCache;
  }

  // Migrate legacy split flags before merging defaults — DEFAULT_CONFIG.improvementEnabled = true
  // would otherwise shadow a v1 file that only set selfImprovementEnabled/appImprovementEnabled.
  const persistedConfig = state.config || {};
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

  stateCache = {
    ...DEFAULT_STATE,
    ...state,
    config: { ...DEFAULT_CONFIG, ...persistedConfig },
    stats: { ...DEFAULT_STATE.stats, ...state.stats },
    agents: state.agents ?? {}
  };
  return stateCache;
}

export async function saveState(state) {
  await ensureDirectories();
  stateCache = state;
  await atomicWrite(STATE_FILE, state);
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
