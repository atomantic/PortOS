/**
 * Convert legacy quota-burn plans into scheduled-task REFERENCES.
 *
 * A burn step used to BE its work: a copied prompt in a free-form `params` bag
 * keyed by a quota-only `jobType`, executed by a registry that existed for
 * nothing else. #6381 retires that registry, so an install that upgrades across
 * it would find every step in `data/cos/quota-burn.json` unavailable — its plan
 * intact but unrunnable — until this migration points each step at a scheduled
 * task the user owns.
 *
 * The decision itself is NOT here. `lib/quotaBurnLegacyConversion.js` owns it,
 * and the live compat path (`services/quotaBurnConversion.js`, for a payload an
 * older client still PUTs) reads the same module: two conversions would drift
 * the first time either was tightened, and the drift would land as a duplicated
 * automation or a silently downgraded reference. This file is the adapter — it
 * reads two JSON files, creates the custom jobs the conversion asked for, and
 * writes the rewritten plan.
 *
 * **Gated on its INPUT, and ships no seed.** `data/cos/quota-burn.json` is
 * DERIVED from the install's own records, so per AGENTS.md it must never ship a
 * `data.reference/` seed (setup-data runs first and would land shipped defaults
 * where the user's plan was, and this migration — gating on the input — would
 * then convert the seed instead of their plan). The path is declared in
 * `scripts/lib/migrationOwnedPaths.js`, whose guard test fails if a seed
 * appears.
 *
 * **Idempotent and interrupt-safe.** A step that already carries a `taskRef` is
 * skipped, so a second run converts nothing. A custom conversion addresses its
 * job by a deterministic `job-burn-<family>-<step>` id, so a resumed run finds
 * the job it created last time instead of minting a duplicate automation. The
 * jobs file is written BEFORE the plan: an interrupt between the two leaves a
 * created job that nothing references yet (inert — it is on-demand, so no clock
 * fires it) rather than a plan referencing a job that does not exist. Nothing
 * here dispatches anything, so no run is ever added.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { atomicWrite } from '../../server/lib/fileCore.js';
import { normalizeQuotaBurnJob } from '../../server/lib/quotaBurnConfig.js';
import {
  applyQuotaBurnStepConversion,
  planQuotaBurnStepConversion,
} from '../../server/lib/quotaBurnLegacyConversion.js';

const QUOTA_BURN_PATH = join('data', 'cos', 'quota-burn.json');
const JOBS_PATH = join('data', 'cos', 'autonomous-jobs.json');

/**
 * Where the pre-conversion plan is copied before anything is rewritten.
 *
 * Recognizing a shipped preset is a structural heuristic (migration 305's
 * mission-half rule), and a heuristic can be wrong in the user's disfavour —
 * here that would mean a prompt they had edited being read as ours and mapped
 * onto a shipped task. `data/` is gitignored runtime state with nothing to
 * recover from, so one copy taken before the first rewrite makes the whole
 * question moot: the conversion stops being irreversible. Same posture, and the
 * same reasoning, as migration 305's backup.
 */
const BACKUP_PATH = join('data', 'cos', 'quota-burn.pre-359.json');

/**
 * Absent → `null` (nothing to migrate). Unparseable → THROW.
 *
 * Swallowing a parse error would return the same `null` as "this install has no
 * burn plan", the migration would report 0 conversions, and the runner would
 * record 359 as applied — so once the user repaired their JSON, the conversion
 * that is the whole point of this migration would never run again. Failing
 * loudly on a corrupt file is the only outcome that stays recoverable.
 */
async function readJson(fullPath, label) {
  const raw = await readFile(fullPath, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (raw == null) return null;
  try {
    // The raw text rides along so a backup is a byte-for-byte copy of what was
    // on disk, not a re-serialization that could differ in formatting.
    return { raw, value: JSON.parse(raw) };
  } catch (err) {
    throw new Error(`${label} is not valid JSON (${err.message}) — repair it and re-run migrations`);
  }
}

const writeJson = (fullPath, value) => atomicWrite(fullPath, `${JSON.stringify(value, null, 2)}\n`);

export default {
  async up({ rootDir }) {
    const planPath = join(rootDir, QUOTA_BURN_PATH);
    const plan = await readJson(planPath, QUOTA_BURN_PATH);
    // Gated on the INPUT: no burn plan on this install means there is nothing to
    // convert, not that an output is missing.
    if (!plan?.value?.families) return { converted: 0 };

    const config = plan.value;
    const pending = [];
    let unconverted = 0;

    for (const [familyId, family] of Object.entries(config.families)) {
      const jobs = Array.isArray(family?.jobs) ? family.jobs : [];
      jobs.forEach((raw, index) => {
        const step = normalizeQuotaBurnJob(raw, index);
        const outcome = step ? planQuotaBurnStepConversion(step, { familyId }) : null;
        if (outcome) {
          pending.push({ familyId, index, step, outcome });
          return;
        }
        // A step that already carries a reference is simply done. One that still
        // names a `jobType` the conversion has no rule for is left EXACTLY as it
        // is — its label, order and settings are the user's — and counted, so it
        // is reported rather than silently invisible.
        if (!step?.taskRef && raw?.jobType) unconverted += 1;
      });
    }

    if (!pending.length) {
      if (unconverted) console.log(`✋ ${QUOTA_BURN_PATH}: left ${unconverted} step(s) that name no convertible work`);
      return { converted: 0, unconverted };
    }

    // Jobs FIRST — see the header. Existing ids are left exactly as they are:
    // a re-run must reuse the job it created, never overwrite edits made since.
    const newJobs = pending.map(({ outcome }) => outcome.customJob).filter(Boolean);
    if (newJobs.length) {
      const stored = await readJson(join(rootDir, JOBS_PATH), JOBS_PATH);
      const data = stored?.value?.jobs ? stored.value : { version: 1, lastUpdated: new Date().toISOString(), jobs: [] };
      const existing = new Set(data.jobs.map((job) => job?.id));
      const added = newJobs.filter((job) => !existing.has(job.id));
      if (added.length) {
        data.jobs.push(...added);
        data.lastUpdated = new Date().toISOString();
        await writeJson(join(rootDir, JOBS_PATH), data);
        for (const job of added) console.log(`🆕 ${JOBS_PATH}: created on-demand custom task ${job.id}`);
      }
    }

    for (const { familyId, index, step, outcome } of pending) {
      const converted = applyQuotaBurnStepConversion(step, outcome);
      const raw = config.families[familyId].jobs[index];
      // Written onto the STORED object so anything this migration does not know
      // about (a field a newer PortOS added, a key a user hand-edited in) rides
      // through untouched. Only the step's IDENTITY changes.
      // `id` is stamped when the stored step had none: it is what the run-once
      // ledger, the dispatch records and the converted task's own id all key on,
      // and leaving it to a positional fallback would move it the first time a
      // step ahead of it was deleted.
      Object.assign(raw, { id: step.id, taskRef: converted.taskRef, overrides: converted.overrides, params: converted.overrides.params, unavailable: null });
      delete raw.jobType;
      const names = outcome.customJob ? `custom task ${outcome.customJob.id}` : `scheduled task ${converted.taskRef.taskType}`;
      console.log(`🔁 ${QUOTA_BURN_PATH}: ${familyId}/${step.id} now references ${names}`);
    }

    await atomicWrite(join(rootDir, BACKUP_PATH), plan.raw);
    console.log(`💾 ${QUOTA_BURN_PATH}: previous plan saved to ${BACKUP_PATH}`);
    await writeJson(planPath, config);

    // A converted built-in reference is only RUNNABLE where the target app has
    // that scheduled task switched on — the shared availability ladder decides
    // that, not this migration, and enabling a task type here would silently arm
    // a recurring automation the user never asked for. Said once, so a step that
    // shows as unavailable on the Quota Burn page has an explanation.
    console.log(`ℹ️ ${QUOTA_BURN_PATH}: a converted step runs once its target app has that scheduled task enabled`);
    if (unconverted) console.log(`✋ ${QUOTA_BURN_PATH}: left ${unconverted} step(s) that name no convertible work`);
    return { converted: pending.length, customTasks: pending.filter(({ outcome }) => outcome.customJob).length, unconverted };
  },
};
