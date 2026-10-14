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
 * The browser sends the scene's own text, the loom's style notes and the
 * camera direction, each listed as a labeled addition (#11317). A linked loom's
 * universe and series style is the compiler's to add (server-side, from the
 * same `universeStylePreset`), so it is not prefixed here; an unlinked loom has
 * no universe style to add.
 */

import { FABLELOOM_CAMERA_MOVEMENTS } from '../../../../server/lib/fableLoomCameraMovements.js';
import {
  asFableLoomRenderPreferences,
  asFableLoomRenderSettings,
} from '../../../../server/lib/fableLoomProduction.js';

// The scene's text plus each addition after it, as `{ prompt, promptAdditions }`.
const withAdditions = (authored, additions) => {
  const listed = additions.filter((item) => item.text);
  return {
    prompt: [authored, ...listed.map((item) => item.text)].filter(Boolean).join('\n\n'),
    ...(listed.length ? { promptAdditions: listed } : {}),
  };
};
const loomStyle = (loom) => {
  const notes = typeof loom?.styleNotes === 'string' ? loom.styleNotes.trim() : '';
  return { id: 'loom-style', label: 'Loom style', text: notes ? `Style: ${notes}` : '' };
};

export function buildFableLoomImageRequest({ loom, episodeId, node }) {
  const composed = withAdditions((node?.imagePrompt || '').trim(), [loomStyle(loom)]);
  const render = asFableLoomRenderSettings(loom?.renderSettings);
  const preferences = asFableLoomRenderPreferences(loom?.renderSettings);
  return {
    ...composed,
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

export function buildFableLoomVideoRequest({ loom, episodeId, node }) {
  const authoredPrompt = (node?.videoPrompt || '').trim() || (node?.prose || '').trim();
  const movement = FABLELOOM_CAMERA_MOVEMENTS.find((move) => move.value === node?.cameraMovement);
  const direction = movement?.prompt || (node?.cameraMovement || '').trim();
  const composed = withAdditions(authoredPrompt, [
    { id: 'camera-direction', label: 'Camera direction', text: direction ? `Camera direction: ${direction}` : '' },
    loomStyle(loom),
  ]);
  const render = asFableLoomRenderSettings(loom?.renderSettings);
  const preferences = asFableLoomRenderPreferences(loom?.renderSettings);
  return {
    ...composed,
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
