/**
 * Local Vitest worker budget derived from the CoS settings, so the app's
 * "max concurrent agents" is the one knob for host load — no env var to set.
 * Every concurrent agent may run its own gate, so the host's cores are divided
 * by that cap. The result only ever LOWERS the proven per-workspace cap.
 * Builtins only: vitest configs and pre-install scripts import this.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';

/** Mirrors DEFAULT_CONFIG.maxConcurrentAgents in server/services/cosState.js. */
export const DEFAULT_MAX_CONCURRENT_AGENTS = 3;

/**
 * Root of the primary checkout. A CoS worktree keeps its own near-empty
 * `data/`; the live CoS config belongs to the checkout the worktree hangs off.
 */
export function primaryCheckoutRoot(cwd = process.cwd()) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return gitDir ? dirname(gitDir) : cwd;
  } catch {
    return cwd;
  }
}

/** `maxConcurrentAgents` from data/cos/config.json; the shipped default when unreadable or invalid. */
export function readMaxConcurrentAgents(root = primaryCheckoutRoot()) {
  try {
    const value = JSON.parse(readFileSync(join(root, 'data', 'cos', 'config.json'), 'utf8'))?.maxConcurrentAgents;
    if (Number.isInteger(value) && value >= 1) return value;
  } catch { /* absent or corrupt config: fall through to the default */ }
  return DEFAULT_MAX_CONCURRENT_AGENTS;
}

export function cosWorkerBudget({ cpus = availableParallelism(), agents = readMaxConcurrentAgents(), maxWorkers = 4 } = {}) {
  return Math.max(1, Math.min(maxWorkers, Math.floor(cpus / agents)));
}
