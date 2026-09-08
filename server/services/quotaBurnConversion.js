/**
 * Runtime adapter for the legacy → reference conversion — the compat door.
 *
 * The plan on disk is converted once, by migration 359. This is the OTHER door:
 * a client (or a hand-edited file, or a body replayed from an older build) that
 * still PUTs a legacy `jobType` step. Rather than persisting it as an
 * un-migrated step the runner can only refuse, the save runs it through the SAME
 * decision the migration used (`lib/quotaBurnLegacyConversion.js`) and stores the
 * reference it produces.
 *
 * One rule, two doors, is the point. A second conversion written for the live
 * path would drift from the migration the first time either was tightened, and
 * the drift would land as the exact two failures the reference model exists to
 * prevent: a reference silently downgraded back to a copied prompt, or a
 * duplicate automation created beside one that already existed.
 *
 * Idempotency comes from the job id, not from bookkeeping: a custom conversion
 * addresses its job as `job-burn-<family>-<step>`, so a step converted twice
 * finds the job it made the first time and reuses it. Nothing here ever
 * overwrites an existing job — the user may have edited it since.
 *
 * A step this module cannot convert is left EXACTLY as it was. It normalizes to
 * unavailable with a migration reason (`QUOTA_BURN_UNAVAILABLE.LEGACY_UNMIGRATED`),
 * which is the deliberate posture: unavailable, with its settings intact, rather
 * than dispatched down a parallel legacy execution path that no longer exists.
 */

import {
  applyQuotaBurnStepConversion,
  planQuotaBurnStepConversion,
} from '../lib/quotaBurnLegacyConversion.js';
import { normalizeQuotaBurnJob } from '../lib/quotaBurnConfig.js';

/**
 * Ensure the custom job a conversion needs exists, and say whether it did.
 * Returns false when the job could not be created — the caller then leaves the
 * step legacy rather than pointing it at a job that is not there.
 */
async function ensureCustomJob(record) {
  // Lazy: the route imports this module on every save, and only a LEGACY payload
  // ever reaches here — a static import would pull the whole autonomous-jobs
  // tree (script handlers, command security, skill templates) into the request
  // path for every reference save that needs none of it.
  const { createJob, getJob } = await import('./autonomousJobs.js');
  const existing = await getJob(record.id).catch(() => null);
  if (existing) return true;
  const created = await createJob(record).catch((err) => {
    console.error(`❌ Quota-burn conversion could not create custom job ${record.id}: ${err.message}`);
    return null;
  });
  return Boolean(created?.id);
}

/**
 * Convert every legacy step in one family's `jobs` array. Steps that already
 * carry a reference pass through untouched, which is what makes a repeated save
 * a no-op instead of a second automation.
 */
async function convertFamilyJobs(jobs, familyId) {
  const converted = [];
  let changed = 0;
  for (const [index, raw] of jobs.entries()) {
    // Normalized first so the conversion reads the same shape the migration
    // does — including the `job-N` id a payload written without one falls back
    // to, which is what the custom job's deterministic id is keyed on.
    const step = normalizeQuotaBurnJob(raw, index);
    if (!step) continue;
    const outcome = planQuotaBurnStepConversion(step, { familyId });
    if (!outcome) {
      converted.push(raw);
      continue;
    }
    if (outcome.customJob && !(await ensureCustomJob(outcome.customJob))) {
      converted.push(raw);
      continue;
    }
    converted.push(applyQuotaBurnStepConversion(step, outcome));
    changed += 1;
    console.log(`🔁 Quota-burn step ${familyId}/${step.id} converted to a scheduled-task reference`);
  }
  return { jobs: converted, changed };
}

/**
 * Convert the legacy steps in a config PATCH before it is merged and saved.
 *
 * Takes and returns a patch (not a whole config): the PUT is partial, and a
 * family the body did not mention must stay untouched.
 */
export async function convertLegacyQuotaBurnPatch(patch) {
  const families = patch?.families;
  if (!families) return patch;
  const next = {};
  let changed = 0;
  for (const [familyId, family] of Object.entries(families)) {
    if (!Array.isArray(family?.jobs)) {
      next[familyId] = family;
      continue;
    }
    const result = await convertFamilyJobs(family.jobs, familyId);
    changed += result.changed;
    next[familyId] = result.changed ? { ...family, jobs: result.jobs } : family;
  }
  return changed ? { ...patch, families: next } : patch;
}
