/**
 * Music Video — composition manifest + deterministic typography (#8984, part of #8966).
 *
 * A project may carry a versioned `composition` manifest that switches its
 * final render from plain clip concatenation (`mode: 'concat'`, the default and
 * the behavior of every project that has no manifest) to a **composed** render:
 * the same footage cut over the same master song, with editable timed text cues
 * laid over it. The cues are explicit, user-owned text — independent of the
 * lyric cues the shot planner reads, though the UI can copy them across.
 *
 * Everything here is storage- and browser-agnostic. `cueStateAt` is the single
 * source of truth for how a cue looks at a time; the overlay document embeds its
 * source verbatim, so seeking the page to a time and calling the function in
 * Node yield the same state. `buildTypographyDocument` produces the sandboxed
 * HTML composition (see services/htmlComposition/browser.js) that
 * compositionRender.js captures into transparent overlay clips.
 */

import { randomUUID } from 'crypto';
import { trimTo } from '../../lib/textUtils.js';
import {
  MUSIC_VIDEO_COMPOSITION_MODES as COMPOSITION_MODES,
  MUSIC_VIDEO_TYPOGRAPHY_EMPHASES as TYPOGRAPHY_EMPHASES,
  MUSIC_VIDEO_TYPOGRAPHY_FONTS as TYPOGRAPHY_FONTS,
  MUSIC_VIDEO_TYPOGRAPHY_PLACEMENTS as TYPOGRAPHY_PLACEMENTS,
  MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES as TYPOGRAPHY_TEMPLATES,
} from '../../lib/musicVideoValidation.js';

export const COMPOSITION_VERSION = 1;

const MAX_SEC = 36000;
const round3 = (n) => Math.round(n * 1000) / 1000;
const toTime = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SEC ? round3(value) : null);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

/**
 * Normalize a validated (or legacy/peer-supplied) manifest. Every cue persists
 * a stable id and explicit defaults; a cue whose end is not after its start
 * keeps its text but loses its end (it does not render until re-timed). Returns
 * null for a non-object so a cleared manifest stays cleared.
 */
export function normalizeComposition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const seen = new Set();
  const textCues = [];
  for (const cue of Array.isArray(input.textCues) ? input.textCues : []) {
    const text = cue && typeof cue === 'object' ? trimTo(cue.text, 500) : '';
    if (!text) continue;
    const id = typeof cue.id === 'string' && cue.id && !seen.has(cue.id) ? cue.id : `mtc-${randomUUID()}`;
    seen.add(id);
    const startSec = toTime(cue.startSec);
    const end = toTime(cue.endSec);
    textCues.push({
      id,
      text,
      startSec,
      endSec: startSec != null && end != null && end > startSec ? end : null,
      template: pick(cue.template, TYPOGRAPHY_TEMPLATES, 'fade'),
      placement: pick(cue.placement, TYPOGRAPHY_PLACEMENTS, 'lower'),
      emphasis: pick(cue.emphasis, TYPOGRAPHY_EMPHASES, 'subtitle'),
    });
  }
  const style = input.style && typeof input.style === 'object' ? input.style : {};
  return {
    version: COMPOSITION_VERSION,
    mode: pick(input.mode, COMPOSITION_MODES, 'concat'),
    textCues,
    style: {
      color: typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color) ? style.color.toLowerCase() : '#ffffff',
      font: pick(style.font, TYPOGRAPHY_FONTS, 'sans'),
    },
    posterSec: toTime(input.posterSec),
  };
}

/** Clear the audio-derived timings (cue times, poster) when the song changes, keeping the text. */
export function invalidateCompositionTiming(composition) {
  if (!composition || typeof composition !== 'object') return composition;
  return {
    ...composition,
    textCues: (composition.textCues || []).map((cue) => ({ ...cue, startSec: null, endSec: null })),
    posterSec: null,
  };
}

/** The cues a composed render draws: timed, non-empty, clipped to the video. */
export function renderableCues(composition, durationSec) {
  if (composition?.mode !== 'composed') return [];
  return (composition.textCues || [])
    .filter((cue) => cue.text && cue.startSec != null && cue.endSec != null && cue.startSec < durationSec)
    .map((cue) => ({ ...cue, endSec: Math.min(cue.endSec, durationSec) }))
    .filter((cue) => cue.endSec > cue.startSec)
    .sort((a, b) => a.startSec - b.startSec);
}

/**
 * Pure and self-contained (its source is embedded in the overlay page, so it
 * must not reference anything outside its own body): the visual state of `cue`
 * at time `t`, or null when the cue is not on screen. `offsetY` is a fraction
 * of the frame height; `visibleChars` is how much of the text the typewriter
 * template has revealed.
 */
export function cueStateAt(cue, t) {
  const start = cue.startSec;
  const end = cue.endSec;
  if (!(t >= start && t < end)) return null;
  const span = end - start;
  const ramp = Math.min(0.35, span / 4);
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const inP = ramp > 0 ? clamp((t - start) / ramp) : 1;
  const outP = ramp > 0 ? clamp((end - t) / ramp) : 1;
  const easeOut = (p) => 1 - (1 - p) * (1 - p) * (1 - p);
  const length = String(cue.text).length;
  let opacity = Math.min(easeOut(inP), easeOut(outP));
  let offsetY = 0;
  let scale = 1;
  let visibleChars = length;
  if (cue.template === 'rise') {
    // Starts this far below its resting place (the overlay page's RISE reserve).
    offsetY = 0.04 * (1 - easeOut(inP));
  } else if (cue.template === 'pop') {
    // Grows into place and never past full size, so it cannot leave the safe area.
    scale = 0.85 + 0.15 * easeOut(inP);
  } else if (cue.template === 'typewriter') {
    const typeSec = Math.min(span * 0.6, length * 0.05);
    visibleChars = typeSec > 0 ? Math.min(length, Math.ceil(length * clamp((t - start) / typeSec))) : length;
    opacity = easeOut(outP);
  }
  return { opacity: Math.round(opacity * 10000) / 10000, offsetY: Math.round(offsetY * 10000) / 10000, scale: Math.round(scale * 10000) / 10000, visibleChars };
}

/**
 * The contiguous time ranges that need an overlay clip: the union of cue spans,
 * with near-adjacent spans joined so a lyric run renders as one clip. Frames
 * outside every window are never captured (the footage passes through as-is).
 */
export function overlayWindows(cues, { joinGapSec = 1 } = {}) {
  const windows = [];
  for (const cue of [...cues].sort((a, b) => a.startSec - b.startSec)) {
    const last = windows[windows.length - 1];
    if (last && cue.startSec - last.endSec <= joinGapSec) last.endSec = Math.max(last.endSec, cue.endSec);
    else windows.push({ startSec: cue.startSec, endSec: cue.endSec });
  }
  return windows;
}

// Title-safe area: 10% in from every edge of the frame, at any aspect.
export const SAFE_INSET = 0.1;
const FONT_STACKS = {
  sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "Menlo, 'Courier New', monospace",
};

// A `<script>`-safe JSON literal: `<` escaped so text can never close the tag. (U+2028/9
// are legal inside JS string literals since ES2019, so they need no escape.)
const scriptJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * The overlay page: a transparent document whose `portosComposition.seek(t)`
 * draws every cue's `cueStateAt` state. `layout()` sizes each cue once per frame
 * size — shrinking its font until it fits inside the safe area — so the text
 * box never changes between frames and cannot leave the safe area.
 */
export function buildTypographyDocument({ cues, style = {}, width, height, durationSec, fps }) {
  const payload = cues.map(({ id, text, startSec, endSec, template, placement, emphasis }) => ({ id, text, startSec, endSec, template, placement, emphasis }));
  const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#ffffff';
  const fontStack = FONT_STACKS[style.font] || FONT_STACKS.sans;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
#safe { position: absolute; }
.cue { position: absolute; left: 0; right: 0; box-sizing: border-box; padding: 0.25em; text-align: center; color: ${color}; font-family: ${fontStack};
  font-weight: 700; line-height: 1.15; overflow-wrap: break-word; overflow: hidden; visibility: hidden; will-change: transform, opacity;
  /* The padding keeps this legibility shadow inside the cue box, and so inside the safe area. */
  text-shadow: 0 0 0.12em rgba(0,0,0,0.85), 0 0.04em 0.18em rgba(0,0,0,0.7); }
.cue .rest { visibility: hidden; }
</style></head><body><div id="safe"></div><script>
const CUES = ${scriptJson(payload)};
const SAFE_INSET = ${SAFE_INSET};
const cueStateAt = ${cueStateAt.toString()};
const safe = document.getElementById('safe');
const nodes = CUES.map((cue) => {
  const el = document.createElement('div');
  el.className = 'cue';
  const shown = document.createElement('span');
  const rest = document.createElement('span');
  rest.className = 'rest';
  el.append(shown, rest);
  safe.append(el);
  return { cue, el, shown, rest, chars: Array.from(cue.text) };
});
let frame = { width: ${Number(width)}, height: ${Number(height)} };
function layout({ width, height }) {
  frame = { width, height };
  const insetX = Math.round(width * SAFE_INSET);
  const insetY = Math.round(height * SAFE_INSET);
  const safeW = width - insetX * 2;
  const safeH = height - insetY * 2;
  Object.assign(safe.style, { left: insetX + 'px', top: insetY + 'px', width: safeW + 'px', height: safeH + 'px' });
  const base = Math.min(width, height);
  for (const node of nodes) {
    const hero = node.cue.emphasis === 'hero';
    const maxH = safeH * (hero ? 0.6 : 0.3);
    node.shown.textContent = node.cue.text;
    node.rest.textContent = '';
    let size = Math.round(base * (hero ? 0.09 : 0.05));
    const floor = Math.max(8, Math.round(base * 0.02));
    node.el.style.fontSize = size + 'px';
    while (size > floor && (node.el.scrollHeight > maxH || node.el.scrollWidth > safeW)) {
      size = Math.max(floor, Math.floor(size * 0.92));
      node.el.style.fontSize = size + 'px';
    }
    // A lower cue that rises in starts below its resting place: rest it high
    // enough that its first frame is still inside the safe area.
    const reserve = node.cue.template === 'rise' ? Math.ceil(0.04 * height) : 0;
    // Text still too tall at the minimum size is clipped to the box (overflow:
    // hidden), and the box — plus any rise travel — never exceeds the safe area.
    const boxH = Math.min(node.el.scrollHeight, safeH - reserve);
    const top = node.cue.placement === 'upper' ? 0 : node.cue.placement === 'center' ? (safeH - reserve - boxH) / 2 : safeH - boxH - reserve;
    node.el.style.top = Math.round(top) + 'px';
    node.el.style.maxHeight = boxH + 'px';
  }
}
function draw(t) {
  for (const node of nodes) {
    const state = cueStateAt(node.cue, t);
    if (!state) { node.el.style.visibility = 'hidden'; continue; }
    node.shown.textContent = node.chars.slice(0, state.visibleChars).join('');
    node.rest.textContent = node.chars.slice(state.visibleChars).join('');
    node.el.style.visibility = 'visible';
    node.el.style.opacity = String(state.opacity);
    node.el.style.transformOrigin = '50% 50%';
    node.el.style.transform = 'translateY(' + Math.round(state.offsetY * frame.height) + 'px) scale(' + state.scale + ')';
  }
}
layout(frame);
globalThis.portosComposition = {
  durationSec: ${Number(durationSec)}, fps: ${Number(fps)}, width: ${Number(width)}, height: ${Number(height)},
  layout,
  state: (t) => nodes.map((node) => ({ id: node.cue.id, state: cueStateAt(node.cue, t) })),
  async seek(t) { draw(t); await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
};
</script></body></html>`;
}
