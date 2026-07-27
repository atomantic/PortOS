import { getProviderQuotas } from './providerUsage.js';
import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';

export const QUOTA_BURN_TASK_TYPE = 'quota-burn';
const LEDGER_FILE = join(PATHS.cos, 'quota-burn-dispatches.json');
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

export async function getQuotaBurnDispatches() {
  const loaded = await readJSONFile(LEDGER_FILE, {});
  return loaded && typeof loaded === 'object' ? loaded : {};
}

export async function recordQuotaBurnDispatch(key) {
  const ledger = await getQuotaBurnDispatches();
  const next = { ...ledger, [key]: Number(ledger[key] || 0) + 1 };
  await atomicWrite(LEDGER_FILE, next);
  return next;
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

export async function detectQuotaBurn(app, { getQuotas = getProviderQuotas, now = Date.now(), dispatches } = {}) {
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
  const candidates = selectBurnCandidates(quotas, config, { now, dispatches: dispatches || await getQuotaBurnDispatches() });
  return candidates.length
    ? { actionable: true, count: candidates.length, reason: `${candidates[0].family.id} resets in ${Math.ceil(candidates[0].hoursUntilReset)}h`, candidates }
    : { actionable: false, count: 0, reason: 'no-family-within-reset-window' };
}
