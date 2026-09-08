/**
 * Pure Video treatment compilation and pinned-backend shot compatibility.
 * Shared by project mutations and execution preflight; no storage, dispatch,
 * approval, or revision-history mutation belongs here. Inputs have already
 * passed the treatment/plan schemas; this checks their cross-field contracts.
 */

import { ServerError } from './errorHandler.js';
import { GROK_VIDEO_DURATIONS } from './grokVideoClip.js';
import { REACTOR_MIN_CLIP_SECONDS, REACTOR_MAX_CLIP_SECONDS, REACTOR_MAX_PROMPT_LENGTH, REACTOR_ASPECTS } from './reactorVideoClip.js';

export function validateVideoShot(project, scene, isFirst) {
  const backend = project.renderBackend?.video?.mode;
  const unsupported = [];
  if (isFirst && scene.useContinuationFromPrior) unsupported.push('continuation without a prior shot');
  if (backend === 'grok' && !GROK_VIDEO_DURATIONS.includes(scene.durationSeconds)) {
    unsupported.push(`duration (choose ${GROK_VIDEO_DURATIONS.join(' or ')} seconds)`);
  }
  if (backend === 'reactor') {
    if (scene.durationSeconds < REACTOR_MIN_CLIP_SECONDS || scene.durationSeconds > REACTOR_MAX_CLIP_SECONDS) {
      unsupported.push(`duration (choose ${REACTOR_MIN_CLIP_SECONDS}–${REACTOR_MAX_CLIP_SECONDS} seconds)`);
    }
    if (scene.prompt.length > REACTOR_MAX_PROMPT_LENGTH) unsupported.push(`prompt (maximum ${REACTOR_MAX_PROMPT_LENGTH} characters)`);
    if (!REACTOR_ASPECTS.includes(project.aspectRatio)) unsupported.push('aspect ratio');
  }
  if (unsupported.length) {
    throw new ServerError(`Video shot ${scene.sceneId} has incompatible ${unsupported.join(', ')}. Revise the shot or choose a compatible backend.`, {
      status: 400, code: 'VIDEO_BACKEND_INPUT_UNSUPPORTED',
    });
  }
}

/** Compile the existing treatment into a persisted Video artifact, without dispatch. */
export function compileVideoArtifact(project, treatment, sourceRevisions) {
  if (!treatment.script) {
    throw new ServerError('Video treatments require a production script. Add script text and resubmit the treatment.', {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  const scenes = [...treatment.scenes].sort((a, b) => a.order - b.order);
  const ids = new Set();
  const orders = new Set();
  let elapsed = 0;
  const shots = scenes.map((scene) => {
    validateVideoShot(project, scene, elapsed === 0);
    if (ids.has(scene.sceneId) || orders.has(scene.order)) {
      throw new ServerError('Video scenes must have unique sceneId and order values', { status: 400, code: 'VALIDATION_ERROR' });
    }
    ids.add(scene.sceneId);
    orders.add(scene.order);
    const startSeconds = elapsed;
    elapsed = Math.round((elapsed + scene.durationSeconds) * 1000000) / 1000000;
    return {
      shotId: `shot-${scene.sceneId}`,
      sceneId: scene.sceneId,
      startSeconds,
      endSeconds: elapsed,
      durationSeconds: scene.durationSeconds,
    };
  });
  if (Math.abs(elapsed - project.targetDurationSeconds) > 0.000001) {
    throw new ServerError(`Video shots total ${elapsed}s; they must total the exact target of ${project.targetDurationSeconds}s`, { status: 400, code: 'VALIDATION_ERROR' });
  }
  const references = (project.videoPlanningContext?.references || project.videoDraft?.sources || []).map((source) => ({
    ...source, referenceId: `${source.kind}:${source.id}`,
    ...(sourceRevisions ? { sourceRevision: sourceRevisions[`${source.kind}:${source.id}`] ?? source.sourceRevision ?? null } : {}),
  }));
  if (new Set(references.map((ref) => ref.referenceId)).size !== references.length) {
    throw new ServerError('Video source references must have unique kind and id values', { status: 400, code: 'VALIDATION_ERROR' });
  }
  return {
    scriptId: project.treatment?.artifact?.scriptId || `script-${project.id}`,
    revision: (project.treatment?.artifact?.revision || 0) + 1,
    targetDurationSeconds: project.targetDurationSeconds,
    aspectRatio: project.aspectRatio,
    ...(project.videoPlanningContext ? { sourceContextRevision: project.videoPlanningContext.revision } : {}),
    // Keep the selected IDs/revisions, never copy or mutate creative-suite records.
    references,
    shots,
    stale: false,
  };
}

