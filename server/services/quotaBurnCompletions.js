/**
 * The `run once` completion ledger: which burn jobs have already had their one dispatch.
 *
 * A job marked `runOnce` records itself here when it dispatches and drops out of the
 * rotation until the user re-arms it. One file, `data/cos/quota-burn-completions.json`:
 * `<familyId>:<jobId>` → ISO instant. Machine-local and NOT federated (quota belongs to
 * a machine and provider account). A ledger rather than a job flag because a config PUT
 * replaces a family's whole `jobs` array (and the client's optimistic copy never sees
 * runner writes); the run log is a capped 50-entry feed and ages jobs out.
 */

import { join } from 'path';
import { atomicWrite, PATHS, readJSONFileStrict } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { QUOTA_BURN_BOUNDS, QUOTA_BURN_FAMILIES, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';

const LEDGER_FILE = () => join(PATHS.cos, 'quota-burn-completions.json');

/**
 * Entries kept, newest first. DERIVED as twice the most keys a live plan can hold,
 * so pruning only evicts records of deleted jobs, never a live one.
 */
const LEDGER_LIMIT = QUOTA_BURN_FAMILIES.length * QUOTA_BURN_BOUNDS.jobsPerFamily.max * 2;

// Serializes the read-modify-write: the scheduler tick and a manual "Run now" can
// finish a dispatch at once, and a lost completion puts a one-shot job back in the rotation.
const writeQueue = createFileWriteQueue();

/**
 * `<familyId>:<jobId>` → ISO instant of the dispatch that spent the job, or `null`
 * when the ledger could not be read. Reads STRICTLY: a failed read must not look
 * like "nothing has run" (re-dispatching every one-shot job, then persisting that
 * empty ledger over the survivors). Callers turn `null` into a skipped cycle.
 */
export async function getQuotaBurnCompletions() {
  const { ok, value } = await readJSONFileStrict(LEDGER_FILE(), {}, { logError: false });
  if (!ok) return null;
  if (!isPlainObject(value)) return {};
  // A truthy non-instant would make `jobIsSpent` retire that job forever.
  return Object.fromEntries(Object.entries(value).filter(([, at]) => typeof at === 'string' && at));
}

// Newest first, then capped; an unparseable date sorts last and is evicted first.
const prune = (ledger) => Object.fromEntries(
  Object.entries(ledger)
    .sort(([, a], [, b]) => (Date.parse(b) || 0) - (Date.parse(a) || 0))
    .slice(0, LEDGER_LIMIT),
);

/**
 * Read-modify-write inside the queue; `mutate` returning `null` skips the write.
 * Never overwrites a ledger that could not be read (same guard as `quotaBurnDenials.js#writeLedger`).
 */
const writeLedger = (mutate) => writeQueue(async () => {
  const ledger = await getQuotaBurnCompletions();
  if (!ledger) return null;
  const next = mutate({ ...ledger });
  if (!next) return null;
  await atomicWrite(LEDGER_FILE(), next);
  return next;
});

/** Mark one job as having had its run; re-stamps the instant on a forced re-run. */
export async function recordQuotaBurnJobCompletion(familyId, jobId, { now = Date.now() } = {}) {
  if (!familyId || !jobId) return null;
  return writeLedger((ledger) => prune({ ...ledger, [quotaBurnJobKey(familyId, jobId)]: new Date(now).toISOString() }));
}

/** Re-arm a spent `run once` job; omitting `jobId` re-arms the family's whole plan. */
export async function clearQuotaBurnJobCompletion(familyId, jobId = null) {
  if (!familyId) return null;
  return writeLedger((ledger) => {
    const keys = Object.keys(ledger).filter((key) => (jobId
      ? key === quotaBurnJobKey(familyId, jobId)
      : key.split(':')[0] === familyId));
    if (!keys.length) return null;
    for (const key of keys) delete ledger[key];
    return ledger;
  });
}
