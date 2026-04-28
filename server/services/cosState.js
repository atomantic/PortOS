/**
 * CoS State Module
 *
 * Shared state management for Chief of Staff services.
 */

import { readFile, writeFile, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { createMutex } from '../lib/asyncMutex.js';
import { ensureDirs, safeJSONParse, PATHS, atomicWrite } from '../lib/fileUtils.js';

export const STATE_FILE = join(PATHS.cos, 'state.json');
export const AGENTS_DIR = join(PATHS.cos, 'agents');
export const REPORTS_DIR = PATHS.reports;
export const SCRIPTS_DIR = PATHS.scripts;
export const ROOT_DIR = PATHS.root;

// Mutex lock for state operations to prevent race conditions
export const withStateLock = createMutex();

export const DEFAULT_CONFIG = {
  userTasksFile: 'data/TASKS.md',
  cosTasksFile: 'data/COS-TASKS.md',
  goalsFile: 'GOALS.md',
  evaluationIntervalMs: 60000,
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

// Daemon state accessors — used by modules that need to check daemon status
// without importing cos.js (which would create circular deps)
let _daemonRunning = false;

export function isDaemonRunning() {
  return _daemonRunning;
}

export function setDaemonRunning(value) {
  _daemonRunning = value;
}
