/**
 * Creative Director — hard stop for an in-flight project.
 *
 * Pausing a project (`POST /:id/pause`) only flips `status`; it deliberately
 * leaves the in-flight render running and never touches the CoS agent tasks the
 * cognitive stages spawned. That is the right gesture for "let this finish, just
 * don't queue more" — but it is NOT enough when the caller wants the project to
 * STOP: an agent task already handed to the runner keeps burning the provider,
 * and a `running` run row left behind is respawned by the orphan sweeps —
 * `resetOrphanedTasks` on boot AND on the 15-minute health-check interval — so
 * the same stage is handed to the same model again and again.
 *
 * `stopProject` is the full stop. In order (the order matters):
 *
 *   1. Park the project as `paused` FIRST, so any completion / media-job event
 *      that lands mid-stop finds a paused project and returns early instead of
 *      dispatching the next step behind us.
 *   2. Mark the in-flight run rows `failed`, so the re-dispatch guards in
 *      planAdvance / completionHook don't treat a dead run as "a worker is on it"
 *      — and so the completion the next step provokes reads as stale.
 *   3. Kill any live agent process attached to those runs.
 *   4. Retire the underlying internal CoS tasks, so the orphan sweeps can't
 *      respawn them (same reasoning + same `'internal'` / `'completed'`
 *      constraints as recovery.js — see the comment there).
 *   5. Reset the scene / plan-step state the stop invalidated, so Resume has
 *      something runnable to pick up instead of waiting on a worker that is gone.
 *   6. Cancel every queued/running media job the project owns, so a doomed render
 *      isn't left holding the GPU.
 *
 * Steps 2-4 are also exported on their own as `retireRuns`, because a caller that
 * wants the project to keep going under a DIFFERENT provider needs exactly that
 * teardown and none of the parking (see creativeCommissions/projectControl.js).
 *
 * Runs OUTSIDE the Express request lifecycle (callers include the commission
 * store's change bus) — every step is individually caught and no path throws out.
 */

import { getProject, updateProject, updateRun, updateScene, updatePlanStep } from './local.js';
import { PROJECT_TERMINAL_STATUSES, RUN_TERMINAL_STATUSES } from '../../lib/creativeDirectorPresets.js';

const nowISO = () => new Date().toISOString();

// Every teardown step is best-effort: this runs outside the request lifecycle, so
// one failed kill must not abort the rest of the stop. These two collapse the
// shape that would otherwise be written out once per step.

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
 *
 * A CD project claims its media jobs three different ways, and a stop that misses
 * one leaves that render burning GPU after the user asked it to stop:
 *   - `owner: "cd:<projectId>:<sceneId>"`      — the scene loop's per-scene render
 *   - `owner: "creative-director:<projectId>"`  — a Phase-2 plan render step
 *   - `params.creativeDirector.projectId`      — first-pass seed frames
 *     (firstPassGen.js#enqueueFirstPassSceneFrames), which carry NO owner at all;
 *     this is the tag completionHook's findPendingSeedFrameJob keys on. A
 *     10-scene project enqueues ten of these up front, so omitting them is the
 *     difference between "Stop" cancelling the queue and cancelling nothing.
 *   - `params.creativeDirectorMusicBed.projectId` — the first-pass / planner music
 *     bed (firstPassMusicGen.js, creative/tools/media.js), also owner-less. A
 *     music commission's whole deliverable is one of these.
 */
export function ownedLiveJobs(jobs, projectId) {
  const ownedBy = (j) => (typeof j?.owner === 'string'
      && (j.owner.startsWith(`cd:${projectId}:`) || j.owner === `creative-director:${projectId}`))
    || j?.params?.creativeDirector?.projectId === projectId
    || j?.params?.creativeDirectorMusicBed?.projectId === projectId;
  return (jobs || []).filter((j) => ownedBy(j) && (j.status === 'queued' || j.status === 'running'));
}

/**
 * Tear down the agent side of a set of in-flight runs: kill the live agent
 * process, retire the underlying internal CoS task, settle the run row. Does NOT
 * touch the project's status and does NOT cancel media jobs.
 *
 * Retiring the TASK — not just the run row — is the load-bearing part. A task
 * already handed to the runner carries the provider/model resolved at dispatch
 * frozen into its metadata, and the orphan sweep respawns it verbatim; so a
 * caller that re-pins the project must retire the task too, or the sweep keeps
 * re-launching the stale provider every 15 minutes.
 *
 * @param {string} projectId
 * @param {{runs?: Array<object>, reason?: string, taskMetadata?: object}} options —
 *   `runs` is the exact set of in-flight run rows to retire (callers narrow it by
 *   kind); `taskMetadata` is the audit stamp merged onto each retired task, so a
 *   caller can record WHY without changing the retirement contract.
 */
export async function retireRuns(projectId, { runs = [], reason = 'Stopped', taskMetadata = { retiredByPortos: 'true' } } = {}) {
  const taskIds = new Set(runs.map((r) => r.taskId).filter(Boolean));
  let agents = 0;
  let tasks = 0;

  // Settle the run rows BEFORE killing anything. The kill fires the agent
  // completion path, and completionHook's `!success` branch would flip the whole
  // project to `failed` — clobbering the stop's `paused`, or killing a project we
  // are restarting under a new provider. A terminal row is completionHook's
  // stale-completion guard, so settling first makes the echo a no-op. (A lingering
  // `running` row is also what every re-dispatch guard reads as "another worker
  // owns this stage", and what boot recovery revives.)
  const completedAt = nowISO();
  for (const run of runs) {
    await tally(
      updateRun(projectId, run.runId, { status: 'failed', completedAt, failureReason: reason }),
      `settle run ${run.runId}`, projectId,
    );
  }

  if (!taskIds.size) return { runs: runs.length, tasks: 0, agents: 0 };

  // An agent that already exited is simply absent from the active list
  // (killAgent 404s), which is not an error for us.
  const { getActiveAgents, killAgent } = await loadOrEmpty(() => import('../agentManagement.js'), 'agent', projectId);
  if (getActiveAgents && killAgent) {
    for (const agent of getActiveAgents().filter((a) => taskIds.has(a.taskId))) {
      agents += await tally(killAgent(agent.id), `kill agent ${agent.id}`, projectId);
    }
  }

  // taskType MUST be 'internal' and status MUST be a value generateTasksMarkdown
  // supports — see the long-form rationale in recovery.js#recoverInFlightProjects,
  // which retires the same task rows.
  const { updateTask } = await loadOrEmpty(() => import('../cos.js'), 'cos', projectId);
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
 * @param {{reason?: string}} options — `reason` is stamped on the project's
 *   `failureReason` and on each retired run, so the CD detail page explains why
 *   the project stopped rather than showing a bare pause.
 * @returns {Promise<{projectId: string, stopped: boolean, skipped?: string,
 *   runs: number, tasks: number, agents: number, jobs: number}>}
 */
export async function stopProject(projectId, { reason = 'Stopped', project: preread } = {}) {
  // `project` lets a caller that already listed its projects skip the re-read —
  // a fan-out over one commission's projects would otherwise cost a single-row
  // query per project just to rediscover what it already holds.
  const project = preread || await getProject(projectId).catch(() => null);
  if (!project) return { projectId, stopped: false, skipped: 'missing', runs: 0, tasks: 0, agents: 0, jobs: 0 };
  if (PROJECT_TERMINAL_STATUSES.has(project.status) && (project.workspace !== 'video' || project.status === 'complete')) {
    return { projectId, stopped: false, skipped: 'terminal', runs: 0, tasks: 0, agents: 0, jobs: 0 };
  }

  // 1. Park first — a settle event racing us must find `paused` and bail.
  if (project.workspace === 'video') {
    const { pauseVideoExecution } = await import('./videoExecution.js');
    // If the durable stop fails, do not pretend subsequent teardown is safe.
    await pauseVideoExecution(projectId, reason, { invalidate: true });
    if (project.videoExecution?.assembly?.jobId) {
      const { cancelRender } = await import('../videoTimeline/local.js');
      cancelRender(project.videoExecution.assembly.jobId);
    }
  } else await updateProject(projectId, { status: 'paused', failureReason: reason })
    .catch((e) => console.error(`❌ CD stop ${projectId}: park failed: ${e.message}`));

  const retired = await retireRuns(projectId, { runs: inflightRuns(project), reason });

  // 5. Reset the stage state the stop just invalidated. Without this a stopped
  // project can never be RESUMED: a plan step left `running` makes
  // deriveNextPlanAction return `waiting` forever (it reads that as "a worker owns
  // this"), and a scene left `rendering`/`evaluating` points at a job we are about
  // to cancel. Boot recovery performs exactly this reset for paused projects — but
  // only at boot, so without it here Resume is dead until the next restart. A scene
  // whose render already landed (`renderedJobId` set) keeps its `evaluating`
  // status, the same carve-out recovery.js makes: resetting it would throw away a
  // finished video.
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
    const { mutateVideoProject } = await import('./local.js');
    await mutateVideoProject(projectId, current => ({ project: { ...current, videoExecution: { ...current.videoExecution,
      attempts: (current.videoExecution?.attempts || []).map(attempt => !['clip', 'audio'].includes(attempt.kind) && ['running', 'submitting'].includes(attempt.status) ? { ...attempt, status: 'failed' } : attempt),
    } }, result: true }));
  }
  console.log(`🛑 CD project ${projectId} stopped: ${reason} (${retired.runs} run(s), ${retired.tasks} task(s), ${retired.agents} agent(s), ${jobs} job(s))`);
  return { projectId, stopped: true, ...retired, jobs };
}
