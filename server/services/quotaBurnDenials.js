/**
 * Quota-burn denial ledger — the observed "stop, you are out" signal.
 *
 * Reported quota numbers are stale by design and describe the window a burn
 * targets (usually weekly), while what actually refuses a run is the SHORT
 * rolling window. So a refusal is recorded as a first-class fact: when a
 * burn-dispatched agent dies with a usage-limit error, the family is BLOCKED
 * until the short window resets, and `evaluateFamily` reports that as the gate
 * (same "report what we observed" posture as `imageGenQuota.js`).
 *
 * Blocks self-heal: a successful burn clears the family immediately, and a block
 * with no stated reset expires on a bounded TTL.
 *
 * Storage: `ephemeral-file` (`data/cos/quota-burn-denials.json`) — machine-local,
 * never federated. Regenerable telemetry; deleting it only risks one dispatch
 * into a still-exhausted window.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { isObservedBlockActive, parseObservedReset } from '../lib/quotaReset.js';

const DENIALS_FILE = () => join(PATHS.cos, 'quota-burn-denials.json');

/**
 * How long a block with no stated reset and no classifiable short window stays in
 * force. Five hours is the shortest rolling window every supported CLI family
 * publishes.
 */
export const UNKNOWN_BLOCK_TTL_MS = 5 * 60 * 60 * 1000;

/**
 * Phrases that mean "the provider refused this run because its quota is spent".
 *
 * Deliberately NARROWER than `agentErrorAnalysis.js`: a transient `429` is a
 * retry, not a spent window. These are matched against an agent's own output,
 * which quotes its prompt and the files it read, so nothing here may be a phrase
 * ordinary work can emit — a bare "limit" or "quota" would match a burn task
 * whose prompt is about quota handling.
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
 * `errorAnalysis`'s `usage-limit` category is trusted only when it came from a
 * STRUCTURED marker (`origin: 'provider'`); the same category is also reached by
 * a loose keyword sweep over the agent's narration, so a loose match falls
 * through to the narrow patterns above.
 */
export function parseQuotaDenial(text, { now = Date.now(), errorAnalysis = null } = {}) {
  const raw = typeof text === 'string' ? text : '';
  const categorized = errorAnalysis?.category === 'usage-limit' && errorAnalysis.origin === 'provider';
  const denied = categorized || QUOTA_DENIAL_PATTERNS.some((pattern) => pattern.test(raw));
  if (!denied) return { denied: false, resetsAt: null };
  // waitTime has its lead-in stripped ("45 minutes"); re-frame it into a sentence
  // parseObservedReset recognizes, then fall back to the full text.
  const waitTime = typeof errorAnalysis?.waitTime === 'string' ? errorAnalysis.waitTime.trim() : '';
  const stated = (waitTime ? parseObservedReset(`retry in ${waitTime}`, { now }) : null)
    ?? parseObservedReset(raw, { now });
  return { denied: true, resetsAt: stated };
}

/**
 * Everything a failed run said, as one blob to classify. `analyzeAgentFailure`
 * keeps no full transcript, so every field it does keep is scanned.
 */
export const denialTextOf = (result) => [
  result?.errorAnalysis?.message,
  result?.errorAnalysis?.details,
  result?.errorAnalysis?.snippet,
  result?.error,
].filter((part) => typeof part === 'string' && part).join('\n');

/**
 * Raw ledger: `{ [familyId]: { at, until, reason } }`, or **null** when the file
 * could not be read. A failed read must not come back as "nothing is blocked":
 * that would re-open the gate and let the next write clobber surviving blocks.
 */
export async function getQuotaBurnDenials() {
  const { ok, value } = await readJSONFileStrict(DENIALS_FILE(), {}, { logError: false });
  if (!ok) return null;
  return isPlainObject(value) ? value : {};
}

/**
 * Is this ledger entry still holding? Known reset: until it passes; otherwise
 * `UNKNOWN_BLOCK_TTL_MS` after observation. Exported so the status page and the
 * gate can't disagree.
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

// Single tail: a denial and a success can land together, both read-modify-writes on one file.
const denialWriteQueue = createFileWriteQueue();

/**
 * Read-modify-write the ledger inside the queue. `mutate` returns the next
 * ledger, or `null` to skip the write.
 */
const writeLedger = (mutate) => denialWriteQueue(async () => {
  const ledger = await getQuotaBurnDenials();
  // Never overwrite a ledger we couldn't read — that erases real blocks.
  if (!ledger) return null;
  const next = mutate({ ...ledger });
  if (!next) return null;
  await atomicWrite(DENIALS_FILE(), next);
  return next;
});

/**
 * Record that `familyId` was refused.
 *
 * `until` resolves in priority order: the provider's stated reset, then the
 * reset of the family's narrowest reported window, then null (TTL-bounded).
 * Never DOWNGRADE a known reset to unknown: a second refusal during an active
 * block typically restates nothing.
 */
export async function recordQuotaBurnDenial({
  familyId, output = '', errorAnalysis = null, limitingResetAt = null, at = Date.now(),
} = {}) {
  if (!familyId) return null;
  const signal = parseQuotaDenial(output, { now: at, errorAnalysis });
  if (!signal.denied) return null;
  const stated = signal.resetsAt ?? (Number.isFinite(limitingResetAt) && limitingResetAt > at ? limitingResetAt : null);
  const ledger = await writeLedger((current) => {
    // A lapsed prior reset is not carried forward: isObservedBlockActive trusts
    // a present `until`, so it would hide this fresh refusal instead of TTL-bounding it.
    const prior = current[familyId]?.until;
    return {
      ...current,
      [familyId]: {
        at,
        until: stated ?? (Number.isFinite(prior) && prior > at ? prior : null),
        reason: errorAnalysis?.message || 'the provider refused the run as out of quota',
      },
    };
  });
  const entry = ledger?.[familyId] || null;
  if (entry) {
    console.log(`🛑 Quota-burn ${familyId} denied by the provider — blocked until ${entry.until ? new Date(entry.until).toISOString() : `+${UNKNOWN_BLOCK_TTL_MS / 3_600_000}h`}`);
  }
  return entry;
}

/**
 * Clear `familyId`'s block. Called when a burn run SUCCEEDS: the provider served
 * it, which is more current evidence than any (rounded) stated reset.
 */
export async function clearQuotaBurnBlock(familyId) {
  if (!familyId) return null;
  return writeLedger(({ [familyId]: dropped, ...rest }) => {
    if (!dropped) return null;
    console.log(`✅ Quota-burn ${familyId} served a run — clearing its denial block`);
    return rest;
  });
}

/**
 * Fold one completed agent into the ledger: a refusal blocks its family, a
 * success clears it.
 *
 * Called from the runner's `agent:completed` continuation and AWAITED there
 * before the family is re-evaluated: that continuation dispatches the next plan
 * job immediately, so a block recorded later would cost one wasted agent.
 *
 * Only agents spawned BY a burn count (`quotaBurnFamily` stamped by
 * `quotaBurnInvoke.js`); an unrelated agent hitting a usage limit says nothing
 * about whether the burn plan may spend.
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
