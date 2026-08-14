/**
 * Quota-burn runner — the single install-level loop.
 *
 * ONE loop lives in PortOS (not one scheduled task per managed app, which is
 * what this replaced): every `checkIntervalMinutes` it reads the burn plan,
 * takes a zero-token quota reading, and — only when a family's window is inside
 * its reset horizon with headroom above its reserve — runs the next job in that
 * family's ordered plan that reports pending work.
 *
 * The interval only STARTS a family's burn. Once a job is out, each finished burn
 * agent triggers a fresh evaluation of that family (`onBurnAgentCompleted`), so
 * the plan is walked one agent at a time until a gate closes — the window's
 * dispatch cap, the reserve, or the reset horizon.
 *
 * "Next job" is literal — the walk resumes after the family's last dispatch
 * rather than restarting at the top (`rotatePlanAfter`), so an N-job plan cycles
 * through all N instead of re-running job #1 every time.
 *
 * At most one dispatch per FAMILY per cycle. Families do not share a budget:
 * each one draws down its own subscription window, against its own reserve and
 * its own `maxDispatchesPerWindow`. Stopping the whole cycle after the first
 * dispatch (which is what this used to do) therefore didn't protect anything —
 * it just meant the soonest-resetting family took every cycle, and a family with
 * a longer window never burned at all while it was enabled. A `claude` window
 * resetting in 2h beat an `agy` window resetting in 21h on every single tick, so
 * the agy plan sat at "93% left · 0/5 used" indefinitely.
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
import { getQuotaBurnDispatches, evaluateFamilies, PLAN_COMPLETE_SKIP_REASON, recordQuotaBurnDispatch, selectBurnCandidates } from './quotaBurn.js';
import { getQuotaBurnCompletions, recordQuotaBurnJobCompletion } from './quotaBurnCompletions.js';
import { getActiveQuotaBurnBlocks, recordBurnAgentCompletion } from './quotaBurnDenials.js';
import { getQuotaBurnConfig, getQuotaBurnRuns, recordQuotaBurnRun } from './quotaBurnStore.js';
import { countJobPending, runBurnJob } from './quotaBurnJobs/index.js';
import { familyHasRunnableJobs, familyIsConfigured, jobIsSpent, quotaBurnJobKey } from '../lib/quotaBurnConfig.js';
import { windowLabelOf } from '../lib/quotaWindows.js';
import { WAIT } from '../lib/staleWhileRevalidate.js';
import { cosEvents } from './cosEvents.js';

const TICK_MS = 60_000;

let tickTimer = null;
let running = false;
let lastRunAt = null;
// Family ids whose completion continuation arrived while a cycle was running —
// drained by `drainDeferredContinuations` when that cycle releases the guard.
const deferredContinuations = new Set();

/**
 * The jobs a cycle will consider, in plan order.
 *
 * `jobId` scopes to one named job. When it is named AND the run was forced, the
 * job's own `enabled` checkbox — and a spent `run once` marker — are ignored:
 * the user just clicked ▶ on that exact row, which is a more specific
 * instruction than the checkbox they set earlier, and re-running a finished
 * one-shot job on demand is exactly what that button is for. Without this,
 * clicking ▶ on a paused (or already-run) job is a silent no-op reported as "no
 * pending work".
 */
const selectJobs = (family, { jobId = null, force = false, completions = {} } = {}) => {
  const targeted = Boolean(jobId) && force;
  return (family.jobs || []).filter((job) => (!jobId || job.id === jobId)
    && (targeted || (job?.enabled !== false && !jobIsSpent(job, family.id, completions))));
};

/**
 * The two fields of a pending-probe the page actually renders. An allowlist
 * rather than an omit so a job type that starts returning something new has to
 * opt into the wire deliberately.
 */
const wireShape = (pending) => ({ count: pending?.count ?? 0, detail: pending?.detail ?? '' });

/**
 * The plan, re-anchored to start just AFTER the job this family last dispatched.
 *
 * A burn plan is an ordered ROTATION, not a priority list. Without this the walk
 * restarts at index 0 every cycle, and since `agent-prompt` always reports work
 * pending (its probe only checks that an app and a provider resolve), the first
 * job in the plan won every dispatch forever — an eight-job agy plan spent its
 * entire window re-running "Performance issues" and the other seven never ran
 * once. Rotating preserves the "first job with pending work wins" semantics that
 * matter for probing jobs like `universe-bible-images`; it only moves where the
 * walk begins.
 *
 * An unknown cursor (first ever dispatch, a job since deleted from the plan, or
 * one aged out of the capped run log) falls back to plan order.
 */
export function rotatePlanAfter(jobs, afterJobId) {
  const at = afterJobId ? jobs.findIndex((job) => job.id === afterJobId) : -1;
  return at < 0 ? jobs : [...jobs.slice(at + 1), ...jobs.slice(0, at + 1)];
}

/**
 * Each family's most recently dispatched job id, read from the run log rather
 * than a second persisted cursor file — `recordQuotaBurnRun` already stamps
 * `familyId` + `jobId` on every dispatch, newest first, so the log IS the cursor.
 */
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
 * the first job with pending work. Returns the dispatch outcome plus the per-job
 * reasons, so a cycle that dispatched nothing still explains itself in the run
 * log.
 *
 * The probe's `context` is handed to `run` rather than thrown away: a
 * `universe-bible-images` probe reads every universe bible to count the backlog,
 * and `run` needs the very same scan to know what to render. Without the
 * passthrough that multi-megabyte read happened twice per dispatch.
 */
async function dispatchFromCandidate(candidate, { jobId = null, force = false, afterJobId = null, completions = {} } = {}) {
  const attempts = [];
  // A forced run of a NAMED job skips the pending probe entirely and calls the
  // job directly. The probe exists to pick which job in the plan to run; when
  // the user has already picked one, letting it veto the click reproduces the
  // silent no-op the force path exists to fix — one gate later. It bites hardest
  // on `universe-bible-images`, whose 6-hour in-flight cooldown makes the probe
  // report zero for entries that are merely already queued, with no way to
  // override it from the page. `force` is threaded into the job so it can relax
  // its own cooldown too.
  const targeted = force && jobId;
  for (const job of rotatePlanAfter(selectJobs(candidate.family, { jobId, force, completions }), afterJobId)) {
    const pending = targeted ? null : await countJobPending({ job, family: candidate.family });
    if (pending && !(pending.count > 0)) {
      attempts.push({ jobId: job.id, jobType: job.jobType, skipped: pending.detail || 'no pending work' });
      continue;
    }
    const result = await runBurnJob({ job, family: candidate.family, candidate, context: pending?.context, force });
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
  if (running) {
    // A continuation that lands mid-cycle is REMEMBERED, not dropped. Two burn
    // agents from different families finishing within the same cycle is ordinary
    // — and a dropped continuation stalls that family's plan until the next
    // interval tick, which at the 12-hour default is most of a day of the window
    // this feature exists to spend. Keyed by family, so several completions from
    // one family while it is mid-cycle collapse to the single re-evaluation they
    // amount to.
    if (options.trigger === 'continuation' && options.familyId) deferredContinuations.add(options.familyId);
    return { skipped: 'already-running' };
  }
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
    await drainDeferredContinuations();
  }
}

/**
 * Run the continuations that arrived while a cycle was in flight, one at a time.
 *
 * Bounded by the same gate ladder every other dispatch faces: a drained family
 * gets one cycle, which the reserve or the reset horizon can decline. A
 * completion that lands DURING the drain re-enters the set legitimately — it is
 * a different agent finishing — and faces that ladder too. Errors are swallowed here
 * rather than allowed to replace the outer cycle's result: this runs from the
 * caller's `finally`, so a throw would mask what that cycle actually decided.
 */
async function drainDeferredContinuations() {
  while (deferredContinuations.size) {
    const [familyId] = deferredContinuations;
    deferredContinuations.delete(familyId);
    await runQuotaBurnCycle({ trigger: 'continuation', familyId })
      .catch((err) => console.error(`❌ Quota-burn deferred continuation for ${familyId} failed: ${err.message}`));
  }
}

async function evaluate({ trigger = 'scheduled', familyId = null, jobId = null, force = false }) {
  const finish = async (entry) => {
    // Only a SCHEDULED cycle advances the interval clock. A manual "Evaluate
    // now" that reports "no burnable window" would otherwise push the next
    // automatic cycle a full interval out — on a 12-hour interval, one curiosity
    // click can defer the tick past the reset the feature exists to spend.
    if (trigger === 'scheduled') lastRunAt = Date.now();
    // Every cycle says what it decided. Previously ONLY the error paths logged,
    // so clicking "Evaluate now" — which can spend a provider's quota — left no
    // trace in the server log at all, and a cycle that correctly declined was
    // indistinguishable from one that never ran.
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
  // A disabled tick writes NO run-log entry: a silent loop would otherwise fill
  // the log with "disabled" rows and bury the last real run. Only a `manual`
  // trigger — the user asking for this cycle by name — runs while the master
  // switch is off; everything unattended (the interval tick AND the completion
  // continuation it hands off to) stops. Phrased as "not manual" rather than an
  // allowlist of automatic triggers so a trigger added later fails CLOSED.
  if (!config.enabled && trigger !== 'manual') return { skipped: 'disabled' };

  // Read once per cycle and threaded through selection, the gate ladder, and the
  // dispatch record, so a job spent mid-cycle can't be re-picked by a later
  // family's walk.
  //
  // `null` means the ledger could not be read, which is NOT "nothing has run" —
  // treating it as such would re-dispatch every `run once` job on the plan. Fails
  // CLOSED: skip the cycle and say so rather than redoing work the user asked
  // for exactly once.
  const completions = await getQuotaBurnCompletions();
  if (!completions) {
    console.error('❌ Quota-burn could not read its run-once ledger — skipping this cycle');
    return finish({ dispatched: false, reason: 'run-once ledger unreadable' });
  }

  // Check the plan BEFORE the quota read. `getProviderQuotas({ wait: WAIT.FRESH })`
  // spawns a multi-second TUI scrape per enabled family; with no actionable
  // family configured that scrape could never produce a dispatch, and it would
  // otherwise run every `checkIntervalMinutes` forever. A plan made entirely of
  // spent `run once` jobs is the same case, which is why `completions` is passed
  // — without it a finished one-shot plan keeps paying for the scrape forever.
  //
  // A forced run of a NAMED job is exempt: this requires an enabled family with
  // an enabled, unspent job, but ▶ on a paused job (or a paused family, or one
  // that already ran) is exactly the case the force path exists to serve —
  // gating it here would make the click a silent no-op before selection ever ran.
  //
  // One short-circuiting pass on the healthy path; the second only runs to pick
  // the wording, and only when nothing is runnable. The two are kept distinct
  // because a finished one-shot plan did what it was asked and wants Re-arm,
  // which is not what an unset plan wants (add a job).
  const targeted = force && familyId;
  const families = Object.values(config.families);
  if (!targeted && !families.some((family) => familyHasRunnableJobs(family, completions))) {
    return finish({
      dispatched: false,
      reason: families.some(familyIsConfigured) ? PLAN_COMPLETE_SKIP_REASON : 'no families enabled',
    });
  }

  // Scoped to the one family when the caller named it — a per-family "Run now",
  // or a completion continuation. Every card this read returns for another family
  // is discarded by the `familyId` filter below, and each one costs its own
  // multi-second PTY scrape (WAIT.FRESH bypasses the cache by design). Unscoped
  // that was two wasted scrapes a day; with the continuation it would be N per
  // finished burn agent, on every link of the chain.
  const quotas = await getProviderQuotas({ wait: WAIT.FRESH, family: familyId }).catch((err) => {
    console.error(`❌ Quota-burn could not read provider quota: ${err.message}`);
    return null;
  });
  if (!quotas) return finish({ dispatched: false, reason: 'provider quota read failed' });

  const [dispatches, blocks] = await Promise.all([getQuotaBurnDispatches(), getActiveQuotaBurnBlocks()]);
  // An unreadable dispatch ledger reads as "0 used this window", which would
  // walk straight past `maxDispatchesPerWindow` and spend quota the user already
  // spent (#4115). Same posture as the provider-quota read above: skip the cycle.
  if (!dispatches) return finish({ dispatched: false, reason: 'dispatch ledger read failed' });
  // `force` is the page's per-job "Run now" — the window/reserve/cap/denial gates
  // that bound UNATTENDED burns don't apply to a run the user just asked for. It
  // goes through the same selection, so the candidate still carries the family's
  // real card and limit; it only comes back `charge: false`.
  const candidates = selectBurnCandidates(quotas, config, {
    dispatches, blocks, completions, bypassGatesFor: force ? familyId : null,
  }).filter((candidate) => !familyId || candidate.family.id === familyId);

  if (!candidates.length) {
    // Scoped to the family the user asked about, and NOT filtered to enabled
    // families: when someone force-runs a job on a family whose checkbox is
    // off, "disabled" IS the answer — reporting a different family's verdict
    // instead (or claiming it is "ready" when it did not run) leaves them with
    // no path to the control they need.
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
  // Where each family's plan walk resumes (see `rotatePlanAfter`). Read once per
  // cycle, before any dispatch, so two families in the same cycle can't see each
  // other's fresh run-log entries.
  const cursors = await lastDispatchedJobByFamily();
  // Every eligible family gets its own dispatch — see the module header. The
  // loop does NOT break on the first success: `candidates` is already the set
  // that passed the full gate ladder, and each entry spends a different
  // provider's window.
  for (const candidate of candidates) {
    const outcome = await dispatchFromCandidate(candidate, {
      jobId, force, completions, afterJobId: cursors.get(candidate.family.id) || null,
    });
    attempts.push(...outcome.attempts.map((entry) => ({ familyId: candidate.family.id, ...entry })));
    if (!outcome.dispatched) continue;
    // Charge the window only once work actually started. `runBurnJob` reports a
    // decline rather than throwing, and a declined job never reaches here — so
    // the cap bounds real burns, not attempts. `charge` is false for a forced
    // run, which the user asked for outside the automatic budget.
    if (candidate.charge) await recordQuotaBurnDispatch(candidate.dispatchKey);
    // A `run once` job records its one dispatch even when the run was FORCED
    // and therefore uncharged. The two ledgers answer different questions:
    // `charge` is about this window's automatic budget, while `runOnce` is a
    // statement about the WORK ("this only needs doing once") — and the work
    // just happened, however it was triggered. The ▶ on the row stays the way
    // back, since a forced run bypasses this gate too.
    if (outcome.job.runOnce) {
      await recordQuotaBurnJobCompletion(candidate.family.id, outcome.job.id)
        // A ledger failure must not fail a dispatch that already happened —
        // the worst case is the job running one extra time next cycle, which
        // is the pre-`runOnce` behavior.
        .catch((err) => console.error(`⚠️ Quota-burn run-once ledger for ${candidate.family.id}/${outcome.job.id}: ${err.message}`));
    }
    // One run-log entry PER dispatch, recorded as it happens: the page's
    // "Recent runs" list is how the user audits what their subscriptions were
    // spent on, and folding three families into one row would hide two of them.
    dispatched.push(await finish({
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
    }));
  }

  // Single dispatch keeps the flat entry shape the route, the run log, and the
  // tests already speak. Several come back as one aggregate so the caller's
  // toast names all of them rather than an arbitrary first.
  if (dispatched.length === 1) return dispatched[0];
  if (dispatched.length > 1) {
    return {
      dispatched: true,
      summary: `Dispatched ${dispatched.length} jobs — ${dispatched.map((entry) => `${entry.familyId}: ${entry.summary}`).join('; ')}`,
      dispatches: dispatched,
    };
  }

  // Report what each job actually said. Collapsing every non-dispatch to "no
  // job had pending work" asserts something usually false — a job that DID have
  // work and declined ("an identical burn task is already running", "managed
  // app app-x no longer exists", "no enabled CLI/TUI provider in the grok
  // family") is the actionable case, and it was the one being thrown away.
  // Prefix each reason with its family once more than one was evaluated —
  // "j: no managed app selected" is unactionable when three plans were walked.
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
 * burn on the next tick (and if not, exactly why) and each job's pending count.
 *
 * Returns the config it loaded so the route doesn't read and normalize the same
 * file a second time.
 *
 * NEVER blocks on a quota reading. A cached one is served immediately (and
 * refreshed behind the response once stale); a cold cache comes back as a
 * `pending: true` card while the scrape runs, which `evaluateFamily` reports as
 * "reading provider quota…" and never turns into a burn. Waiting instead cost
 * this page 20-30s per open — a PTY spawn per family — for numbers that move by
 * single digits an hour. The page's explicit Refresh passes `refresh: true` and
 * does wait, because that click IS the request for a live reading.
 */
export async function getQuotaBurnStatus({ refresh = false } = {}) {
  // Independent reads: only `quotas` is slow (a PTY scrape on the Refresh path),
  // and nothing else waits on it.
  const [config, quotas, dispatches, blocks, completions, runs] = await Promise.all([
    getQuotaBurnConfig(),
    getProviderQuotas({ wait: refresh ? WAIT.FRESH : WAIT.NEVER }).catch((err) => {
      console.error(`❌ Quota-burn status could not read provider quota: ${err.message}`);
      return [];
    }),
    // Degrades to "no dispatches counted" on an unreadable ledger for the same
    // reason the completions read below does: on the STATUS path the cost of
    // being wrong is a stale `N/M used` label, not re-spent quota. The cycle's
    // read of the same ledger refuses to run instead.
    getQuotaBurnDispatches().then((ledger) => ledger || {}),
    getActiveQuotaBurnBlocks(),
    // An unreadable ledger degrades to "no badges" here rather than failing the
    // whole status read — the opposite of the CYCLE's posture, and deliberately
    // so: the cost of being wrong on this path is a missing "Ran once" label,
    // while on the cycle's path it is re-spending quota on finished work.
    getQuotaBurnCompletions().then((ledger) => ledger || {}),
    getQuotaBurnRuns(),
  ]);

  const cards = new Map(quotas.map((card) => [card.family, card]));
  // ONE pass over the gate ladder the runner uses — the page's "will burn" and
  // its reason come from the same verdict, so they can't contradict each other.
  const families = await Promise.all(evaluateFamilies(quotas, config, { dispatches, blocks, completions })
    .map(async ({ family, candidate, skipReason, block }) => {
      const card = cards.get(family.id);
      return {
        id: family.id,
        label: candidate?.card?.label || card?.label || family.id,
        percentRemaining: candidate?.limit?.percentRemaining ?? null,
        hoursUntilReset: candidate ? Math.round(candidate.hoursUntilReset * 10) / 10 : null,
        // WHICH window those two numbers describe. Without it the card reports a
        // percentage and a countdown with no way to tell the weekly allowance
        // from the 5-hour one — the exact ambiguity that hid the wrong window
        // being selected in the first place.
        windowLabel: candidate ? windowLabelOf(candidate.limit) : null,
        dispatchesUsed: candidate?.dispatchesUsed ?? null,
        willBurn: Boolean(candidate),
        skipReason: skipReason || null,
        // An observed provider refusal, surfaced whether or not it is the gate
        // that closed — a family blocked AND out of window should say both.
        blockedUntil: block?.until ? new Date(block.until).toISOString() : null,
        blockedReason: block?.reason || null,
        // The reading for this family is being taken right now — the page polls
        // again instead of leaving a card that looks like it has no quota.
        pending: Boolean(card?.pending),
        // Probe pending work only for families the user actually enabled, and
        // only for jobs a cycle could still pick — a probe is not free (the
        // universe job reads every bible), and neither a disabled family's
        // counts nor a spent `run once` job's are ever acted on. `ranAt` is what
        // the row renders instead, and it is the only signal the page has that a
        // step is finished rather than merely idle.
        jobs: await Promise.all(family.jobs.map(async (job) => {
          const ranAt = completions[quotaBurnJobKey(family.id, job.id)] || null;
          // `jobIsSpent` re-derived from the value just read rather than called —
          // it would rebuild the same key and re-index the same object. Not
          // shipped on the wire either: the client gates its badge on the
          // OPTIMISTIC config it holds, so a just-ticked checkbox reads as spent
          // before the save round-trips, and a server copy would only be a second
          // rule to keep in sync.
          const spent = job.runOnce === true && Boolean(ranAt);
          return {
            id: job.id,
            ranAt,
            // `context` is stripped: it is the probe→run hand-off (see the job
            // registry), and it holds whatever the probe already computed —
            // for the universe jobs a picked-universe payload. The page renders
            // `count` and `detail` only, so shipping the rest would put probe
            // internals on the wire and grow with every job type.
            pending: family.enabled && !spent ? wireShape(await countJobPending({ job, family })) : null,
          };
        })),
      };
    }));

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

/**
 * Continuation: when a burn agent finishes, evaluate its family again so the
 * NEXT job in the plan goes out.
 *
 * Without this the plan advances only once per `checkIntervalMinutes` — at the
 * 12-hour default, two dispatches a day against a window that resets every 5
 * hours, so most of the allowance the feature exists to spend expired unspent.
 * Completion is the right pacing signal: it runs the plan strictly one agent at
 * a time and asks the gate ladder, every time, whether there is still quota to
 * spend.
 *
 * It cannot run away. The chain is serial by construction — the next dispatch
 * needs an agent to finish first — and every link re-reads the family's live
 * quota, so the reserve, the reset horizon, and an observed provider refusal
 * each close it as soon as the numbers say to. A `maxDispatchesPerWindow` other
 * than the unlimited default bounds it earlier still, from the same ledger every
 * continuation dispatch is charged to.
 */
function onBurnAgentCompleted(agent) {
  const familyId = agent?.metadata?.taskQuotaBurnFamily;
  if (!familyId) return null;
  // Returned so tests can await the cycle. The emitter ignores it — this is a
  // fire-and-forget listener, and the `.catch` is what keeps a rejection from
  // reaching the emitter as an unhandled one.
  //
  // The denial ledger is folded in FIRST and awaited. If this run was refused,
  // the family's short rolling window is spent and the very next thing this
  // function does — dispatch the next job — would walk straight into the same
  // wall. Recording after the cycle (or from a second `agent:completed`
  // subscriber, whose ordering against this one is not guaranteed) is one wasted
  // agent too late, every single time. A ledger failure must not stop the
  // continuation, so it degrades to a logged warning.
  return recordBurnAgentCompletion(agent)
    .catch((err) => console.error(`⚠️ Quota-burn denial ledger for ${familyId}: ${err.message}`))
    .then(() => runQuotaBurnCycle({ trigger: 'continuation', familyId }))
    .catch((err) => console.error(`❌ Quota-burn continuation for ${familyId} failed: ${err.message}`));
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
  // Same "outside the request lifecycle" posture as the timer: an emitter
  // callback that throws would take the process down, so `onBurnAgentCompleted`
  // never awaits and never rethrows.
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
