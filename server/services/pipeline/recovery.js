import { listAllIssues, listIssues, updateIssue, updateStageWithLatest, TEXT_STAGE_IDS } from './issues.js';
import { listSeries, updateSeries } from './series.js';

// A recovery read can overlap a newly admitted generation. Keep the ownership check shared.
export const liveGenerations = new Map();

/**
 * Boot-time recovery: the in-memory run map is lost on restart, so any series
 * whose persisted marker still says `running` is demoted to `paused` (the user
 * can click Run to resume from the next missing step). Mirrors
 * recoverStuckAutoRuns in autoRunner.js. Best-effort; never blocks boot.
 */
export async function recoverStuckAutopilots() {
  const all = await listSeries().catch(() => []);
  const stuck = all.filter((s) => s.autopilot?.status === 'running');
  if (stuck.length === 0) return 0;
  for (const s of stuck) {
    await updateSeries(s.id, {
      autopilot: { ...s.autopilot, status: 'paused', lastError: 'interrupted by server restart', updatedAt: new Date().toISOString() },
    }).catch(() => null);
  }
  console.log(`📝 autopilot: recovered ${stuck.length} stuck run${stuck.length === 1 ? '' : 's'} on boot`);
  return stuck.length;
}

/**
 * Boot-time recovery for issues stuck in `status: 'running'`.
 *
 * The in-memory `runs` map is lost on server restart — there's no way to
 * reattach SSE to the dead run, and the issue would remain stuck in
 * `running` forever (the UI shows a spinner that never resolves).
 *
 * On boot, walk every issue and demote any `running` to `needs-review` (the
 * same terminal state a normal-completion path lands on). Idempotent. Fires
 * as a fire-and-forget side effect; failures are logged but never escalated
 * — the listIssues call has its own error handling and an exception here
 * shouldn't block server startup.
 *
 * Mirrors writers-room/evaluator.js#recoverStuckAnalyses.
 */
export async function recoverStuckAutoRuns() {
  const all = await listIssues().catch(() => []);
  const stuck = all.filter((i) => i.status === 'running');
  if (stuck.length === 0) return 0;
  for (const issue of stuck) {
    await updateIssue(issue.id, { status: 'needs-review' }).catch(() => null);
  }
  console.log(`📝 pipeline: recovered ${stuck.length} stuck auto-run${stuck.length === 1 ? '' : 's'} on boot`);
  return stuck.length;
}

function episodeVideoRecoveryPatch(project) {
  if (!project) {
    return { status: 'error', errorMessage: 'The linked Creative Director project was not found. Restart the episode render.' };
  }
  if (project.peerReplica) return null;
  if (project.status === 'complete') return { status: 'ready', errorMessage: '' };
  // Stop parks legacy CD projects as paused and records the reason. A plain
  // Pause remains resumable and should keep its current stage state.
  if (project.status === 'failed' || (project.status === 'paused' && project.failureReason === 'Stopped by user')) {
    return { status: 'error', errorMessage: project.failureReason || 'Creative Director episode render failed.' };
  }
  return null;
}

async function recoverEpisodeVideos(issues) {
  const pending = issues.filter((issue) => issue.stages.episodeVideo.status === 'generating');
  if (!pending.length) return 0;
  const projectIds = [...new Set(pending.map((issue) => issue.stages.episodeVideo.cdProjectId).filter(Boolean))];
  const { getProjectsByIds } = await import('../creativeDirector/local.js');
  const projects = new Map((await getProjectsByIds(projectIds)).map((project) => [project.id, project]));
  let recovered = 0;
  for (const issue of pending) {
    const snapshot = issue.stages.episodeVideo;
    const project = projects.get(snapshot.cdProjectId);
    const patch = episodeVideoRecoveryPatch(project);
    if (!patch) continue;
    await updateStageWithLatest(issue.id, 'episodeVideo', (current) => {
      if (current.status !== 'generating' || current.cdProjectId !== snapshot.cdProjectId
        || current.updatedAt !== snapshot.updatedAt) return {};
      recovered += 1;
      return patch;
    });
  }
  return recovered;
}

/** Repair locally abandoned text generations and reconcile episode video handoffs. */
export async function recoverStuckGeneratingStages() {
  const { getInstanceId, UNKNOWN_INSTANCE_ID } = await import('../instanceIdentity.js');
  const instanceId = await getInstanceId();
  const issues = await listAllIssues({ withHistory: false });
  if (!instanceId || instanceId === UNKNOWN_INSTANCE_ID) return recoverEpisodeVideos(issues);
  let recovered = 0;
  for (const issue of issues) {
    for (const stageId of TEXT_STAGE_IDS) {
      const snapshot = issue.stages[stageId];
      if (snapshot.status !== 'generating' || snapshot.generation?.instanceId !== instanceId) continue;
      await updateStageWithLatest(issue.id, stageId, (current) => {
        if (current.status !== 'generating' || current.generation?.instanceId !== instanceId
          || current.generation?.id !== snapshot.generation.id
          || current.updatedAt !== snapshot.updatedAt || liveGenerations.has(current.generation.id)) return {};
        recovered += 1;
        return { status: 'error', errorMessage: 'Interrupted by a server restart — generate again.' };
      });
    }
  }
  return recovered + await recoverEpisodeVideos(issues);
}
