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
 *
 * The preset is applied here as well as server-side on purpose: an unlinked
 * loom (no universe reachable from the loom or its series) gets no compiled
 * request back, and the browser preset is the only style it would ever see.
 * The compiler drops style tokens the authored prompt already carries
 * (`dropTokensPresentIn` in server/lib/universeVisualStyle.js), so the linked
 * path does not emit the token list twice — do not fix the overlap by
 * deleting either side.
 */

import { composeStyledPrompt } from '../../lib/composeStyledPrompt';
import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import {
  asFableLoomRenderPreferences,
  asFableLoomRenderSettings,
} from '../../../../server/lib/fableLoomProduction.js';

const withLoomStyle = (prompt, styleNotes) => {
  const notes = typeof styleNotes === 'string' ? styleNotes.trim() : '';
  return notes ? `${prompt}\n\nStyle: ${notes}` : prompt;
};

export function buildFableLoomImageRequest({ loom, episodeId, node, stylePreset = null }) {
  const authoredPrompt = withLoomStyle((node?.imagePrompt || '').trim(), loom?.styleNotes);
  const styled = composeStyledPrompt(authoredPrompt, '', stylePreset);
  const render = asFableLoomRenderSettings(loom?.renderSettings);
  const preferences = asFableLoomRenderPreferences(loom?.renderSettings);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    ...((preferences.imageMode || preferences.imageModel)
      ? { mode: preferences.imageMode || 'local' }
      : {}),
    ...(preferences.imageModel ? { modelId: preferences.imageModel } : {}),
    ...(preferences.effort ? { effort: preferences.effort } : {}),
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
  const preferences = asFableLoomRenderPreferences(loom?.renderSettings);
  return {
    prompt: styled.prompt,
    ...(styled.negativePrompt ? { negativePrompt: styled.negativePrompt } : {}),
    backend: preferences.videoMode || 'local',
    ...(preferences.videoModel ? { modelId: preferences.videoModel } : {}),
    mode: node?.image ? 'image' : 'text',
    ...(node?.image ? { sourceImageFile: node.image } : {}),
    disableAudio: true,
    width: render.width,
    height: render.height,
    fableLoom: JSON.stringify({ loomId: loom.id, episodeId, nodeId: node.id }),
  };
}
