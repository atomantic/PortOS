import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { moodBoardStyleSchema } from '../../lib/moodBoardValidation.js';
import { buildBoardRecord, MAX_ITEMS_PER_BOARD } from './logic.js';

// Copy references and analyses, never importer links, posters or in-flight jobs.
// The complete snapshot is validated before its single INSERT and announcement.
export function buildCompositeBoardRecord(input, boards, options) {
  const items = boards.flatMap(board => board.items || []);
  if (items.length > MAX_ITEMS_PER_BOARD) {
    throw new ServerError('The combined board would exceed 500 pins. Remove some pins first.', {
      status: 400, code: 'BOARD_FULL',
    });
  }
  const board = buildBoardRecord({
    ...input,
    description: input.description ?? `Combined from ${boards.map(source => source.name).join(' + ')}.`,
  }, options);
  board.items = items.map(item => {
    const { render: _render, ...snapshot } = structuredClone(item);
    return { ...snapshot, id: `mbi-${randomUUID()}`, createdAt: board.createdAt };
  });
  const styles = boards.filter(source => source.style?.prompt);
  if (styles.length) {
    const style = {
      prompt: styles.map(source => `${source.name}:\n${source.style.prompt}`).join('\n\n'),
      negativePrompt: styles.map(source => source.style.negativePrompt).filter(Boolean).join('\n\n') || null,
      composedAt: board.createdAt,
    };
    if (!moodBoardStyleSchema.safeParse(style).success) {
      throw new ServerError('The combined style exceeds 8,000 characters. Shorten the source styles first.', {
        status: 400, code: 'COMPOSITE_STYLE_TOO_LONG',
      });
    }
    board.style = style;
  }
  return board;
}
