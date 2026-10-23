/**
 * FableLoom and storyboards. "Make storyboard from this path" builds a board
 * from one path through an episode (the FableLoom Board view's path, `via`
 * picks at its forks): one beat per dramatic scene, one panel per scene with
 * its image prompt, length, camera move and current art. The board keeps the
 * episode as its `source` and each panel its scene, so recipe-made panel art
 * goes back to the scene with "Use as scene art". The loom is not changed
 * until then. Runs only on the user's tap; no model call.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { fableLoomBoardPath } from '../../lib/fableLoomBoard.js';
import { asFableLoomRenderSettings } from '../../lib/fableLoomProduction.js';
import { STORYBOARD_ASPECT_RATIOS, STORYBOARD_LIMITS as L } from '../../lib/storyboardVocabulary.js';
import { trimTo } from '../../lib/textUtils.js';
import { createStoryboard, getStoryboard } from './index.js';

const notFound = (what) => new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });

function panelFromNode(node, seconds) {
  return {
    action: trimTo(node.imagePrompt || node.prose || node.title, L.panelText),
    camera: trimTo(node.cameraMovement, L.camera),
    seconds,
    notes: trimTo(node.shot?.framing, L.notes),
    takes: node.image ? [{ source: 'gallery', image: node.image }] : [],
    sourceSceneId: node.id,
  };
}

export async function makeStoryboardFromFableLoom(loomId, episodeId, { via = [] } = {}) {
  const { getLoom } = await import('../fableLoom/records.js');
  const loom = await getLoom(loomId);
  if (!loom) throw notFound('Story');
  const episode = loom.episodes.find((e) => e.id === episodeId);
  if (!episode) throw notFound('Episode');
  const path = fableLoomBoardPath(episode, via);
  if (!path.beats.length) throw new ServerError('This episode has no start scene yet.', { status: 400, code: 'NO_SCENES' });
  const aspect = asFableLoomRenderSettings(loom.renderSettings).aspectRatio;
  const name = [loom.name, episode.title || `Episode ${episode.number}`].filter(Boolean).join(' · ');
  const board = await createStoryboard({
    name: trimTo(name, L.name) || 'Untitled storyboard',
    logline: trimTo(episode.synopsis, L.logline),
    aspectRatio: STORYBOARD_ASPECT_RATIOS.includes(aspect) ? aspect : '16:9',
    universeId: loom.universeId || null,
  }, {
    beats: path.beats.map((beat) => ({
      title: trimTo(beat.title, L.beatTitle),
      panels: beat.panels.map(({ node, seconds }) => panelFromNode(node, seconds)),
    })),
    source: { kind: 'fableloom', loomId, episodeId },
  });
  console.log(`🎬 Storyboard ${board.id} made from FableLoom ${loomId} episode ${episodeId}`);
  return board;
}

/** Use as scene art: the panel's selected image becomes its FableLoom scene's image. */
export async function sendPanelArtToFableLoom(boardId, panelId) {
  const board = await getStoryboard(boardId);
  if (board.source?.kind !== 'fableloom') {
    throw new ServerError('This storyboard was not made from a FableLoom episode.', { status: 400, code: 'NO_SOURCE' });
  }
  const panel = board.beats.flatMap((beat) => beat.panels).find((p) => p.id === panelId);
  if (!panel) throw notFound('Panel');
  if (!panel.sourceSceneId) throw new ServerError('This panel has no FableLoom scene.', { status: 400, code: 'NO_SOURCE' });
  const take = panel.takes.find((t) => t.id === panel.selectedTakeId);
  if (!take?.image) {
    throw new ServerError('Pick an image for this panel first; a sketch can\'t be scene art.', { status: 400, code: 'NO_IMAGE' });
  }
  const { attachNodeImage } = await import('../fableLoom/records.js');
  const { loomId, episodeId } = board.source;
  const node = await attachNodeImage(loomId, episodeId, panel.sourceSceneId, { filename: take.image, jobId: null });
  if (!node) throw notFound('FableLoom scene');
  console.log(`🎬 Storyboard ${boardId} panel ${panelId} art sent to FableLoom scene ${node.id}`);
  return { board, node };
}
