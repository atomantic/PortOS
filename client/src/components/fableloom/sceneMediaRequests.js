/**
 * Shared FableLoom scene-media request builders.
 *
 * Both the graph-card buttons and the selected-scene editor queue through the
 * page owner. Keeping request composition here makes their image/video prompts
 * identical: the canonical universe/series style preset leads, the scene owns
 * the subject/action, and loom-local direction remains an explicit suffix.
 * Image generation also conditions on a rendered direct predecessor when one
 * exists, preserving visual continuity across adjacent graph shots.
 */

import { composeStyledPrompt } from '../../lib/composeStyledPrompt';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';

const withLoomStyle = (prompt, styleNotes) => {
  const notes = typeof styleNotes === 'string' ? styleNotes.trim() : '';
  return notes ? `${prompt}\n\nStyle: ${notes}` : prompt;
};

// Keep enough reference influence to carry likeness and environment forward
// without asking the model to preserve the prior shot's composition.
export const FABLELOOM_CONTINUITY_STRENGTH = 0.4;

/**
 * Resolve the still from a direct incoming graph neighbor. Storage order is
 * the deterministic tie-break at a convergence because a shared target node
 * has no active reader path while it is being authored. Self-loops never seed
 * themselves, and unrelated adjacent array entries are not "prior" shots.
 */
export function findFableLoomPriorImage(episode, nodeId) {
  const nodes = Array.isArray(episode?.nodes) ? episode.nodes : [];
  if (!nodeId || episode?.startNodeId === nodeId) return null;
  const predecessor = nodes.find((candidate) => (
    candidate?.id !== nodeId
    && typeof candidate?.image === 'string'
    && candidate.image.trim()
    && Array.isArray(candidate.transitions)
    && candidate.transitions.some((transition) => transition?.targetNodeId === nodeId)
  ));
  return predecessor?.image.trim() || null;
}

export function buildFableLoomImageRequest({ loom, episode, episodeId, node, stylePreset = null }) {
  const authoredPrompt = withLoomStyle((node?.imagePrompt || '').trim(), loom?.styleNotes);
  const styled = composeStyledPrompt(authoredPrompt, '', stylePreset);
  const priorImage = findFableLoomPriorImage(episode, node?.id);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    ...(priorImage ? {
      referenceImageFiles: [priorImage],
      referenceStrengths: [FABLELOOM_CONTINUITY_STRENGTH],
    } : {}),
    fableLoom: { loomId: loom.id, episodeId, nodeId: node.id },
  };
}

export function buildFableLoomVideoRequest({ loom, episodeId, node, stylePreset = null }) {
  const authoredPrompt = (node?.videoPrompt || '').trim() || (node?.prose || '').trim();
  const movement = FABLELOOM_CAMERA_MOVEMENTS.find((move) => move.value === node?.cameraMovement);
  const direction = movement?.prompt || (node?.cameraMovement || '').trim();
  const directedPrompt = direction
    ? `${authoredPrompt}\n\nCamera direction: ${direction}`
    : authoredPrompt;
  const styled = composeStyledPrompt(withLoomStyle(directedPrompt, loom?.styleNotes), '', stylePreset);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    backend: 'local',
    mode: node?.image ? 'image' : 'text',
    ...(node?.image ? { sourceImageFile: node.image } : {}),
    disableAudio: true,
    fableLoom: JSON.stringify({ loomId: loom.id, episodeId, nodeId: node.id }),
  };
}
