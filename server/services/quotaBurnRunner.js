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
import { getQuotaBurnDispatches, explainFamilySkip, recordQuotaBurnDispatch, selectBurnCandidates } from './quotaBurn.js';
import { getQuotaBurnConfig, getQuotaBurnRuns, recordQuotaBurnRun } from './quotaBurnStore.js';
import { countJobPending, runBurnJob } from './quotaBurnJobs/index.js';
import { normalizeQuotaBurnFamily } from '../lib/quotaBurnConfig.js';

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
 */
async function dispatchFromCandidate(candidate, { jobId = null } = {}) {
  const attempts = [];
  for (const job of enabledJobs(candidate.family, jobId)) {
    const pending = await countJobPending({ job, family: candidate.family });
    if (!(pending.count > 0)) {
      attempts.push({ jobId: job.id, jobType: job.jobType, skipped: pending.detail || 'no pending work' });
      continue;
    }
    const result = await runBurnJob({ job, family: candidate.family, candidate });
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

  const quotas = await getProviderQuotas({ refresh: true }).catch((err) => {
    console.error(`❌ Quota-burn could not read provider quota: ${err.message}`);
    return null;
  });
  if (!quotas) return finish({ dispatched: false, reason: 'provider quota read failed' });

  const dispatches = await getQuotaBurnDispatches();
  let candidates = selectBurnCandidates(quotas, config, { dispatches })
    .filter((candidate) => !familyId || candidate.family.id === familyId);

  // `force` is the page's per-job "Run now": the user named a family and a job
  // and clicked, which is a direct instruction to spend that quota now — so the
  // reset-window / reserve / cap gates (which exist to bound UNATTENDED burns)
  // don't apply. It carries NO dispatchKey, so the run is also not charged
  // against the window's automatic budget.
  if (force && familyId && !candidates.length) {
    const family = { id: familyId, ...normalizeQuotaBurnFamily(config.families[familyId]) };
    candidates = [{ family, card: quotas.find((entry) => entry.family === familyId) || null, limit: null, hoursUntilReset: 0, dispatchKey: null }];
  }

  if (!candidates.length) {
    const reasons = Object.entries(config.families)
      .filter(([, family]) => family.enabled)
      .map(([id, family]) => `${id}: ${explainFamilySkip(id, family, quotas, { dispatches }) || 'ready'}`);
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
    // the cap bounds real burns, not attempts. A forced run has no window key
    // and is deliberately not charged (see the `force` block above).
    if (candidate.dispatchKey) await recordQuotaBurnDispatch(candidate.dispatchKey);
    return finish({
      dispatched: true,
      familyId: candidate.family.id,
      jobId: outcome.job.id,
      jobType: outcome.job.jobType,
      dispatchKey: candidate.dispatchKey,
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
 * Per-family view for the config page: the live quota card, whether the family
 * would burn on the next tick (and if not, exactly why), and each job's pending
 * count. Reads quota from cache by default — the page's explicit Refresh passes
 * `refresh: true` — so opening the page doesn't spawn a TUI scrape per family.
 */
export async function getQuotaBurnStatus({ refresh = false } = {}) {
  const config = await getQuotaBurnConfig();
  const quotas = await getProviderQuotas({ refresh }).catch((err) => {
    console.error(`❌ Quota-burn status could not read provider quota: ${err.message}`);
    return [];
  });
  const dispatches = await getQuotaBurnDispatches();
  const candidates = selectBurnCandidates(quotas, config, { dispatches });
  const byFamily = new Map(candidates.map((candidate) => [candidate.family.id, candidate]));

  const families = await Promise.all(Object.entries(config.families).map(async ([id, raw]) => {
    const family = { id, ...normalizeQuotaBurnFamily(raw) };
    const card = quotas.find((entry) => entry.family === id) || null;
    const candidate = byFamily.get(id) || null;
    // Probe pending work only for families the user actually enabled — a probe
    // is cheap but not free (the universe job reads every bible), and a disabled
    // family's counts are never acted on.
    const jobs = family.enabled
      ? await Promise.all(family.jobs.map(async (job) => ({ ...job, pending: await countJobPending({ job, family }) })))
      : family.jobs.map((job) => ({ ...job, pending: null }));
    return {
      id,
      label: card?.label || id,
      supported: card ? card.supported !== false : null,
      error: card?.error || null,
      percentRemaining: candidate?.limit?.percentRemaining ?? null,
      limitLabel: candidate?.limit?.label || candidate?.limit?.scope || null,
      hoursUntilReset: candidate ? Math.round(candidate.hoursUntilReset * 10) / 10 : null,
      dispatchesUsed: candidate?.dispatchesUsed ?? null,
      willBurn: Boolean(candidate),
      skipReason: candidate ? null : explainFamilySkip(id, raw, quotas, { dispatches }),
      jobs,
    };
  }));

  return {
    enabled: config.enabled,
    checkIntervalMinutes: config.checkIntervalMinutes,
    running,
    lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    families,
    runs: await getQuotaBurnRuns(),
  };
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

export function stopQuotaBurnScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/** Test seam — clears the in-process cycle state between cases. */
export function __resetQuotaBurnRunner() {
  stopQuotaBurnScheduler();
  running = false;
  lastRunAt = null;
}
