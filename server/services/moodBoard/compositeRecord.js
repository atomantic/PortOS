import { moodBoardStyleSchema } from '../../lib/moodBoardValidation.js';
import { buildBoardRecord } from './logic.js';

// Only the synthesized style belongs to the new board. Source pins, importer
// links, posters and jobs remain on their original boards.
export function buildCompositeBoardRecord(input, boards, options) {
  const board = buildBoardRecord({
    name: input.name,
    description: input.description ?? `Combined from ${boards.map(source => source.name).join(' + ')}.`,
  }, options);
  board.style = moodBoardStyleSchema.parse(input.style);
  return board;
}
