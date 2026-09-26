/**
 * Creative Commission style source — the universe and/or mood board a
 * commission is configured with, resolved at fire time into the art-direction
 * BASE the Creative Director works from.
 *
 * The same pickers Card Decks and Code Animation offer: a universe contributes
 * its style guide (embrace/avoid tokens, curated style references, style
 * notes, style images) and, by default, its linked mood board; a mood board
 * contributes its through-line (captions, notes, visual analyses) and pinned
 * images. The rendered text is folded into both the directive goal (the
 * planner never sees the project styleSpec) and the project's styleSpec (what
 * the treatment and evaluation stages judge against). Reference images are
 * listed by their served `/data/...` path — the same convention the treatment
 * prompt uses for a starting image — never by an absolute machine path.
 *
 * Board selection on the stored brief (`brief.constraints.moodBoardId`):
 * absent / null follows the universe's linked board, '' means no board, any
 * other string names a board explicitly — matching Code Animation's wire
 * contract, where an absent id follows the universe and '' means none.
 */

import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';
import { moodBoardSection, universeStyleLines } from '../../lib/styleSourcePrompt.js';
import { resolveMoodBoardStyleSource, resolveUniverseStyleSource } from '../creativeStyleSources.js';
import { COMMISSION_STYLE_SPEC_MAX } from '../../lib/creativeBriefLimits.js';
import { MAX_STYLE_SOURCE_LEN, clamp } from './directive.js';

export const COMMISSION_STYLE_REFERENCE_IMAGES_MAX = 4;
const IMAGE_LABEL_MAX = 60;
const STYLE_SOURCE_HEADER = "Art direction base (from the commission's universe / mood board — ground every render in it):";

// A universe or board deleted after the commission was configured must not
// kill every future fire: skip it with a warning and render from what is left.
// Any other failure (a DB outage) propagates — it is not evidence of deletion.
async function orSkipMissing(label, promise, fallback) {
  return promise.catch((error) => {
    if (error?.code !== 'NOT_FOUND') throw error;
    console.warn(`⚠️ Creative commission style source ${label} not found — firing without it`);
    return fallback;
  });
}

/**
 * Render resolved style inputs into the bounded art-direction base. Pure.
 * Returns '' when there is nothing to say.
 */
function renderCommissionStyleSource({ universe = null, board = null, images = [] }) {
  const sections = [];
  if (universe) {
    const lines = [`The look comes from the universe "${universe.name}" — match its established style so this work sits beside its other artwork.`];
    lines.push(...universeStyleLines(universe));
    if (isNonBlankStr(universe.styleNotes)) lines.push(`Tone and staging notes: ${universe.styleNotes}`);
    sections.push(lines.join('\n'));
  }
  const boardText = moodBoardSection(board);
  if (boardText) sections.push(boardText);
  const imageLines = images.map((image, index) => {
    const origin = image.origin === 'mood-board' ? 'mood board' : 'universe';
    return `${index + 1}. ${trimTo(image.label, IMAGE_LABEL_MAX)} [${origin}] ${image.url}`;
  });
  const imageBlock = imageLines.length
    ? `Reference images (served by PortOS at these paths — study them for palette, composition, texture, and lighting):\n${imageLines.join('\n')}`
    : '';
  if (!sections.length && !imageBlock) return '';
  // The image list is short and bounded; the free text gives way first.
  const textBudget = MAX_STYLE_SOURCE_LEN - STYLE_SOURCE_HEADER.length - 1 - (imageBlock ? imageBlock.length + 2 : 0);
  const text = clamp(sections.join('\n\n'), Math.max(0, textBudget));
  return `${STYLE_SOURCE_HEADER}\n${[text, imageBlock].filter(Boolean).join('\n\n')}`;
}

/**
 * Resolve a commission's configured universe / mood board. Returns null when
 * neither is configured (or both were deleted), else
 * `{ universeId, universeName, moodBoardId, moodBoardName, text }`.
 */
export async function resolveCommissionStyleSource(commission) {
  const constraints = commission?.brief?.constraints || {};
  const universeId = isNonBlankStr(constraints.universeId) ? constraints.universeId : null;
  const slots = COMMISSION_STYLE_REFERENCE_IMAGES_MAX;
  const universe = universeId
    ? await orSkipMissing(`universe ${universeId}`, resolveUniverseStyleSource(universeId, { imageSlots: slots }), null)
    : null;
  const boardChoice = constraints.moodBoardId;
  const explicitBoard = isNonBlankStr(boardChoice) ? boardChoice : null;
  const moodBoardId = boardChoice == null ? universe?.moodBoardId || null : explicitBoard;
  const universeImages = universe?.images || [];
  const noBoard = { board: null, images: [] };
  const { board, images: boardImages } = moodBoardId
    ? await orSkipMissing(
      `mood board ${moodBoardId}`,
      resolveMoodBoardStyleSource(moodBoardId, { imageSlots: Math.max(0, slots - universeImages.length) }),
      noBoard,
    )
    : noBoard;
  if (!universe && !board) return null;
  const text = renderCommissionStyleSource({ universe, board, images: [...universeImages, ...boardImages] });
  return {
    universeId: universe ? universeId : null,
    universeName: universe?.name || null,
    moodBoardId: board ? moodBoardId : null,
    moodBoardName: board?.name || null,
    text,
  };
}

/**
 * The CD project's styleSpec: the style-source base, then the commission's own
 * style notes as refinements on top. The user's words are never cut for the
 * base — the base shrinks to fit the project's styleSpec cap instead.
 */
export function composeCommissionStyleSpec(userStyleSpec, styleSource) {
  const own = typeof userStyleSpec === 'string' ? userStyleSpec.trim() : '';
  const base = styleSource?.text || '';
  if (!base) return clamp(own, COMMISSION_STYLE_SPEC_MAX);
  if (!own) return clamp(base, COMMISSION_STYLE_SPEC_MAX);
  const label = 'Refinements for this commission (apply on top of the base above):';
  const room = COMMISSION_STYLE_SPEC_MAX - own.length - label.length - 3;
  if (room <= 0) return clamp(own, COMMISSION_STYLE_SPEC_MAX);
  return `${clamp(base, room)}\n\n${label}\n${own}`;
}
