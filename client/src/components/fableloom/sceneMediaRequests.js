/**
 * Shared FableLoom scene-media request builders.
 *
 * Both the graph-card buttons and the selected-scene editor queue through the
 * page owner. Keeping request composition here makes their image/video prompts
 * identical: the canonical universe/series style preset leads, the scene owns
 * the subject/action, and loom-local direction remains an explicit suffix.
 * The server-side visual-canon compiler owns reference allocation and graph
 * continuity. These builders send authored intent plus the destination tag;
 * they never pre-flatten canon into an untyped browser reference list.
 */

import { composeStyledPrompt } from '../../lib/composeStyledPrompt';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import { asFableLoomRenderSettings } from '../../../../server/lib/fableLoomProduction.js';

const withLoomStyle = (prompt, styleNotes) => {
  const notes = typeof styleNotes === 'string' ? styleNotes.trim() : '';
  return notes ? `${prompt}\n\nStyle: ${notes}` : prompt;
};

export function buildFableLoomImageRequest({ loom, episodeId, node, stylePreset = null }) {
  const authoredPrompt = withLoomStyle((node?.imagePrompt || '').trim(), loom?.styleNotes);
  const styled = composeStyledPrompt(authoredPrompt, '', stylePreset);
  const render = asFableLoomRenderSettings(loom?.renderSettings);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    width: render.width,
    height: render.height,
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
  const render = asFableLoomRenderSettings(loom?.renderSettings);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    backend: 'local',
    mode: node?.image ? 'image' : 'text',
    ...(node?.image ? { sourceImageFile: node.image } : {}),
    disableAudio: true,
    width: render.width,
    height: render.height,
    fableLoom: JSON.stringify({ loomId: loom.id, episodeId, nodeId: node.id }),
  };
}
