/** Review and edit FableLoom episode teleplays through conversational feedback. */

import { ServerError } from '../../lib/errorHandler.js';
import { analyzeEpisodeGraph, describeGraphForPrompt } from '../../lib/fableLoomGraph.js';
import {
  FABLELOOM_CAMERA_MOVEMENT_VALUES,
  fableLoomCameraMovementCatalogForPrompt,
  normalizeFableLoomCameraMovement,
} from '../../lib/fableLoomCameraMovements.js';
import { isFableLoomPlaybackMode } from '../../lib/fableLoomPlayback.js';
import { LOOM_LIMITS, findEpisode, mutateLoom } from './records.js';
import { isStr, trimTo } from '../../lib/textUtils.js';
import { aiShapeError, requireLoom, runLoomAi } from './weaveShared.js';
import { buildCanonDigest, requiresAudienceIntroduction, storyContext } from './weaveContext.js';

const REVIEW_SEVERITIES = new Set(['high', 'medium', 'low']);

export async function reviewEpisode(loomId, episodeId, { providerId, model, effort, operationId } = {}) {
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const structural = analyzeEpisodeGraph(episode, {
    participationMode: loom.participationMode,
    requireAudienceIntroduction: requiresAudienceIntroduction(loom, episode),
  });
  const { content, runId } = await runLoomAi('fableloom-review', {
    storyContext: storyContext(loom, episode),
    graphDigest: describeGraphForPrompt(episode, { participationMode: loom.participationMode }),
    structuralDigest: structural.issues.length
      ? structural.issues.map((i) => `- [${i.severity}] ${i.message}`).join('\n')
      : '(no structural issues)',
  }, { providerId, model, effort, operationId }, {
    action: 'review-episode', label: 'Reviewing episode', source: 'fableloom-review',
  });

  const nodeIds = new Set(episode.nodes.map((n) => n.id));
  const findings = (Array.isArray(content?.findings) ? content.findings : [])
    .filter((f) => f && typeof f === 'object' && isStr(f.problem))
    .map((f) => ({
      severity: REVIEW_SEVERITIES.has(f.severity) ? f.severity : 'medium',
      nodeId: nodeIds.has(f.nodeId) ? f.nodeId : null,
      problem: trimTo(f.problem, 1000),
      suggestion: trimTo(f.suggestion, 1000),
    }));
  return {
    structural,
    review: { summary: trimTo(content?.summary, 2000), findings },
    runId,
  };
}

// --- Feedback: apply a conversational episode edit --------------------------

const FEEDBACK_NODE_FIELDS = [
  'title', 'prose', 'imagePrompt', 'videoPrompt', 'cameraMovement', 'playbackMode',
  'audienceConnection', 'isEnding', 'endingLabel',
];
const FEEDBACK_TRANSITION_FIELDS = ['targetNodeId', 'intent', 'triggers', 'description'];
const FEEDBACK_STRING_NODE_FIELDS = new Set(['title', 'prose', 'imagePrompt', 'videoPrompt', 'endingLabel']);

/**
 * Keep feedback edits sparse and graph-safe. The model may revise metadata,
 * scene content, and the labels/details of existing paths, but it cannot mint
 * or delete scene/transition records. This makes a conversational edit useful
 * without allowing a malformed response to silently change graph membership.
 */
const normalizeFeedbackPatch = (content, episode) => {
  if (!content || typeof content !== 'object') throw aiShapeError('The model returned no episode feedback edits');

  const episodePatch = {};
  for (const key of ['title', 'synopsis']) {
    if (Object.hasOwn(content, key) && typeof content[key] === 'string') episodePatch[key] = content[key];
  }

  const nodeIds = new Set(episode.nodes.map((node) => node.id));
  const scenePatches = [];
  for (const rawScene of Array.isArray(content.scenes) ? content.scenes : []) {
    if (!rawScene || typeof rawScene !== 'object' || !nodeIds.has(rawScene.id)) continue;
    const nodePatch = { id: rawScene.id };
    for (const key of FEEDBACK_NODE_FIELDS) {
      const value = rawScene[key];
      if (!Object.hasOwn(rawScene, key)) continue;
      if (FEEDBACK_STRING_NODE_FIELDS.has(key) && typeof value === 'string') {
        nodePatch[key] = value;
      } else if (key === 'cameraMovement' && typeof value === 'string') {
        const movement = normalizeFableLoomCameraMovement(value);
        if (!movement || FABLELOOM_CAMERA_MOVEMENT_VALUES.includes(movement)) nodePatch[key] = movement;
      } else if (key === 'playbackMode' && isFableLoomPlaybackMode(value)) {
        nodePatch[key] = value;
      } else if (key === 'audienceConnection' && ['connected', 'disconnected'].includes(value)) {
        nodePatch[key] = value;
      } else if (key === 'isEnding' && typeof value === 'boolean') {
        nodePatch[key] = value;
      }
    }

    const node = episode.nodes.find((candidate) => candidate.id === rawScene.id);
    const transitionIds = new Set((node.transitions || []).map((transition) => transition.id));
    const transitions = [];
    if (Object.hasOwn(rawScene, 'transitions') && Array.isArray(rawScene.transitions)) {
      for (const rawTransition of rawScene.transitions) {
        if (!rawTransition || typeof rawTransition !== 'object' || !transitionIds.has(rawTransition.id)) continue;
        const transitionPatch = { id: rawTransition.id };
        for (const key of FEEDBACK_TRANSITION_FIELDS) {
          const value = rawTransition[key];
          if (!Object.hasOwn(rawTransition, key)) continue;
          if (key === 'targetNodeId' && typeof value === 'string' && nodeIds.has(value)) transitionPatch[key] = value;
          if (key === 'intent' && typeof value === 'string') transitionPatch[key] = value;
          if (key === 'description' && typeof value === 'string') transitionPatch[key] = value;
          if (key === 'triggers' && Array.isArray(value)) transitionPatch[key] = value;
        }
        if (Object.keys(transitionPatch).length > 1) transitions.push(transitionPatch);
      }
    }
    if (transitions.length) nodePatch.transitions = transitions;
    if (Object.keys(nodePatch).length > 1) scenePatches.push(nodePatch);
  }

  if (!Object.keys(episodePatch).length && !scenePatches.length) {
    throw aiShapeError('The model returned no usable episode feedback edits');
  }
  return { episodePatch, scenePatches };
};

/**
 * Apply one natural-language author instruction to an existing episode. The
 * prompt asks for sparse edits, so omitted fields preserve their authored
 * values while present empty strings intentionally clear them. The graph's
 * scene and path membership stays stable; use the scene/branch controls when
 * records need to be added or removed.
 */
export async function feedbackEpisode(loomId, episodeId, {
  feedback, providerId, model, effort, operationId,
} = {}) {
  const instruction = trimTo(feedback, LOOM_LIMITS.FEEDBACK_MAX);
  if (!instruction) {
    throw new ServerError('Episode feedback is required', { status: 400, code: 'FEEDBACK_REQUIRED' });
  }
  const loom = await requireLoom(loomId);
  const episode = findEpisode(loom, episodeId);
  const canonDigest = await buildCanonDigest(loom);
  const { content, runId } = await runLoomAi('fableloom-feedback-episode', {
    storyContext: storyContext(loom, episode),
    canonDigest: canonDigest || '(none)',
    graphDigest: describeGraphForPrompt(episode, {
      proseLimit: 1200,
      participationMode: loom.participationMode,
    }),
    cameraMovementCatalog: fableLoomCameraMovementCatalogForPrompt(),
    feedback: instruction,
  }, { providerId, model, effort, operationId }, {
    action: 'feedback-episode', label: 'Updating episode', source: 'fableloom-feedback',
  });

  const { episodePatch, scenePatches } = normalizeFeedbackPatch(content, episode);
  const updated = await mutateLoom(loomId, (current) => {
    const currentEpisode = findEpisode(current, episodeId);
    for (const key of ['title', 'synopsis']) {
      if (Object.hasOwn(episodePatch, key)) currentEpisode[key] = episodePatch[key];
    }
    for (const scenePatch of scenePatches) {
      const node = currentEpisode.nodes.find((candidate) => candidate.id === scenePatch.id);
      if (!node) continue;
      for (const key of FEEDBACK_NODE_FIELDS) {
        if (Object.hasOwn(scenePatch, key)) node[key] = scenePatch[key];
      }
      for (const transitionPatch of scenePatch.transitions || []) {
        const transition = (node.transitions || []).find((candidate) => candidate.id === transitionPatch.id);
        if (!transition) continue;
        for (const key of FEEDBACK_TRANSITION_FIELDS) {
          if (Object.hasOwn(transitionPatch, key)) transition[key] = transitionPatch[key];
        }
      }
    }
    currentEpisode.updatedAt = new Date().toISOString();
    return current;
  });
  return {
    loom: updated,
    episodeId,
    changedScenes: scenePatches.length,
    runId,
  };
}
