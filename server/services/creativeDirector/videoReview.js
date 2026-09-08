import { assertVideoOwner, applyVideoReviewAction, videoReviewStages } from '../../lib/creativeDirectorVideoReview.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getInstanceId } from '../instances.js';
import { getProject, mutateVideoProject } from './local.js';

export async function getVideoReview(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const instanceId = await getInstanceId();
  return { checkpoints: videoReviewStages(project), feedback: project.videoReview?.feedback || [],
    revisionRequests: project.videoReview?.revisionRequests || [],
    artifacts: { script: project.treatment?.script, revision: project.treatment?.artifact?.revision,
      shots: project.treatment?.scenes || [], steps: project.plan?.steps || [],
      references: project.treatment?.artifact?.references || [], startingImageFile: project.startingImageFile,
      roughCut: project.videoRoughCut, finalCut: project.videoFinalCut },
    canReview: !project.videoReplica && Boolean(project.videoOwnerInstanceId) && project.videoOwnerInstanceId === instanceId };
}

export async function reviewVideo(projectId, input) {
  const instanceId = await getInstanceId();
  const { project, result } = await mutateVideoProject(projectId, current => {
    const { project: next, changed } = applyVideoReviewAction(current, input, instanceId);
    return { project: next, result: { changed }, skipPersist: !changed };
  });
  // A duplicate approval and either feedback gesture can never enqueue work.
  if (result.changed && input.action === 'approve' && project.videoExecution?.authorized) {
    const { startCreativeDirectorProject } = await import('./completionHook.js');
    await startCreativeDirectorProject(projectId);
  }
  return getVideoReview(projectId);
}

/** All direct and DAG consumers require saved local authorization AND current approvals. */
export async function videoReviewAllowsDispatch(projectId, stages) {
  const project = await getProject(projectId);
  if (!project || project.workspace !== 'video') return Boolean(project);
  // The explicit-Start implementation owns this record. Missing means inert,
  // including pre-authorization drafts and every synced replica.
  if (!project.videoExecution?.authorized || ['paused', 'failed', 'draft'].includes(project.status)) return false;
  assertVideoOwner(project, await getInstanceId());
  const { assertVideoSourcesAvailable } = await import('./videoSources.js');
  await assertVideoSourcesAvailable(project);
  const { result } = await mutateVideoProject(projectId, current => {
    assertVideoOwner(current, project.videoOwnerInstanceId);
    if (!current.videoExecution?.authorized || ['paused', 'failed', 'draft'].includes(current.status)) {
      return { project: current, result: false, skipPersist: true };
    }
    const checkpoints = videoReviewStages(current);
    const blocked = checkpoints.find(row => stages.includes(row.stage) && !['approved', 'skipped'].includes(row.status));
    if (!blocked) return { project: current, result: true, skipPersist: true };
    return { project: { ...current,
      videoReview: { ...current.videoReview, waitingFor: { stage: blocked.stage, revision: blocked.revision } },
      updatedAt: new Date().toISOString(),
    }, result: false };
  });
  return result;
}
