import { storyboardShotPanel } from '../../lib/storyboardFit.js';
import { getStoryboard } from '../storyboards/index.js';

/**
 * The live storyboard panel a shot was fitted from, or null (no linked board,
 * the board deleted, or the panel gone). Its picks direct the shot's still.
 */
export async function loadLinkedStoryboardPanel(project, scene) {
  if (!project?.storyboardId || !scene?.panelId) return null;
  const board = await getStoryboard(project.storyboardId).catch((err) => {
    if (err?.code === 'NOT_FOUND') return null;
    throw err;
  });
  return storyboardShotPanel(board, scene)?.panel || null;
}
