/**
 * Quota-burn denial ledger — the observed "stop, you are out" signal.
 *
 * The quota gates in `quotaBurn.js` reason about the numbers a provider REPORTS.
 * Those numbers are stale by design (a card is scraped every few minutes and
 * rounded to whole percent), and they describe the window the burn is targeting
 * — usually the weekly one. What actually refuses a run is the SHORT rolling
 * window: a burn plan spending down a weekly allowance runs task after task and
 * eventually exhausts the 5-hour window, at which point every further dispatch
 * fails instantly, wastes an agent spawn, and leaves a red card in the queue —
 * while the weekly card still reads "60% left, resets in 2 days" and the runner
 * happily dispatches again on the next tick.
 *
 * So a refusal is recorded as a first-class fact: when a burn-dispatched agent
 * dies with a usage-limit error, the family is BLOCKED until the short window
 * resets, and `evaluateFamily` reports that as the gate. This is the same
 * "report what we observed, never what we assumed" posture as `imageGenQuota.js`
 * — a provider that just said no is more authoritative than a card that says
 * yes.
 *
 * Blocks are self-healing in both directions: a successful burn clears the
 * family immediately (proof it is serving again), and a block whose refusal
 * stated no reset expires on a bounded TTL so an install that stops burning
 * can't be blocked forever.
 *
 * Storage is `ephemeral-file` per docs/STORAGE.md — regenerable runtime
 * telemetry with an hours-long horizon, alongside the dispatch ledger in
 * `data/cos/`.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isObservedBlockActive, parseObservedReset } from '../lib/quotaReset.js';

const DENIALS_FILE = () => join(PATHS.cos, 'quota-burn-denials.json');

/**
 * How long a block whose refusal stated no reset — and whose family reported no
 * classifiable short window either — stays in force. Bounds an otherwise
 * open-ended block: nothing forces a later burn to happen and prove the family
 * is serving again. Five hours is the shortest rolling window every supported
 * CLI family publishes, so it is the smallest wait that is actually likely to
 * clear a real refusal.
 */
export const UNKNOWN_BLOCK_TTL_MS = 5 * 60 * 60 * 1000;

/**
 * Phrases that mean "the provider refused this run because its quota is spent".
 *
 * Deliberately NARROWER than the generic rate-limit matching in
 * `agentErrorAnalysis.js`: a transient `429` is a retry, not a spent window, and
 * blocking a family for five hours over one is a much worse error than missing a
 * burn. Every pattern here is a subscription-window idiom the CLIs print
 * verbatim when the allowance itself is gone.
 *
 * These are matched against an agent's own output, which quotes its prompt and
 * the files it read — so nothing here may be a phrase ordinary work can emit.
 * `usage limit` / `quota exceeded` / `plan limit` are anchored to a possessive
 * or a verb for that reason; a bare "limit" or "quota" would match a burn task
 * whose prompt is literally about quota handling.
 */
export const QUOTA_DENIAL_PATTERNS = Object.freeze([
  /hit your (?:usage )?limit/i,
  /(?:you(?:'ve| have) )?(?:reached|exceeded) your (?:usage |plan |weekly |session )?limit/i,
  /(?:usage|rate) limit reached/i,
  /(?:your )?(?:quota|usage) (?:has been |is )?exhausted/i,
  /out of (?:quota|credits)/i,
  /resource[\s_-]*exhausted/i,
  /upgrade to pro/i,
  /now using extra usage/i,
  /(?:5|five)[\s-]?hour limit/i,
  /weekly limit reached/i,
]);

/**
 * Classify one failed burn run's output. Returns `{ denied, resetsAt }` where
 * `resetsAt` is epoch ms or null. Pure given `now`; exported for tests.
 *
 * `errorAnalysis` is the structured verdict `analyzeAgentFailure` already
 * produced for this run — its `usage-limit` category is the provider-anchored
 * classification of exactly this condition, so it is trusted directly rather
 * than re-derived from the raw text. Only when that verdict came from a
 * STRUCTURED marker, though (`origin: 'provider'`): the same category is also
 * reached by a loose keyword sweep over the agent's own narration, which is the
 * false-positive class the pattern list below is deliberately narrow about. A
 * loose match falls through to those patterns rather than being trusted.
 */
export function parseQuotaDenial(text, { now = Date.now(), errorAnalysis = null } = {}) {
  const raw = typeof text === 'string' ? text : '';
  const categorized = errorAnalysis?.category === 'usage-limit' && errorAnalysis.origin === 'provider';
  const denied = categorized || QUOTA_DENIAL_PATTERNS.some((pattern) => pattern.test(raw));
  if (!denied) return { denied: false, resetsAt: null };
  // The usage-limit analysis extracts the CLI's own wait phrase but strips the
  // lead-in ("try again in " → "45 minutes"), so it is re-framed into a sentence
  // `parseObservedReset` recognizes before falling back to the full text — where
  // a reset stated outside the matched line still gets read.
  const waitTime = typeof errorAnalysis?.waitTime === 'string' ? errorAnalysis.waitTime.trim() : '';
  const stated = (waitTime ? parseObservedReset(`retry in ${waitTime}`, { now }) : null)
    ?? parseObservedReset(raw, { now });
  return { denied: true, resetsAt: stated };
}

/**
 * Everything a failed run said, as one blob to classify. `analyzeAgentFailure`
 * keeps no copy of the full transcript — `snippet` is the window around the
 * matched pattern, `details` the error lines it pulled out — so every field it
 * does keep is scanned rather than assuming any one carries the refusal.
 */
export const denialTextOf = (result) => [
  result?.errorAnalysis?.message,
  result?.errorAnalysis?.details,
  result?.errorAnalysis?.snippet,
  result?.error,
].filter((part) => typeof part === 'string' && part).join('\n');

/**
 * Raw ledger: `{ [familyId]: { at, until, reason } }`, or **null** when the file
 * could not be read.
 *
 * A failed/corrupt read must not come back as "nothing is blocked" — that would
 * re-open the gate on a family the provider is still refusing AND let the next
 * write clobber the surviving blocks with an empty object. Same posture as
 * `imageGenQuota.js`'s ledger read.
 */
export async function getQuotaBurnDenials() {
  const { ok, value } = await readJSONFileStrict(DENIALS_FILE(), {}, { logError: false });
  if (!ok) return null;
  return isPlainObject(value) ? value : {};
}

/**
 * Is this ledger entry still holding? A block with a known reset holds until it
 * passes; one without holds for `UNKNOWN_BLOCK_TTL_MS` after it was observed.
 * Pure; exported so the status page and the gate can't disagree.
 */
export const isBlockActive = (entry, now = Date.now()) =>
  isObservedBlockActive(entry, { now, ttlMs: UNKNOWN_BLOCK_TTL_MS });

/** Only the families blocked right now, keyed by family id. */
export async function getActiveQuotaBurnBlocks({ now = Date.now() } = {}) {
  const ledger = await getQuotaBurnDenials();
  if (!ledger) {
    console.error('❌ Quota-burn denial ledger unreadable — treating every family as unblocked this cycle');
    return {};
  }
  return Object.fromEntries(Object.entries(ledger).filter(([, entry]) => isBlockActive(entry, now)));
}

// Single tail: a denial and a success can land together (two families burning in
// the same cycle), and both are read-modify-writes on one file.
const denialWriteQueue = createFileWriteQueue();

/**
 * Read-modify-write the ledger inside the queue. `mutate` returns the next
 * ledger, or `null` for "nothing to change" — which skips the write, so the
 * common case (a successful burn for a family that was never blocked) costs one
 * read rather than a read plus a pointless rewrite.
 */
const writeLedger = (mutate) => denialWriteQueue(async () => {
  const ledger = await getQuotaBurnDenials();
  // Don't overwrite a ledger we couldn't read — that is exactly how a real
  // block gets erased by the next unrelated write.
  if (!ledger) return null;
  const next = mutate({ ...ledger });
  if (!next) return null;
  await atomicWrite(DENIALS_FILE(), next);
  return next;
});

/**
 * Record that `familyId` was refused.
 *
 * `until` is resolved in priority order — the provider's own stated reset, then
 * the reset of the family's narrowest reported window (the 5-hour one it just
 * ran out of), then null, which the TTL bounds. Never DOWNGRADE a known reset to
 * unknown: a second refusal during an active block typically restates nothing,
 * and erasing the first one's instant would shorten the block to the TTL.
 */
export async function recordQuotaBurnDenial({
  familyId, output = '', errorAnalysis = null, limitingResetAt = null, at = Date.now(),
} = {}) {
  if (!familyId) return null;
  const signal = parseQuotaDenial(output, { now: at, errorAnalysis });
  if (!signal.denied) return null;
  const stated = signal.resetsAt ?? (Number.isFinite(limitingResetAt) && limitingResetAt > at ? limitingResetAt : null);
  const ledger = await writeLedger((current) => ({
    ...current,
    [familyId]: {
      at,
      until: stated ?? current[familyId]?.until ?? null,
      reason: errorAnalysis?.message || 'the provider refused the run as out of quota',
    },
  }));
  const entry = ledger?.[familyId] || null;
  if (entry) {
    console.log(`🛑 Quota-burn ${familyId} denied by the provider — blocked until ${entry.until ? new Date(entry.until).toISOString() : `+${UNKNOWN_BLOCK_TTL_MS / 3_600_000}h`}`);
  }
  return entry;
}

/**
 * Clear `familyId`'s block. Called when a burn run SUCCEEDS: the provider served
 * it, which is direct evidence the window it refused on has rolled — more
 * current than any stated reset, which providers round.
 */
export async function clearQuotaBurnBlock(familyId) {
  if (!familyId) return null;
  return writeLedger(({ [familyId]: dropped, ...rest }) => {
    if (!dropped) return null; // never blocked — skip the write
    console.log(`✅ Quota-burn ${familyId} served a run — clearing its denial block`);
    return rest;
  });
}

/**
 * Fold one completed agent into the ledger: a refusal blocks its family, a
 * success clears it.
 *
 * Called from the runner's `agent:completed` continuation rather than from a
 * second subscriber of its own, and AWAITED there before the family is
 * re-evaluated. The ordering is the whole point — that continuation dispatches
 * the next job in the plan the moment a burn agent finishes, so a block recorded
 * after it runs would arrive one wasted agent too late, every time.
 *
 * Only agents spawned BY a burn are considered — `quotaBurnFamily` is stamped on
 * the task by the burn dispatch (`quotaBurnInvoke.js`) and projected onto the agent record
 * at registration. An unrelated agent that happens to hit a usage limit says
 * nothing about whether the burn plan may spend; blocking on it would stall the
 * feature over someone else's failed task.
 */
export async function recordBurnAgentCompletion(agent) {
  const familyId = agent?.metadata?.taskQuotaBurnFamily;
  if (!familyId) return null;
  if (agent.result?.success) return clearQuotaBurnBlock(familyId);
  const limitingResetAt = Number(agent.metadata?.taskQuotaBurnLimitingResetAt);
  return recordQuotaBurnDenial({
    familyId,
    output: denialTextOf(agent.result),
    errorAnalysis: agent.result?.errorAnalysis || null,
    limitingResetAt: Number.isFinite(limitingResetAt) ? limitingResetAt : null,
  });
}
