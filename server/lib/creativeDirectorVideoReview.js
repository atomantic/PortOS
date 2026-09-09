import { canonicalSnapshotChecksum } from './snapshotChecksum.js';
import { ServerError } from './errorHandler.js';

import { VIDEO_REVIEW_CHECKPOINTS } from './creativeDirectorPresets.js';

export const VIDEO_REVIEW_STAGES = VIDEO_REVIEW_CHECKPOINTS;
const LABELS = ['Script and shot plan', 'References', 'Rough cut', 'Final cut'];
const fingerprint = value => canonicalSnapshotChecksum(value);

/** Creative inputs only: runtime status/evaluation changes cannot stale script approval. */
export function videoSceneInputs(scene) {
  return Object.fromEntries(['sceneId', 'order', 'durationSeconds', 'intent', 'prompt', 'negativePrompt',
    'sourceImageFile', 'imageStrength', 'useContinuationFromPrior', 'cast'].map(key => [key, scene?.[key] ?? null]));
}

export function assertVideoOwner(project, instanceId) {
  if (project?.workspace !== 'video') throw new ServerError('Review requires a Video production', { status: 400, code: 'INVALID_STATE' });
  if (project.videoReplica || !instanceId || !project.videoOwnerInstanceId || project.videoOwnerInstanceId !== instanceId) {
    throw new ServerError('Only the owning install can approve or run this production. Open it there, or create a new local draft from its settings.', { status: 409, code: 'VIDEO_OWNER_REQUIRED' });
  }
}

/** Derive the displayed checkpoints from durable artifacts and recorded decisions. */
export function videoReviewStages(project) {
  if (project?.workspace !== 'video') return [];
  const review = project.videoReview || {};
  const scenes = [...(project.treatment?.scenes || [])].sort((a, b) => a.order - b.order);
  const scriptData = {
    script: project.treatment?.script, artifactRevision: project.treatment?.artifact?.revision,
    scenes: scenes.map(videoSceneInputs),
    steps: (project.plan?.steps || []).map(({ stepId, toolName, args, dependsOn }) => ({ stepId, toolName, args, dependsOn })),
    brief: project.userStory, style: project.styleSpec, cast: project.cast,
    target: project.targetDurationSeconds, aspect: project.aspectRatio, quality: project.quality,
    backend: project.renderBackend, model: project.modelId, modelOverrides: project.modelOverrides,
    audio: project.videoDraft?.audio, sources: project.videoDraft?.sources,
  };
  const hasScript = Boolean(project.treatment?.artifact && !project.treatment.artifact.stale);
  const hasReferences = Boolean(project.videoDraft?.sources?.length || project.startingImageFile || scenes.some(s => s.sourceImageFile));
  const ready = [hasScript, hasScript, Boolean(project.videoRoughCut?.videoId), Boolean(project.videoFinalCut?.videoId)];
  const data = [scriptData, {
    context: project.videoPlanningContext, references: project.treatment?.artifact?.references,
    startingImageFile: project.startingImageFile, frames: scenes.map(s => [s.sceneId, s.sourceImageFile]),
  }, project.videoRoughCut || null, project.videoFinalCut || null];
  let priorRevision = null;
  return VIDEO_REVIEW_STAGES.map((stage, index) => {
    const revision = fingerprint({ priorRevision, data: data[index], request: review.revisions?.[stage] || 0 });
    priorRevision = revision;
    const skipReason = stage === 'references' && !hasReferences ? 'No attached references'
      : project.videoDraft?.reviewPolicy === 'autonomous' ? 'Autonomous production policy'
      : !(project.videoDraft?.checkpoints || VIDEO_REVIEW_STAGES).includes(stage) ? 'Checkpoint disabled in the saved policy' : null;
    const decision = review.decisions?.[stage];
    const currentDecision = decision?.revision === revision ? decision : null;
    const status = !ready[index] ? 'not-ready' : skipReason ? 'skipped'
      : currentDecision?.action === 'approve' ? 'approved' : 'awaiting-review';
    return { stage, label: LABELS[index], revision, status, ready: ready[index], skipReason,
      stale: Boolean(decision && !currentDecision), decision: currentDecision || null };
  });
}

/** Preserve rendered cuts when an edit invalidates their approvals. */
export function retainVideoCuts(project) {
  const cuts = [...(project.videoCutHistory || [])];
  for (const cut of [project.videoRoughCut, project.videoFinalCut]) {
    if (cut?.videoId && !cuts.some(row => row.videoId === cut.videoId)) cuts.push(cut);
  }
  return cuts;
}

/** One atomic owner action; feedback never changes authorization or artifact readiness. */
export function applyVideoReviewAction(project, input, instanceId, now = new Date().toISOString()) {
  assertVideoOwner(project, instanceId);
  const checkpoint = videoReviewStages(project).find(row => row.stage === input.stage);
  if (!checkpoint || checkpoint.revision !== input.revision) {
    throw new ServerError('This artifact changed. Refresh and review its current revision.', { status: 409, code: 'VIDEO_REVIEW_STALE' });
  }
  if (!checkpoint.ready) throw new ServerError('This checkpoint has no current artifact to review yet.', { status: 409, code: 'VIDEO_REVIEW_NOT_READY' });
  const review = project.videoReview || {};
  const existing = review.decisions?.[input.stage];
  if (input.action === 'approve' && existing?.action === 'approve' && existing.revision === input.revision) return { project, changed: false };
  const entry = { action: input.action, stage: input.stage, revision: input.revision, at: now,
    ...(input.note ? { note: input.note } : {}), ...(input.sceneId ? { sceneId: input.sceneId } : {}),
    ...(input.stepId ? { stepId: input.stepId } : {}), ...(input.rating ? { rating: input.rating } : {}) };
  if (input.action === 'feedback') {
    return { project: { ...project, videoReview: { ...review, feedback: [...(review.feedback || []), entry].slice(-200) }, updatedAt: now }, changed: true };
  }
  if (input.action === 'approve') {
    return { project: { ...project, videoReview: { ...review,
      decisions: { ...review.decisions, [input.stage]: entry }, waitingFor: null }, updatedAt: now }, changed: true };
  }
  const index = VIDEO_REVIEW_STAGES.indexOf(input.stage);
  const decisions = { ...review.decisions };
  for (const stage of VIDEO_REVIEW_STAGES.slice(index)) delete decisions[stage];
  let treatment = project.treatment;
  let plan = project.plan;
  if (!input.sceneId && !input.stepId && treatment) {
    const { history = [], ...snapshot } = treatment;
    treatment = { ...treatment, history: [...history, structuredClone(snapshot)],
      scenes: (treatment.scenes || []).map(scene => ({ ...scene,
        workRevision: (scene.workRevision || 0) + 1,
        ...(['rendering', 'evaluating'].includes(scene.status) ? { status: 'pending', renderedJobId: null, evaluation: null } : {}),
      })) };
  }
  if (input.sceneId) {
    const ordered = [...(treatment?.scenes || [])].sort((a, b) => a.order - b.order);
    const start = ordered.findIndex(s => s.sceneId === input.sceneId);
    if (start < 0) throw new ServerError('Shot not found', { status: 404, code: 'NOT_FOUND' });
    const affected = new Set([input.sceneId]);
    for (let i = start + 1; i < ordered.length && ordered[i].useContinuationFromPrior; i++) affected.add(ordered[i].sceneId);
    const { history = [], ...snapshot } = treatment;
    treatment = { ...treatment, history: [...history, structuredClone(snapshot)], scenes: treatment.scenes.map(scene => affected.has(scene.sceneId)
      ? { ...scene, status: 'pending', renderedJobId: null, evaluation: null, retryCount: 0, workRevision: (scene.workRevision || 0) + 1 }
      : scene) };
  }
  if (input.stepId) {
    if (!plan?.steps?.some(step => step.stepId === input.stepId)) throw new ServerError('Plan step not found', { status: 404, code: 'NOT_FOUND' });
    const affected = new Set([input.stepId]);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const step of plan.steps) if (!affected.has(step.stepId) && step.dependsOn?.some(id => affected.has(id))) { affected.add(step.stepId); expanded = true; }
    }
    plan = { ...plan, history: [...(plan.history || []), { steps: structuredClone(plan.steps), updatedAt: plan.updatedAt }],
      steps: plan.steps.map(step => affected.has(step.stepId) ? { ...step, status: 'pending', result: null, workRevision: (step.workRevision || 0) + 1 } : step) };
  }
  if (input.stage === 'script-shot-plan' && treatment?.artifact) {
    treatment = { ...treatment, artifact: { ...treatment.artifact, stale: true } };
  }
  return { project: { ...project, treatment, plan, status: 'paused', finalVideoId: null, videoCutHistory: retainVideoCuts(project),
    ...(index <= 2 ? { videoRoughCut: null } : {}), videoFinalCut: null,
    videoWorkRevision: (project.videoWorkRevision || 0) + 1,
    videoReview: { ...review, decisions, waitingFor: null,
      revisions: { ...review.revisions, [input.stage]: (review.revisions?.[input.stage] || 0) + 1 },
      revisionRequests: [...(review.revisionRequests || []), entry].slice(-100),
    }, updatedAt: now }, changed: true };
}
