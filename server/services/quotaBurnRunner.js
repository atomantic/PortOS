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

/**
 * The jobs a cycle will consider, in plan order.
 *
 * `jobId` scopes to one named job. When it is named AND the run was forced, the
 * job's own `enabled` checkbox is ignored: the user just clicked ▶ on that
 * exact row, which is a more specific instruction than the checkbox they set
 * earlier. Without this, clicking ▶ on a paused job is a silent no-op reported
 * as "no pending work".
 */
const selectJobs = (family, { jobId = null, force = false } = {}) =>
  (family.jobs || []).filter((job) =>
    (!jobId || job.id === jobId) && (job?.enabled !== false || (jobId && force)));

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
async function dispatchFromCandidate(candidate, { jobId = null, force = false } = {}) {
  const attempts = [];
  for (const job of selectJobs(candidate.family, { jobId, force })) {
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
    // Only a SCHEDULED cycle advances the interval clock. A manual "Evaluate
    // now" that reports "no burnable window" would otherwise push the next
    // automatic cycle a full interval out — on a 12-hour interval, one curiosity
    // click can defer the tick past the reset the feature exists to spend.
    if (trigger === 'scheduled') lastRunAt = Date.now();
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
  //
  // A forced run of a NAMED job is exempt: `familyIsActionable` requires an
  // enabled family with an enabled job, but ▶ on a paused job (or a paused
  // family) is exactly the case the force path exists to serve — gating it here
  // would make the click a silent no-op before selection ever ran.
  const targeted = force && familyId;
  if (!targeted && !Object.values(config.families).some(familyIsActionable)) {
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
    // Scoped to the family the user asked about, and NOT filtered to enabled
    // families: when someone force-runs a job on a family whose checkbox is
    // off, "disabled" IS the answer — reporting a different family's verdict
    // instead (or claiming it is "ready" when it did not run) leaves them with
    // no path to the control they need.
    const reasons = evaluateFamilies(quotas, config, { dispatches })
      .filter(({ family }) => (familyId ? family.id === familyId : family.enabled))
      .map(({ family, skipReason }) => `${family.id}: ${skipReason || 'ready'}`);
    return finish({
      dispatched: false,
      reason: reasons.length ? `no burnable window — ${reasons.join('; ')}` : 'no families enabled',
    });
  }

  const attempts = [];
  for (const candidate of candidates) {
    const outcome = await dispatchFromCandidate(candidate, { jobId, force });
    attempts.push(...outcome.attempts.map((entry) => ({ familyId: candidate.family.id, ...entry })));
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

  // Report what each job actually said. Collapsing every non-dispatch to "no
  // job had pending work" asserts something usually false — a job that DID have
  // work and declined ("an identical burn task is already running", "managed
  // app app-x no longer exists", "no enabled CLI/TUI provider in the grok
  // family") is the actionable case, and it was the one being thrown away.
  const detail = attempts.map((entry) => `${entry.jobId}: ${entry.skipped}`).join('; ');
  return finish({
    dispatched: false,
    familyId: candidates[0].family.id,
    reason: detail
      ? `nothing dispatched — ${detail}`
      : `no enabled job in the ${candidates[0].family.id} plan`,
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

/**
 * When the last SCHEDULED cycle ran, in ms — from memory once this process has
 * run one, otherwise from the persisted run log.
 *
 * Reading the log is what makes `checkIntervalMinutes` mean anything across a
 * restart. `lastRunAt` is in-process, so on a bare `null` the very first tick
 * after boot is always "due": a PM2 restart, a self-update, or a crash-loop
 * would each fire a full cycle (a multi-second TUI scrape per family, plus a
 * possible dispatch) ~60s later, no matter how long the configured interval is
 * — pacing a 12-hourly plan into minutes, bounded only by the window cap.
 */
async function lastScheduledRunAt() {
  if (lastRunAt) return lastRunAt;
  const runs = await getQuotaBurnRuns().catch(() => []);
  const previous = runs.find((entry) => entry?.trigger === 'scheduled' && entry.at);
  const parsed = previous ? Date.parse(previous.at) : NaN;
  // Cache it so a restart pays the log read once, not every minute. An
  // unreadable/absent log leaves it null and the next tick runs — the correct
  // fail-open for "we have no idea when we last ran".
  if (Number.isFinite(parsed)) lastRunAt = parsed;
  return lastRunAt;
}

async function tick() {
  const config = await getQuotaBurnConfig().catch(() => null);
  if (!config?.enabled) return;
  const dueAt = (await lastScheduledRunAt() || 0) + config.checkIntervalMinutes * 60_000;
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

/** Test seam — one interval tick, without waiting on the timer. */
export const __tickQuotaBurn = tick;

/** Test seam — disarms the timer and clears the in-process cycle state. */
export function __resetQuotaBurnRunner() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  running = false;
  lastRunAt = null;
}
