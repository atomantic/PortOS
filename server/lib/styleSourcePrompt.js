/**
 * Style-source prompt renderers — a resolved universe style guide or mood
 * board (`services/creativeStyleSources.js`) as prompt text. Shared by every
 * surface that uses a universe / mood board as its look (Code Animation's
 * coding prompt and brief writer, Creative Commissions' art-direction base),
 * so the prompts describing one universe or board can't drift in what they
 * show the model. Pure; no I/O.
 */

import { isNonBlankStr } from './textUtils.js';

const bulletList = (values) => values.map((value) => `- ${value}`).join('\n');

/**
 * The universe's curated style, as prompt lines. Excludes the free-text
 * `styleNotes`, which each caller frames itself.
 */
export function universeStyleLines(universe) {
  const lines = [];
  if (universe.embrace?.length) lines.push(`Visual style to embrace: ${universe.embrace.join(', ')}`);
  if (universe.avoid?.length) lines.push(`Visual style to avoid: ${universe.avoid.join(', ')}`);
  if (universe.styleReferences?.length) {
    lines.push('Style references curated for this universe:');
    lines.push(bulletList(universe.styleReferences.map((ref) => (ref.title ? `${ref.title}: ${ref.prompt}` : ref.prompt))));
  }
  return lines;
}

/** The board's style context as prompt text (`''` when there is no board). */
export function moodBoardSection(board) {
  if (!board) return '';
  const lines = [`Mood board: "${board.name || 'Untitled board'}" — distill its through-line (palette, texture, lighting, rhythm, mood), not any single item.`];
  if (isNonBlankStr(board.description)) lines.push(`Board description: ${board.description}`);
  const fragments = (board.items || []).map((item) => {
    const parts = [];
    if (item.note) parts.push(`note: ${item.note}`);
    if (item.caption) parts.push(`caption: ${item.caption}`);
    if (item.analyzedPrompt) parts.push(`visual analysis: ${item.analyzedPrompt}`);
    if (item.analyzedNegative) parts.push(`avoid: ${item.analyzedNegative}`);
    return parts.join('; ');
  }).filter(Boolean);
  if (fragments.length) lines.push(bulletList(fragments));
  if (board.droppedItems) lines.push(`(${board.droppedItems} more board items omitted for length.)`);
  return lines.join('\n');
}
