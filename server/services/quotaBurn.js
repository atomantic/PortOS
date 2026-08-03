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
import { isPlainObject } from '../lib/objects.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-dispatches.json');

// Window keys older than this fall out of the ledger on the next write. A key is
// `<family>:<resetEpochMs>`, so a passed window can never be selected again and
// its count is dead weight; without a prune the file grows for the life of the
// install.
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Dispatch counts per `<family>:<resetEpochMs>` window key. */
export async function getQuotaBurnDispatches() {
  const loaded = await readJSONFile(LEDGER_FILE(), {});
  return isPlainObject(loaded) ? loaded : {};
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
    const ledger = pruneLedger(await getQuotaBurnDispatches(), now);
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
 * THE gate ladder. Evaluates one family against its live quota card and returns
 * either a burn candidate or the reason it isn't one — never both, never
 * neither.
 *
 * Deliberately one function rather than a selector plus a matching explainer.
 * Those were written twice, and the status page renders the explanation
 * verbatim: a gate added to one and not the other makes the page confidently
 * report "will burn" for a family the runner then skips forever, which is
 * exactly the question the page exists to answer.
 *
 * `bypassGates` is the page's per-job "Run now": the user named a family and
 * clicked, which is a direct instruction to spend that quota. The window /
 * reserve / cap gates bound UNATTENDED burns, so they are skipped — but the card
 * and limit are still read, so a forced run reports its real remaining
 * percentage and reset time instead of a fabricated one. It comes back
 * `charge: false` so it never eats the automatic budget.
 */
export function evaluateFamily(family, card, { now = Date.now(), dispatches = {}, bypassGates = false } = {}) {
  if (!family.enabled) return { skipReason: 'disabled' };
  if (!familyIsActionable(family)) return { skipReason: 'no enabled jobs configured' };
  if (!card) return { skipReason: 'no enabled provider in this family' };
  if (card.supported === false) return { skipReason: 'provider has no queryable quota surface' };
  if (card.error) return { skipReason: `quota read failed: ${card.error}` };
  // A card can declare it carries no spendable headroom (`burnable: false`) —
  // e.g. the Image Gen card, whose 0%-left meter is an OBSERVED refusal, not a
  // measured allowance. Burning against it would dispatch work to a backend that
  // just refused. Opt-out only: absent means burnable.
  if (card.burnable === false) return { skipReason: 'provider reports no spendable headroom' };

  const selected = selectLimit(card, family, now);
  // A window with no readable reset time is unknowable, not merely closed — a
  // forced run can't invent one either, so this gate holds even under bypass.
  if (!selected) return { skipReason: 'no window states a reset time' };

  const dispatchKey = `${family.id}:${normalizeResetAt(selected.limit, { now }).epochMs}`;
  const dispatchesUsed = Number(dispatches[dispatchKey] || 0);

  // The three gates a forced run is allowed past. Evaluated regardless so the
  // ordering (and the wording) stays in one place; only the return is skipped.
  if (!bypassGates) {
    if (selected.hours < 0) return { skipReason: 'window already reset' };
    if (selected.hours > family.resetWithinHours) {
      return { skipReason: `resets in ${Math.ceil(selected.hours)}h — outside the ${family.resetWithinHours}h window` };
    }
    if (dispatchesUsed >= family.maxDispatchesPerWindow) {
      return { skipReason: `dispatch cap reached (${dispatchesUsed}/${family.maxDispatchesPerWindow})` };
    }
    if (burnBudgetRemaining(selected.limit, family) <= 0) {
      return { skipReason: `${selected.limit.percentRemaining}% left is at or below the ${family.reservePercent}% reserve` };
    }
  }

  return {
    candidate: {
      family,
      card,
      limit: selected.limit,
      hoursUntilReset: selected.hours,
      dispatchKey,
      dispatchesUsed,
      // Only an unforced burn is charged against the window's automatic budget.
      charge: !bypassGates,
    },
  };
}

/** The family entries of a config, normalized and id-stamped. */
const familiesOf = (config) => Object.entries(config?.families || {})
  .map(([id, value]) => ({ id, ...normalizeQuotaBurnFamily(value) }));

/**
 * Select only safely-known, still-burnable provider windows, soonest reset
 * first (ties broken by the family's `priority`).
 *
 * `config` is a normalized quota-burn config; `quotas` the provider cards from
 * `providerUsage.getProviderQuotas()`. `bypassGatesFor` names one family whose
 * window/reserve/cap gates are skipped (see `evaluateFamily`).
 */
export function selectBurnCandidates(quotas, config, { now = Date.now(), dispatches = {}, bypassGatesFor = null } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return familiesOf(config)
    .map((family) => evaluateFamily(family, cards.get(family.id), {
      now, dispatches, bypassGates: bypassGatesFor === family.id,
    }).candidate)
    .filter(Boolean)
    .sort((a, b) => a.hoursUntilReset - b.hoursUntilReset || a.family.priority - b.family.priority);
}

/**
 * Per-family verdicts for the status page: the candidate when the family would
 * burn on the next tick, otherwise the exact gate that closed. One pass over the
 * SAME ladder the runner uses, so the two can't disagree.
 */
export function evaluateFamilies(quotas, config, { now = Date.now(), dispatches = {} } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return familiesOf(config).map((family) => ({
    family,
    ...evaluateFamily(family, cards.get(family.id), { now, dispatches }),
  }));
}
