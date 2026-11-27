/**
 * The ending after the song: the cutting room floor then the credits, each optional.
 *
 * `endingParts`, `endingSeconds`, `endingPartAt`, `drawEnding` and `endingPageSource` (the final
 * render's page script). Browser-safe.
 *
 * Music Video — the ending after the song: the cutting room floor
 * (lib/musicVideo/musicVideoStatsOutro.js) and the film credits
 * (lib/musicVideo/musicVideoCreditsOutro.js), each optional, played in that order with
 * silence under them. `endingParts` lays out which are on and where each
 * starts on the ending's own clock; the final render captures them as one
 * page (`endingPageSource`) and the animatic draws the part at each moment.
 * Browser-safe.
 */

import { drawStatsOutro, normalizeStatsOutro, statsOutroRows, statsOutroSeconds } from './musicVideoStatsOutro.js';
import { CREDITS_OUTRO_FACE_LOADS, CREDITS_OUTRO_FONTS, creditsOutroSeconds, drawCreditsOutro, normalizeCreditsOutro } from './musicVideoCreditsOutro.js';

/**
 * The ending's parts in play order, `{ kind: 'floor'|'credits', startSec,
 * durationSec, outro?|credits? }` (the normalized record each draws from);
 * empty when neither is on.
 */
export function endingParts(project) {
  const parts = [];
  let at = 0;
  const floorSec = statsOutroSeconds(project?.statsOutro);
  if (floorSec > 0) {
    parts.push({ kind: 'floor', startSec: at, durationSec: floorSec, outro: normalizeStatsOutro(project.statsOutro) });
    at += floorSec;
  }
  const creditsSec = creditsOutroSeconds(project?.creditsOutro);
  if (creditsSec > 0) parts.push({ kind: 'credits', startSec: at, durationSec: creditsSec, credits: normalizeCreditsOutro(project.creditsOutro) });
  return parts;
}

/** The seconds the ending adds after the song (0 when nothing is on). */
export const endingSeconds = (project) => endingParts(project).reduce((sum, part) => sum + part.durationSec, 0);

/* drawEnding is inlined into the render page by toString(), beside the two painters it calls by name. */

/** The part showing at ending time `t` and the time inside it: `{ part, t }` (part null when there are none). */
function endingPartAt(parts, t) {
  const list = Array.isArray(parts) ? parts : [];
  if (!list.length) return { part: null, t: 0 };
  let part = list[list.length - 1];
  for (const candidate of list) {
    if (t < candidate.startSec + candidate.durationSec) { part = candidate; break; }
  }
  return { part, t: Math.max(0, Math.min(part.durationSec, t - part.startSec)) };
}

/** Paint the ending at its own time `t`: whichever part is showing, on its own clock. */
function drawEnding(ctx, { width, height, t, parts, stats, images = [], creditsBg = null }) {
  const at = endingPartAt(parts, t);
  if (!at.part) return;
  if (at.part.kind === 'floor') {
    drawStatsOutro(ctx, { width, height, t: at.t, durationSec: at.part.durationSec, stats, outro: at.part.outro, images });
  } else {
    drawCreditsOutro(ctx, { width, height, t: at.t, durationSec: at.part.durationSec, credits: at.part.credits, bgImage: creditsBg });
  }
}

export { endingPartAt, drawEnding };

/** The weights each page waits for before it draws (the faces its @font-face rules declare). */
const ENDING_FACE_LOADS = Object.freeze([
  '800 40px "MV Archivo"', '500 40px "MV Mono"', '600 40px "MV Mono"',
  ...CREDITS_OUTRO_FACE_LOADS,
]);

/**
 * The render page's script: draws the ending full-frame on a canvas and
 * exposes `globalThis.portosComposition` (`seek(t)` on the ending's own time)
 * for the shared composition encoder. `imageSrcs[i]` is the page-relative file
 * for `stats.floorImages[i]`; the faces are declared by the page's
 * @font-face rules. Every seek waits for the stills and faces to load.
 */
export function endingPageSource({ stats, parts, imageSrcs = [], creditsBgSrc = '', width, height, fps, durationSec }) {
  const json = (value) => JSON.stringify(value).replace(/</g, '\\u003c');
  return `(() => {
  const CREDITS_OUTRO_FONTS = ${json(CREDITS_OUTRO_FONTS)};
  ${statsOutroRows.toString()}
  ${drawStatsOutro.toString()}
  ${drawCreditsOutro.toString()}
  ${endingPartAt.toString()}
  ${drawEnding.toString()}
  const STATS = ${json(stats)};
  const PARTS = ${json(parts)};
  const SRCS = ${json(imageSrcs)};
  const CREDITS_BG_SRC = ${json(creditsBgSrc || '')};
  const FACES = ${json(ENDING_FACE_LOADS)};
  const WIDTH = ${Number(width)}, HEIGHT = ${Number(height)}, FPS = ${Number(fps)}, DURATION = ${Number(durationSec)};
  const canvas = document.getElementById('outro');
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx = canvas.getContext('2d');
  const images = SRCS.map(() => null);
  let creditsBg = null;
  const loadImg = (src, assign) => new Promise((resolve) => {
    if (!src) { resolve(); return; }
    const img = new Image();
    img.onload = () => { assign(img); resolve(); };
    img.onerror = () => resolve();
    img.src = src;
  });
  const loaded = Promise.all([
    ...SRCS.map((src, i) => loadImg(src, (img) => { images[i] = img; })),
    loadImg(CREDITS_BG_SRC, (img) => { creditsBg = img; }),
  ]);
  const faces = document.fonts && document.fonts.load
    ? Promise.all(FACES.map((font) => document.fonts.load(font).catch(() => null)))
    : Promise.resolve();
  globalThis.portosComposition = {
    durationSec: DURATION, fps: FPS, width: WIDTH, height: HEIGHT,
    async seek(t) {
      await loaded;
      await faces;
      drawEnding(ctx, { width: WIDTH, height: HEIGHT, t, parts: PARTS, stats: STATS, images, creditsBg });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
  };
})();
`;
}
