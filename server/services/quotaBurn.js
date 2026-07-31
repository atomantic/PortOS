import { getProviderQuotas } from './providerUsage.js';
import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';

export const QUOTA_BURN_TASK_TYPE = 'quota-burn';
const LEDGER_FILE = join(PATHS.cos, 'quota-burn-dispatches.json');
const AGENT_DISPATCH_LEDGER_KEY = '__agentDispatches';
export const DEFAULT_QUOTA_BURN_FAMILY = {
  enabled: false,
  providerId: null,
  model: null,
  scope: null,
  resetWithinHours: 24,
  reservePercent: 0,
  maxDispatchesPerWindow: 5,
  priority: 0,
  prompt: '',
};

export function quotaBurnConfig(app) {
  const metadata = app?.taskTypeOverrides?.[QUOTA_BURN_TASK_TYPE]?.taskMetadata;
  return metadata && typeof metadata === 'object' ? metadata : { families: {} };
}

async function readQuotaBurnLedger() {
  const loaded = await readJSONFile(LEDGER_FILE, {});
  return loaded && typeof loaded === 'object' ? loaded : {};
}

export async function getQuotaBurnDispatches() {
  const { [AGENT_DISPATCH_LEDGER_KEY]: _agentDispatches, ...counts } = await readQuotaBurnLedger();
  return counts;
}

// Single-tail queue for the dispatch ledger's read-modify-write. Two quota-burn
// agents (one per app) can finalize concurrently, and each finalization records a
// dispatch — unserialized, both would read the same count and write the same
// increment, losing one burn. An undercounted ledger then lets the window
// dispatch past `maxDispatchesPerWindow`, which is real quota overspend. This is
// the "serialize two write paths that mutate the same record" case, not a
// defense against competing users. It only became reachable when the write moved
// from generation (sequential, one app at a time) to finalize (#3179).
//
// `__agentDispatches` keeps the increment idempotent across a crash between the
// hook side effect and finalizeAgent's separate agent-marker write (#3182). It
// lives in this SAME atomic ledger write and leaves window counts as top-level
// numbers, so an older PortOS version still reads and updates the file safely.
const ledgerWriteQueue = createFileWriteQueue();

export async function recordQuotaBurnDispatch(key, { agentId = null } = {}) {
  return ledgerWriteQueue(async () => {
    const ledger = await readQuotaBurnLedger();
    const agentDispatches = ledger[AGENT_DISPATCH_LEDGER_KEY];
    const seenAgents = agentDispatches && typeof agentDispatches === 'object' ? agentDispatches : {};
    if (agentId && seenAgents[agentId]) return ledger;
    const next = {
      ...ledger,
      [key]: Number(ledger[key] || 0) + 1,
      ...(agentId ? {
        [AGENT_DISPATCH_LEDGER_KEY]: { ...seenAgents, [agentId]: key }
      } : {}),
    };
    await atomicWrite(LEDGER_FILE, next);
    return next;
  });
}

/**
 * The task-metadata key a resolved `dispatchKey` rides across on, from the
 * pre-agent `buildTaskInput` hook to the post-agent `processTaskOutput` that
 * writes the ledger (#3179). Lives here, beside the ledger it guards, so the
 * producer, the consumer, and the in-flight count below can't drift on spelling.
 */
export const QUOTA_BURN_DISPATCH_KEY_FIELD = 'quotaBurnDispatchKey';

/**
 * Dispatch counts to select the next burn candidate against: the persisted
 * ledger PLUS every quota-burn task already queued or running that carries a
 * dispatch key but has not reached its post-agent ledger write yet.
 *
 * Counting the in-flight tasks is what keeps the window cap honest now that the
 * ledger is written post-agent (#3179). The ledger write used to happen during
 * generation, which incidentally serialized sibling candidates — the next reader
 * always saw it. Deferring the write opens a gap between "task created" and
 * "dispatch recorded", and two paths generate inside that gap: the per-app
 * improvement loop runs once per managed app while `dispatchKey` is
 * `<family>:<resetEpoch>` (app-independent, one global ledger), and an on-demand
 * "Run" calls the generator directly, bypassing the per-app pending-task cap
 * entirely. Without this, either could dispatch past `maxDispatchesPerWindow` —
 * real quota overspend, the exact thing the cap exists to prevent, and a worse
 * failure than the over-counting #3179 fixed.
 *
 * `ignoreTaskId` excludes one task from the in-flight tally — the same exclusion
 * `buildImprovementDedupSets` takes, for the same reason. `agent:completed` fires
 * from `completeAgent`, which runs AFTER the output hook wrote this run's ledger
 * entry but BEFORE the completion flow's `updateTask` marks the task done. So
 * during the perpetual drain-on-completion refill the just-finished burn is
 * counted twice — once in the ledger, once as a still-`in_progress` task — and a
 * family with `maxDispatchesPerWindow: 2` would stop after one run and likely
 * miss its reset window. Callers on that path pass the completing task's id.
 *
 * An unreadable task file degrades to the ledger-only count rather than throwing:
 * COS-TASKS.md is the file the whole CoS queue reads, so if it is unavailable
 * nothing is dispatching anyway, and failing the probe closed would wedge
 * quota-burn until the next 12-hourly recheck.
 */
export async function getEffectiveQuotaBurnDispatches({ ignoreTaskId = null } = {}) {
  const counts = { ...(await getQuotaBurnDispatches()) };
  // Lazy import: cosTaskStore pulls a heavy graph (state, code review, merge),
  // and quotaBurn.js is imported by the perpetual-work detector on a hot path.
  const { getCosTasks } = await import('./cosTaskStore.js');
  const cosTasks = await getCosTasks().catch((err) => {
    console.error(`❌ Quota-burn in-flight probe failed, falling back to the ledger alone: ${err.message}`);
    return null;
  });
  for (const task of cosTasks?.tasks || []) {
    if (ignoreTaskId && task?.id === ignoreTaskId) continue;
    if (task?.status !== 'pending' && task?.status !== 'in_progress') continue;
    const key = task?.metadata?.[QUOTA_BURN_DISPATCH_KEY_FIELD];
    if (typeof key !== 'string' || !key) continue;
    counts[key] = Number(counts[key] || 0) + 1;
  }
  return counts;
}

function normalizedFamily(id, value) {
  if (!value || typeof value !== 'object' || value.enabled !== true) return null;
  const config = { ...DEFAULT_QUOTA_BURN_FAMILY, ...value };
  return {
    id,
    ...config,
    resetWithinHours: Math.max(0, Number(config.resetWithinHours) || 24),
    reservePercent: Math.min(100, Math.max(0, Number(config.reservePercent) || 0)),
    maxDispatchesPerWindow: Math.max(1, Math.floor(Number(config.maxDispatchesPerWindow) || 5)),
    priority: Number(config.priority) || 0,
  };
}

function selectLimit(card, family, now) {
  const scoped = (card.limits || []).filter((limit) => !family.scope || limit.scope === family.scope);
  return scoped
    .map((limit) => ({ limit, hours: hoursUntilReset(limit, { now, timeZone: family.timeZone }) }))
    .filter((entry) => entry.hours !== null)
    .sort((a, b) => a.hours - b.hours)[0] || null;
}

export function burnBudgetRemaining(limit, family) {
  return Math.max(0, Number(limit?.percentRemaining) - family.reservePercent);
}

/** Select only safely-known, still-burnable provider windows. */
export function selectBurnCandidates(quotas, config, { now = Date.now(), dispatches = {} } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return Object.entries(config?.families || {})
    .map(([id, value]) => normalizedFamily(id, value))
    .filter(Boolean)
    .map((family) => {
      const card = cards.get(family.id);
      if (!card || card.supported === false || card.error) return null;
      // A card can declare it carries no spendable headroom (`burnable: false`)
      // — e.g. the Image Gen card, whose 0%-left meter is an OBSERVED refusal,
      // not a measured allowance. Burning against it would dispatch work to a
      // backend that just refused. Opt-out only: absent means burnable.
      if (card.burnable === false) return null;
      const selected = selectLimit(card, family, now);
      if (!selected || selected.hours < 0 || selected.hours > family.resetWithinHours) return null;
      const dispatchKey = `${family.id}:${normalizeResetAt(selected.limit, { now, timeZone: family.timeZone }).epochMs}`;
      if (Number(dispatches[dispatchKey] || 0) >= family.maxDispatchesPerWindow) return null;
      if (burnBudgetRemaining(selected.limit, family) <= 0) return null;
      return { family, card, limit: selected.limit, hoursUntilReset: selected.hours, dispatchKey };
    })
    .filter(Boolean)
    .sort((a, b) => a.hoursUntilReset - b.hoursUntilReset || a.family.priority - b.family.priority);
}

export async function detectQuotaBurn(app, { getQuotas = getProviderQuotas, now = Date.now(), dispatches, ignoreTaskId = null } = {}) {
  const config = quotaBurnConfig(app);
  const configured = Object.entries(config.families || {})
    .filter(([, family]) => family?.enabled === true)
    .map(([id, family]) => ({ id, ...family }));
  if (!configured.length) return { actionable: false, count: 0, reason: 'no-enabled-families' };
  const quotas = await getQuotas({ refresh: false });
  const configuredCards = quotas.filter((card) => configured.some((family) => family?.id === card?.family));
  if (configuredCards.length && configuredCards.every((card) => card?.error)) {
    return { actionable: false, count: 0, transient: true, reason: 'all-provider-quota-checks-failed' };
  }
  const candidates = selectBurnCandidates(quotas, config, { now, dispatches: dispatches || await getEffectiveQuotaBurnDispatches({ ignoreTaskId }) });
  return candidates.length
    ? { actionable: true, count: candidates.length, reason: `${candidates[0].family.id} resets in ${Math.ceil(candidates[0].hoursUntilReset)}h`, candidates }
    : { actionable: false, count: 0, reason: 'no-family-within-reset-window' };
}
