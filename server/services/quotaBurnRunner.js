/**
 * Quota-burn runner — the single install-level loop.
 *
 * ONE loop lives in PortOS (not one scheduled task per managed app, which is
 * what this replaced): every `checkIntervalMinutes` it reads the burn plan,
 * takes a zero-token quota reading, and — only when a family's window is inside
 * its reset horizon with headroom above its reserve — runs the first job in that
 * family's ordered plan that reports pending work. At most ONE dispatch per
 * cycle, so a cycle can never blow through several windows' budgets at once.
 *
 * AI-policy posture (CLAUDE.md): this is a sanctioned scheduled automation —
 * disabled by default, armed only by an explicit opt-in on the Quota Burn page,
 * where the family, provider, model, and work are all named before anything
 * runs. Boot ARMS the interval; it never dispatches. With `enabled: false` the
 * tick returns before reading quota, so a fresh install is silent.
 *
 * Everything fails CLOSED and nothing here throws into the timer: a probe that
 * errors, a job that declines, or an unreadable config all end the cycle with a
 * logged reason instead of charging a dispatch or crashing the process.
 */

import { getProviderQuotas } from './providerUsage.js';
import { getQuotaBurnDispatches, evaluateFamilies, recordQuotaBurnDispatch, selectBurnCandidates } from './quotaBurn.js';
import { getQuotaBurnConfig, getQuotaBurnRuns, recordQuotaBurnRun } from './quotaBurnStore.js';
import { countJobPending, runBurnJob } from './quotaBurnJobs/index.js';
import { familyIsActionable } from '../lib/quotaBurnConfig.js';

const TICK_MS = 60_000;

let tickTimer = null;
let running = false;
let lastRunAt = null;

const enabledJobs = (family, jobId = null) =>
  (family.jobs || []).filter((job) => job?.enabled !== false && (!jobId || job.id === jobId));

/**
 * Walk a candidate's plan in order and run the first job with pending work.
 * Returns the dispatch outcome plus the per-job reasons, so a cycle that
 * dispatched nothing still explains itself in the run log.
 *
 * The probe's `context` is handed to `run` rather than thrown away: a
 * `universe-bible-images` probe reads every universe bible to count the backlog,
 * and `run` needs the very same scan to know what to render. Without the
 * passthrough that multi-megabyte read happened twice per dispatch.
 */
async function dispatchFromCandidate(candidate, { jobId = null } = {}) {
  const attempts = [];
  for (const job of enabledJobs(candidate.family, jobId)) {
    const pending = await countJobPending({ job, family: candidate.family });
    if (!(pending.count > 0)) {
      attempts.push({ jobId: job.id, jobType: job.jobType, skipped: pending.detail || 'no pending work' });
      continue;
    }
    const result = await runBurnJob({ job, family: candidate.family, candidate, context: pending.context });
    if (!result.dispatched) {
      attempts.push({ jobId: job.id, jobType: job.jobType, skipped: result.reason || 'declined' });
      continue;
    }
    return { dispatched: true, job, result, attempts };
  }
  return { dispatched: false, attempts };
}

/**
 * One evaluation. `trigger` is recorded in the run log so the page can tell a
 * scheduled tick from a "Run now". A manual trigger ignores the master
 * `enabled` switch (the user just clicked the button) but respects every quota
 * gate — the reset window, the reserve, and the per-window dispatch cap.
 */
export async function runQuotaBurnCycle(options = {}) {
  if (running) return { skipped: 'already-running' };
  running = true;
  // try/finally, not try/catch: this runs from a timer and from a route, and a
  // throw anywhere below (an ENOSPC on the ledger write, say) would otherwise
  // leave `running` stuck true and wedge the loop for the life of the process.
  // The error itself is deliberately NOT swallowed — the timer logs it and the
  // route surfaces it.
  try {
    return await evaluate(options);
  } finally {
    running = false;
  }
}

async function evaluate({ trigger = 'scheduled', familyId = null, jobId = null, force = false }) {
  const finish = async (entry) => {
    lastRunAt = Date.now();
    await recordQuotaBurnRun({ trigger, ...entry });
    return entry;
  };

  const config = await getQuotaBurnConfig().catch((err) => {
    console.error(`❌ Quota-burn could not read its config: ${err.message}`);
    return null;
  });
  if (!config) return finish({ dispatched: false, reason: 'config unreadable' });
  // A disabled tick writes NO run-log entry: a silent loop would otherwise fill
  // the log with "disabled" rows and bury the last real run.
  if (!config.enabled && trigger === 'scheduled') return { skipped: 'disabled' };

  // Check the plan BEFORE the quota read. `getProviderQuotas({ refresh: true })`
  // spawns a multi-second TUI scrape per enabled family; with no actionable
  // family configured that scrape could never produce a dispatch, and it would
  // otherwise run every `checkIntervalMinutes` forever.
  if (!Object.values(config.families).some(familyIsActionable)) {
    return finish({ dispatched: false, reason: 'no families enabled' });
  }

  const quotas = await getProviderQuotas({ refresh: true }).catch((err) => {
    console.error(`❌ Quota-burn could not read provider quota: ${err.message}`);
    return null;
  });
  if (!quotas) return finish({ dispatched: false, reason: 'provider quota read failed' });

  const dispatches = await getQuotaBurnDispatches();
  // `force` is the page's per-job "Run now" — the window/reserve/cap gates that
  // bound UNATTENDED burns don't apply to a run the user just asked for. It goes
  // through the same selection, so the candidate still carries the family's real
  // card and limit; it only comes back `charge: false`.
  const candidates = selectBurnCandidates(quotas, config, {
    dispatches, bypassGatesFor: force ? familyId : null,
  }).filter((candidate) => !familyId || candidate.family.id === familyId);

  if (!candidates.length) {
    const reasons = evaluateFamilies(quotas, config, { dispatches })
      .filter(({ family }) => family.enabled)
      .map(({ family, skipReason }) => `${family.id}: ${skipReason || 'ready'}`);
    return finish({
      dispatched: false,
      reason: reasons.length ? `no burnable window — ${reasons.join('; ')}` : 'no families enabled',
    });
  }

  for (const candidate of candidates) {
    const outcome = await dispatchFromCandidate(candidate, { jobId });
    if (!outcome.dispatched) continue;
    // Charge the window only once work actually started. `runBurnJob` reports a
    // decline rather than throwing, and a declined job never reaches here — so
    // the cap bounds real burns, not attempts. `charge` is false for a forced
    // run, which the user asked for outside the automatic budget.
    if (candidate.charge) await recordQuotaBurnDispatch(candidate.dispatchKey);
    return finish({
      dispatched: true,
      familyId: candidate.family.id,
      jobId: outcome.job.id,
      jobType: outcome.job.jobType,
      dispatchKey: candidate.dispatchKey,
      charged: candidate.charge,
      hoursUntilReset: Math.round(candidate.hoursUntilReset * 10) / 10,
      percentRemaining: candidate.limit?.percentRemaining ?? null,
      summary: outcome.result.summary || 'dispatched',
      detail: outcome.result.detail || null,
    });
  }

  return finish({
    dispatched: false,
    familyId: candidates[0].family.id,
    reason: `no job in the ${candidates[0].family.id} plan had pending work`,
  });
}

/**
 * The config page's whole payload: the plan plus, per family, whether it would
 * burn on the next tick (and if not, exactly why) and each job's pending count.
 *
 * Returns the config it loaded so the route doesn't read and normalize the same
 * file a second time. Reads quota from cache by default — the page's explicit
 * Refresh passes `refresh: true` — so opening the page doesn't spawn a TUI
 * scrape per family.
 */
export async function getQuotaBurnStatus({ refresh = false } = {}) {
  // Independent reads: only `quotas` is slow (a PTY scrape on the Refresh path),
  // and nothing else waits on it.
  const [config, quotas, dispatches, runs] = await Promise.all([
    getQuotaBurnConfig(),
    getProviderQuotas({ refresh }).catch((err) => {
      console.error(`❌ Quota-burn status could not read provider quota: ${err.message}`);
      return [];
    }),
    getQuotaBurnDispatches(),
    getQuotaBurnRuns(),
  ]);

  // ONE pass over the gate ladder the runner uses — the page's "will burn" and
  // its reason come from the same verdict, so they can't contradict each other.
  const families = await Promise.all(evaluateFamilies(quotas, config, { dispatches })
    .map(async ({ family, candidate, skipReason }) => ({
      id: family.id,
      label: candidate?.card?.label || quotas.find((entry) => entry.family === family.id)?.label || family.id,
      percentRemaining: candidate?.limit?.percentRemaining ?? null,
      hoursUntilReset: candidate ? Math.round(candidate.hoursUntilReset * 10) / 10 : null,
      dispatchesUsed: candidate?.dispatchesUsed ?? null,
      willBurn: Boolean(candidate),
      skipReason: skipReason || null,
      // Probe pending work only for families the user actually enabled — a probe
      // is not free (the universe job reads every bible), and a disabled
      // family's counts are never acted on.
      jobs: family.enabled
        ? await Promise.all(family.jobs.map(async (job) => ({ id: job.id, pending: await countJobPending({ job, family }) })))
        : family.jobs.map((job) => ({ id: job.id, pending: null })),
    })));

  return { config, status: { running, families, runs } };
}

async function tick() {
  const config = await getQuotaBurnConfig().catch(() => null);
  if (!config?.enabled) return;
  const dueAt = (lastRunAt || 0) + config.checkIntervalMinutes * 60_000;
  if (Date.now() < dueAt) return;
  await runQuotaBurnCycle({ trigger: 'scheduled' });
}

/**
 * Arm the loop. Called once at boot. The interval itself is unconditional and
 * cheap (a config read per minute); the SPEND is gated inside `tick`, so
 * toggling the feature on the page takes effect without a restart.
 */
export function startQuotaBurnScheduler() {
  if (tickTimer) return;
  // Every timer callback runs outside the request lifecycle — an uncaught throw
  // here would take down the process, so the whole tick is caught and logged.
  tickTimer = setInterval(() => {
    // `running` is already released by runQuotaBurnCycle's finally — this only
    // has to keep the throw from reaching the timer and killing the process.
    tick().catch((err) => console.error(`❌ Quota-burn tick failed: ${err.message}`));
  }, TICK_MS);
  tickTimer.unref?.();
  console.log('🔥 Quota-burn loop armed (off unless enabled in Quota Burn settings)');
}

/** Test seam — disarms the timer and clears the in-process cycle state. */
export function __resetQuotaBurnRunner() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  running = false;
  lastRunAt = null;
}
