import { normalizeMusicVideoGrade } from '../../lib/musicVideoGrade.js';
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
import { filmStyleIdSchema } from '../../lib/filmStyleGrammarValidation.js';
import {
  musicVideoEidoverseSceneSchema,
  MUSIC_VIDEO_COMPOSITION_MODES as COMPOSITION_MODES,
  MUSIC_VIDEO_CUTTING_MODES as CUTTING_MODES,
  MUSIC_VIDEO_DOCUMENT_DIRECTORY,
  MUSIC_VIDEO_DOCUMENT_SOURCES,
  MUSIC_VIDEO_TYPOGRAPHY_EMPHASES as TYPOGRAPHY_EMPHASES,
  MUSIC_VIDEO_TYPOGRAPHY_FONTS as TYPOGRAPHY_FONTS,
  MUSIC_VIDEO_TYPOGRAPHY_PLACEMENTS as TYPOGRAPHY_PLACEMENTS,
  MUSIC_VIDEO_TYPOGRAPHY_TEMPLATES as TYPOGRAPHY_TEMPLATES,
  isDeterministicCodeSource,
  musicVideoNarrativeEventSchema,
  musicVideoReactiveSectionSchema,
} from '../../lib/musicVideoValidation.js';

export const COMPOSITION_VERSION = 1;

const MAX_SEC = 36000;
const round3 = (n) => Math.round(n * 1000) / 1000;
const toTime = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SEC ? round3(value) : null);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

// Keep generated section functions across a mode switch. A source that would
// not seek cleanly is dropped rather than stored.
function normalizeCodeVideo(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const seen = new Set();
  const sections = [];
  for (const section of Array.isArray(input.sections) ? input.sections : []) {
    if (!section || typeof section.id !== 'string' || !section.id || seen.has(section.id)) continue;
    if (!isDeterministicCodeSource(section.source)) continue;
    seen.add(section.id);
    sections.push({ id: section.id, source: section.source });
  }
  if (!sections.length && !input.providerId && !input.model && !input.generatedAt) return null;
  return {
    providerId: typeof input.providerId === 'string' && input.providerId ? input.providerId.slice(0, 120) : null,
    model: typeof input.model === 'string' && input.model ? input.model.slice(0, 200) : null,
    generatedAt: typeof input.generatedAt === 'string' && input.generatedAt ? input.generatedAt.slice(0, 40) : null,
    sections,
  };
}

/**
 * The stored pointer to the project's composition document, or null when the
 * value is not a document version folder. Only the import routes set it.
 */
function normalizeCompositionDocument(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (typeof input.directory !== 'string' || !MUSIC_VIDEO_DOCUMENT_DIRECTORY.test(input.directory)) return null;
  const source = input.source && typeof input.source === 'object' && MUSIC_VIDEO_DOCUMENT_SOURCES.includes(input.source.kind)
    ? { kind: input.source.kind, name: typeof input.source.name === 'string' && input.source.name ? input.source.name.slice(0, 200) : null }
    : null;
  const count = (value, max) => (Number.isInteger(value) && value >= 0 && value <= max ? value : null);
  return {
    directory: input.directory,
    entry: 'index.html',
    updatedAt: typeof input.updatedAt === 'string' && input.updatedAt ? input.updatedAt.slice(0, 40) : null,
    source,
    ...(count(input.files, 4096) != null ? { files: input.files } : {}),
    ...(count(input.bytes, Number.MAX_SAFE_INTEGER) != null ? { bytes: input.bytes } : {}),
  };
}

/** The HUD block a composition document may draw; null when absent. */
function normalizeCompositionOverlay(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const lines = (list, maxItems, maxLen) => (Array.isArray(list) ? list : [])
    .map((line) => trimTo(line, maxLen)).filter(Boolean).slice(0, maxItems);
  const meterIn = input.meter && typeof input.meter === 'object' && !Array.isArray(input.meter) ? input.meter : null;
  const keyframes = (Array.isArray(meterIn?.keyframes) ? meterIn.keyframes : [])
    .filter((pair) => Array.isArray(pair) && toTime(pair[0]) != null && typeof pair[1] === 'number' && pair[1] >= 0 && pair[1] <= 100)
    .map(([t, v]) => [toTime(t), Math.round(v * 100) / 100])
    .sort((a, b) => a[0] - b[0])
    .slice(0, 200);
  const start = input.timecodeStartSec;
  return {
    enabled: input.enabled !== false,
    titleLines: lines(input.titleLines, 4, 120),
    meter: meterIn ? { label: trimTo(meterIn.label, 40), keyframes } : null,
    ticker: lines(input.ticker, 40, 200),
    timecode: input.timecode !== false,
    timecodeStartSec: typeof start === 'number' && Number.isFinite(start) && start >= 0 && start <= 86400 ? start : 0,
  };
}

/**
 * Normalize a validated (or legacy/peer-supplied) manifest. Every cue persists
 * a stable id and explicit defaults; a cue whose end is not after its start
 * keeps its text but loses its end (it does not render until re-timed). Returns
 * null for a non-object so a cleared manifest stays cleared.
 */
/** A cue's sung word onsets (#9291), in time order; null when there are none. */
function cueWords(words) {
  if (!Array.isArray(words)) return null;
  const out = words
    .filter((w) => w && typeof w.w === 'string' && w.w.trim() && toTime(w.atSec) != null)
    .slice(0, 80)
    .map((w) => ({ w: w.w.trim().slice(0, 60), atSec: toTime(w.atSec) }))
    .sort((a, b) => a.atSec - b.atSec);
  return out.length ? out : null;
}

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
      ...(cueWords(cue.words) ? { words: cueWords(cue.words) } : {}),
    });
  }
  const style = input.style && typeof input.style === 'object' ? input.style : {};
  const eidoverse = musicVideoEidoverseSceneSchema.safeParse(input.eidoverseScene);
  const codeVideo = normalizeCodeVideo(input.codeVideo);
  const documentRef = normalizeCompositionDocument(input.document);
  const documentDraft = normalizeCompositionDocument(input.documentDraft);
  const overlay = normalizeCompositionOverlay(input.overlay);
  const grade = normalizeMusicVideoGrade(input.grade);
  return {
    version: COMPOSITION_VERSION,
    mode: pick(input.mode, COMPOSITION_MODES, 'concat'),
    ...(['canvas', 'three'].includes(input.authoringRenderer) ? { authoringRenderer: input.authoringRenderer } : {}),
    // Kept verbatim when well-formed so a peer on an older or newer catalog round-trips it (#10254).
    ...(filmStyleIdSchema.safeParse(input.styleGrammarId).success ? { styleGrammarId: input.styleGrammarId } : {}),
    textCues,
    style: {
      color: typeof style.color === 'string' && /^#[0-9a-f]{6}$/i.test(style.color) ? style.color.toLowerCase() : '#ffffff',
      font: pick(style.font, TYPOGRAPHY_FONTS, 'sans'),
      ...(typeof style.accentColor === 'string' && /^#[0-9a-f]{6}$/i.test(style.accentColor) ? { accentColor: style.accentColor.toLowerCase() } : {}),
    },
    posterSec: toTime(input.posterSec),
    ...(grade ? { grade } : {}),
    // Absent until chosen (#9290): the autopilot plan picks 'intercut' for an undecided project.
    ...(CUTTING_MODES.includes(input.cutting) ? { cutting: input.cutting } : {}),
    // Absent unless a code video was actually stored, so a composed manifest
    // stays the shape peers and clones already compare.
    ...(codeVideo ? { codeVideo } : {}),
    ...(eidoverse.success ? { eidoverseScene: eidoverse.data } : {}),
    // Same posture: present only once a document was imported / a HUD set.
    ...(documentRef ? { document: documentRef } : {}),
    ...(documentDraft ? { documentDraft } : {}),
    ...(overlay ? { overlay } : {}),
    ...(Array.isArray(input.narrativeEvents) ? { narrativeEvents: input.narrativeEvents.slice(0, 200)
      .map((event) => musicVideoNarrativeEventSchema.safeParse(event)).filter((result) => result.success).map((result) => result.data)
      .filter((event, index, events) => events.findIndex((other) => other.id === event.id) === index) } : {}),
    ...(Array.isArray(input.reactiveSections) ? { reactiveSections: input.reactiveSections.slice(0, 40)
      .map((section) => musicVideoReactiveSectionSchema.safeParse(section)).filter((result) => result.success).map((result) => result.data)
      .filter((section, index, sections) => sections.findIndex((other) => other.sectionId === section.sectionId) === index) } : {}),
  };
}

/**
 * #9290: the project with `cutting` defaulted for an autopilot production run
 * (intercut) unless the director already chose how it cuts.
 */
export function withAutopilotCutting(project) {
  if (!project || project.composition?.cutting) return project;
  return { ...project, composition: normalizeComposition({ ...(project.composition || {}), cutting: 'intercut' }) };
}

/**
 * `next` (a normalized manifest, or null) carrying `stored`'s document pointer
 * instead of whatever `next` holds: only the import routes set the pointer.
 */
export function withStoredCompositionDocument(next, stored) {
  if (!next) return next;
  const { document: _ignored, documentDraft: _ignoredDraft, ...rest } = next;
  return {
    ...rest,
    ...(stored?.document ? { document: stored.document } : {}),
    ...(stored?.documentDraft ? { documentDraft: stored.documentDraft } : {}),
  };
}

/** Clear the audio-derived timings (cue times, poster) when the song changes, keeping the text. */
export function invalidateCompositionTiming(composition) {
  if (!composition || typeof composition !== 'object') return composition;
  return {
    ...composition,
    textCues: (composition.textCues || []).map((cue) => ({ ...cue, startSec: null, endSec: null })),
    posterSec: null,
    ...(composition.reactiveSections ? { reactiveSections: [] } : {}),
    ...(composition.narrativeEvents ? { narrativeEvents: composition.narrativeEvents.map((event) => ({ ...event, anchor: null })) } : {}),
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

/** Shared absolute-song-time cues and style for full renders and draft excerpts. */
export function projectTypographyPlan(project, clips, sections, durationSec) {
  const graphicLanguage = project.treatment?.brief?.graphicLanguage;
  return {
    cues: [...renderableCues(project.composition, durationSec), ...sectionCardCues(clips, sections, durationSec, graphicLanguage)]
      .sort((a, b) => a.startSec - b.startSec),
    style: { ...project.composition?.style, graphicLanguage },
  };
}

/**
 * A title card's text (#8985), drawn by the typography layer for exactly its
 * section on the output timebase (`sections` from buildMusicVideoFfmpegArgs),
 * clipped to the rendered video.
 */
export function sectionCardCues(clips, sections, durationSec, graphicLanguage = '') {
  const textBySceneId = new Map(clips.filter((c) => c.layer === 'card' && c.cardText).map((c) => [c.sceneId, c.cardText]));
  return sections
    .filter((section) => textBySceneId.has(section.sceneId) && section.startSec < durationSec)
    .map((section) => ({
      id: `card-${section.sceneId}`, text: textBySceneId.get(section.sceneId),
      startSec: section.startSec, endSec: Math.min(section.endSec, durationSec),
      template: /\b(pictograms?|counters?|hud)\b/i.test(graphicLanguage) ? 'pop' : 'fade', placement: 'center', emphasis: 'hero',
    }));
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
  } else if (cue.template === 'build') {
    // #9291: each word lands on its sung onset (evenly over the first 60% of
    // the cue when no onsets are known); the line holds, then fades out.
    const words = Array.isArray(cue.words) && cue.words.length ? cue.words.map((w) => w.atSec) : null;
    // Tokens counted inline: this function is serialized into the overlay
    // page (cueStateAt.toString()), so it cannot import lib/textUtils.
    let count = 0;
    if (words) count = words.length;
    else for (const token of String(cue.text).split(/\s+/)) if (token) count += 1;
    let shown = 0;
    if (words) for (const at of words) { if (at <= t + 1e-6) shown += 1; }
    else shown = count ? Math.min(count, 1 + Math.floor(clamp((t - start) / (span * 0.6)) * count)) : 0;
    opacity = easeOut(outP);
    return { opacity: Math.round(opacity * 10000) / 10000, offsetY: 0, scale: 1, visibleChars: length, visibleWords: Math.max(1, shown) };
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
  const payload = cues.map(({ id, text, startSec, endSec, template, placement, emphasis, words }) => ({ id, text, startSec, endSec, template, placement, emphasis, ...(words ? { words } : {}) }));
  const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#ffffff';
  const fontStack = /\b(hud|counters?)\b/i.test(style.graphicLanguage || '') ? FONT_STACKS.mono : (FONT_STACKS[style.font] || FONT_STACKS.sans);
  const accent = /^#[0-9a-f]{6}$/i.test(style.accentColor || '') ? style.accentColor : '#ff5a1f';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html, body { margin: 0; padding: 0; background: transparent; overflow: hidden; }
#safe { position: absolute; }
.cue { position: absolute; left: 0; right: 0; box-sizing: border-box; padding: 0.25em; text-align: center; color: ${color}; font-family: ${fontStack};
  font-weight: 700; line-height: 1.15; overflow-wrap: break-word; overflow: hidden; visibility: hidden; will-change: transform, opacity;
  /* The padding keeps this legibility shadow inside the cue box, and so inside the safe area. */
  text-shadow: 0 0 0.12em rgba(0,0,0,0.85), 0 0.04em 0.18em rgba(0,0,0,0.7); }
.cue .rest { visibility: hidden; }
/* #9291 word build: heavy condensed caps, words hold their place as they land. */
.cue.build { text-align: left; font-family: Impact, "Arial Narrow Bold", "Arial Narrow", ${fontStack}; font-weight: 900; text-transform: uppercase; letter-spacing: 0.01em; line-height: 0.98; }
.cue.build .word { visibility: hidden; }
</style></head><body><div id="safe"></div><script>
const CUES = ${scriptJson(payload)};
const SAFE_INSET = ${SAFE_INSET};
const ACCENT = ${scriptJson(accent)};
const cueStateAt = ${cueStateAt.toString()};
const safe = document.getElementById('safe');
const nodes = CUES.map((cue) => {
  const el = document.createElement('div');
  el.className = cue.template === 'build' ? 'cue build' : 'cue';
  const shown = document.createElement('span');
  const rest = document.createElement('span');
  rest.className = 'rest';
  const words = [];
  if (cue.template === 'build') {
    const tokens = cue.words && cue.words.length ? cue.words.map((w) => w.w) : cue.text.split(/\s+/).filter(Boolean);
    tokens.forEach((token, i) => {
      const span = document.createElement('span');
      span.className = 'word';
      span.textContent = token;
      if (i) el.append(' ');
      el.append(span);
      words.push(span);
    });
  } else el.append(shown, rest);
  safe.append(el);
  return { cue, el, shown, rest, words, chars: Array.from(cue.text) };
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
    const build = node.words.length > 0;
    const maxH = safeH * (hero || build ? 0.6 : 0.3);
    if (!build) { node.shown.textContent = node.cue.text; node.rest.textContent = ''; }
    let size = Math.round(base * (build ? 0.13 : hero ? 0.09 : 0.05));
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
    // A word span set visible would show through its hidden cue, so hide both.
    if (!state) { node.el.style.visibility = 'hidden'; node.words.forEach((span) => { span.style.visibility = 'hidden'; }); continue; }
    if (node.words.length) {
      const n = state.visibleWords || 0;
      node.words.forEach((span, i) => {
        span.style.visibility = i < n ? 'visible' : 'hidden';
        span.style.color = i === n - 1 ? ACCENT : '';
      });
      node.el.style.visibility = 'visible';
      node.el.style.opacity = String(state.opacity);
      node.el.style.transform = 'none';
      continue;
    }
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
