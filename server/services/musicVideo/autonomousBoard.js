/**
 * Autonomous Music Video — build a mood board from the creative brief.
 *
 * A board of text notes plus a composite style (the same `style.prompt` /
 * `negativePrompt` shape the board's own "compose style" action writes), so
 * the project's authored style snapshot (styleSnapshots.js) reads the look
 * description first. Only text items are created: nothing here renders or
 * downloads an image, so the stage costs no media quota.
 */
import { addBoardItem, createBoard, updateBoard } from '../moodBoard/index.js';

/**
 * @param {{ name: string, description: string, notes: string[], stylePrompt: string, negativePrompt: string }} spec
 * @returns the created board (with its items and style)
 */
export async function createAutonomousMoodBoard(spec) {
  const board = await createBoard({ name: spec.name, description: spec.description });
  for (const text of spec.notes || []) {
    await addBoardItem(board.id, { type: 'text', text, source: 'autonomous music video' });
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
  console.log(`🖼️ Autonomous music video mood board "${spec.name}" created (${(spec.notes || []).length} notes)`);
  return board;
}
