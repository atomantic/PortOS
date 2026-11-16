/**
 * Quota-burn candidate selection + the per-window dispatch ledger.
 *
 * Owns the SELECTION half only (which family, which window, is the window's
 * dispatch cap spent). The plan lives in `quotaBurnStore.js`, invocation in
 * `quotaBurnInvoke.js`, the loop in `quotaBurnRunner.js`.
 *
 * Everything here fails CLOSED: an unknown reset time, unsupported provider,
 * quota-read error, or unburnable card all mean "do not dispatch"; a permissive
 * guess costs the user real quota.
 *
 * Storage: `ephemeral-file` (`data/cos/quota-burn-dispatches.json`) — machine-local,
 * never federated. Per-window dispatch counts, self-pruning at 30 days; safe to delete.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { familyHasRunnableJobs, familyIsConfigured, isUnlimitedDispatchCap, normalizeQuotaBurnFamily } from '../lib/quotaBurnConfig.js';
import { isPlainObject } from '../lib/objects.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';
import { cardHasReading } from '../lib/fleetQuotas.js';
import { classifyWindows, windowLabelOf } from '../lib/quotaWindows.js';
import { isBlockActive } from './quotaBurnDenials.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-dispatches.json');

// A key is `<family>:<resetEpochMs>`, so a passed window can never be selected
// again; keys older than this are pruned on the next write.
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Dispatch counts per `<family>:<resetEpochMs>` window key, or `null` when the
 * ledger could not be read.
 *
 * The `null` is load-bearing (sibling ledgers read strictly too): a failed read
 * must not look like "0 dispatches", or a spent window re-opens and the next
 * write persists the empty ledger over every surviving count. Absent file is a
 * trustworthy `{}`.
 */
export async function getQuotaBurnDispatches() {
  const { ok, value } = await readJSONFileStrict(LEDGER_FILE(), {}, { logError: false });
  if (!ok) return null;
  return isPlainObject(value) ? value : {};
}

const windowEpoch = (key) => Number(String(key).split(':').pop());

function pruneLedger(ledger, now) {
  return Object.fromEntries(Object.entries(ledger).filter(([key]) => {
    const epoch = windowEpoch(key);
    // Keep anything we can't date — an unparseable key is not evidence of age.
    return !Number.isFinite(epoch) || now - epoch < LEDGER_RETENTION_MS;
  }));
}

// Serializes the ledger's read-modify-write: the scheduler tick and "Run now" can
// land together and lose an increment, overspending past `maxDispatchesPerWindow`.
const ledgerWriteQueue = createFileWriteQueue();

export async function recordQuotaBurnDispatch(key, { now = Date.now() } = {}) {
  return ledgerWriteQueue(async () => {
    const loaded = await getQuotaBurnDispatches();
    // Never overwrite an unreadable ledger; null tells the caller it went unrecorded.
    if (!loaded) return null;
    const ledger = pruneLedger(loaded, now);
    const next = { ...ledger, [key]: Number(ledger[key] || 0) + 1 };
    await atomicWrite(LEDGER_FILE(), next);
    return next;
  });
}

/**
 * The ledger the gate ladder should read: charged dispatches plus every burn
 * requested and not yet accepted. Acceptance is asynchronous
 * (`quotaBurnAcceptance.js`), so without the pending count the cap reads short
 * and a cycle can walk past `maxDispatchesPerWindow`. A reservation already
 * CLAIMED (`chargedAt`) is skipped, since the ledger write counts it.
 *
 * Pure: unreadable `reservations` returns the ledger untouched; the caller
 * decides whether that may run a cycle.
 */
export function withPendingDispatches(ledger, reservations) {
  if (!isPlainObject(reservations)) return ledger;
  const next = { ...ledger };
  for (const record of Object.values(reservations)) {
    if (!record?.charge || !record.dispatchKey || record.chargedAt) continue;
    next[record.dispatchKey] = Number(next[record.dispatchKey] || 0) + 1;
  }
  return next;
}

/**
 * The verdict for a plan whose every enabled step is a spent `run once`.
 *
 * Exported so the runner's pre-quota early return reports the same wording.
 */
export const PLAN_COMPLETE_SKIP_REASON = 'every enabled job has already run once';

/** Headroom the family is willing to spend on ONE window: what's left, minus its reserve. */
export function burnBudgetRemaining(limit, family) {
  return Math.max(0, Number(limit?.percentRemaining) - family.reservePercent);
}

/**
 * The window with the LEAST headroom on the card — what the reserve protects.
 * Checking only the soonest-resetting window would let a card at
 * `session: 100%` / `week: 2%` pass a 40% reserve and drain the weekly allowance.
 */
function tightestBudget(limits, family) {
  const measured = limits.filter((limit) => Number.isFinite(Number(limit?.percentRemaining)));
  if (!measured.length) return null;
  return measured.reduce((tightest, limit) =>
    (burnBudgetRemaining(limit, family) < burnBudgetRemaining(tightest, family) ? limit : tightest));
}

/**
 * The ledger key for one window: `<family>:<resetEpoch rounded to the hour>`.
 *
 * The rounding is load-bearing: Antigravity states its reset only as a relative
 * string, so an exact-epoch key drifts per scrape, mints a fresh zero count each
 * cycle and the cap never engages. Hour rounding collapses the drift; a reset
 * near a half-hour boundary can straddle two buckets (one extra dispatch at most).
 */
const HOUR_MS = 60 * 60 * 1000;
export function windowKey(familyId, limit, { now = Date.now() } = {}) {
  const epoch = normalizeResetAt(limit, { now }).epochMs;
  return `${familyId}:${Math.round(epoch / HOUR_MS) * HOUR_MS}`;
}

/**
 * THE gate ladder. Evaluates one family against its live quota card and returns
 * either a burn candidate or the reason it isn't one — never both, never
 * neither.
 *
 * One function so the status page's explanation and the runner's decision can't
 * disagree about a gate.
 *
 * `bypassGates` is the per-job "Run now": a direct user instruction, so the
 * window / reserve / cap / denial gates (which bound UNATTENDED burns) are
 * skipped, but the card is still read for real numbers. It returns
 * `charge: false` so it never eats the automatic budget.
 */
export function evaluateFamily(family, card, { now = Date.now(), dispatches = {}, blocks = {}, completions = {}, bypassGates = false } = {}) {
  // The "switched off" gates govern the UNATTENDED loop only; a forced run passes
  // them. Everything below is a fact about the world and holds even under force.
  if (!bypassGates) {
    if (!family.enabled) return { skipReason: 'disabled' };
    // Distinct verdicts: "nothing configured" wants a job added, a finished
    // one-shot plan wants Re-arm.
    if (!familyHasRunnableJobs(family, completions)) {
      return { skipReason: familyIsConfigured(family) ? PLAN_COMPLETE_SKIP_REASON : 'no enabled jobs configured' };
    }
  }
  if (!card) return { skipReason: 'no enabled provider in this family' };
  if (card.supported === false) return { skipReason: 'provider has no queryable quota surface' };
  // Scrape in flight: not an error, not an empty allowance — fails closed, even
  // under force. `pending` only says THIS machine's scrape is running; a peer's
  // reading may already fill the meters (`lib/fleetQuotas.js`), so gate on having none.
  if (card.pending && !cardHasReading(card)) return { skipReason: 'reading provider quota…' };
  // `error` covers a failed read and a read with nothing to meter, so the reason
  // quotes the card rather than asserting a failure.
  if (card.error) return { skipReason: `quota unavailable: ${card.error}` };
  // `burnable: false` (e.g. Image Gen, whose 0%-left is an observed refusal) opts out.
  if (card.burnable === false) return { skipReason: 'provider reports no spendable headroom' };

  // `target` is the BROADEST window (the allowance that expires unused), not the
  // soonest-resetting short rolling one; its reset epoch keys the dispatch cap.
  // `limiting` is the NARROWEST window, the horizon a denial backs off to
  // (see `lib/quotaWindows.js`, `quotaBurnDenials.js`).
  const limits = card.limits || [];
  const { target, limiting } = classifyWindows(limits, (limit) => hoursUntilReset(limit, { now }));
  // Unknowable reset: holds even under bypass.
  if (!target) return { skipReason: 'no window states a reset time' };

  const dispatchKey = windowKey(family.id, target.limit, { now });
  const dispatchesUsed = Number(dispatches[dispatchKey] || 0);
  // The reserve guards the TIGHTEST window (see `tightestBudget`).
  const tightest = tightestBudget(limits, family) || target.limit;
  const block = blocks[family.id];

  if (!bypassGates) {
    // An OBSERVED refusal outranks the card's numbers. Bypassable so a forced run
    // can retry a stale block. `until` is not restated: the card renders it.
    if (isBlockActive(block, now)) {
      return { skipReason: `provider refused the last burn — ${block.reason || 'out of quota'}` };
    }
    if (target.hours < 0) return { skipReason: 'window already reset' };
    if (target.hours > family.resetWithinHours) {
      return { skipReason: `resets in ${Math.ceil(target.hours)}h — outside the ${family.resetWithinHours}h window` };
    }
    // A cap of -1 (the default) opts out of counting.
    if (!isUnlimitedDispatchCap(family.maxDispatchesPerWindow) && dispatchesUsed >= family.maxDispatchesPerWindow) {
      return { skipReason: `dispatch cap reached (${dispatchesUsed}/${family.maxDispatchesPerWindow})` };
    }
    if (burnBudgetRemaining(tightest, family) <= 0) {
      return { skipReason: `${windowLabelOf(tightest)} at ${tightest.percentRemaining}% left is at or below the ${family.reservePercent}% reserve` };
    }
  }

  return {
    candidate: {
      family,
      card,
      limit: target.limit,
      hoursUntilReset: target.hours,
      // Narrowest window — what a refusal is about; null when unclassifiable.
      limitingLimit: limiting,
      limitingResetAt: limiting ? normalizeResetAt(limiting, { now }).epochMs : null,
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
 * `providerUsage.getProviderQuotas()`; `blocks` the active denial ledger from
 * `quotaBurnDenials.getActiveQuotaBurnBlocks()`; `completions` the `run once`
 * ledger from `quotaBurnCompletions.getQuotaBurnCompletions()`.
 * `bypassGatesFor` names one family whose window/reserve/cap/denial gates are
 * skipped (see `evaluateFamily`).
 */
export function selectBurnCandidates(quotas, config, { now = Date.now(), dispatches = {}, blocks = {}, completions = {}, bypassGatesFor = null } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return familiesOf(config)
    .map((family) => evaluateFamily(family, cards.get(family.id), {
      now, dispatches, blocks, completions, bypassGates: bypassGatesFor === family.id,
    }).candidate)
    .filter(Boolean)
    .sort((a, b) => a.hoursUntilReset - b.hoursUntilReset || a.family.priority - b.family.priority);
}

/**
 * Per-family verdicts for the status page: the candidate when the family would
 * burn on the next tick, otherwise the exact gate that closed. One pass over the
 * SAME ladder the runner uses, so the two can't disagree.
 */
export function evaluateFamilies(quotas, config, { now = Date.now(), dispatches = {}, blocks = {}, completions = {} } = {}) {
  const cards = new Map((quotas || []).map((card) => [card.family, card]));
  return familiesOf(config).map((family) => ({
    family,
    block: blocks[family.id] || null,
    ...evaluateFamily(family, cards.get(family.id), { now, dispatches, blocks, completions }),
  }));
}
