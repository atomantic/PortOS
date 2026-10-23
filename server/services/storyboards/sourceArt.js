/**
 * "Use as scene art" / "Use as shot art": a panel made from a production's
 * scene sends its selected image back there — a FableLoom scene's image or a
 * Series Pipeline shot's start frame. The board is not changed; the target
 * changes only on this tap.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { attachPanelArtToFableLoomScene } from './fromFableLoom.js';
import { attachPanelArtToPipelineShot } from './fromPipeline.js';
import { getStoryboard } from './index.js';

const ATTACH = { fableloom: attachPanelArtToFableLoomScene, pipeline: attachPanelArtToPipelineShot };

export async function sendPanelArtToSource(boardId, panelId) {
  const board = await getStoryboard(boardId);
  const attach = ATTACH[board.source?.kind];
  if (!attach) throw new ServerError('This storyboard was not made from a FableLoom episode or a pipeline issue.', { status: 400, code: 'NO_SOURCE' });
  const panel = board.beats.flatMap((beat) => beat.panels).find((p) => p.id === panelId);
  if (!panel) throw new ServerError('Panel not found', { status: 404, code: 'NOT_FOUND' });
  if (!panel.sourceSceneId) throw new ServerError('This panel was added on the storyboard; it has no scene to send art to.', { status: 400, code: 'NO_SOURCE' });
  const take = panel.takes.find((t) => t.id === panel.selectedTakeId);
  if (!take?.image) {
    throw new ServerError('Pick an image for this panel first; a sketch can\'t be sent as art.', { status: 400, code: 'NO_IMAGE' });
  }
  const target = await attach(board.source, panel, take.image);
  console.log(`🎬 Storyboard ${boardId} panel ${panelId} art sent to ${board.source.kind} scene ${panel.sourceSceneId}`);
  return { board, target };
}
