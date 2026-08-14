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
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { familyHasRunnableJobs, familyIsConfigured, isUnlimitedDispatchCap, normalizeQuotaBurnFamily } from '../lib/quotaBurnConfig.js';
import { isPlainObject } from '../lib/objects.js';
import { hoursUntilReset, normalizeResetAt } from '../lib/quotaReset.js';
import { classifyWindows, windowLabelOf } from '../lib/quotaWindows.js';
import { isBlockActive } from './quotaBurnDenials.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-dispatches.json');

// Window keys older than this fall out of the ledger on the next write. A key is
// `<family>:<resetEpochMs>`, so a passed window can never be selected again and
// its count is dead weight; without a prune the file grows for the life of the
// install.
const LEDGER_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Dispatch counts per `<family>:<resetEpochMs>` window key, or `null` when the
 * ledger could not be read.
 *
 * The `null` is load-bearing, and matches `quotaBurnCompletions.js` /
 * `quotaBurnDenials.js`, which read the sibling ledgers strictly for exactly this
 * reason (#4115). A failed or corrupt read must not come back as "0 dispatches
 * this window": `dispatchesUsed` is both the cap gate AND the number the family
 * card shows as `N/M used`, so a swallowed read re-opens a spent window and then
 * lets the next write persist the empty ledger over every surviving count — real
 * quota overspend. Absent (never dispatched) is still a trustworthy `{}`.
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
    const loaded = await getQuotaBurnDispatches();
    // Never overwrite a ledger we could not read — the same guard the sibling
    // ledgers' `writeLedger` carries. Returning null tells the caller the
    // dispatch went unrecorded rather than pretending the window is at 1.
    if (!loaded) return null;
    const ledger = pruneLedger(loaded, now);
    const next = { ...ledger, [key]: Number(ledger[key] || 0) + 1 };
    await atomicWrite(LEDGER_FILE(), next);
    return next;
  });
}

/**
 * The verdict for a plan whose every enabled step is a spent `run once`.
 *
 * Exported because the runner reports the same state from its own pre-quota
 * early return (which must run BEFORE the quota read the ladder needs), and two
 * hand-written wordings for one condition is how the page and the run log end up
 * describing the same plan in two different sentences.
 */
export const PLAN_COMPLETE_SKIP_REASON = 'every enabled job has already run once';

/** Headroom the family is willing to spend on ONE window: what's left, minus its reserve. */
export function burnBudgetRemaining(limit, family) {
  return Math.max(0, Number(limit?.percentRemaining) - family.reservePercent);
}

/**
 * The window with the LEAST headroom on the card — what the reserve is actually
 * protecting.
 *
 * Checking only the soonest-resetting window (which is what selection keys on)
 * makes the reserve inert for every provider that reports two: claude, codex and
 * agy each expose a short rolling window AND a weekly one on the same card, and
 * the short one is always the soonest. A card at `session: 100%` / `week: 2%`
 * with a 40% reserve would pass the gate on the session number and drain a
 * weekly allowance already far below the floor the user set — while the field's
 * own hint reads "Never spend below this much headroom".
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
 * The rounding is load-bearing. Antigravity states its reset only as a RELATIVE
 * string ("Refreshes in 4h 57m"), which `parseAgyUsage` turns into
 * `now + duration` — so an exact-epoch key drifts by a minute or two on every
 * scrape and each cycle mints a FRESH key with a count of zero. The per-window
 * cap then never engages: an agy family would burn once per tick forever
 * (~48/day at the default interval) while the page's "1/5 used" badge showed
 * 0/5, and the ledger accumulated a dead key per cycle. Rounding to the hour
 * collapses that drift into one bucket. The residual cost is a window whose true
 * reset sits within a scrape's drift of a half-hour boundary, which can straddle
 * two buckets and allow one extra dispatch — a bounded overshoot, versus an
 * unbounded one.
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
 * Deliberately one function rather than a selector plus a matching explainer.
 * Those were written twice, and the status page renders the explanation
 * verbatim: a gate added to one and not the other makes the page confidently
 * report "will burn" for a family the runner then skips forever, which is
 * exactly the question the page exists to answer.
 *
 * `bypassGates` is the page's per-job "Run now": the user named a family and
 * clicked, which is a direct instruction to spend that quota. The window /
 * reserve / cap / denial gates bound UNATTENDED burns, so they are skipped — but
 * the card and limit are still read, so a forced run reports its real remaining
 * percentage and reset time instead of a fabricated one. It comes back
 * `charge: false` so it never eats the automatic budget.
 */
export function evaluateFamily(family, card, { now = Date.now(), dispatches = {}, blocks = {}, completions = {}, bypassGates = false } = {}) {
  // The three "switched off" gates. A forced run passes all of them: `enabled`
  // on the family, `enabled` on a job, and a spent `run once` job all govern the
  // UNATTENDED loop, and the user clicking ▶ on a specific row is a more
  // specific instruction than a checkbox they set earlier. Everything below — no
  // provider, unreadable quota, unburnable card — is a fact about the world and
  // holds even under force.
  if (!bypassGates) {
    if (!family.enabled) return { skipReason: 'disabled' };
    // One check on the healthy path; the two verdicts are only told apart on the
    // failing branch. They are reported distinctly because they call for
    // opposite actions: "you configured nothing" wants a job added, while a
    // finished one-shot plan wants Re-arm (or nothing at all — it did what it
    // was asked).
    if (!familyHasRunnableJobs(family, completions)) {
      return { skipReason: familyIsConfigured(family) ? PLAN_COMPLETE_SKIP_REASON : 'no enabled jobs configured' };
    }
  }
  if (!card) return { skipReason: 'no enabled provider in this family' };
  if (card.supported === false) return { skipReason: 'provider has no queryable quota surface' };
  // The reading is still being taken (a cold-cache status read starts the scrape
  // rather than blocking the page on a 20s PTY spawn). NOT an error and NOT an
  // empty allowance — it is "ask again in a moment". A candidate here would burn
  // against a card with no numbers on it, so it fails closed like every other
  // unknown, and holds even under force.
  if (card.pending) return { skipReason: 'reading provider quota…' };
  // `error` covers both a failed read and a successful one with nothing to
  // meter (see the card contract in providerUsage.js) — either way there are no
  // numbers to burn against, so the reason quotes the card rather than
  // asserting a failure that may not have happened.
  if (card.error) return { skipReason: `quota unavailable: ${card.error}` };
  // A card can declare it carries no spendable headroom (`burnable: false`) —
  // e.g. the Image Gen card, whose 0%-left meter is an OBSERVED refusal, not a
  // measured allowance. Burning against it would dispatch work to a backend that
  // just refused. Opt-out only: absent means burnable.
  if (card.burnable === false) return { skipReason: 'provider reports no spendable headroom' };

  // ONE scoring pass over the card's windows yields both roles a burn reasons
  // about (see `lib/quotaWindows.js`):
  //
  //   `target`   — the BROADEST window: the allowance that expires unused. Not
  //     the soonest-resetting one. Claude, codex and agy each publish a short
  //     rolling window (≈5h) alongside a weekly one, and the short window is
  //     nearly always the soonest: keying on it made the page report "resets in
  //     3h" for a plan written against a weekly allowance, and re-opened
  //     `resetWithinHours` every five hours, so "only spend as the window is
  //     about to expire" never actually bounded anything. Its reset epoch is
  //     also what the dispatch cap keys on, making `maxDispatchesPerWindow` mean
  //     "per weekly window" rather than "per 5-hour window".
  //   `limiting` — the NARROWEST window: what a weekly burn plan runs out of
  //     long before the weekly allowance is spent, and so the horizon a denial
  //     backs off to (see `quotaBurnDenials.js`).
  const limits = card.limits || [];
  const { target, limiting } = classifyWindows(limits, (limit) => hoursUntilReset(limit, { now }));
  // A window with no readable reset time is unknowable, not merely closed — a
  // forced run can't invent one either, so this gate holds even under bypass.
  if (!target) return { skipReason: 'no window states a reset time' };

  const dispatchKey = windowKey(family.id, target.limit, { now });
  const dispatchesUsed = Number(dispatches[dispatchKey] || 0);
  // The reserve guards the TIGHTEST window on the card, not the one selection
  // happens to key on (see `tightestBudget`).
  const tightest = tightestBudget(limits, family) || target.limit;
  const block = blocks[family.id];

  // The gates a forced run is allowed past. Evaluated regardless so the ordering
  // (and the wording) stays in one place; only the return is skipped.
  if (!bypassGates) {
    // An OBSERVED refusal outranks the reported numbers: the provider itself
    // just said no, while the card it says no against can still read "60% left".
    // Bypassable on purpose — a forced run is the user's way to retry a block
    // they believe is stale, and a run that then succeeds clears it.
    // The `until` is deliberately NOT restated here — the family card renders
    // `blockedUntil` as a localized timestamp of its own, and an ISO instant
    // stacked above it is the same fact twice in two formats.
    if (isBlockActive(block, now)) {
      return { skipReason: `provider refused the last burn — ${block.reason || 'out of quota'}` };
    }
    if (target.hours < 0) return { skipReason: 'window already reset' };
    if (target.hours > family.resetWithinHours) {
      return { skipReason: `resets in ${Math.ceil(target.hours)}h — outside the ${family.resetWithinHours}h window` };
    }
    // A cap of -1 (the default) opts out of counting entirely — the window is
    // still bounded by `resetWithinHours`, the reserve, and provider refusals,
    // all of which read live numbers rather than a tally.
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
      // The narrowest window on the card — what a refusal is actually about. Null
      // when the provider reports no window whose period we can classify.
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
