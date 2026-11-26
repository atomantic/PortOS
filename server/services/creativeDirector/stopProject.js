/**
 * Creative Director — hard stop for an in-flight project.
 *
 * Pausing only flips `status`; an agent task already handed to the runner keeps
 * burning the provider, and a `running` run row is respawned by the orphan sweeps
 * (`resetOrphanedTasks` at boot and every 15 minutes). `stopProject` is the full
 * stop, in this order:
 *
 *   1. Park as `paused` FIRST (unless already parked, see projectCommands.js), so a
 *      completion / media-job event mid-stop returns early instead of dispatching.
 *   2. Detach settlement listeners and mark in-flight run rows `failed`.
 *   3. Kill live agent processes attached to those runs.
 *   4. Retire the internal CoS tasks so sweeps can't respawn them (same
 *      `'internal'` / `'completed'` constraints as recovery.js).
 *   5. Reset the scene / plan-step state so Resume works.
 *   6. Cancel every queued/running media job the project owns.
 *
 * Steps 2-4 are exported as `retireRuns` for callers moving a project to a
 * DIFFERENT provider (creativeCommissions/projectControl.js).
 *
 * Runs outside the request lifecycle: every step is individually caught.
 */

import { getProject, updateProject, updateRun, updateScene, updatePlanStep, mutateVideoProject } from './local.js';
import { RUN_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';
import { resolveCreativeDirectorProjectCommand } from './projectCommands.js';
import { loadLateBoundService } from '../../lib/lateBoundServices.js';

const nowISO = () => new Date().toISOString();

// Every teardown step is best-effort: this runs outside the request lifecycle.

/** Import a module, or an empty object when it can't load. Callers feature-detect. */
const loadOrEmpty = (loader, what, projectId) => loader()
  .catch((e) => { console.error(`❌ CD teardown ${projectId}: ${what} module load failed: ${e.message}`); return {}; });

/** Await one teardown call; return 1 on success, 0 (logged) on failure. */
const tally = (promise, what, projectId) => promise
  .then(() => 1)
  .catch((e) => { console.log(`⚠️ CD teardown ${projectId}: ${what} failed: ${e.message}`); return 0; });

/**
 * In-flight (non-terminal) run rows on a project, optionally narrowed to a set of
 * run kinds ('treatment' | 'plan' | 'evaluate' | 'plan-step'). Pure.
 */
export function inflightRuns(project, kinds = null) {
  return (project?.runs || []).filter((r) => r
    && !RUN_TERMINAL_STATUSES.has(r.status)
    && (!kinds || kinds.includes(r.kind)));
}

/**
 * Media jobs this project owns that are still live. Pure over the passed-in list.
 * A project claims jobs four ways, and missing one leaves a render burning GPU:
 *   - `owner: "cd:<projectId>:<sceneId>"` — per-scene render
 *   - `owner: "creative-director:<projectId>"` — Phase-2 plan render step
 *   - `params.creativeDirector.projectId` — first-pass seed frames (no owner;
 *     the tag completionHook's findPendingSeedFrameJob keys on)
 *   - `params.creativeDirectorMusicBed.projectId` — music bed, also owner-less
 */
export function ownedLiveJobs(jobs, projectId) {
  const ownedBy = (j) => (typeof j?.owner === 'string'
      && (j.owner.startsWith(`cd:${projectId}:`) || j.owner === `creative-director:${projectId}`))
    || j?.params?.creativeDirector?.projectId === projectId
    || j?.params?.creativeDirectorMusicBed?.projectId === projectId;
  return (jobs || []).filter((j) => ownedBy(j) && (j.status === 'queued' || j.status === 'running'));
}

/**
 * Tear down the agent side of in-flight runs: kill the live agent, retire the
 * internal CoS task, settle the run row. Leaves project status and media jobs alone.
 *
 * Retiring the TASK is load-bearing: it carries the provider/model resolved at
 * dispatch and the orphan sweep respawns it verbatim, so a caller that re-pins the
 * project must retire it too.
 *
 * @param {string} projectId
 * @param {{runs?: Array<object>, reason?: string, taskMetadata?: object}} options —
 *   `runs` is the exact set of in-flight rows; `taskMetadata` is the audit stamp
 *   merged onto each retired task.
 */
export async function retireRuns(projectId, { runs = [], reason = 'Stopped', taskMetadata = { retiredByPortos: 'true' } } = {}) {
  const taskIds = new Set(runs.map((r) => r.taskId).filter(Boolean));
  let agents = 0;
  let tasks = 0;

  // Settle run rows BEFORE killing: the kill fires completionHook's `!success` branch,
  // which would flip the project to `failed`, clobbering `paused`. A terminal row is its
  // stale-completion guard, so settling first makes the echo a no-op.
  const completedAt = nowISO();
  for (const run of runs) {
    await tally(
      updateRun(projectId, run.runId, { status: 'failed', completedAt, failureReason: reason }),
      `settle run ${run.runId}`, projectId,
    );
  }

  if (!taskIds.size) return { runs: runs.length, tasks: 0, agents: 0 };

  // An agent that already exited is absent from the active list (killAgent 404s): not an error.
  const { getActiveAgents, killAgent } = await loadOrEmpty(() => loadLateBoundService('agentManagement'), 'agent', projectId);
  if (getActiveAgents && killAgent) {
    for (const agent of getActiveAgents().filter((a) => taskIds.has(a.taskId))) {
      agents += await tally(killAgent(agent.id), `kill agent ${agent.id}`, projectId);
    }
  }

  // taskType MUST be 'internal' and status one generateTasksMarkdown supports (see recovery.js#recoverInFlightProjects).
  const { updateTask } = await loadOrEmpty(() => import('../cos/cosTaskStore.js'), 'cos', projectId);
  if (updateTask) {
    for (const taskId of taskIds) {
      tasks += await tally(updateTask(taskId, {
        status: 'completed',
        metadata: { ...taskMetadata, retiredReason: reason, retiredAt: nowISO() },
      }, 'internal'), `retire task ${taskId}`, projectId);
    }
  }

  return { runs: runs.length, tasks, agents };
}

/**
 * Stop a Creative Director project and everything it has in flight.
 *
 * @param {string} projectId
 * @param {{reason?: string}} options — stamped on `failureReason` and each retired run.
 * @returns {Promise<{projectId: string, stopped: boolean, skipped?: string,
 *   runs: number, tasks: number, agents: number, jobs: number}>}
 */
export async function stopProject(projectId, { reason = 'Stopped', project: preread } = {}) {
  // `project` lets a caller that already holds it skip the per-project re-read.
  const project = preread || await getProject(projectId).catch(() => null);
  const command = resolveCreativeDirectorProjectCommand(project, 'stop', { reason });
  if (command.outcome === 'skip') return { projectId, stopped: false, skipped: command.skipped, runs: 0, tasks: 0, agents: 0, jobs: 0 };

  // 1. Park first so a racing settlement cannot advance the project. A draft or
  // already-paused project needs no write (null patch) but still gets the teardown.
  if (command.outcome === 'delegate') {
    const { pauseVideoExecution } = await import('./videoExecution.js');
    // If the durable stop fails, do not pretend subsequent teardown is safe.
    await pauseVideoExecution(projectId, reason, { invalidate: true });
    if (project.videoExecution?.assembly?.jobId) {
      const { cancelRender } = await import('../videoTimeline/local.js');
      cancelRender(project.videoExecution.assembly.jobId);
    }
  } else if (command.patch) await updateProject(projectId, command.patch)
    .catch((e) => console.error(`❌ CD stop ${projectId}: park failed: ${e.message}`));

  const [{ clearSceneRenderListeners }, { clearPlanListenersForProject }] = await Promise.all([
    import('./sceneRunner.js'),
    import('./planAdvance.js'),
  ]);
  clearSceneRenderListeners(projectId);
  clearPlanListenersForProject(projectId);

  const retired = await retireRuns(projectId, { runs: inflightRuns(project), reason });

  // 5. Reset the stage state the stop invalidated, or Resume is dead until restart: a plan
  // step left `running` makes deriveNextPlanAction return `waiting` forever, and a
  // `rendering` scene points at a job we cancel. A scene whose render landed
  // (`renderedJobId` set) keeps `evaluating`, as in recovery.js: resetting would discard a finished video.
  for (const step of (project.plan?.steps || []).filter((st) => st.status === 'running')) {
    await updatePlanStep(projectId, step.stepId, { status: 'pending' })
      .catch((e) => console.log(`⚠️ CD stop ${projectId}: reset plan step ${step.stepId} failed: ${e.message}`));
  }
  for (const scene of (project.treatment?.scenes || [])) {
    if (scene.status !== 'rendering' && scene.status !== 'evaluating') continue;
    if (scene.renderedJobId && (project.workspace !== 'video' || scene.status === 'evaluating')) continue;
    await updateScene(projectId, scene.sceneId, { status: 'pending', ...(project.workspace === 'video' ? { renderedJobId: null } : {}) })
      .catch((e) => console.log(`⚠️ CD stop ${projectId}: reset scene ${scene.sceneId} failed: ${e.message}`));
  }

  // 6. Cancel the project's live media jobs — nothing downstream will consume them.
  let jobs = 0;
  const queue = await loadOrEmpty(() => import('../mediaJobQueue/index.js'), 'media queue', projectId);
  if (queue.listJobs && queue.cancelJob) {
    for (const job of ownedLiveJobs(queue.listJobs(), projectId)) {
      jobs += await tally(queue.cancelJob(job.id), `cancel job ${job.id}`, projectId);
    }
  }

  if (project.workspace === 'video') {
    await mutateVideoProject(projectId, current => ({ project: { ...current, videoExecution: { ...current.videoExecution,
      attempts: (current.videoExecution?.attempts || []).map(attempt => !['clip', 'audio'].includes(attempt.kind) && ['running', 'submitting'].includes(attempt.status) ? { ...attempt, status: 'failed' } : attempt),
    } }, result: true }));
  }
  console.log(`🛑 CD project ${projectId} stopped: ${reason} (${retired.runs} run(s), ${retired.tasks} task(s), ${retired.agents} agent(s), ${jobs} job(s))`);
  return { projectId, stopped: true, ...retired, jobs };
}
