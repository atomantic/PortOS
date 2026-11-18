/**
 * Quota-burn runner — the single install-level loop.
 *
 * Every `checkIntervalMinutes` it reads the burn plan, takes a zero-token quota
 * reading, and — only when a family's window is inside its reset horizon with
 * headroom above its reserve — runs the next job in that family's ordered plan
 * that reports pending work.
 *
 * The interval only STARTS a family's burn. Each finished burn agent triggers a
 * fresh evaluation of that family (`onBurnAgentCompleted`), so the plan is walked
 * one agent at a time until a gate closes (dispatch cap, reserve, reset horizon).
 * "Next job" is literal: the walk resumes after the family's last dispatch
 * (`rotatePlanAfter`).
 *
 * At most one dispatch per FAMILY per cycle. Families draw down their own
 * subscription window, reserve and `maxDispatchesPerWindow`, so stopping the
 * whole cycle after the first dispatch would let the soonest-resetting family
 * starve the rest.
 *
 * AI-policy posture (AGENTS.md): a sanctioned scheduled automation — disabled by
 * default, armed only by an explicit opt-in on the Quota Burn page. Boot ARMS the
 * interval; it never dispatches. With `enabled: false` the tick returns before
 * reading quota.
 *
 * Everything fails CLOSED and nothing throws into the timer: a failing probe, a
 * declining job or an unreadable config ends the cycle with a logged reason.
 *
 * ACCOUNTING happens on acceptance, not dispatch. The synchronous lanes
 * (programmatic handler, custom job) are charged here on return. A reference step
 * goes out as an on-demand REQUEST an engine may refuse, so it takes a
 * reservation that counts against the window cap and blocks a duplicate dispatch
 * until `quotaBurnAcceptance.js` settles it into one charge or releases it.
 * Each cycle settles the previous one's requests first.
 */

import { getProviderQuotas } from './provider/providerUsage.js';
import { getQuotaBurnDispatches, evaluateFamilies, PLAN_COMPLETE_SKIP_REASON, recordQuotaBurnDispatch, selectBurnCandidates, withPendingDispatches } from './quotaBurn.js';
import { reconcileQuotaBurnReservations, reserveQuotaBurnDispatch } from './quotaBurnAcceptance.js';
import { getQuotaBurnCompletions, recordQuotaBurnJobCompletion } from './quotaBurnCompletions.js';
import { getActiveQuotaBurnBlocks, recordBurnAgentCompletion } from './quotaBurnDenials.js';
import { isQueuedContinuation } from '../lib/agent/agentOutcome.js';
import { getQuotaBurnConfig, getQuotaBurnReservations, getQuotaBurnRuns, quotaBurnReservationKey, recordQuotaBurnRun } from './quotaBurnStore.js';
import { countQuotaBurnStepPending, getQuotaBurnTaskCatalog, invokeQuotaBurnStep } from './quotaBurnInvoke.js';
import { familyHasRunnableJobs, familyIsConfigured, jobIsSpent, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';
import { applyQuotaBurnAvailability } from '../lib/quotaBurnTaskRef.js';
import { windowLabelOf } from '../lib/quotaWindows.js';
import { WAIT } from '../lib/staleWhileRevalidate.js';
import { cosEvents } from './cos/cosEvents.js';
import { nextQuotaBurnSequenceJob, completeQuotaBurnSequenceStep, heldForDeepCheckpoint } from './quotaBurnSequence.js';
import { burnPlanOwnsAgent } from '../lib/quotaBurnOrigin.js';
import { isHostShuttingDown } from '../lib/hostShutdown.js';

const TICK_MS = 60_000;

let tickTimer = null;
let running = false;
let lastRunAt = null;
// Completion continuations deferred while a cycle runs. Retain the completed
// task id: its task record can still say in_progress when the event arrives.
const deferredContinuations = new Map();

/**
 * The jobs a cycle will consider, in plan order. `jobId` scopes to one named
 * job; when also forced, that job's `enabled` checkbox and a spent `run once`
 * marker are ignored, since the explicit ▶ click is more specific.
 */
const selectJobs = (family, { jobId = null, force = false, completions = {} } = {}) => {
  const targeted = Boolean(jobId) && force;
  return (family.jobs || []).filter((job) => (!jobId || job.id === jobId)
    && (targeted || (job?.enabled !== false && !jobIsSpent(job, family.id, completions))));
};

/** The two pending-probe fields the page renders; an allowlist so new job fields opt into the wire. */
const wireShape = (pending) => ({ count: pending?.count ?? 0, detail: pending?.detail ?? '' });

/**
 * What a step names, for the run log and skip report: its scheduled task, or the
 * legacy job type. `jobType` is null on a reference step.
 */
const stepIdentity = (job) => (job?.taskRef
  ? { taskRef: job.taskRef }
  : { jobType: job?.jobType ?? null });

/**
 * ONE invocation path, whatever the step names. The quota-only `JOB_MODULES`
 * registry is retired (#6381): a legacy `jobType` step resolves to
 * `LEGACY_UNMIGRATED` inside the shared path and reports "nothing pending" with
 * its migration reason, so the page and the runner say the same thing.
 */
const probeStep = ({ job, family, catalog }) => countQuotaBurnStepPending({ step: job, family, catalog });

const runStep = ({ job, family, candidate, context, force, catalog }) =>
  invokeQuotaBurnStep({ step: job, family, candidate, context, force, catalog });

/**
 * The live task catalog, read at most once per cycle/status pass and only when a
 * reference step is present. An unreadable one comes back EMPTY, which
 * `resolveQuotaBurnStepAvailability` reads as "ask no catalog questions":
 * target scope is still judged and a transient read failure orphans no step.
 */
const catalogFor = async (jobs) => ((jobs || []).some((job) => job?.taskRef)
  ? await getQuotaBurnTaskCatalog().catch((err) => {
    console.error(`❌ Quota-burn could not read the scheduled-task catalog: ${err.message}`);
    return {};
  })
  : {});

/**
 * The plan, re-anchored to start just AFTER the job this family last dispatched.
 * A burn plan is an ordered ROTATION: restarting at index 0 each cycle let the
 * first job win forever, since `agent-prompt` always reports work pending. An
 * unknown cursor (first dispatch, deleted or aged-out job) falls back to plan order.
 */
export function rotatePlanAfter(jobs, afterJobId) {
  const at = afterJobId ? jobs.findIndex((job) => job.id === afterJobId) : -1;
  return at < 0 ? jobs : [...jobs.slice(at + 1), ...jobs.slice(0, at + 1)];
}

/** Each family's most recently dispatched job id; the run log (newest first) IS the cursor. */
async function lastDispatchedJobByFamily() {
  const runs = await getQuotaBurnRuns().catch(() => []);
  const cursors = new Map();
  for (const entry of runs) {
    if (!entry?.dispatched || !entry.familyId || !entry.jobId) continue;
    if (!cursors.has(entry.familyId)) cursors.set(entry.familyId, entry.jobId);
  }
  return cursors;
}

/**
 * Walk a candidate's plan — starting after the family's last dispatch — and run
 * the first job with pending work. Returns the outcome plus per-job reasons, so
 * a cycle that dispatched nothing still explains itself in the run log.
 *
 * The probe's `context` is handed to `run` to avoid repeating its scan
 * (a `universe-bible-images` probe reads every bible).
 */
async function dispatchFromCandidate(candidate, { jobId = null, force = false, afterJobId = null, completions = {}, catalog = {}, reserved = new Set() } = {}) {
  const attempts = [];
  // A forced run of a NAMED job skips the pending probe: the user already picked the job, and
  // the probe (e.g. `universe-bible-images`' 6-hour in-flight cooldown) must not veto the click.
  // `force` is threaded into the job so it can relax its own cooldown too.
  const targeted = force && jobId;
  for (const job of rotatePlanAfter(selectJobs(candidate.family, { jobId, force, completions }), afterJobId)) {
    // A burn of this step is already out and unaccepted: re-dispatching would queue and charge
    // the same work twice (`quotaBurnAcceptance.js`). Not bypassable by `force`: it is not a quota gate.
    if (reserved.has(quotaBurnReservationKey(candidate.family.id, job.id))) {
      attempts.push({ jobId: job.id, ...stepIdentity(job), skipped: 'a burn of this step is already awaiting acceptance' });
      continue;
    }
    const pending = targeted ? null : await probeStep({ job, family: candidate.family, catalog });
    if (pending && !(pending.count > 0)) {
      attempts.push({ jobId: job.id, ...stepIdentity(job), skipped: pending.detail || 'no pending work' });
      continue;
    }
    const result = await runStep({ job, family: candidate.family, candidate, context: pending?.context, force, catalog });
    if (!result.dispatched) {
      attempts.push({ jobId: job.id, ...stepIdentity(job), skipped: result.reason || 'declined' });
      continue;
    }
    return { dispatched: true, job, result, attempts };
  }
  return { dispatched: false, attempts };
}

/**
 * One evaluation. `trigger` is recorded in the run log. A manual trigger ignores
 * the master `enabled` switch; `force` also bypasses the reset window, reserve,
 * dispatch cap, and denial gates.
 */
export async function runQuotaBurnCycle(options = {}) {
  // A dispatch made while the server exits registers an owner the shutdown marker never saw,
  // so the next boot would charge it as an orphan (#14170). Checked before the deferral below too.
  if (isHostShuttingDown()) return { skipped: 'host-shutdown' };
  if (running) {
    // A continuation landing mid-cycle is REMEMBERED, not dropped (a drop would stall that
    // family until the next interval tick). Keyed by family so repeats collapse into one.
    if (options.trigger === 'continuation' && options.familyId) deferredContinuations.set(options.familyId, options.ignoreTaskId || null);
    return { skipped: 'already-running' };
  }
  running = true;
  // try/finally, not try/catch: a throw below (e.g. ENOSPC on the ledger write) must not leave
  // `running` stuck true. The error is NOT swallowed; the timer logs it and the route surfaces it.
  try {
    return await evaluate(options);
  } finally {
    running = false;
    await drainDeferredContinuations();
  }
}

/**
 * Run the continuations that arrived while a cycle was in flight, one at a time,
 * through the same gate ladder as any dispatch. Errors are swallowed because this
 * runs from the caller's `finally` and a throw would mask that cycle's result.
 */
async function drainDeferredContinuations() {
  while (deferredContinuations.size) {
    const [[familyId, ignoreTaskId]] = deferredContinuations;
    deferredContinuations.delete(familyId);
    await runQuotaBurnCycle({ trigger: 'continuation', familyId, ignoreTaskId })
      .catch((err) => console.error(`❌ Quota-burn deferred continuation for ${familyId} failed: ${err.message}`));
  }
}

async function evaluate({ trigger = 'scheduled', familyId = null, jobId = null, force = false, ignoreTaskId = null }) {
  const finish = async (entry) => {
    // Only a SCHEDULED cycle advances the interval clock; a manual "Evaluate now" must not defer the tick.
    if (trigger === 'scheduled') lastRunAt = Date.now();
    // Every cycle logs its decision, including a correct decline.
    console.log(entry.dispatched
      ? `🔥 Quota-burn ${trigger}: dispatched ${entry.familyId}/${entry.jobId} — ${entry.summary}`
      : `💤 Quota-burn ${trigger}: nothing dispatched — ${entry.reason}`);
    await recordQuotaBurnRun({ trigger, ...entry });
    return entry;
  };

  const config = await getQuotaBurnConfig().catch((err) => {
    console.error(`❌ Quota-burn could not read its config: ${err.message}`);
    return null;
  });
  if (!config) return finish({ dispatched: false, reason: 'config unreadable' });
  // A disabled tick writes NO run-log entry. Only a `manual` trigger runs while the master
  // switch is off; "not manual" (not an allowlist) so a new trigger type fails CLOSED.
  if (!config.enabled && trigger !== 'manual') return { skipped: 'disabled' };

  // Settle what the LAST dispatch asked for first: acceptance is asynchronous and charging or
  // releasing reservations changes the ladder's answers. Ahead of the run-once read: an accepted step is spent now.
  const settlement = await reconcileQuotaBurnReservations();
  if (settlement.accepted || settlement.refused) {
    console.log(`🧾 Quota-burn settled ${settlement.accepted} accepted and ${settlement.refused} refused burn${settlement.accepted + settlement.refused === 1 ? '' : 's'}`);
  }

  // Read once per cycle and threaded through so a job spent mid-cycle can't be re-picked.
  // `null` (unreadable ledger) is NOT "nothing has run": it would re-dispatch every `run once`
  // job, so fail CLOSED and skip the cycle.
  const completions = await getQuotaBurnCompletions();
  if (!completions) {
    console.error('❌ Quota-burn could not read its run-once ledger — skipping this cycle');
    return finish({ dispatched: false, reason: 'run-once ledger unreadable' });
  }

  // Check the plan BEFORE the quota read: `getProviderQuotas({ wait: WAIT.FRESH })` spawns a
  // multi-second TUI scrape per enabled family, pointless with no actionable family (or only
  // spent `run once` jobs, hence `completions`). A forced run of a NAMED job is exempt, since
  // ▶ on a paused or already-run job is what force serves. The second pass only picks the
  // wording: a finished one-shot plan wants Re-arm, an unset plan wants a job.
  const targeted = force && familyId;
  const families = Object.values(config.families);
  if (!targeted && !families.some((family) => familyHasRunnableJobs(family, completions))) {
    return finish({
      dispatched: false,
      reason: families.some(familyIsConfigured) ? PLAN_COMPLETE_SKIP_REASON : 'no families enabled',
    });
  }

  // Scoped to the named family (per-family "Run now" or continuation): each card for another
  // family would cost its own multi-second PTY scrape (WAIT.FRESH bypasses the cache).
  const quotas = await getProviderQuotas({ wait: WAIT.FRESH, family: familyId }).catch((err) => {
    console.error(`❌ Quota-burn could not read provider quota: ${err.message}`);
    return null;
  });
  if (!quotas) return finish({ dispatched: false, reason: 'provider quota read failed' });

  const [charged, blocks, reservations] = await Promise.all([
    getQuotaBurnDispatches(), getActiveQuotaBurnBlocks(), getQuotaBurnReservations(),
  ]);
  // An unreadable dispatch ledger reads as "0 used", which would walk past
  // `maxDispatchesPerWindow` and respend quota (#4115): skip the cycle.
  if (!charged) return finish({ dispatched: false, reason: 'dispatch ledger read failed' });
  // Same for reservations: "nothing pending" would re-queue an awaiting step and reopen its share of the cap.
  if (!reservations) return finish({ dispatched: false, reason: 'pending reservations read failed' });
  // Gate on charges plus burns committed to this window and not yet accepted.
  const dispatches = withPendingDispatches(charged, reservations);
  const reserved = new Set(Object.keys(reservations));
  // `force` bypasses the window/reserve/cap/denial gates that bound UNATTENDED burns; it still
  // goes through selection and comes back `charge: false`.
  const candidates = selectBurnCandidates(quotas, config, {
    dispatches, blocks, completions, bypassGatesFor: force ? familyId : null,
  }).filter((candidate) => !familyId || candidate.family.id === familyId);

  if (!candidates.length) {
    // Scoped to the asked family and NOT filtered to enabled ones: for a force-run on a disabled
    // family, "disabled" is the answer.
    const reasons = evaluateFamilies(quotas, config, { dispatches, blocks, completions })
      .filter(({ family }) => (familyId ? family.id === familyId : family.enabled))
      .map(({ family, skipReason }) => `${family.id}: ${skipReason || 'ready'}`);
    return finish({
      dispatched: false,
      reason: reasons.length ? `no burnable window — ${reasons.join('; ')}` : 'no families enabled',
    });
  }

  const attempts = [];
  const dispatched = [];
  // Where each family's plan walk resumes (`rotatePlanAfter`); read before any dispatch so
  // families in one cycle can't see each other's fresh entries.
  const cursors = await lastDispatchedJobByFamily();
  // ONE catalog for the whole cycle; none of its inputs vary per family.
  const catalog = await catalogFor(candidates.flatMap((entry) => entry.family.jobs || []));
  // Every eligible family gets its own dispatch (see the header): no break on first success,
  // since each candidate spends a different provider's window.
  for (const candidate of candidates) {
    let selectedJobId = jobId;
    if (candidate.family.sequence) {
      const next = await nextQuotaBurnSequenceJob(candidate.family, { completions, reservations, catalog, ignoreTaskId });
      if (!next.job || (jobId && jobId !== next.job.id)) {
        attempts.push({ familyId: candidate.family.id, jobId: jobId || 'sequence', skipped: next.reason || 'an earlier sequence step must finish first' });
        continue;
      }
      selectedJobId = next.job.id;
    }
    const outcome = await dispatchFromCandidate(candidate, {
      jobId: selectedJobId, force, completions, catalog, reserved, afterJobId: cursors.get(candidate.family.id) || null,
    });
    attempts.push(...outcome.attempts.map((entry) => ({ familyId: candidate.family.id, ...entry })));
    if (!outcome.dispatched) continue;
    // Charge only once work is ACCEPTED. A declined step never reaches here; an `awaiting` lane
    // holds a reservation that becomes one charge on join (`quotaBurnAcceptance.js`).
    // `charge` is false for a forced run, outside the automatic budget.
    const requestId = outcome.result.awaiting?.requestId || null;
    if (requestId) {
      const held = await reserveQuotaBurnDispatch({
        familyId: candidate.family.id,
        stepId: outcome.job.id,
        dispatchKey: candidate.dispatchKey,
        charge: candidate.charge,
        // A strict sequence finishes on successful agent completion (or a drained
        // claim backlog), not merely on the request being accepted.
        runOnce: outcome.job.runOnce === true && !candidate.family.sequence,
        requestId,
      });
      // The request is already scheduled and cannot be recalled: warn; the burn runs uncharged.
      if (!held) console.error(`⚠️ Quota-burn could not reserve ${candidate.family.id}/${outcome.job.id} for request ${requestId} — this burn will go uncharged`);
    } else {
      if (candidate.charge) await recordQuotaBurnDispatch(candidate.dispatchKey);
      // A `run once` job records its dispatch even when FORCED and uncharged: `charge` is about
      // the automatic budget, `runOnce` about the WORK having happened. ▶ stays the way back.
      if (outcome.job.runOnce && !candidate.family.sequence) {
        await recordQuotaBurnJobCompletion(candidate.family.id, outcome.job.id)
          // A ledger failure must not fail a dispatch that already happened.
          .catch((err) => console.error(`⚠️ Quota-burn run-once ledger for ${candidate.family.id}/${outcome.job.id}: ${err.message}`));
      }
    }
    // One run-log entry PER dispatch, recorded as it happens, so the user can audit each
    // family's spend. A pending row is settled IN PLACE (`settleQuotaBurnRun`).
    dispatched.push(await finish({
      dispatched: true,
      familyId: candidate.family.id,
      jobId: outcome.job.id,
      ...stepIdentity(outcome.job),
      dispatchKey: candidate.dispatchKey,
      requestId,
      pending: Boolean(requestId),
      taskId: outcome.result.detail?.taskId ?? null,
      charged: candidate.charge && !requestId,
      hoursUntilReset: Math.round(candidate.hoursUntilReset * 10) / 10,
      percentRemaining: candidate.limit?.percentRemaining ?? null,
      summary: outcome.result.summary || 'dispatched',
      detail: outcome.result.detail || null,
    }));
  }

  // One dispatch keeps the flat entry shape; several come back as one aggregate naming all of them.
  if (dispatched.length === 1) return dispatched[0];
  if (dispatched.length > 1) {
    return {
      dispatched: true,
      summary: `Dispatched ${dispatched.length} jobs — ${dispatched.map((entry) => `${entry.familyId}: ${entry.summary}`).join('; ')}`,
      dispatches: dispatched,
    };
  }

  // Report what each job actually said: a job that had work and declined is the actionable
  // case. Prefix reasons with the family when several were evaluated.
  const label = (entry) => (candidates.length > 1 ? `${entry.familyId}/${entry.jobId}` : entry.jobId);
  const detail = attempts.map((entry) => `${label(entry)}: ${entry.skipped}`).join('; ');
  const plans = candidates.map((candidate) => candidate.family.id).join(', ');
  return finish({
    dispatched: false,
    familyId: candidates[0].family.id,
    reason: detail
      ? `nothing dispatched — ${detail}`
      : `no enabled job in the ${plans} plan${candidates.length > 1 ? 's' : ''}`,
  });
}

/**
 * The config page's whole payload: the plan plus, per family, whether it would
 * burn on the next tick (and if not, why) and each job's pending count. Returns
 * the loaded config so the route doesn't re-read it.
 *
 * NEVER blocks on a quota reading: a cached one is served (refreshed behind the
 * response once stale), a cold cache comes back `pending: true`. The page's
 * explicit Refresh passes `refresh: true` and waits, since that click IS the
 * request for a live reading.
 */
export async function getQuotaBurnStatus({ refresh = false } = {}) {
  // Independent reads; only `quotas` is slow.
  const configPromise = getQuotaBurnConfig();
  const [config, quotas, charged, blocks, completions, runs, catalog, reservations] = await Promise.all([
    configPromise,
    getProviderQuotas({ wait: refresh ? WAIT.FRESH : WAIT.NEVER }).catch((err) => {
      console.error(`❌ Quota-burn status could not read provider quota: ${err.message}`);
      return [];
    }),
    // An unreadable ledger degrades to "no dispatches counted": on the STATUS path the cost is
    // a stale `N/M used` label, whereas the cycle refuses to run.
    getQuotaBurnDispatches().then((ledger) => ledger || {}),
    getActiveQuotaBurnBlocks(),
    // An unreadable ledger degrades to "no badges" here (the cost is a missing "Ran once"
    // label), the opposite of the cycle's posture.
    getQuotaBurnCompletions().then((ledger) => ledger || {}),
    getQuotaBurnRuns(),
    // Depends only on the config, so it overlaps the PTY scrape.
    configPromise.then((cfg) => catalogFor(Object.values(cfg.families).flatMap((family) => family.jobs || []))),
    // READ ONLY: a reserved burn counts as used against the cap, but a probe read that settled
    // one would make opening the page a spend (AGENTS.md). Degrades to "nothing pending".
    getQuotaBurnReservations().then((pending) => pending || {}),
  ]);

  const dispatches = withPendingDispatches(charged, reservations);
  const cards = new Map(quotas.map((card) => [card.family, card]));
  // ONE pass over the runner's gate ladder, so "will burn" and its reason can't contradict.
  const families = await Promise.all(evaluateFamilies(quotas, config, { dispatches, blocks, completions })
    .map(async ({ family, candidate, skipReason, block }) => {
      const card = cards.get(family.id);
      return {
        id: family.id,
        label: candidate?.card?.label || card?.label || family.id,
        percentRemaining: candidate?.limit?.percentRemaining ?? null,
        hoursUntilReset: candidate ? Math.round(candidate.hoursUntilReset * 10) / 10 : null,
        // WHICH window the numbers describe (weekly vs 5-hour).
        windowLabel: candidate ? windowLabelOf(candidate.limit) : null,
        dispatchesUsed: candidate?.dispatchesUsed ?? null,
        willBurn: Boolean(candidate),
        skipReason: skipReason || null,
        // An observed provider refusal, surfaced even if it is not the closing gate.
        blockedUntil: block?.until ? new Date(block.until).toISOString() : null,
        blockedReason: block?.reason || null,
        // The reading is being taken now; the page polls again.
        pending: Boolean(card?.pending),
        // Probe only enabled families and jobs a cycle could still pick (a probe is not free);
        // `ranAt` is the page's only signal that a step is finished rather than idle.
        jobs: await Promise.all(family.jobs.map(async (job) => {
          const ranAt = completions[quotaBurnJobKey(family.id, job.id)] || null;
          // `jobIsSpent` re-derived from the value just read, and not shipped: the client gates its
          // badge on its optimistic config.
          const spent = job.runOnce === true && Boolean(ranAt);
          return {
            id: job.id,
            ranAt,
            // `context` is stripped: it is the probe→run hand-off; the page renders `count` and `detail` only.
            pending: family.enabled && !spent ? wireShape(await probeStep({ job, family, catalog })) : null,
          };
        })),
      };
    }));

  // Availability is a fact about the catalog RIGHT NOW: stamped onto the page config, never disk.
  return { config: applyQuotaBurnAvailability(config, catalog), status: { running, families, runs } };
}

/**
 * When the last SCHEDULED cycle ran, in ms — from memory once this process has run
 * one, otherwise from the persisted run log, so `checkIntervalMinutes` survives a
 * restart (a bare `null` would make the first tick after boot always due).
 */
async function lastScheduledRunAt() {
  if (lastRunAt) return lastRunAt;
  const runs = await getQuotaBurnRuns().catch(() => []);
  const previous = runs.find((entry) => entry?.trigger === 'scheduled' && entry.at);
  const parsed = previous ? Date.parse(previous.at) : NaN;
  // Cache so a restart pays the log read once; an absent log leaves it null and the next tick runs.
  if (Number.isFinite(parsed)) lastRunAt = parsed;
  return lastRunAt;
}

/**
 * Continuation: when a burn agent finishes, evaluate its family again so the
 * NEXT job in the plan goes out. Without it the plan advances once per
 * `checkIntervalMinutes`. It cannot run away: the chain is serial and every link
 * re-reads live quota, so the reserve, reset horizon, a provider refusal or
 * `maxDispatchesPerWindow` close it.
 */
function onBurnAgentCompleted(agent) {
  const familyId = agent?.metadata?.taskQuotaBurnFamily;
  if (!familyId) return null;
  // A relaunch is not a completion: the denial ledger would file "Relaunched by user" as a
  // provider refusal, and the walk would dispatch while the task is re-spawned. Gated on
  // `isQueuedContinuation`, not `isAgentHandoff`: a stranded pause retirement also stamps
  // `resumed: true` but queues no continuation run (#7469).
  if (isQueuedContinuation(agent)) return null;
  // Returned so tests can await the cycle; the `.catch` keeps a rejection off the emitter.
  // The denial ledger is folded in FIRST and awaited: a refused run spends the family's rolling
  // window, so the next dispatch would hit the same wall. A ledger failure only warns.
  // The plan is walked only for an agent the plan OWNS (`burnPlanOwnsAgent`); a manual
  // maintenance run's completion still feeds the denial ledger. Evaluated inside the chain
  // because an unsupported audit-workflow marker throws.
  const walkPlan = () => {
    const deepHold = heldForDeepCheckpoint(agent);
    return deepHold
      ? { skipped: 'deep-audit-checkpoint', reason: deepHold.reason }
      : completeQuotaBurnSequenceStep(agent)
        .then(() => runQuotaBurnCycle({ trigger: 'continuation', familyId, ignoreTaskId: agent?.result?.success ? agent?.taskId : null }));
  };
  return recordBurnAgentCompletion(agent)
    .catch((err) => console.error(`⚠️ Quota-burn denial ledger for ${familyId}: ${err.message}`))
    .then(() => (burnPlanOwnsAgent(agent) ? walkPlan() : { skipped: 'maintenance-run' }))
    .catch((err) => console.error(`❌ Quota-burn continuation for ${familyId} failed: ${err.message}`));
}

async function tick() {
  const config = await getQuotaBurnConfig().catch(() => null);
  if (!config?.enabled) return;
  const dueAt = (await lastScheduledRunAt() || 0) + config.checkIntervalMinutes * 60_000;
  if (Date.now() < dueAt) return;
  await runQuotaBurnCycle({ trigger: 'scheduled' });
}

/** Arm the loop at boot. The interval is unconditional and cheap; the SPEND is gated inside `tick`. */
export function startQuotaBurnScheduler() {
  if (tickTimer) return;
  // Timer callbacks run outside the request lifecycle: catch and log.
  tickTimer = setInterval(() => {
    // `running` is already released by runQuotaBurnCycle's finally.
    tick().catch((err) => console.error(`❌ Quota-burn tick failed: ${err.message}`));
  }, TICK_MS);
  tickTimer.unref?.();
  // Emitter callback: `onBurnAgentCompleted` never awaits and never rethrows.
  cosEvents.on('agent:completed', onBurnAgentCompleted);
  console.log('🔥 Quota-burn loop armed (off unless enabled in Quota Burn settings)');
}

/** Test seam — one interval tick, without waiting on the timer. */
export const __tickQuotaBurn = tick;

/** Test seam — the completion continuation, without going through cosEvents. */
export const __onBurnAgentCompleted = onBurnAgentCompleted;

/** Test seam — disarms the timer/listener and clears the in-process cycle state. */
export function __resetQuotaBurnRunner() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  cosEvents.off('agent:completed', onBurnAgentCompleted);
  deferredContinuations.clear();
  running = false;
  lastRunAt = null;
}
