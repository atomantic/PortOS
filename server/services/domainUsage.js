/**
 * Per-domain autonomy usage ledger (#711, budgets slice).
 *
 * Tracks how much autonomous work each domain has done *today* so the gate
 * sites can compare it against the per-domain caps in `lib/domainBudgets.js`.
 * Where `domainAutonomy` answers "may this domain act?" and `domainBudgets`
 * defines the caps, this service is the running tally that makes the caps bite.
 *
 * Storage is one small rolling-day JSON file (`data/cos/domain-usage.json`):
 * `{ date: 'YYYY-MM-DD', usage: { brain: { actions, ms }, ... } }`. When the
 * stored date isn't today the ledger resets to zero on the next read or write —
 * so "daily" budgets reset at UTC midnight, matching how `cosAgents` buckets
 * completed agents by `toISOString().slice(0,10)` (budgets and agent archives
 * roll over together). All writes serialize on a single file write tail.
 */

import { join } from 'path';
import { PATHS, atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { DOMAIN_IDS } from '../lib/domainAutonomy.js';
import { getDomainBudget, hasBudget, evaluateBudget } from '../lib/domainBudgets.js';
import { loadState } from './cosState.js';

export const USAGE_FILE = join(PATHS.cos, 'domain-usage.json');

// Single tail so two concurrent record calls can't read-modify-write the same
// ledger file and clobber each other (same convention as cosState's withStateLock).
const usageWriteTail = createFileWriteQueue();

// The UTC calendar day key the ledger buckets against. Exported for tests.
export function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function emptyUsageMap() {
  return Object.fromEntries(DOMAIN_IDS.map((id) => [id, { actions: 0, ms: 0 }]));
}

// Read the ledger from disk, rolling it to a fresh empty map when the stored
// date isn't today (or the file is missing / hand-edited into a bad shape).
async function readFreshLedger() {
  const today = todayKey();
  const stored = await readJSONFile(USAGE_FILE, null, { logError: false });
  if (!stored || stored.date !== today || typeof stored.usage !== 'object' || stored.usage === null) {
    return { date: today, usage: emptyUsageMap() };
  }
  // Backfill any domain missing from an older-shape / partial file, and coerce
  // non-numeric tallies to 0 so a hand edit can't poison the math.
  const usage = emptyUsageMap();
  for (const id of DOMAIN_IDS) {
    const u = stored.usage[id];
    if (u && typeof u === 'object') {
      usage[id] = { actions: Number(u.actions) || 0, ms: Number(u.ms) || 0 };
    }
  }
  return { date: today, usage };
}

/**
 * Add to a domain's usage for today (rolling the ledger to a new day if needed).
 * No-op for unknown domains or an empty delta.
 *
 * @param {string} domainId - one of DOMAIN_IDS
 * @param {{actions?: number, ms?: number}} delta
 */
export async function recordDomainUsage(domainId, { actions = 0, ms = 0 } = {}) {
  if (!DOMAIN_IDS.includes(domainId)) return;
  const addActions = Number(actions) || 0;
  const addMs = Number(ms) || 0;
  if (!addActions && !addMs) return;
  await usageWriteTail(async () => {
    const ledger = await readFreshLedger();
    ledger.usage[domainId].actions += addActions;
    ledger.usage[domainId].ms += addMs;
    await atomicWrite(USAGE_FILE, ledger);
  });
}

/**
 * Today's accumulated usage for one domain.
 * @returns {Promise<{actions: number, ms: number}>}
 */
export async function getDomainUsageToday(domainId) {
  const ledger = await readFreshLedger();
  return ledger.usage[domainId] || { actions: 0, ms: 0 };
}

/**
 * Today's usage for every domain (for the settings UI).
 * @returns {Promise<{date: string, usage: Record<string, {actions: number, ms: number}>}>}
 */
export async function getAllDomainUsageToday() {
  return readFreshLedger();
}

/**
 * Resolve a domain's live budget status from the stored CoS config + today's
 * usage. Domains with no caps short-circuit without reading the ledger. Returns
 * the budget and usage too, so the gate sites can log/display specifics.
 *
 * @param {string} domainId - one of DOMAIN_IDS
 * @returns {Promise<{withinBudget: boolean, exceeded: 'actions'|'minutes'|null,
 *   budget: object, usage: {actions: number, ms: number}}>}
 */
export async function getDomainBudgetStatus(domainId) {
  const state = await loadState();
  const budget = getDomainBudget(state.config, domainId);
  if (!hasBudget(budget)) {
    return { withinBudget: true, exceeded: null, budget, usage: { actions: 0, ms: 0 } };
  }
  const usage = await getDomainUsageToday(domainId);
  const { withinBudget, exceeded } = evaluateBudget(budget, usage);
  return { withinBudget, exceeded, budget, usage };
}
