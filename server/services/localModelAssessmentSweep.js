/**
 * Measure a batch of local models in one pass — the overnight sweep.
 *
 * Measuring one model takes minutes; measuring a machine's worth of them takes
 * hours. That is a job you start at the end of the day and read in the morning,
 * which rules out the shape the single-model path uses (one blocking POST held
 * open by the browser tab). This module runs the queue SERVER-SIDE: the request
 * that starts it returns immediately, the loop keeps going with nobody watching,
 * and the page reads its progress from a status endpoint plus the existing
 * `localLlm:progress` socket event.
 *
 * ## Two dimensions, one queue
 *
 * The queue walks a list of (model, tuning) pairs, and which list it walks is
 * the only difference between the two sweeps this module serves:
 *
 *   - **Model sweep** — every model a scope covers, each under the tuning it
 *     already carries. Answers "which of my models is worth using?".
 *   - **Tuning sweep** — one model across a grid of tunings
 *     (`lib/localModelTuning.js#tuningGridFor`). Answers "which flags suit this
 *     model here?", which is what `compareTunings` ranks.
 *
 * They deliberately share the queue rather than getting one each: cancellation,
 * progress, the accelerator claim, and the "one measurement at a time" rule are
 * identical, and a second queue could run concurrently with this one — which
 * would make every number either produced describe the contention.
 *
 * ## AI Provider Usage Policy (root CLAUDE.md) — read before editing
 *
 * A sweep calls a provider once per queued measurement, so it is STRICTLY
 * user-triggered, the same as the single-model run:
 *
 *   - `startSweep()` is reachable only from `POST /api/local-llm/assessments/sweep`,
 *     behind a consent gate that names the exact measurement count (models, or
 *     tuning variants) and the total generation count.
 *   - `getSweepStatus()` reads module state only. Zero LLM calls, safe to poll.
 *
 * The prohibition the single-model service states — "no scheduler, no boot hook,
 * no background sweep" — is about work the user did not ask for. This IS the ask:
 * a button they pressed, having been told what it will run. What must never
 * appear is a cron entry, a boot hook, or an auto-start that fires this without a
 * click. Do not add one.
 *
 * `lib/sseUtils.js#createSseRunner` owns a similar lifecycle (runId, abort,
 * cancel, active-guard) but is SSE-transport-bound and keeps no cumulative record
 * of what a run has produced so far — which is the one thing a page reloaded at
 * 3am needs. Hence a small queue of its own rather than a transport it would have
 * to work around.
 *
 * ## Restart behavior
 *
 * The queue lives in module memory, so a server restart mid-sweep ends it. That
 * is deliberate rather than unfinished: every COMPLETED measurement is already
 * durable (`runAssessment` persists as it goes), so a restart costs the model in
 * flight and nothing else, and re-running the sweep afterwards picks up exactly
 * what is still unmeasured. Persisting the queue would buy a resumable pointer
 * into a job that is cheap to restart and must never auto-resume on boot.
 *
 * One consequence is worth naming: a restart during a MODEL or TUNING sweep
 * also loses the captured launch configuration, so llama-server stays on
 * whichever variant/model was in flight. That is visible and fixable on the
 * LLMs page, and the alternative — persisting it and relaunching a daemon at
 * boot to put it back — is exactly the boot-time work this module refuses to do.
 */

import { selectSweepTargets, SWEEP_SCOPES } from '../lib/localModelAssessment.js';
import { tuningGridFor } from '../lib/localModelTuning.js';
import {
  captureLaunchState,
  getAssessmentReport,
  isTuningSweepable,
  restoreLaunchState,
  runAssessment,
} from './localModelAssessments.js';
import { claimHeavyLocalJob } from '../lib/heavyJobClaim.js';

// One sweep at a time. This is a re-entrancy guard, not a concurrency control:
// PortOS serves one user, and the thing being prevented is a second click (or a
// second tab) queuing the same models against a machine that can only run one
// model at a time anyway.
let sweep = null;

// Held across `startSweep`'s `await getAssessmentReport()`. The `sweep` object
// itself cannot be published until the targets are known, so without this a
// second request arriving during that await passes the "already running" check,
// and both requests go on to assign `sweep` and launch a detached loop — two
// overnight queues measuring the same models against each other, with only the
// second one's status visible. The slot has to be reserved SYNCHRONOUSLY, before
// the first await, or the check and the claim are not atomic.
let startingSweep = false;

// A sweep is sequential BY DESIGN. Two models measured at once contend for the
// same memory and the same GPU, and every number either one produces would
// describe that contention rather than the model — which is the one thing this
// whole feature exists to measure accurately.

// How long one model waits for the machine-wide accelerator claim before giving
// up on its turn. An interactive Measure click refuses immediately; a queue
// running unattended should ride out a short image render rather than throwing
// away a model's slot over it — but not wait all night behind a LoRA training
// run, which would leave the sweep looking hung with nothing to show.
const CLAIM_WAIT_MS = 10 * 60 * 1000;

const nowIso = () => new Date().toISOString();

/** Public snapshot. Never leaks the AbortController or the emit hook. */
function snapshot() {
  if (!sweep) {
    // `status: 'idle'` with a null run is the honest "nothing has been started",
    // distinct from a finished sweep whose results are still worth showing.
    return { status: 'idle', mode: null, scope: null, target: null, settled: true, startedAt: null, finishedAt: null, total: 0, completed: 0, current: null, results: [], cancelRequested: false, restoreError: null };
  }
  return {
    status: sweep.status,
    // 'models' = every model the scope covers, each under one tuning.
    // 'tunings' = ONE model across a grid of tunings. The page renders a
    // different sentence for each, so it cannot be inferred from the counts.
    mode: sweep.mode,
    scope: sweep.scope,
    // The single model a tuning sweep is measuring; null for a model sweep.
    target: sweep.target,
    // Whether the sweep has let go of the machine, which outlasts `status`: a
    // cancelled sweep is still aborting its last measurement and, for a tuning
    // sweep, still has a launch configuration to put back — a relaunch. The page
    // keeps its per-model actions disabled while this is false.
    settled: sweep.settled === true,
    startedAt: sweep.startedAt,
    finishedAt: sweep.finishedAt,
    total: sweep.total,
    completed: sweep.results.length,
    // Which model is being measured right now — `null` between models and once
    // the sweep ends.
    current: sweep.current,
    results: sweep.results,
    cancelRequested: sweep.cancelRequested,
    error: sweep.error || null,
    // A sweep whose MEASUREMENTS all landed but whose daemon could not be put
    // back is not a failed sweep — but the user has to be told, because their
    // runtime is now serving the last variant's launch line and nothing else on
    // the page would say so. Separate from `error` so neither one lies.
    restoreError: sweep.restoreError || null,
    // `launchStates` is deliberately NOT exposed: it holds on-disk model paths,
    // and the page has no use for the configuration being put back.
  };
}

export function getSweepStatus() {
  return snapshot();
}

/**
 * Put the captured launch configuration back, holding the machine-wide claim
 * while it happens.
 *
 * A restore STOPS and STARTS the daemon, which takes seconds to minutes for a
 * large GGUF — the same disruption the claim exists to keep away from a
 * measurement. `runAssessment` released it after the last variant, and a Stop
 * click re-enables the per-model Measure button immediately, so without a claim
 * of its own the restore can bounce llama-server in the middle of a reading
 * somebody started meanwhile (from the page, ⌘K, or curl) and that reading would
 * record the restart.
 *
 * A claim that cannot be had is NOT a reason to skip: the daemon would be left
 * on the sweep's last variant, which is the thing this exists to prevent. It
 * waits, bounded, then restores anyway and lets the reason be reported.
 */
async function restoreUnderClaim(backend, launchState) {
  const claim = await claimHeavyLocalJob({
    kind: 'local-model assessment',
    id: `${backend} launch restore`,
    timeoutMs: CLAIM_WAIT_MS,
  });
  if (!claim.ok) {
    console.error(`⚠️ Local LLM: restoring the launch configuration without the accelerator claim — ${claim.message}`);
  }
  try {
    return await restoreLaunchState(backend, launchState);
  } finally {
    if (claim.ok) await claim.release();
  }
}

/**
 * Restore every backend touched by a model or tuning sweep, one at a time.
 *
 * Only CAPTURED backends are in the map, so every entry is a real restore —
 * there is no "nothing to restore" here to mistake for a failure. Each is caught
 * on its own: one runtime that will not come back must not leave the next one
 * serving the sweep's launch line.
 */
async function restoreAllUnderClaim(run) {
  const failures = [];
  for (const [backend, launchState] of Object.entries(run.launchStates)) {
    const result = await restoreUnderClaim(backend, launchState)
      .catch((err) => ({ restored: false, reason: err?.message || 'restore failed' }));
    if (result?.restored === false) {
      failures.push(`${backend}: ${result.reason || 'the launch configuration could not be put back'}`);
    }
  }
  return failures;
}

/**
 * Ask the running sweep to stop.
 *
 * Aborts the model in flight (which `runAssessment` treats as a cancel and does
 * NOT record) and drops the rest of the queue. Everything already measured stays
 * on disk — an interrupted overnight run is still worth what it finished.
 */
export function cancelSweep() {
  if (!sweep || sweep.status !== 'running') return snapshot();
  sweep.cancelRequested = true;
  sweep.controller.abort();
  // Flip the status here rather than waiting for the loop's `finally`: the
  // caller is an HTTP handler returning this snapshot NOW, and reporting
  // `running` to a client that just stopped it would leave a Stop button on
  // screen for a queue that is already winding down. The `finally` re-affirms
  // `cancelled` (it reads the same flag), so the two cannot disagree.
  sweep.status = 'cancelled';
  console.log(`🛑 Local LLM: assessment sweep cancelled after ${sweep.results.length}/${sweep.total}`);
  return snapshot();
}

/** Test seam: forget any sweep state between suites. */
export function __resetSweep() {
  sweep?.controller?.abort();
  sweep = null;
  startingSweep = false;
}

// The sweep loop runs OUTSIDE the request lifecycle — there is no `next(err)` to
// bubble to, so an uncaught throw here would take the process down (root
// CLAUDE.md). Every model is individually caught, and the loop itself is wrapped.
//
// It mutates the `run` it was handed, NOT the module-level `sweep`: a cancelled
// queue is replaceable the moment it is cancelled, and a loop still winding down
// its last model must not write its results into the sweep that succeeded it.
async function runSweepLoop(run, targets, contextTokens, emit) {
  // A tuning sweep asks each variant to be the COMPLETE tuning, while a model
  // sweep applies each model's recorded tuning. In both cases the launch line
  // is made explicit before the measurement, and `beginSweep` captured what
  // was running first so the final restore can put the user's configuration
  // back.
  for (const target of targets) {
    if (run.cancelRequested) break;
    run.current = { backend: target.backend, modelId: target.modelId, tuningLabel: target.tuningLabel, startedAt: nowIso() };
    emit({
      scope: 'assessment-sweep',
      event: 'model-start',
      backend: target.backend,
      modelId: target.modelId,
      // The label is what distinguishes one step of a TUNING sweep from the
      // next — every step names the same model, so a message without it reads
      // as one measurement repeating.
      tuningLabel: target.tuningLabel || null,
      completed: run.results.length,
      total: run.total,
      message: `Sweep ${run.results.length + 1}/${run.total}: measuring ${target.modelId}${target.tuningLabel ? ` (${target.tuningLabel})` : ''}…`,
    });

    // One model failing is a RESULT, not a reason to abandon the queue — the
    // whole point of an overnight run is that it gets through the list.
    // A llama model sweep must reset the launch line before applying the stored
    // tuning for each model. Without this, model B inherited model A's batch /
    // KV / speculative flags while its record named only B's tuning (#4774).
    // Other endpoint runtimes have no sweep-safe reset/restore path, so they
    // remain ordinary model measurements.
    //
    // Gated on a CAPTURED configuration rather than on `isTuningSweepable`
    // alone: a reset renders the cleared launch line, which wipes knobs the USER
    // may have set on the LLMs page, and only a caller holding what was running
    // there is entitled to do that. `beginSweep` captured every sweepable
    // backend it could, so a runtime that could not be captured — llama-server
    // stopped, or started outside PortOS — measures under what is running
    // instead of losing flags nothing can put back.
    const resetTuning = Boolean(run.launchStates[target.backend]);
    const result = await runAssessment({
      backend: target.backend,
      modelId: target.modelId,
      contextTokens,
      tuning: target.tuning,
      resetTuning,
      signal: run.controller.signal,
      onProgress: emit,
      claimTimeoutMs: CLAIM_WAIT_MS,
    }).catch((err) => ({ error: err?.message || 'assessment failed' }));

    run.current = null;
    // A cancelled run recorded nothing, so it is not a result — recording it as
    // one would make a stopped sweep look like it measured what it abandoned.
    if (result?.cancelled) break;
    run.results.push({
      backend: target.backend,
      modelId: target.modelId,
      tuningLabel: target.tuningLabel,
      finishedAt: nowIso(),
      // `null` verdict + an error means the run threw before producing evidence.
      verdict: result?.error ? null : (result?.verdict || 'unknown'),
      error: result?.error || null,
      meanTokensPerSecond: Number.isFinite(result?.performance?.meanTokensPerSecond) ? result.performance.meanTokensPerSecond : null,
      meanCharsPerSecond: Number.isFinite(result?.performance?.meanCharsPerSecond) ? result.performance.meanCharsPerSecond : null,
      // Travels WITH the rate it qualifies. Dropping it here would render a
      // frame-counted estimate as a tokenizer measurement in the results list.
      tokensEstimated: typeof result?.performance?.tokensEstimated === 'boolean' ? result.performance.tokensEstimated : null,
      // `false` means the knobs never reached the daemon, so these numbers
      // describe some OTHER configuration. The report already refuses to rank
      // such a record; without these the sweep's own list would still present it
      // as a clean reading for the tuning it names — which is exactly the row a
      // tuning sweep is read for.
      tuningApplied: typeof result?.tuningApplied === 'boolean' ? result.tuningApplied : null,
      tuningNotApplied: result?.tuningNotApplied || null,
    });
  }
}

/**
 * Start measuring every model the scope covers. **Calls a provider, once per
 * model** — see the policy note at the top.
 *
 * Returns as soon as the queue is built: the loop runs detached so the HTTP
 * request that started it can return, and so closing the browser does not stop
 * an overnight run.
 *
 * Set `tunings` and it measures ONE named model across the grid of launch
 * configurations its runtime declares — the tuning sweep. The grid is chosen
 * HERE, from `tuningGridFor`, rather than accepted from the caller: what a
 * "tuning sweep of this model" means is a domain decision, and deriving it in
 * one place is what keeps the count a consent gate names equal to the count that
 * runs.
 *
 * @param {object} options
 * @param {'unmeasured'|'stale'|'all'} [options.scope] which models, when no
 *   explicit model is named
 * @param {string} [options.backend] measure only this model (with `modelId`)
 * @param {string} [options.modelId]
 * @param {boolean} [options.tunings] sweep the named model's tuning grid instead
 *   of measuring it under the tuning it already carries
 * @param {number[]} [options.contextTokens] passed through to each measurement
 * @param {(frame: object) => void} [options.onProgress] forwarded to the socket
 * @returns {Promise<object>} the initial snapshot, or `{ rejected }` when a
 *   sweep is already running or the request covers nothing
 */
export async function startSweep({ scope = 'unmeasured', backend, modelId, tunings = false, contextTokens, onProgress } = {}) {
  if (sweep?.status === 'running' || startingSweep) return { ...snapshot(), rejected: 'a sweep is already running' };
  // A CANCELLED sweep is not finished with the machine: its last measurement is
  // still aborting and it may have a launch configuration to put back. Starting
  // the next one on top of that would have the old sweep relaunch the daemon
  // partway through the new one's first measurement — and every number the new
  // sweep produced up to then would describe that relaunch.
  if (sweep && !sweep.settled) return { ...snapshot(), rejected: 'the previous sweep is still winding down' };
  // Reserved here, synchronously, so the check above and this claim cannot be
  // split by the await inside. Released in the `finally` — by which point either
  // `sweep` is published (and the `running` check covers the slot) or the start
  // was refused and the slot is free again.
  startingSweep = true;
  try {
    return await beginSweep({ scope, backend, modelId, tunings, contextTokens, onProgress });
  } finally {
    startingSweep = false;
  }
}

async function beginSweep({ scope, backend, modelId, tunings, contextTokens, onProgress }) {
  const resolvedScope = SWEEP_SCOPES.includes(scope) ? scope : 'unmeasured';
  const named = backend && modelId ? { backend, modelId } : null;

  // A tuning sweep varies the configuration of ONE model, so without a model
  // there is nothing to hold constant and the request is meaningless.
  if (tunings && !named) return { ...snapshot(), rejected: 'a tuning sweep needs a model to sweep' };
  // A runtime PortOS cannot reset and put back must not be swept: its baseline
  // would measure the previous variant's configuration, and the sweep would
  // leave its knobs set for good. See `LAUNCH_APPLIERS` and #4763.
  if (tunings && !isTuningSweepable(named.backend)) {
    return { ...snapshot(), rejected: `PortOS cannot sweep ${named.backend} tunings yet — it has no way to put the runtime back afterwards` };
  }
  const grid = named && tunings ? tuningGridFor(named.backend) : null;
  // A runtime PortOS cannot pass flags to yields the baseline alone — one
  // measurement with nothing to compare it to. Refuse rather than spend minutes
  // of GPU on a table `compareTunings` will not render.
  if (grid && grid.length < 2) {
    return { ...snapshot(), rejected: `${named.backend} has no tuning knobs PortOS can sweep` };
  }
  const mode = grid ? 'tunings' : 'models';

  // Read the report ONCE, here, rather than per model: it lists installed models
  // across every runtime and annotates staleness, which is exactly the input the
  // target selection needs. It is disk-plus-listing only — no LLM call.
  const report = await getAssessmentReport({ intent: 'balanced' });
  const uninstalledKeys = new Set(report.uninstalled.map((u) => `${u.backend}:${u.modelId}`));
  const installed = report.assessments.filter((a) => !uninstalledKeys.has(`${a?.backend}:${a?.modelId}`));

  const targets = selectSweepTargets({
    // Records for models that are no longer installed cannot be re-measured, so
    // they never enter the queue.
    assessments: installed,
    unassessed: report.unassessed,
    scope: resolvedScope,
    only: named,
    tunings: grid,
  });

  // An empty list for a NAMED model means it is not installed — the selector
  // found neither a record nor a listing for it. Saying so beats queuing one
  // doomed measurement per variant and reporting the sweep as failed.
  if (!targets.length) {
    return {
      ...snapshot(),
      rejected: named ? `${named.modelId} is not installed on ${named.backend}` : 'nothing to measure for that scope',
    };
  }

  const emit = (frame) => {
    if (typeof onProgress !== 'function') return;
    // A broken listener (a closed socket) must never abort a job the user is
    // paying hours of compute for.
    try { onProgress(frame); }
    catch (err) { console.error(`❌ Local LLM: sweep progress listener failed: ${err.message}`); }
  };

  // Capture BEFORE the first model/variant relaunches anything. A model sweep
  // can cross several llama targets, each with a different stored tuning; the
  // llama daemon is machine-wide, so the one launch state has to be restored
  // after the whole queue, not after each model. Endpoint runtimes that cannot
  // reset safely are intentionally absent from this map.
  //
  // A backend whose capture comes back `null` is LEFT OUT rather than stored as
  // null: the daemon is stopped or somebody else started it, so there is nothing
  // to put back — and the loop reads presence here as its permission to reset.
  const restoreBackends = [...new Set(targets.map((target) => target.backend).filter(isTuningSweepable))];
  const launchStates = {};
  for (const restoreBackend of restoreBackends) {
    const state = await captureLaunchState(restoreBackend);
    if (state) launchStates[restoreBackend] = state;
  }
  // Nothing to capture means the daemon is stopped, or someone else started it —
  // either way PortOS cannot put a tuning on its launch line, so every variant
  // would record `tuningApplied: false` and the comparison would rank a set of
  // configurations that never ran. Refusing costs a click; running costs the
  // whole sweep.
  //
  // Only a TUNING sweep refuses. Varying the launch line is its entire job, so
  // an uncapturable runtime leaves it nothing to do — but a MODEL sweep is a
  // queue of real measurements across every runtime the scope covers, and one
  // llama-server somebody else started must not cancel the Ollama and LM Studio
  // models alongside it. It measures that runtime under whatever is running, as
  // it did before the reset existed.
  if (grid && !launchStates[named.backend]) {
    return {
      ...snapshot(),
      rejected: `PortOS is not running ${named.backend}, so it cannot vary the launch configuration — start it from the LLMs page first`,
    };
  }

  const run = {
    status: 'running',
    mode,
    // A tuning sweep of ONE named model did not consult the scope, so reporting
    // one would tell the page it measured a set it never looked at.
    scope: named ? null : resolvedScope,
    target: named,
    startedAt: nowIso(),
    finishedAt: null,
    total: targets.length,
    current: null,
    results: [],
    cancelRequested: false,
    error: null,
    restoreError: null,
    // Flipped in the loop's `finally`, after the restore. `startSweep` refuses
    // while it is false, so a cancelled sweep cannot relaunch the daemon
    // underneath the sweep that replaced it.
    settled: false,
    launchStates,
    controller: new AbortController(),
  };
  sweep = run;

  // A tuning sweep measures ONE thing many ways, so counting "models" would be
  // wrong in exactly the place the user is reading for reassurance.
  const plural = targets.length === 1 ? '' : 's';
  const what = grid
    ? `${named.modelId} across ${targets.length} tuning${plural}`
    : `${targets.length} model${plural}`;
  console.log(`📏 Local LLM: assessment sweep started — ${targets.length} measurement${plural} (${named ? named.modelId : resolvedScope})`);
  emit({ scope: 'assessment-sweep', event: 'start', total: targets.length, completed: 0, message: `Measuring ${what}…` });

  // Detached on purpose: the caller is an HTTP handler that must return now.
  runSweepLoop(run, targets, contextTokens, emit)
    .catch((err) => {
      run.error = err?.message || 'sweep failed';
      console.error(`❌ Local LLM: assessment sweep failed: ${run.error}`);
    })
    // Not in the `finally`: putting the daemon back is real work that can fail,
    // and it has to finish before the page is told the sweep is over — a user
    // reading "complete" must not still be racing a relaunch.
    .then(() => restoreAllUnderClaim(run)
      .then((failures) => {
        // A captured state that did not restore means that backend is still on
        // the last variant. Recording the reason is the only way the user finds
        // out; swallowing it leaves them running a configuration they did not
        // choose and cannot see.
        if (failures.length) {
          run.restoreError = failures.join('; ');
          console.error(`❌ Local LLM: sweep finished but the launch configuration was not restored — ${run.restoreError}`);
        }
      })
      .catch((err) => {
        run.restoreError = err?.message || 'the launch configuration could not be put back';
        console.error(`❌ Local LLM: could not restore the launch configuration after the sweep: ${run.restoreError}`);
      }))
    .finally(() => {
      run.status = run.cancelRequested ? 'cancelled' : (run.error ? 'failed' : 'complete');
      run.finishedAt = nowIso();
      run.current = null;
      // Set LAST, once the queue and the restore are both done — this is what
      // lets the next sweep start.
      run.settled = true;
      console.log(`📏 Local LLM: assessment sweep ${run.status} — ${run.results.length}/${run.total} measured`);
      // A queue the user already replaced has nothing to report — emitting its
      // terminal frame would tell the page the CURRENT sweep just finished.
      if (sweep !== run) return;
      emit({
        scope: 'assessment-sweep',
        event: 'complete',
        status: run.status,
        completed: run.results.length,
        total: run.total,
        message: `Sweep ${run.status}: ${run.results.length}/${run.total} measured`,
      });
    });

  return snapshot();
}
