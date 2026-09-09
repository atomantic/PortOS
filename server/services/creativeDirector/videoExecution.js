/** Explicit Video authorization and bounded receipts on the existing project store. */
import { randomUUID } from 'crypto';
import { canonicalSnapshotChecksum } from '../../lib/snapshotChecksum.js';
import { ServerError } from '../../lib/errorHandler.js';
import { creativeDirectorVideoLimitsSchema } from '../../lib/creativeDirectorValidation.js';
import { assertVideoOwner } from '../../lib/creativeDirectorVideoReview.js';

const ACTIVE = new Set(['planning', 'rendering', 'stitching']);
const isMediaAttempt = attempt => ['clip', 'audio'].includes(attempt.kind);
const LIVE_ATTEMPTS = new Set(['submitting', 'queued', 'running', 'uncertain']);
const now = () => new Date().toISOString();

export function videoConfigurationRevision(project) {
  return canonicalSnapshotChecksum(Object.fromEntries(['userStory', 'styleSpec', 'cast', 'targetDurationSeconds',
    'aspectRatio', 'quality', 'modelId', 'renderBackend', 'modelOverrides', 'videoDraft', 'startingImageFile',
    // Keep the legacy field in this persisted hash for compatibility with
    // executions authorized by older releases; Video rendering itself reads
    // videoDraft.audio / the frozen execution choice instead.
    'disableAudio', 'autoAcceptScenes', 'directive'].map(key => [key, project[key] ?? null])));
}

/** Frozen choices contain identifiers only; credentials always stay in Settings. */
export function effectiveVideoProject(project) {
  const choices = project.videoExecution?.choices;
  if (project.workspace !== 'video' || !choices) return project;
  return { ...project, renderBackend: { ...project.renderBackend, video: choices.video },
    modelId: choices.video.modelId || project.modelId,
    modelOverrides: { ...project.modelOverrides, treatment: choices.treatment, plan: choices.plan,
      ...(choices.evaluation.type === 'api' ? { evaluation: choices.evaluation } : {}) } };
}

async function resolveChoices(project) {
  project = { ...project, videoExecution: null };
  const { getSettings } = await import('../settings.js');
  const { resolveVideoBackendPin } = await import('../videoGen/backendPin.js');
  const { getStageAssignment } = await import('./agentBridge.js');
  const { resolveAgentProviderAndModel } = await import('../agentProviderResolution.js');
  const { resolveVisionEvalTarget } = await import('./sceneEvaluator.js');
  const settings = await getSettings();
  const pin = resolveVideoBackendPin(project, settings);
  const { hasConfiguredMediaRoute } = await import('../federatedMedia/defaultRouting.js');
  if (await hasConfiguredMediaRoute('video')) throw new ServerError('A standing video route would change the reviewed backend. Disable it in Settings before Start.', { status: 409, code: 'VIDEO_ROUTE_CHANGED' });
  const video = { mode: pin.mode, modelId: pin.modelId || (pin.mode === 'local' ? project.modelId : null) || null };
  if (pin.mode === 'reactor') {
    const { REACTOR_MODEL_ID } = await import('../videoGen/reactor.js');
    video.modelDescription = REACTOR_MODEL_ID;
  }
  if (pin.mode === 'fal' && !pin.modelId) {
    const { FAL_DEFAULT_TEXT_MODEL, FAL_DEFAULT_IMAGE_MODEL } = await import('../videoGen/fal.js');
    video.modelDescription = `${FAL_DEFAULT_TEXT_MODEL} (text) / ${FAL_DEFAULT_IMAGE_MODEL} (image)`;
  }
  if (pin.mode === 'local') {
    const { hasConfiguredMediaRoute } = await import('../federatedMedia/defaultRouting.js');
    // A strict local choice must not silently become a different peer/backend.
    if (await hasConfiguredMediaRoute('video')) throw new ServerError('This install routes video to a peer. Disable the standing video route or use a production backend that is configured locally before Start.', { status: 409, code: 'VIDEO_ROUTE_CHANGED' });
    if (!settings.imageGen?.local?.pythonPath) throw new ServerError('Configure the local video runtime in Settings, or select a cloud backend.', { status: 409, code: 'VIDEO_BACKEND_UNAVAILABLE' });
    const { resolveVideoModelSelection } = await import('../videoGen/modelSelection.js');
    const { isHardwareCompatible, hardwareUnavailableReason } = await import('../../lib/systemCapabilities.js');
    const selected = await resolveVideoModelSelection(video.modelId || undefined);
    if (!selected.model) throw new ServerError('Select an installed local video model in Settings.', { status: 409, code: 'VIDEO_BACKEND_UNAVAILABLE' });
    if (!isHardwareCompatible(selected.model.hardwareCompatibility)) throw new ServerError(hardwareUnavailableReason('Selected video model', selected.model.hardwareCompatibility), { status: 409, code: 'MODEL_HARDWARE_UNAVAILABLE' });
    video.modelId = selected.modelId;
  }
  const agentChoice = async kind => {
    const assignment = await getStageAssignment(kind, project);
    const resolved = await resolveAgentProviderAndModel({ description: 'Video production planning', metadata: assignment });
    if (!resolved.ok || (assignment.providerId && assignment.providerId !== resolved.provider?.id)) {
      throw new ServerError(resolved.error || `The selected ${kind} provider is unavailable. Change Models or Settings before Start.`, { status: 409, code: 'VIDEO_AGENT_UNAVAILABLE' });
    }
    return { type: 'agent', providerId: resolved.provider.id, model: resolved.selectedModel, ...(assignment.effort ? { effort: assignment.effort } : {}) };
  };
  const treatment = await agentChoice('treatment');
  const plan = await agentChoice('plan');
  const vision = await resolveVisionEvalTarget(project);
  const explicitEval = project.modelOverrides?.evaluation?.providerId || settings.creativeDirector?.evaluation?.providerId;
  if (explicitEval && vision?.provider.id !== explicitEval) throw new ServerError('The selected evaluation provider is unavailable. Change Models or Settings before Start.', { status: 409, code: 'VIDEO_AGENT_UNAVAILABLE' });
  const evaluation = vision ? { type: 'api', providerId: vision.provider.id, model: vision.model || vision.provider.defaultModel || null } : await agentChoice('evaluate');
  const { resolveVideoAudioChoice } = await import('./videoAudio.js');
  const audio = await resolveVideoAudioChoice(project);
  return { video, treatment, plan, evaluation, audio, costEstimateUsd: null };
}

export async function getVideoExecutionPreview(projectId) {
  const { getProject } = await import('./local.js');
  const { getInstanceId } = await import('../instances.js');
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const owner = await getInstanceId();
  const canStart = project.workspace === 'video' && !project.videoReplica && project.videoOwnerInstanceId === owner;
  const blockers = [];
  if (!canStart) blockers.push('Start is available only on the owning install.');
  if (!project.userStory?.trim()) blockers.push('Add a production brief before Start.');
  const choices = canStart ? await resolveChoices(project).catch(error => { blockers.push(error.message); return null; }) : null;
  const { assertVideoSourcesAvailable } = await import('./videoSources.js');
  if (canStart) await assertVideoSourcesAvailable(project).catch(error => blockers.push(error.message));
  let execution = project.videoExecution || null;
  if (execution?.blocker) {
    const { isAudioDisabledBackendBlocker, videoAudioIsDisabled } = await import('./videoAudio.js');
    // A failed render can leave its blocker persisted after the operator edits
    // the draft back to native audio. Do not keep showing an error that the
    // current Video contract cannot produce; a new Start/Resume clears it.
    if (project.workspace === 'video'
      && isAudioDisabledBackendBlocker(execution.blocker)
      && !videoAudioIsDisabled(project, { includeExecution: false })) {
      execution = { ...execution, blocker: null };
    }
  }
  return { canStart: canStart && blockers.length === 0, blockers, choices,
    inputRevision: videoConfigurationRevision(project),
    configurationRevision: canonicalSnapshotChecksum({ input: videoConfigurationRevision(project), choices }),
    limits: creativeDirectorVideoLimitsSchema.parse(project.videoExecution?.limits || {}),
    execution,
    costNotice: 'Provider prices and balances are unknown. Clip and agent-call limits are enforced; a dollar cap blocks calls whose price cannot be bounded.' };
}

async function ownedMutation(projectId, mutate) {
  const { mutateVideoProject } = await import('./local.js');
  const { getInstanceId } = await import('../instances.js');
  const owner = await getInstanceId();
  return mutateVideoProject(projectId, project => { assertVideoOwner(project, owner); return mutate(project); });
}

export async function pauseVideoExecution(projectId, reason, { invalidate = false } = {}) {
  return ownedMutation(projectId, project => ({ project: { ...project, status: 'paused', failureReason: reason || null,
    ...(invalidate ? { videoWorkRevision: (project.videoWorkRevision || 0) + 1,
      treatment: project.treatment ? { ...project.treatment, scenes: project.treatment.scenes.map(scene => ({ ...scene, workRevision: (scene.workRevision || 0) + 1 })) } : project.treatment } : {}),
    videoExecution: { ...project.videoExecution, ...(invalidate ? { authorized: false } : {}), blocker: reason || null }, updatedAt: now(),
  }, result: true }));
}

/** Reload queue receipts before deciding whether an explicit resume may submit. No provider call. */
export async function reconcileVideoExecution(projectId, { restarting = false, retryAttemptIds = [] } = {}) {
  const { listJobs } = await import('../mediaJobQueue/index.js');
  const jobs = listJobs();
  const { getProject } = await import('./local.js');
  const snapshot = await getProject(projectId);
  const tasks = new Map();
  if (!restarting) {
    const liveAgents = (snapshot?.videoExecution?.attempts || []).filter(attempt => !isMediaAttempt(attempt) && LIVE_ATTEMPTS.has(attempt.status) && attempt.taskId);
    if (liveAgents.length) {
      const { getTaskById } = await import('../cos.js');
      for (const attempt of liveAgents) tasks.set(attempt.taskId, await getTaskById(attempt.taskId));
    }
  }
  return ownedMutation(projectId, project => {
    const attempts = (project.videoExecution?.attempts || []).map(attempt => {
      if (!LIVE_ATTEMPTS.has(attempt.status)) return attempt;
      if (!isMediaAttempt(attempt)) return restarting || (attempt.taskId && (!tasks.get(attempt.taskId) || ['blocked', 'completed', 'failed'].includes(tasks.get(attempt.taskId).status))) ? { ...attempt, status: 'failed' } : attempt;
      const job = jobs.find(job => job.id === attempt.jobId || job.params?.videoProduction?.attemptId === attempt.id);
      if (job?.status === 'completed') return { ...attempt, jobId: job.id, status: 'completed' };
      if (job?.status === 'queued' || job?.status === 'running') return { ...attempt, jobId: job.id, status: job.status };
      const uncertain = !job || job.params?.videoProduction?.submissionUncertain === true
        || (job.params?.videoProduction?.submissionUncertain !== false && /interrupted|restart|timeout|timed out/i.test(job.error || ''));
      if (uncertain && !retryAttemptIds.includes(attempt.id)) return { ...attempt, jobId: job?.id || attempt.jobId, status: 'uncertain' };
      return { ...attempt, status: 'failed', explicitlyRetriedAt: retryAttemptIds.includes(attempt.id) ? now() : undefined };
    });
    const retiredTaskIds = new Set(attempts.filter(attempt => !isMediaAttempt(attempt) && attempt.status === 'failed').map(attempt => attempt.taskId).filter(Boolean));
    const runs = (project.runs || []).map(run => retiredTaskIds.has(run.taskId) && run.status === 'running' ? { ...run, status: 'failed', failureReason: 'Provider task ended before resume' } : run);
    const scenes = project.treatment?.scenes?.map(scene => {
      const receipt = [...attempts].reverse().find(attempt => attempt.sceneId === scene.sceneId && attempt.workRevision === (scene.workRevision || 0) && attempt.kind === 'clip');
      if (!receipt && scene.status === 'rendering' && !scene.renderedJobId) return { ...scene, status: 'pending' };
      if (receipt?.status === 'completed' && receipt.jobId && !['accepted', 'evaluating'].includes(scene.status)) return { ...scene, renderedJobId: receipt.jobId, status: 'evaluating' };
      if (receipt?.status === 'failed' && ['rendering', 'failed'].includes(scene.status)) return { ...scene, status: 'pending', renderedJobId: null, evaluation: null };
      return scene;
    });
    const steps = project.plan?.steps?.map(step => {
      const receipt = [...attempts].reverse().find(attempt => attempt.stepId === step.stepId && attempt.productionRevision === (project.videoWorkRevision || 0));
      if (receipt?.status === 'completed' && receipt.jobId) return { ...step, status: 'done', result: { jobId: receipt.jobId } };
      if (receipt?.status === 'failed' && ['running', 'failed', 'blocked'].includes(step.status)) return { ...step, status: 'pending' };
      return step;
    });
    const blocked = attempts.some(attempt => attempt.status === 'uncertain');
    return { project: { ...project, runs, ...(steps ? { plan: { ...project.plan, steps } } : {}), ...(scenes ? { treatment: { ...project.treatment, scenes } } : {}),
      ...(restarting || blocked ? { status: 'paused' } : {}),
      videoExecution: { ...project.videoExecution, attempts,
        ...(restarting ? { authorized: false } : {}),
        blocker: blocked ? 'A previous submission is uncertain. Reconcile its job or explicitly authorize retry; it may charge again.' : restarting ? 'Restart paused production. Review the saved jobs and Resume to continue.' : null,
      }, updatedAt: now() }, result: { uncertain: blocked, live: attempts.some(attempt => ['queued', 'running', 'submitting'].includes(attempt.status)) } };
  });
}

export async function startVideoExecution(projectId, input) {
  const preview = await getVideoExecutionPreview(projectId);
  if (preview.configurationRevision !== input.configurationRevision) throw new ServerError('Production choices changed. Refresh before Start.', { status: 409, code: 'VIDEO_START_STALE' });
  if (!preview.canStart) throw new ServerError(preview.blockers.join(' '), { status: 409, code: 'VIDEO_START_BLOCKED' });
  const limits = creativeDirectorVideoLimitsSchema.parse(input.limits);
  if (limits.spendCapUsd !== null && preview.choices.costEstimateUsd === null) throw new ServerError('This provider has no enforceable dollar estimate. Remove the dollar cap to use clip/call bounds, or choose a provider with bounded pricing.', { status: 409, code: 'VIDEO_COST_UNKNOWN' });
  const reconciled = await reconcileVideoExecution(projectId, { retryAttemptIds: input.retryAttemptIds });
  if (reconciled.result.uncertain) throw new ServerError(reconciled.project.videoExecution.blocker, { status: 409, code: 'VIDEO_SUBMISSION_UNCERTAIN' });
  const { project, result } = await ownedMutation(projectId, current => {
    if (current.videoExecution?.authorized && ACTIVE.has(current.status)) return { project: current, result: false, skipPersist: true };
    if (videoConfigurationRevision(current) !== preview.inputRevision) throw new ServerError('Production changed during Start. Refresh and try again.', { status: 409, code: 'VIDEO_START_STALE' });
    const execution = current.videoExecution || {};
    return { project: { ...current, status: current.treatment ? 'rendering' : 'planning', failureReason: null,
      // Resume retries terminal failures while preserving attempt receipts and
      // counters, so changing limits never erases previously consumed budget.
      ...(current.treatment ? { treatment: { ...current.treatment, scenes: (current.treatment.scenes || []).map(scene =>
        scene.status === 'failed' ? { ...scene, status: 'pending', renderedJobId: null, evaluation: null } : scene) } } : {}),
      videoExecution: { ...execution, id: execution.id || randomUUID(), authorized: true, authorizedAt: now(),
        inputRevision: videoConfigurationRevision(current), configurationRevision: input.configurationRevision,
        choices: preview.choices, limits, attempts: execution.attempts || [], blocker: null }, updatedAt: now(),
    }, result: true };
  });
  if (result) {
    const { startCreativeDirectorProject } = await import('./completionHook.js');
    startCreativeDirectorProject(projectId).catch(error => pauseVideoExecution(projectId, error.message).catch(() => {}));
  }
  return project;
}

export async function reserveVideoAttempt(projectId, details) {
  const { result } = await ownedMutation(projectId, project => {
    const execution = project.videoExecution;
    if (!execution?.authorized || !ACTIVE.has(project.status)) return { project, result: null, skipPersist: true };
    if (details.expectedProductionRevision !== undefined && details.expectedProductionRevision !== (project.videoWorkRevision || 0)) return { project, result: null, skipPersist: true };
    if (details.sceneId && details.workRevision !== undefined && details.workRevision !== (project.treatment?.scenes?.find(scene => scene.sceneId === details.sceneId)?.workRevision || 0)) return { project, result: null, skipPersist: true };
    const attempts = execution.attempts || [];
    let blocker = null;
    if (execution.inputRevision !== videoConfigurationRevision(project)) blocker = 'Production settings changed. Review the new choices and Resume.';
    if (attempts.some(attempt => LIVE_ATTEMPTS.has(attempt.status) && attempt.key === details.key)) return { project, result: null, skipPersist: true };
    const limits = execution.limits;
    const isClip = details.kind === 'clip';
    const isAudio = details.kind === 'audio';
    const sameKey = attempts.filter(attempt => attempt.key === details.key);
    if (isClip && attempts.filter(attempt => attempt.kind === 'clip').length >= limits.maxClips) blocker = 'The clip limit is exhausted. Review limits before Resume.';
    if (isClip && sameKey.length > limits.maxRetries) blocker = 'The retry limit for this shot is exhausted. Review limits before Resume.';
    if (!isClip && !isAudio && attempts.filter(attempt => !isMediaAttempt(attempt)).length >= limits.maxAgentCalls) blocker = 'The agent-call limit is exhausted. Review limits before Resume.';
    if (isAudio && (attempts.filter(attempt => attempt.kind === 'audio').length >= (limits.maxAudioJobs ?? 1) || sameKey.length > limits.maxRetries)) blocker = 'The audio job limit is exhausted. Review limits before Resume.';
    if (details.kind === 'plan' && attempts.filter(attempt => attempt.kind === 'plan').length > limits.maxReplans) blocker = 'The replan limit is exhausted. Review limits before Resume.';
    if (limits.spendCapUsd !== null) blocker = 'The next call has unknown cost and cannot fit an enforceable dollar cap.';
    if (blocker) return { project: { ...project, status: 'paused', failureReason: blocker, videoExecution: { ...execution, blocker }, updatedAt: now() }, result: null };
    const attempt = { ...details, id: randomUUID(), executionId: execution.id, productionRevision: project.videoWorkRevision || 0, status: 'submitting', at: now() };
    return { project: { ...project, videoExecution: { ...execution, attempts: [...attempts, attempt] }, updatedAt: now() }, result: attempt };
  });
  return result;
}

export async function settleVideoAttempt(projectId, attemptId, patch) {
  return ownedMutation(projectId, project => ({ project: { ...project,
    videoExecution: { ...project.videoExecution, attempts: (project.videoExecution?.attempts || []).map(attempt => attempt.id === attemptId ? { ...attempt, ...patch, status: (patch.status === 'queued' && ['running', 'completed', 'failed', 'canceled'].includes(attempt.status)) || (attempt.status === 'completed' && patch.status !== 'completed') ? attempt.status : patch.status || attempt.status } : attempt) }, updatedAt: now(),
  }, result: true }));
}

/** Checked at the worker boundary, after the queue wait and immediately before provider work. */
export async function assertVideoAttemptDispatch(projectId, attemptId, { jobId } = {}) {
  const { getProject } = await import('./local.js');
  const { getInstanceId } = await import('../instances.js');
  const project = await getProject(projectId);
  assertVideoOwner(project, await getInstanceId());
  const execution = project.videoExecution;
  const attempt = execution?.attempts?.find(value => value.id === attemptId);
  if (!execution?.authorized || !ACTIVE.has(project.status) || !attempt || !LIVE_ATTEMPTS.has(attempt.status)
      || execution.inputRevision !== videoConfigurationRevision(project) || attempt.productionRevision !== (project.videoWorkRevision || 0)) throw new ServerError('Video production is paused or changed. Review and Resume before dispatch.', { status: 409, code: 'VIDEO_DISPATCH_BLOCKED' });
  const { assertVideoSourcesAvailable } = await import('./videoSources.js');
  await assertVideoSourcesAvailable(project);
  const effective = effectiveVideoProject(project);
  const { getSettings } = await import('../settings.js');
  const { resolveVideoBackendPin } = await import('../videoGen/backendPin.js');
  resolveVideoBackendPin(effective, await getSettings());
  if (attempt.kind === 'audio') {
    const { resolveVideoAudioChoice } = await import('./videoAudio.js');
    await resolveVideoAudioChoice({ ...project, videoDraft: { ...project.videoDraft, audio: execution.choices.audio } });
  }
  const { hasConfiguredMediaRoute } = await import('../federatedMedia/defaultRouting.js');
  if (await hasConfiguredMediaRoute('video')) throw new ServerError('The standing video route changed the reviewed backend. Review Settings and Resume.', { status: 409, code: 'VIDEO_ROUTE_CHANGED' });
  {
    await ownedMutation(projectId, current => {
      const receipt = current.videoExecution?.attempts?.find(value => value.id === attemptId);
      if (!current.videoExecution?.authorized || !ACTIVE.has(current.status) || !receipt || !LIVE_ATTEMPTS.has(receipt.status)
          || (jobId && receipt.jobId && receipt.jobId !== jobId) || receipt.productionRevision !== (current.videoWorkRevision || 0)
          || current.videoExecution.inputRevision !== videoConfigurationRevision(current)
          || (receipt.sceneId && receipt.workRevision !== undefined && receipt.workRevision !== (current.treatment?.scenes?.find(scene => scene.sceneId === receipt.sceneId)?.workRevision || 0))) {
        throw new ServerError('This queue job has no current Video authorization. Resume through the production.', { status: 409, code: 'VIDEO_DISPATCH_BLOCKED' });
      }
      if (!jobId) return { project: current, result: true, skipPersist: true };
      return { project: { ...current, videoExecution: { ...current.videoExecution, attempts: current.videoExecution.attempts.map(value => value.id === attemptId ? { ...value, jobId, status: 'running' } : value) } }, result: true };
    });
  }
  return effective;
}

export async function enqueueVideoProductionJob(project, { kind = 'video', params, sceneId, stepId, workRevision }) {
  if (kind !== 'video') throw new ServerError('Video plans currently render bounded video clips. Use attached references and the saved audio choice for other media.', { status: 409, code: 'VIDEO_PLAN_TOOL_UNSUPPORTED' });
  const seconds = Number(params.mode === 'reactor' ? params.seconds
    : ['fal', 'grok'].includes(params.mode) ? params.duration
    : params.numFrames / params.fps);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10.1 || Number(params.chunks || 1) !== 1 || Number(params.batchSize || 1) !== 1) {
    throw new ServerError('A Video submission must contain one clip of at most 10 seconds.', { status: 409, code: 'VIDEO_PLAN_CLIP_BOUNDS' });
  }
  const { validateVideoShot } = await import('../../lib/creativeDirectorVideoCompiler.js');
  validateVideoShot(project, { sceneId: sceneId || stepId, prompt: String(params.prompt || ''), durationSeconds: seconds }, false);
  const { hasConfiguredMediaRoute, enqueueUnattendedMediaJob } = await import('../federatedMedia/defaultRouting.js');
  if (await hasConfiguredMediaRoute(kind)) throw new ServerError('A standing peer route would change the reviewed video backend. Change Settings before Resume.', { status: 409, code: 'VIDEO_ROUTE_CHANGED' });
  const attempt = await reserveVideoAttempt(project.id, { kind: 'clip', key: sceneId ? `scene:${sceneId}` : `step:${stepId}`, sceneId, stepId, workRevision, expectedProductionRevision: project.videoWorkRevision || 0 });
  if (!attempt) return null;
  const marker = { projectId: project.id, attemptId: attempt.id, executionId: attempt.executionId };
  try {
    await assertVideoAttemptDispatch(project.id, attempt.id);
    const result = await enqueueUnattendedMediaJob({ kind, params: { ...params, videoProduction: marker },
      owner: sceneId ? `cd:${project.id}:${sceneId}` : `creative-director:${project.id}` });
    await settleVideoAttempt(project.id, attempt.id, { status: 'queued', jobId: result.jobId });
    return { ...result, attemptId: attempt.id };
  } catch (error) {
    const uncertain = error.code !== 'VIDEO_DISPATCH_BLOCKED';
    await settleVideoAttempt(project.id, attempt.id, { status: uncertain ? 'uncertain' : 'failed' });
    await pauseVideoExecution(project.id, uncertain ? 'Submission could not be confirmed. Reconcile the queue or explicitly authorize retry; it may charge again.' : error.message);
    throw new ServerError(error.message, { status: 409, code: uncertain ? 'VIDEO_SUBMISSION_UNCERTAIN' : error.code });
  }
}
