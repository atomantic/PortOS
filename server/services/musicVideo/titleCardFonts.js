/**
 * The opening title card's bundled faces (lib/musicVideoTitleCard.js
 * TITLE_CARD_FONT_FACES, SIL OFL 1.1 — licences beside the files in
 * titleCardFonts/) as data URLs, and the card runtime with them registered.
 * The data URLs ride inside the runtime script, so the card draws its face on
 * every page it is installed in (live preview, lyric pages, document renders,
 * the composed overlay) without each page shipping font files.
 */
import { readFileSync } from 'fs';
import { TITLE_CARD_FONT_FACES, titleCardRuntimeSource } from '../../lib/musicVideoTitleCard.js';

let cached = null;

/** `{ family: dataUrl }` for every bundled face, read once per process. */
function titleCardFontSources() {
  if (!cached) {
    cached = Object.fromEntries(Object.values(TITLE_CARD_FONT_FACES).map(({ family, file }) => [
      family, `data:font/woff2;base64,${readFileSync(new URL(`./titleCardFonts/${file}`, import.meta.url)).toString('base64')}`,
    ]));
  }
  return cached;
}

/** titleCardRuntimeSource with the bundled faces registered. */
export const titleCardRuntime = (card) => titleCardRuntimeSource(card, { fonts: titleCardFontSources() });
