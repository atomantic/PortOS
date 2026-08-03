/**
 * Quota-burn candidate selection + the per-window dispatch ledger.
 *
 * Quota-burn spends subscription-backed CLI quota that would otherwise expire
 * unused: it watches each enabled provider family's reset clock and, only once
 * a window is close to resetting and still has headroom above the family's
 * reserve, runs the next job in that family's ordered burn plan.
 *
 * This module owns the SELECTION half (which family, which window, is the
 * window's dispatch cap spent) and nothing else. The plan lives in
 * `quotaBurnStore.js`, the jobs in `quotaBurnJobs/`, and the loop that ties
 * them together in `quotaBurnRunner.js`.
 *
 * Everything here fails CLOSED: an unknown reset time, an unsupported provider,
 * a quota-read error, or a card that declares itself unburnable all mean "do not
 * dispatch". Burning is opt-in spending of the user's own subscription — a
 * guess in the permissive direction costs them real quota.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { familyIsActionable, normalizeQuotaBurnFamily } from '../lib/quotaBurnConfig.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-dispatches.json');

// Window keys older than this fall out of the ledger on the next write. A key is
// `<family>:<resetEpochMs>`, so a passed window can never be selected again and
// its count is dead weight; without a prune the file grows for the life of the
// install.
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

async function readQuotaBurnLedger() {
  const loaded = await readJSONFile(LEDGER_FILE(), {});
  return loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
}

/** Dispatch counts per `<family>:<resetEpochMs>` window key. */
export async function getQuotaBurnDispatches() {
  return readQuotaBurnLedger();
}

const windowEpoch = (key) => Number(String(key).split(':').pop());

function pruneLedger(ledger, now) {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => {
    const epoch = windowEpoch(key);
    // Keep anything we can't date — an unparseable key is not evidence of age.
    return !Number.isFinite(epoch) || now - epoch < LEDGER_RETENTION_MS;
  }));
}

// Single tail for the ledger's read-modify-write. The scheduler tick and an
// on-demand "Run now" can both land a dispatch at once; unserialized, both would
// read the same count and write the same increment, losing one burn. An
// undercounted ledger then lets the window dispatch past
// `maxDispatchesPerWindow`, which is real quota overspend. This is the
// "serialize two write paths that mutate the same record" case, not a defense
// against competing users.
const ledgerWriteQueue = createFileWriteQueue();

export async function recordQuotaBurnDispatch(key, { now = Date.now() } = {}) {
  return ledgerWriteQueue(async () => {
    const ledger = pruneLedger(await readQuotaBurnLedger(), now);
    const next = { ...ledger, [key]: Number(ledger[key] || 0) + 1 };
    await atomicWrite(LEDGER_FILE(), next);
    return next;
  });
}

/**
 * The soonest-resetting limit on a card that is still in scope for the family,
 * or null when none of them state a reset time we can read.
 */
function selectLimit(card, family, now) {
  const scoped = (card.limits || []).filter((limit) => !family.scope || limit.scope === family.scope);
  return scoped
    .map((limit) => ({ limit, hours: hoursUntilReset(limit, { now }) }))
    .filter((entry) => entry.hours !== null)
    .sort((a, b) => a.hours - b.hours)[0] || null;
}

/** Headroom the family is willing to spend: what's left, minus its reserve. */
export function burnBudgetRemaining(limit, family) {
  return Math.max(0, Number(limit?.percentRemaining) - family.reservePercent);
}

/**
 * Select only safely-known, still-burnable provider windows, soonest reset
 * first (ties broken by the family's `priority`).
 *
 * `config` is a normalized quota-burn config; `quotas` the provider cards from
 * `providerUsage.getProviderQuotas()`.
 */
export function selectBurnCandidates(quotas, config, { now = Date.now(), dispatches = {} } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return Object.entries(config?.families || {})
    .map(([id, value]) => ({ id, ...normalizeQuotaBurnFamily(value) }))
    .filter(familyIsActionable)
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
      const dispatchKey = `${family.id}:${normalizeResetAt(selected.limit, { now }).epochMs}`;
      if (Number(dispatches[dispatchKey] || 0) >= family.maxDispatchesPerWindow) return null;
      if (burnBudgetRemaining(selected.limit, family) <= 0) return null;
      return {
        family,
        card,
        limit: selected.limit,
        hoursUntilReset: selected.hours,
        dispatchKey,
        dispatchesUsed: Number(dispatches[dispatchKey] || 0),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.hoursUntilReset - b.hoursUntilReset || a.family.priority - b.family.priority);
}

/**
 * Why a configured family is NOT a candidate right now, for the status page.
 * Mirrors `selectBurnCandidates`'s gates one-for-one so the page can never
 * disagree with the runner about what would happen on the next tick.
 */
export function explainFamilySkip(familyId, rawFamily, quotas, { now = Date.now(), dispatches = {} } = {}) {
  const family = { id: familyId, ...normalizeQuotaBurnFamily(rawFamily) };
  if (!family.enabled) return 'disabled';
  if (!familyIsActionable(family)) return 'no enabled jobs configured';
  const card = (quotas || []).find((entry) => entry.family === familyId);
  if (!card) return 'no enabled provider in this family';
  if (card.supported === false) return 'provider has no queryable quota surface';
  if (card.error) return `quota read failed: ${card.error}`;
  if (card.burnable === false) return 'provider reports no spendable headroom';
  const selected = selectLimit(card, family, now);
  if (!selected) return 'no window states a reset time';
  if (selected.hours < 0) return 'window already reset';
  if (selected.hours > family.resetWithinHours) {
    return `resets in ${Math.ceil(selected.hours)}h — outside the ${family.resetWithinHours}h window`;
  }
  const dispatchKey = `${family.id}:${normalizeResetAt(selected.limit, { now }).epochMs}`;
  const used = Number(dispatches[dispatchKey] || 0);
  if (used >= family.maxDispatchesPerWindow) return `dispatch cap reached (${used}/${family.maxDispatchesPerWindow})`;
  if (burnBudgetRemaining(selected.limit, family) <= 0) {
    return `${selected.limit.percentRemaining}% left is at or below the ${family.reservePercent}% reserve`;
  }
  return null;
}
