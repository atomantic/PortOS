/**
 * Autonomous Music Video — build a mood board from the creative brief.
 *
 * A board of text notes plus a composite style (the same `style.prompt` /
 * `negativePrompt` shape the board's own "compose style" action writes), so
 * the project's authored style snapshot (styleSnapshots.js) reads the look
 * description first. When the run may make images, each note is then queued
 * for a render on the run's image route (#10531), so the board shows the look
 * instead of only describing it; the completion hook turns each note into its
 * image. A render that can't be queued leaves its note as text and never fails
 * the stage.
 */
import { addBoardItem, createBoard, updateBoard, renderBoardItem } from '../moodBoard/index.js';

/**
 * @param {{ name: string, description: string, notes: string[], stylePrompt: string, negativePrompt: string }} spec
 * @param {{ renderRoute?: { mode?: string, model?: string, target?: string } | null }} [opts]
 *   the image route that renders the notes; omitted or null keeps them text
 * @returns the created board (with its items and style)
 */
export async function createAutonomousMoodBoard(spec, { renderRoute = null } = {}) {
  const board = await createBoard({ name: spec.name, description: spec.description });
  const notes = [];
  for (const text of spec.notes || []) {
    notes.push(await addBoardItem(board.id, { type: 'text', text, source: 'autonomous music video' }));
  }
  if (spec.stylePrompt) {
    await updateBoard(board.id, {
      style: {
        prompt: spec.stylePrompt,
        ...(spec.negativePrompt ? { negativePrompt: spec.negativePrompt } : {}),
        analyzedItemCount: 0,
        composedAt: new Date().toISOString(),
      },
    });
  }
  let queued = 0;
  if (renderRoute) {
    for (const note of notes) {
      const sent = await renderBoardItem(board.id, note.id, renderRoute).catch((err) => {
        console.warn(`⚠️ Autonomous mood board note render not queued: ${err.message}`);
        return null;
      });
      if (sent) queued += 1;
    }
  }
  console.log(`🖼️ Autonomous music video mood board "${spec.name}" created (${notes.length} notes, ${queued} rendering)`);
  return board;
}
