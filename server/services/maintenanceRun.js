/**
 * Manual maintenance runs — the Schedule tab's "Run maintenance now".
 *
 * A run walks the maintenance ladder (`lib/maintenanceSequence.js`) against ONE
 * managed app, pinned to the provider/model/effort the user chose, and it walks
 * it to the END: each audit is dispatched when the previous step finishes, and
 * every `claim-issue` drain repeats until the app's issue backlog is empty.
 *
 * It is deliberately NOT a quota burn. The Quota Burn page offers the same
 * ladder as a family plan to be walked later, under that family's window gates
 * — and a run started here used to be written INTO that plan and force-started,
 * which coupled "run it now" to everything the plan is for: the master switch
 * had to be on, the family plan had to be empty, only the first step bypassed
 * the reset-window / reserve / cap gates (every later step waited on them), and
 * running again meant re-arming the plan. A manual run keeps its own record,
 * its own completion ledger and its own continuation, so none of that applies:
 * it runs whether or not Quota Burn is enabled, beside whatever plan the family
 * holds, and a second run is just a second record.
 *
 * What it shares with a burn is the INVOCATION: every step is dispatched through
 * `quotaBurnInvoke.invokeQuotaBurnStep`, so the schedule's own gate ladder (task
 * enabled, per-app switch, master Improve, target scope, duplicate requests)
 * still applies, the provider is pinned to the family the user named, and the
 * task carries the family provenance that makes it cooldown-exempt and lets an
 * observed refusal be credited to the right window. The `maintenanceRunId`
 * provenance field is what tells the quota-burn loop to leave these agents
 * alone (`quotaBurnRunner.js#onBurnAgentCompleted`).
 *
 * Pacing is by completion: `agent:completed` for one of the run's tasks
 * re-evaluates the run, and a slow interval re-evaluates every running run as
 * the safety net for holds that no agent completion will lift — a transient
 * claim probe, a queued request an engine refused, a task setting the user
 * fixes after the fact. A hold never ends a run: it is re-tried until it
 * clears, or the user stops the run.
 *
 * AI-policy posture (AGENTS.md): every dispatch traces to the user's click on
 * "Run now", which names the app, provider and model. Boot arms the listener
 * and the interval; neither dispatches anything on an install with no running
 * run, and a fresh install has none.
 *
 * Storage: `data/cos/maintenance-runs.json`, machine-local and `ephemeral-file`
 * — a capped list of run records, newest first. No `data.reference/` seed: an
 * absent file is "no runs yet".
 */

import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { atomicWrite, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';
import { buildMaintenanceSteps } from '../lib/maintenanceSequence.js';
import { familyForProvider } from '../lib/providerFamilies.js';
import { quotaBurnProvenance } from '../lib/quotaBurnOrigin.js';
import { cosEvents } from './cosEvents.js';
import { getQuotaBurnTaskCatalog, invokeQuotaBurnStep } from './quotaBurnInvoke.js';
import { ACTIVE_TASK_STATUSES, probeSequenceDrain, sequenceStepShapeReason } from './quotaBurnSequence.js';

const runsFile = () => join(PATHS.cos, 'maintenance-runs.json');

/** Finished runs kept for the page's history; running ones are never pruned. */
const RUN_HISTORY_LIMIT = 20;
/** The safety-net re-evaluation cadence for holds no agent completion will lift. */
const RETRY_MS = 2 * 60_000;

export const MAINTENANCE_RUN_STATUS = Object.freeze({ RUNNING: 'running', COMPLETED: 'completed', STOPPED: 'stopped' });

const activeRunError = (appId, runId) => new ServerError(`a maintenance run is already in progress for "${appId}" (${runId})`, { status: 409, code: 'MAINTENANCE_RUN_ACTIVE' });

const writeQueue = createFileWriteQueue();
// One evaluation at a time PER RUN: a completion and the interval can land
// together, and two concurrent walks of one ladder would dispatch its next
// step twice.
const evaluations = createKeyCachedQueue();
let retryTimer = null;

export async function listMaintenanceRuns() {
  const loaded = await readJSONFile(runsFile(), null);
  return Array.isArray(loaded?.runs) ? loaded.runs : [];
}

/**
 * Persist a run: replace it in place, or prepend a new one, then prune finished
 * history past the cap. Running records are never pruned — a run the user can
 * still see progressing must not vanish because twenty others finished.
 */
function writeRun(run) {
  return writeQueue(async () => {
    const runs = await listMaintenanceRuns();
    const next = runs.some((entry) => entry.id === run.id) ? runs.map((entry) => (entry.id === run.id ? run : entry)) : [run, ...runs];
    let finished = 0;
    const kept = next.filter((entry) => entry.status === MAINTENANCE_RUN_STATUS.RUNNING || ++finished <= RUN_HISTORY_LIMIT);
    await atomicWrite(runsFile(), { runs: kept });
    return run;
  });
}

export async function getMaintenanceRun(id) {
  return (await listMaintenanceRuns()).find((run) => run.id === id) || null;
}

const stamp = (run, patch) => ({ ...run, ...patch, updatedAt: new Date().toISOString() });

/** Two ladders against one app would file and claim each other's findings. */
async function assertNoRunningRun(appId) {
  const active = (await listMaintenanceRuns()).find((run) => run.appId === appId && run.status === MAINTENANCE_RUN_STATUS.RUNNING);
  if (active) throw activeRunError(appId, active.id);
}

/**
 * Start a run. Refused (with a thrown, coded error the route maps to a 4xx)
 * when the app is unknown or archived, the provider is not an enabled
 * subscription CLI/TUI provider in a known family — the SAME gate every dispatch
 * re-applies (`resolveBurnProvider`), so a run can never start on a provider
 * its steps would then refuse — or the app already has a running run.
 *
 * The first evaluation runs before this returns, so the caller learns whether
 * step one actually went out (or why it is holding) in the same response.
 */
export async function startMaintenanceRun({ appId, providerId, model = null, effort = null }) {
  const [{ getAppById }, { getProviderById }, { resolveBurnProvider }] = await Promise.all([
    import('./apps.js'), import('./providers.js'), import('./scheduledHandlers/providerPick.js'),
  ]);
  const [app, provider] = await Promise.all([getAppById(appId), getProviderById(providerId)]);
  if (!app || app.archived === true) throw new ServerError(`managed app "${appId}" is not available`, { status: 400, code: 'MAINTENANCE_RUN_APP_UNAVAILABLE' });
  const familyId = familyForProvider(provider);
  const pinned = familyId ? await resolveBurnProvider({ job: { providerId }, family: { id: familyId } }) : null;
  if (!pinned) throw new ServerError(`provider "${providerId}" is not an enabled subscription CLI/TUI provider`, { status: 400, code: 'MAINTENANCE_RUN_PROVIDER_UNAVAILABLE' });
  await assertNoRunningRun(appId);

  const id = `maint-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  const pins = { providerId, model: model || null, effort: effort || null };
  const run = await writeRun({
    id, appId, familyId, ...pins,
    status: MAINTENANCE_RUN_STATUS.RUNNING,
    steps: buildMaintenanceSteps({ appId, idPrefix: id, ...pins }),
    completed: {},
    active: null,
    reason: null,
    startedAt: now, updatedAt: now, finishedAt: null,
  });
  console.log(`🧹 Maintenance run ${id} started for ${appId} via ${providerId}`);
  const result = await evaluateMaintenanceRun(id);
  return { run: await getMaintenanceRun(id) || run, result };
}

/**
 * Stop dispatching. A task already queued or running is NOT recalled — the
 * daemon owns it — so the run's last step may still finish; it just advances
 * nothing afterwards. `resume` picks the ladder up from its completion ledger.
 */
export async function stopMaintenanceRun(id) {
  const run = await getMaintenanceRun(id);
  if (!run) return null;
  if (run.status !== MAINTENANCE_RUN_STATUS.RUNNING) return run;
  console.log(`🧹 Maintenance run ${id} stopped by the user`);
  return writeRun(stamp(run, { status: MAINTENANCE_RUN_STATUS.STOPPED, finishedAt: new Date().toISOString(), reason: 'stopped by the user' }));
}

export async function resumeMaintenanceRun(id) {
  const run = await getMaintenanceRun(id);
  if (!run) return null;
  if (run.status === MAINTENANCE_RUN_STATUS.RUNNING) return { run, result: await evaluateMaintenanceRun(id) };
  await assertNoRunningRun(run.appId);
  await writeRun(stamp(run, { status: MAINTENANCE_RUN_STATUS.RUNNING, finishedAt: null, reason: null }));
  console.log(`🧹 Maintenance run ${id} resumed`);
  const result = await evaluateMaintenanceRun(id);
  return { run: await getMaintenanceRun(id), result };
}

/**
 * Evaluate one run: dispatch its next step if nothing of its own is still
 * queued, running or blocked, mark a drained claim step done, or record why it
 * is holding. Serialized per run; the returned promise is the outcome of THIS
 * caller's evaluation.
 */
export const evaluateMaintenanceRun = (id, { ignoreTaskId = null } = {}) => evaluations(id, () => evaluate(id, { ignoreTaskId }));

async function evaluate(id, { ignoreTaskId }) {
  const run = await getMaintenanceRun(id);
  if (!run) return { skipped: 'unknown run' };
  if (run.status !== MAINTENANCE_RUN_STATUS.RUNNING) return { skipped: run.status };

  const hold = async (reason, patch = null) => {
    if (patch || run.reason !== reason) await writeRun(stamp(run, { ...patch, reason }));
    return { dispatched: false, reason };
  };

  const [{ getAllTasks }, { getOnDemandRequests }] = await Promise.all([import('./cosTaskStore.js'), import('./taskSchedule.js')]);
  const { user, cos } = await getAllTasks();
  const ownTask = [...(user?.tasks || []), ...(cos?.tasks || [])].find((task) => task.id !== ignoreTaskId
    && quotaBurnProvenance(task.metadata).maintenanceRunId === id && ACTIVE_TASK_STATUSES.has(task.status));
  if (ownTask) return hold(`waiting for ${ownTask.status.replace('_', ' ')} task ${ownTask.id}`);
  const queued = (await getOnDemandRequests()).find((request) => request?.burn?.maintenanceRunId === id);
  if (queued) return hold(`waiting for the CoS daemon to accept request ${queued.id} (${queued.taskType})`);

  const catalog = await getQuotaBurnTaskCatalog();
  const completed = { ...run.completed };
  for (const step of run.steps) {
    if (completed[step.id]) continue;
    const shape = sequenceStepShapeReason(step);
    if (shape) return hold(shape);
    if (step.drain) {
      const probe = await probeSequenceDrain(step, { catalog, ignoreTaskId });
      if (probe.drained) {
        completed[step.id] = new Date().toISOString();
        continue;
      }
      if (!probe.job) return hold(probe.reason);
    }
    const result = await invokeQuotaBurnStep({ step, family: { id: run.familyId }, catalog, maintenanceRunId: id });
    if (!result.dispatched) return hold(result.reason, { completed });
    const taskType = step.taskRef.taskType;
    await writeRun(stamp(run, {
      completed,
      reason: null,
      active: { stepId: step.id, taskType, requestId: result.awaiting?.requestId ?? null, at: new Date().toISOString() },
    }));
    console.log(`🧹 Maintenance run ${id}: dispatched ${taskType} (${step.id})`);
    return { dispatched: true, stepId: step.id, taskType, summary: result.summary };
  }
  await writeRun(stamp(run, {
    completed, active: null, reason: 'maintenance sequence complete',
    status: MAINTENANCE_RUN_STATUS.COMPLETED, finishedAt: new Date().toISOString(),
  }));
  console.log(`🧹 Maintenance run ${id} complete for ${run.appId}`);
  return { dispatched: false, completed: true, reason: 'maintenance sequence complete' };
}

/**
 * Continuation. An audit step is done when its agent SUCCEEDS; a failed agent
 * leaves its task blocked, which the next evaluation reports as a hold until
 * the user retries or dismisses it. A drain step is never completed here — the
 * claim probe decides that on the evaluation this triggers.
 */
function onMaintenanceAgentCompleted(agent) {
  const id = agent?.metadata?.taskQuotaBurnMaintenanceRunId;
  if (!id) return null;
  const stepId = agent.metadata?.taskQuotaBurnStepId;
  const success = agent.result?.success === true;
  return getMaintenanceRun(id)
    .then(async (run) => {
      if (!run) return { skipped: 'unknown run' };
      const step = run.steps.find((entry) => entry.id === stepId);
      if (success && step && !step.drain && !run.completed[step.id]) {
        await writeRun(stamp(run, { completed: { ...run.completed, [step.id]: new Date().toISOString() }, active: null }));
      }
      return evaluateMaintenanceRun(id, { ignoreTaskId: success ? agent.taskId || null : null });
    })
    .catch((err) => console.error(`❌ Maintenance run ${id} continuation failed: ${err.message}`));
}

async function retryRunningRuns() {
  const running = (await listMaintenanceRuns()).filter((run) => run.status === MAINTENANCE_RUN_STATUS.RUNNING);
  for (const run of running) {
    await evaluateMaintenanceRun(run.id).catch((err) => console.error(`❌ Maintenance run ${run.id} retry failed: ${err.message}`));
  }
}

/** Arm the continuation listener and the safety-net interval. Called once at boot. */
export function startMaintenanceRunScheduler() {
  if (retryTimer) return;
  // Both run outside the request lifecycle: the listener never rethrows and the
  // timer's callback owns its rejections, so neither can take the process down.
  cosEvents.on('agent:completed', onMaintenanceAgentCompleted);
  retryTimer = setInterval(() => {
    retryRunningRuns().catch((err) => console.error(`❌ Maintenance run retry sweep failed: ${err.message}`));
  }, RETRY_MS);
  retryTimer.unref?.();
  console.log('🧹 Maintenance run loop armed (idle until a run is started from the Schedule tab)');
}

/** Test seams. */
export const __onMaintenanceAgentCompleted = onMaintenanceAgentCompleted;
export const __retryMaintenanceRuns = retryRunningRuns;
export function __resetMaintenanceRunScheduler() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
  cosEvents.off('agent:completed', onMaintenanceAgentCompleted);
  evaluations.clear();
}
