/* Kinetic lyric type — the shared PortOS lyric-motion module.
 *
 * Any composition document can draw its sung words with one consistent look:
 *
 *   import { createLyricType } from './lyricType.js';
 *   const lyricType = createLyricType(window.PORTOS_MV);
 *   await lyricType.ready;                       // the bundled faces are loaded
 *   lyricType.draw(ctx, t, { width, height });   // every frame, after the picture
 *
 * Link lyricType.css from the page so the bundled faces (Archivo variable widths,
 * IBM Plex Mono, OFL licences in fonts/) are declared; PortOS adds lyricType.js,
 * lyricType.css and those fonts to any document that references this module.
 *
 * Everything is driven by the song data PortOS writes (no hard-coded seconds):
 * lines come from PORTOS_MV.lyrics with their aligned word times, the role of each
 * line from PORTOS_MV.lyricMarkers (section headers and delivery directions), and
 * the text zone from the shot under the line (scenes[].textZone / lyricRole).
 *
 * Roles:
 *   line   default sung line: words rise and fade in on their onsets, the line
 *          drifts up and fades out 0.3s after its last word ends, once that
 *          word has shown for 0.8s.
 *   hook   chorus / title phrases: wide caps, centred in the zone (the lower band
 *          unless the shot names one), each word slams in on its onset, one
 *          outline-only accent word, cut on the next beat. A chorus phrase slams
 *          the first time it is sung; later repeats come back as sung lines.
 *   stamp  short punches, negations, spoken lines: a three-frame stamp with a
 *          small tilt, optional strike-through.
 *   data   HUD captions, counters and tags in mono; numbers roll. At most one
 *          per shot. Set large enough to read on a phone, on an ink plate by
 *          default (`dataBacking: 'outline'` rings each word in ink instead), so
 *          a corner readout reads on a light picture either way.
 *
 * Type stays out of the way of the picture: each caption covers at most a small
 * share of the frame (LYRIC_FIT.maxCover by role) and shrinks to fit, never below
 * the phone-legible floor (LYRIC_TIMING.minPx at 1080px on the short side).
 *
 * Every frame is a pure function of song time, so a draft frame matches the full
 * render at that time. The file is plain ES2020 with no imports.
 */

export const LYRIC_ROLES = Object.freeze(['line', 'hook', 'stamp', 'data']);
export const TEXT_ZONES = Object.freeze(['lower-left', 'upper-right', 'upper', 'lower', 'center', 'none', 'lower-right', 'upper-left']);
// A shot's lyric size scales the type's own size (and its share of the frame); null is normal.
export const LYRIC_SIZE_SCALE = Object.freeze({ small: 0.8, large: 1.25 });

export const DEFAULT_PALETTE = Object.freeze({ fill: '#f3ead7', ink: '#141217', accent: '#ff5a1f', strike: '#ff2a2a' });
export const DEFAULT_FONTS = Object.freeze({ display: '"MV Archivo", "Arial Black", Impact, sans-serif', mono: '"MV Mono", Menlo, monospace' });

// Section kinds (lyricMarkers.js) and delivery directions that pick a role.
const HOOK_SECTIONS = new Set(['chorus', 'hook', 'refrain', 'post-chorus', 'drop']);
const STAMP_DIRECTIONS = new Set(['spoken', 'shouted', 'hits']);
const SECTION_LABEL_KINDS = [
  [/^pre[\s-]?chorus\b/i, 'pre-chorus'], [/^post[\s-]?chorus\b/i, 'post-chorus'],
  [/\b(chorus|hook|refrain|drop)\b/i, null], [/\bspoken\b/i, 'spoken'],
];

// Motion constants (seconds unless noted), at 1080px on the short side.
export const LYRIC_TIMING = Object.freeze({
  lineRiseSec: 0.2, lineRisePx: 16, lineExitDelaySec: 0.3, lineExitFrames: 8,
  hookSlamSec: 0.22, hookSlamFrom: 1.35, stampFrames: 3, stampFrom: 1.25, stampTiltDeg: 2,
  strikeSec: 0.2, dataRollSec: 0.4, minOnScreenSec: 0.8, lastWordHoldSec: 0.8, minPx: 56,
});

// How much of the frame one caption may cover (fraction of width × height, at its
// full size), and its starting size at 1080px on the short side.
export const LYRIC_FIT = Object.freeze({
  maxCover: Object.freeze({ line: 0.06, stamp: 0.06, hook: 0.1, data: 0.04 }),
  basePx: Object.freeze({ line: 60, stamp: 84, hook: 112, hookPortrait: 96, data: 48 }),
  maxRows: 2,
});

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const finite = (n) => typeof n === 'number' && Number.isFinite(n);
const easeOutCubic = (k) => 1 - Math.pow(1 - clamp(k), 3);
// A light spring that overshoots once and settles by k = 1.
const spring = (k) => { k = clamp(k); return 1 - Math.cos(k * Math.PI * 1.5) * Math.exp(-5 * k); };
const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
const norm = (s) => String(s).toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9']/g, '');

function lastAtOrBefore(sorted, t) {
  let lo = 0; let hi = sorted.length - 1; let r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

/** The role a section kind or label implies (`hook` for choruses, else null). */
function roleForSection(kindOrLabel) {
  if (!kindOrLabel) return null;
  const value = String(kindOrLabel).trim().toLowerCase();
  if (HOOK_SECTIONS.has(value)) return 'hook';
  if (STAMP_DIRECTIONS.has(value)) return 'stamp';
  for (const [pattern, kind] of SECTION_LABEL_KINDS) {
    if (!pattern.test(value)) continue;
    if (kind === 'pre-chorus') return null;
    if (kind === 'spoken') return 'stamp';
    return 'hook';
  }
  return null;
}

/**
 * The role for each lyric line (by index), resolved in order: an explicit
 * per-line override (`overrides[lineId]` or `overrides[index]`), the line's own
 * `role`, the delivery direction marked on that line, the section the line sits
 * in (lyricMarkers section headers, else the timed song section's label), else
 * `line`. A role that is not one of LYRIC_ROLES is ignored.
 */
function resolveLineRoles(lines, { lyricMarkers = [], sections = [], overrides = {} } = {}) {
  const valid = (role) => (LYRIC_ROLES.includes(role) ? role : null);
  const markers = (Array.isArray(lyricMarkers) ? lyricMarkers : []).filter((m) => m && Number.isInteger(m.line));
  const sectionMarkers = markers.filter((m) => m.type === 'section').sort((a, b) => a.line - b.line);
  const timedSections = (Array.isArray(sections) ? sections : []).filter((s) => finite(s?.startSec)).sort((a, b) => a.startSec - b.startSec);
  return lines.map((line, index) => {
    const override = valid(overrides?.[line?.id]) || valid(overrides?.[index]);
    if (override) return override;
    if (valid(line?.role)) return line.role;
    const direction = markers.find((m) => m.type === 'direction' && m.line === index);
    const fromDirection = direction ? roleForSection(direction.kind) : null;
    if (fromDirection) return fromDirection;
    const header = sectionMarkers.filter((m) => m.line <= index).pop();
    if (header) return roleForSection(header.kind || header.label) || 'line';
    const onset = finite(line?.startSec) ? line.startSec : null;
    const timed = onset == null ? null : timedSections.filter((s) => s.startSec <= onset + 1e-6).pop();
    return roleForSection(timed?.label) || 'line';
  });
}

/**
 * Per-word onsets for a line. Aligned words (`words[].startSec`) are used as they
 * are; a line with one timing for several tokens is matched against the song's
 * aligned words in its window, else spread across the line's first 80%.
 */
function wordsForLine(line, songWords = []) {
  const text = String(line?.text || '').trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  const timed = (Array.isArray(line?.words) ? line.words : [])
    .map((w) => ({ text: String(w?.text ?? w?.w ?? '').trim(), startSec: w?.startSec, endSec: w?.endSec }))
    .filter((w) => w.text && finite(w.startSec));
  if (timed.length > 1 || (timed.length === 1 && tokens.length <= 1)) {
    return timed.map((w) => ({ text: w.text, startSec: w.startSec, endSec: finite(w.endSec) && w.endSec > w.startSec ? w.endSec : null }));
  }
  const start = finite(line?.startSec) ? line.startSec : timed[0]?.startSec;
  if (!finite(start) || !tokens.length) return [];
  const end = finite(line?.endSec) && line.endSec > start ? line.endSec : start + Math.max(1, tokens.length * 0.35);
  const pool = (Array.isArray(songWords) ? songWords : [])
    .filter((w) => finite(w?.startSec) && w.startSec >= start - 0.35 && w.startSec <= end + 0.2)
    .sort((a, b) => a.startSec - b.startSec);
  const out = []; let j = 0;
  for (const token of tokens) {
    const key = norm(token);
    let hit = null;
    for (let k = j; k < pool.length; k++) {
      const p = norm(pool[k].w ?? pool[k].text ?? '');
      if (p && (p === key || (key.length > 3 && p.startsWith(key.slice(0, 4))))) { hit = pool[k]; j = k + 1; break; }
    }
    out.push({ text: token, startSec: hit ? hit.startSec : null, endSec: hit && finite(hit.endSec) ? hit.endSec : null });
  }
  if (out.some((w) => w.startSec == null)) {
    const span = Math.max(0.2, (end - start) * 0.8);
    out.forEach((w, i) => { w.startSec = start + (i * span) / Math.max(1, out.length); w.endSec = null; });
    out[out.length - 1].endSec = end;
  }
  return out;
}

/**
 * When a line leaves the screen. A line never shows before its first onset and
 * stays at least LYRIC_TIMING.minOnScreenSec, and its last word at least
 * LYRIC_TIMING.lastWordHoldSec, so a short final word is read before the line
 * leaves; only another cue taking its zone cuts it sooner.
 * `line`/`data` fade 0.3s after the last word ends (or once it has held), finishing by the next cue in
 * their zone (or cutting at its onset when a full fade cannot fit). A `stamp`
 * cuts after its hold; a `hook` cuts on the next beat (or at the next cue if that comes first), with no fade.
 */
function lineWindow(words, role, { beats = [], nextOnset = null, fps = 24, endSec = null } = {}) {
  const T = LYRIC_TIMING;
  const onset = words[0].startSec;
  const last = words[words.length - 1];
  const lastEnd = Math.max(...words.map((w) => (finite(w.endSec) ? w.endSec : w.startSec)), finite(endSec) ? endSec : -Infinity);
  const minExit = Math.max(onset + T.minOnScreenSec, last.startSec + T.lastWordHoldSec);
  if (role === 'hook') {
    const sorted = beats.filter(finite);
    const from = Math.max(lastEnd, last.startSec, minExit);
    const index = lastAtOrBefore(sorted, from - 1e-6) + 1;
    let exitSec = index < sorted.length ? sorted[index] : from + T.lineExitDelaySec;
    // Never hold past the next cue: two hooks on screen together would collide.
    if (finite(nextOnset) && nextOnset > onset && nextOnset < exitSec) exitSec = nextOnset;
    return { startSec: onset, exitSec, endSec: exitSec };
  }
  let exitSec = lastEnd + T.lineExitDelaySec;
  if (finite(nextOnset) && nextOnset < exitSec) exitSec = nextOnset;
  exitSec = Math.max(exitSec, minExit);
  const fade = role === 'stamp' ? 0 : T.lineExitFrames / fps;
  if (role !== 'stamp' && finite(nextOnset)) {
    // Zone turnover outranks the minimum hold: never crossfade two captions.
    if (nextOnset - fade < minExit) return { startSec: onset, exitSec: nextOnset, endSec: nextOnset };
    exitSec = Math.min(exitSec, nextOnset - fade);
    return { startSec: onset, exitSec, endSec: Math.min(exitSec + fade, nextOnset) };
  }
  return { startSec: onset, exitSec, endSec: exitSec + fade };
}

// The lyric zones a title card in each spot (TITLE_CARD_POSITIONS) would collide with, and where a
// line steps to instead: the same side across the frame, else the first clear corner.
const TITLE_CARD_ZONES = Object.freeze({
  'lower-left': ['lower-left', 'lower'], 'lower-right': ['lower-right', 'lower'],
  'upper-left': ['upper-left', 'upper'], 'upper-right': ['upper-right', 'upper'],
  'lower-center': ['lower', 'lower-left', 'lower-right'], center: ['center'],
});
const ZONE_FLIP = Object.freeze({
  'lower-left': 'upper-left', 'lower-right': 'upper-right', lower: 'upper',
  'upper-left': 'lower-left', 'upper-right': 'lower-right', upper: 'lower', center: 'lower',
});
const ZONE_FALLBACKS = Object.freeze(['upper-right', 'upper-left', 'lower-right', 'lower-left']);

// The strict edges of the Shorts, Reels and TikTok control bands, as fractions of a portrait frame:
// one rectangle clears all three. Only the type moves; the picture stays full-bleed.
const SOCIAL_SAFE = Object.freeze({ top: 0.15, bottom: 0.35, left: 0.06, right: 0.18 });

// Each zone keeps its own shape and anchor, moved into the social-safe band.
function socialZoneRect(zone, width, height) {
  const x = width * SOCIAL_SAFE.left;
  const w = width * (1 - SOCIAL_SAFE.left - SOCIAL_SAFE.right);
  const top = height * SOCIAL_SAFE.top;
  const bottom = height * (1 - SOCIAL_SAFE.bottom);
  const h = height * 0.3;
  const upper = (name, align) => ({ zone: name, x, y: top, w, h, align, anchor: 'top', social: true });
  const lower = (name, align) => ({ zone: name, x, y: bottom - h, w, h, align, anchor: 'bottom', social: true });
  switch (zone) {
    case 'none': return null;
    case 'center': {
      const ch = height * 0.4;
      return { zone, x, y: top + (bottom - top - ch) / 2, w, h: ch, align: 'center', anchor: 'middle', social: true };
    }
    case 'upper': return upper(zone, 'center');
    case 'lower': return lower(zone, 'center');
    case 'upper-right': return upper(zone, 'right');
    case 'upper-left': return upper(zone, 'left');
    case 'lower-right': return lower(zone, 'right');
    default: return lower('lower-left', 'left');
  }
}

/**
 * The pixel box a text zone allows on a width × height frame (null for `none`). A portrait frame
 * uses the social-safe band unless `layout` is `cinematic`; other frames keep the framed insets.
 */
function zoneRect(zone, width, height, { layout = 'social' } = {}) {
  const portrait = height > width;
  if (portrait && layout !== 'cinematic') return socialZoneRect(zone, width, height);
  const unit = Math.min(width, height) / 1080;
  const insetX = Math.max(72 * unit, width * 0.06);
  const insetY = Math.max(72 * unit, height * 0.07);
  switch (zone) {
    case 'none': return null;
    case 'center':
      return { zone, x: insetX, y: height * 0.3, w: width - 2 * insetX, h: height * 0.4, align: 'center', anchor: 'middle' };
    case 'upper':
      return { zone, x: insetX, y: insetY, w: width - 2 * insetX, h: height * 0.3, align: 'center', anchor: 'top' };
    case 'lower': {
      const h = height * 0.3;
      return { zone, x: insetX, y: height - insetY - h, w: width - 2 * insetX, h, align: 'center', anchor: 'bottom' };
    }
    case 'upper-right': {
      const w = portrait ? width - 2 * insetX : width * 0.46;
      return { zone, x: width - insetX - w, y: insetY, w, h: height * 0.3, align: 'right', anchor: 'top' };
    }
    case 'upper-left': {
      const w = portrait ? width - 2 * insetX : width * 0.46;
      return { zone, x: insetX, y: insetY, w, h: height * 0.3, align: 'left', anchor: 'top' };
    }
    case 'lower-right': {
      const w = portrait ? width - 2 * insetX : width * 0.5;
      const h = height * 0.3;
      return { zone, x: width - insetX - w, y: height - insetY - h, w, h, align: 'right', anchor: 'bottom' };
    }
    case 'lower-left':
    default: {
      const w = portrait ? width - 2 * insetX : width * 0.5;
      const h = height * 0.3;
      return { zone: 'lower-left', x: insetX, y: height - insetY - h, w, h, align: 'left', anchor: 'bottom' };
    }
  }
}

/** Word-wrap `items` into rows no wider than `maxW` (measure returns a width). */
function wrap(items, maxW, measure) {
  const rows = []; let row = []; let width = 0;
  for (const item of items) {
    const w = measure(item);
    if (row.length && width + w > maxW) { rows.push(row); row = []; width = 0; }
    row.push(item); width += w;
  }
  if (row.length) rows.push(row);
  return rows;
}

// The hook's outline-only accent word: the longest word (first on a tie).
function accentIndexOf(words) {
  let best = 0;
  words.forEach((w, i) => { if (norm(w.text).length > norm(words[best].text).length) best = i; });
  return words.length > 1 ? best : -1;
}

function rollNumbers(text, k) {
  if (k >= 1) return text;
  return text.replace(/\d+(?:\.\d+)?/g, (match) => {
    const decimals = match.includes('.') ? match.split('.')[1].length : 0;
    return (Number(match) * easeOutCubic(k)).toFixed(decimals);
  });
}

/**
 * Build the lyric plan and its renderer.
 *
 * `mv` is window.PORTOS_MV (lyrics, lyricMarkers, song, scenes, render). Options:
 *   lines        explicit lines `[{ text, startSec, endSec?, words?, role?, zone?, strike? }]`
 *                instead of mv.lyrics (the layered template passes its text cues)
 *   overrides    `{ [lineId | index]: role }`
 *   sectionRoles `{ [sectionKind]: role }` — e.g. `{ verse: 'stamp' }`
 *   palette      `{ fill, ink, accent, strike }`; fonts `{ display, mono }`
 *   defaultZone  zone for a shot without textZone (hooks default to `lower`)
 *   hookRepeats  'line' (default): a chorus phrase slams once, its repeats are sung
 *                lines; 'hook' slams every time. Roles set explicitly (a line's role,
 *                overrides, sectionRoles, a shot's lyricRole) are kept as they are.
 *   boil         `{ px, fps }` ink-boil jitter (off by default; share the scene's line boil)
 *   exclusive    a visible hook hides the other roles (default true)
 *   dataBacking  how a data readout stays legible: 'plate' (an ink plate behind it,
 *                the default) or 'outline' (each word ringed in ink, no plate)
 */
// portos-lyric-overlay-visibility: 1

export function createLyricType(mv = globalThis.PORTOS_MV, options = {}) {
  const T = LYRIC_TIMING;
  const fps = mv?.render?.fps || 24;
  const palette = { ...DEFAULT_PALETTE, ...(options.palette || {}) };
  const fonts = { ...DEFAULT_FONTS, ...(options.fonts || {}) };
  const dataPlate = options.dataBacking !== 'outline';
  const beats = (mv?.song?.beats || []).filter(finite).slice().sort((a, b) => a - b);
  const songWords = mv?.song?.words || [];
  const scenes = (mv?.scenes || [])
    .filter((s) => finite(s?.startSec) && finite(s?.endSec) && s.endSec > s.startSec)
    .slice().sort((a, b) => a.startSec - b.startSec);
  const sceneAt = (t) => scenes.filter((s) => s.startSec <= t + 1e-6 && t < s.endSec).pop() || null;
  const source = (Array.isArray(options.lines) ? options.lines
    : mv?.composition?.lyricOverlayEnabled === false ? [] : (mv?.lyrics || []))
    .filter((l) => l && String(l.text || '').trim());
  const roles = resolveLineRoles(source, {
    lyricMarkers: options.lines ? [] : mv?.lyricMarkers,
    sections: mv?.song?.sections,
    overrides: options.overrides,
  });
  const sectionRoles = options.sectionRoles || {};
  const lyricLayout = options.lyricLayout || mv?.project?.lyricLayout || 'social';
  const timed = source.map((line, index) => {
    const words = wordsForLine(line, songWords);
    if (!words.length) return null;
    let role = roles[index];
    const pinned = !!(line.role || options.overrides?.[line.id] || options.overrides?.[index]);
    let explicit = pinned;
    const section = (mv?.song?.sections || []).filter((s) => finite(s?.startSec) && s.startSec <= words[0].startSec + 1e-6).pop();
    const kind = section?.label ? String(section.label).trim().toLowerCase().replace(/\s+\d+$/, '') : null;
    if (!pinned && LYRIC_ROLES.includes(sectionRoles[kind])) { role = sectionRoles[kind]; explicit = true; }
    const shot = sceneAt(words[0].startSec);
    // The shot's lyricRole outranks sectionRoles; only a line's own role or an override outranks it.
    if (!pinned && LYRIC_ROLES.includes(shot?.lyricRole)) { role = shot.lyricRole; explicit = true; }
    return { index, id: line.id ?? null, text: String(line.text).trim(), role, explicit, words, strike: !!line.strike, endSec: line.endSec, shot, zoneOf: line.zone };
  }).filter(Boolean).sort((a, b) => a.words[0].startSec - b.words[0].startSec);

  // A chorus phrase slams the first time it is sung; its repeats are sung lines.
  if (options.hookRepeats !== 'hook') {
    const slammed = new Set();
    for (const line of timed) {
      if (line.role !== 'hook' || line.explicit) continue;
      const key = line.words.map((w) => norm(w.text)).join(' ');
      if (slammed.has(key)) line.role = 'line'; else slammed.add(key);
    }
  }
  // While the title card shows, a line placed by default steps off the card's corner; a zone the
  // line or its shot names stays where it was put.
  const card = mv?.titleCard;
  const cardWindows = (Array.isArray(card?.windows) ? card.windows : []).filter((w) => finite(w?.startSec) && finite(w?.endSec));
  const cardZones = TITLE_CARD_ZONES[card?.position] || [];
  const clearOfCard = (zone, line) => {
    if (!cardZones.includes(zone)) return zone;
    const from = line.words[0].startSec;
    const until = Math.max(finite(line.endSec) ? line.endSec : 0, line.words[line.words.length - 1].endSec ?? from) + T.lastWordHoldSec + T.lineExitDelaySec;
    if (!cardWindows.some((w) => from < w.endSec && until > w.startSec)) return zone;
    return [ZONE_FLIP[zone], ...ZONE_FALLBACKS].find((other) => other && !cardZones.includes(other)) || zone;
  };
  const zoned = timed.map(({ zoneOf, explicit, ...line }) => {
    const named = zoneOf || line.shot?.textZone;
    const zone = named || clearOfCard(line.role === 'hook' ? 'lower' : options.defaultZone || 'lower-left', line);
    return { ...line, zone: TEXT_ZONES.includes(zone) ? zone : 'lower-left' };
  });

  // At most one data caption per shot: later ones in the same shot fall back to `line`.
  const dataShots = new Set();
  for (const line of zoned) {
    if (line.role !== 'data') continue;
    const key = line.shot?.sceneId ?? `t${Math.floor(line.words[0].startSec)}`;
    if (dataShots.has(key)) line.role = 'line'; else dataShots.add(key);
  }
  const lines = zoned.map((line, i) => {
    const next = zoned.slice(i + 1).find((other) => line.role === 'line' || line.role === 'data'
      ? other.zone === line.zone
      : other.role === line.role);
    const window = lineWindow(line.words, line.role, { beats, nextOnset: next?.words[0].startSec ?? null, fps, endSec: line.role === 'hook' ? line.endSec : null });
    return { ...line, ...window, accent: line.role === 'hook' ? accentIndexOf(line.words) : -1 };
  });

  const exclusive = options.exclusive !== false;
  /** Lines on screen at t (none before a line's first onset). */
  function linesAt(t) {
    const on = lines.filter((l) => t >= l.startSec - 1e-6 && t < l.endSec && l.zone !== 'none');
    if (exclusive && on.some((l) => l.role === 'hook')) return on.filter((l) => l.role === 'hook');
    return on;
  }

  /** Per-word visual state for a line at t (pure; drawing reads it). */
  function wordStates(line, t) {
    return line.words.map((w, i) => {
      const since = t - w.startSec;
      if (since < -1e-6) return { ...w, index: i, shown: false };
      switch (line.role) {
        case 'hook': {
          const k = clamp(since / T.hookSlamSec);
          return { ...w, index: i, shown: true, alpha: 1, scale: T.hookSlamFrom + (1 - T.hookSlamFrom) * spring(k), dy: 0, tilt: 0 };
        }
        case 'stamp': {
          const k = clamp(since / (T.stampFrames / fps));
          const tilt = (hash(line.index * 31 + i) < 0.5 ? -1 : 1) * T.stampTiltDeg * (1 - k);
          return { ...w, index: i, shown: true, alpha: 1, scale: T.stampFrom + (1 - T.stampFrom) * k, dy: 0, tilt };
        }
        default: {
          const k = easeOutCubic(since / T.lineRiseSec);
          return { ...w, index: i, shown: true, alpha: k, scale: 1, dy: (1 - k) * T.lineRisePx, tilt: 0 };
        }
      }
    });
  }

  function lineExit(line, t) {
    if (t < line.exitSec || line.role === 'hook' || line.role === 'stamp') return { alpha: 1, dy: 0 };
    const k = clamp((t - line.exitSec) / Math.max(1e-6, line.endSec - line.exitSec));
    return { alpha: 1 - k, dy: -T.lineRisePx * 1.5 * easeOutCubic(k) };
  }

  const fontFor = (role, px) => {
    if (role === 'hook') return `900 extra-expanded ${Math.round(px)}px ${fonts.display}`;
    if (role === 'stamp') return `900 ${Math.round(px)}px ${fonts.display}`;
    if (role === 'data') return `500 ${Math.round(px)}px ${fonts.mono}`;
    return `700 ${Math.round(px)}px ${fonts.display}`;
  };
  const basePx = (role, unit, portrait) => {
    const B = LYRIC_FIT.basePx;
    if (role === 'hook') return (portrait ? B.hookPortrait : B.hook) * unit;
    return (B[role] || B.line) * unit;
  };

  /** Layout of a line in its zone: rows of words with x/y, font size (pure given measure). */
  function layout(line, width, height, measure) {
    const rect = zoneRect(line.zone, width, height, { layout: lyricLayout });
    if (!rect) return null;
    const unit = Math.min(width, height) / 1080;
    const floor = (line.role === 'data' ? 40 : T.minPx) * unit;
    const scale = LYRIC_SIZE_SCALE[line.shot?.lyricSize] || 1;
    let px = Math.max(floor, basePx(line.role, unit, height > width) * scale);
    const items = line.words.map((w) => (line.role === 'hook' ? String(w.text).toUpperCase() : w.text));
    const rowsAt = (size) => {
      const list = items.map((text, index) => ({ text, index }));
      const width = (item) => measure(`${item.text} `, fontFor(line.role, size));
      const rows = wrap(list, rect.w, width);
      if (rows.length < 2) return rows;
      // Balance the rows (no lone last word): the narrowest width that keeps the row count.
      let lo = rect.w / rows.length; let hi = rect.w;
      for (let k = 0; k < 12; k++) { const mid = (lo + hi) / 2; if (wrap(list, mid, width).length > rows.length) lo = mid; else hi = mid; }
      return wrap(list, hi, width);
    };
    let rows = rowsAt(px);
    const lineHOf = (size) => size * (line.role === 'data' ? 1.3 : 1.02);
    // The area the caption's rows cover at a size (row widths × row height).
    const cover = (size, at) => at.reduce((sum, row) => sum + row.reduce((w, item) => w + measure(`${item.text} `, fontFor(line.role, size)), 0), 0) * lineHOf(size);
    const budget = (LYRIC_FIT.maxCover[line.role] ?? LYRIC_FIT.maxCover.line) * scale * scale * width * height;
    while ((rows.length > LYRIC_FIT.maxRows || rows.length * px * 1.05 > rect.h || cover(px, rows) > budget) && px > floor + 1e-6) { px = Math.max(floor, px * 0.9); rows = rowsAt(px); }
    const lineH = lineHOf(px);
    const blockH = rows.length * lineH;
    const top = rect.anchor === 'top' ? rect.y + px : rect.anchor === 'middle' ? rect.y + (rect.h - blockH) / 2 + px * 0.85 : rect.y + rect.h - blockH + px * 0.85;
    const placed = [];
    rows.forEach((row, r) => {
      const widths = row.map((item) => measure(`${item.text} `, fontFor(line.role, px)));
      const spaceW = measure(' ', fontFor(line.role, px));
      const rowW = widths.reduce((a, b) => a + b, 0) - spaceW;
      let x = rect.align === 'left' ? rect.x : rect.align === 'right' ? rect.x + rect.w - rowW : rect.x + (rect.w - rowW) / 2;
      row.forEach((item, k) => {
        // Words scale about their own centre, so a slam may grow only until it meets the nearer zone edge.
        const ink = widths[k] - spaceW;
        const room = 2 * Math.min(x + ink / 2 - rect.x, rect.x + rect.w - (x + ink / 2));
        placed.push({ index: item.index, text: item.text, x, y: top + r * lineH, w: widths[k], maxScale: ink > 0 ? Math.max(1, room / ink) : 1 });
        x += widths[k];
      });
    });
    // At the legibility floor a line can still overflow its box: a single word wider than the box
    // or more rows than it is tall. The shrink above stops there, so say so instead of drawing over the band.
    const widest = Math.max(0, ...rows.map((row) => row.reduce((w, item) => w + measure(`${item.text} `, fontFor(line.role, px)), 0) - measure(' ', fontFor(line.role, px))));
    const fits = blockH <= rect.h + 1e-6 && widest <= rect.w + 1e-6;
    return { rect, px, rows: rows.length, words: placed, fits };
  }

  /**
   * The lines in the social-safe band that cannot fit it, as `{ startSec, endSec, text }`, optionally
   * only those showing in [window.startSec, window.endSec). Empty on any frame that keeps the framed insets.
   */
  function unfit(ctx, { width = ctx.canvas?.width, height = ctx.canvas?.height, startSec = -Infinity, endSec = Infinity } = {}) {
    const measure = (str, font) => { ctx.font = font; return ctx.measureText(str).width; };
    return lines.filter((line) => {
      const from = line.words[0].startSec;
      const until = line.words[line.words.length - 1].endSec ?? from;
      if (!(from < endSec && until > startSec)) return false;
      const placed = layout(line, width, height, measure);
      return !!placed?.rect.social && !placed.fits;
    }).map((line) => ({ startSec: line.words[0].startSec, endSec: line.words[line.words.length - 1].endSec ?? line.words[0].startSec, text: line.text }));
  }

  function boilOffset(seed, t, unit) {
    const boil = options.boil;
    if (!boil || !(boil.px > 0)) return [0, 0];
    const step = Math.floor(t * (boil.fps || 12));
    return [(hash(seed * 7.1 + step) - 0.5) * 2 * boil.px * unit, (hash(seed * 3.3 + step + 91) - 0.5) * 2 * boil.px * unit];
  }

  /** Draw every visible line at song time t onto a 2D context. */
  function draw(ctx, t, { width = ctx.canvas?.width, height = ctx.canvas?.height } = {}) {
    const unit = Math.min(width, height) / 1080;
    const measure = (str, font) => { ctx.font = font; return ctx.measureText(str).width; };
    for (const line of linesAt(t)) {
      const placed = layout(line, width, height, measure);
      if (!placed) continue;
      const states = wordStates(line, t);
      const exit = lineExit(line, t);
      const font = fontFor(line.role, placed.px);
      const outline = Math.max(2, (line.role === 'data' ? 9 : 11) * unit * (placed.px / basePx(line.role, unit, height > width)));
      ctx.save();
      ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = outline;
      if (line.role === 'data' && dataPlate && placed.words.some((w) => states[w.index].shown)) {
        // One plate for the whole readout, sized to its full text so it doesn't grow as words appear.
        const pad = placed.px * 0.35;
        const x0 = Math.min(...placed.words.map((w) => w.x)) - pad;
        const x1 = Math.max(...placed.words.map((w) => w.x + w.w - measure(' ', font))) + pad;
        const y0 = Math.min(...placed.words.map((w) => w.y)) - placed.px * 0.85 - pad * 0.6;
        const y1 = Math.max(...placed.words.map((w) => w.y)) + placed.px * 0.25 + pad * 0.6;
        ctx.save();
        ctx.globalAlpha = clamp(0.88 * exit.alpha);
        ctx.fillStyle = palette.ink;
        ctx.translate(0, exit.dy * unit);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x0, y0, x1 - x0, y1 - y0, pad * 0.5); else ctx.rect(x0, y0, x1 - x0, y1 - y0);
        ctx.fill();
        ctx.restore();
      }
      for (const word of placed.words) {
        const s = states[word.index];
        if (!s.shown) continue;
        const [bx, by] = boilOffset(line.index * 17 + word.index, t, unit);
        const cx = word.x + (word.w - measure(' ', font)) / 2;
        ctx.save();
        ctx.font = font;
        ctx.globalAlpha = clamp(s.alpha * exit.alpha);
        ctx.translate(cx + bx, word.y + (s.dy + exit.dy) * unit + by);
        if (s.tilt) ctx.rotate((s.tilt * Math.PI) / 180);
        const scale = Math.min(s.scale, word.maxScale);
        if (scale !== 1) ctx.scale(scale, scale);
        const text = line.role === 'data' ? rollNumbers(word.text, (t - s.startSec) / T.dataRollSec) : word.text;
        const x0 = -(word.w - measure(' ', font)) / 2;
        if (line.role === 'data') {
          if (!dataPlate) { ctx.strokeStyle = palette.ink; ctx.strokeText(text, x0, 0); }
          ctx.fillStyle = palette.accent; ctx.fillText(text, x0, 0);
        } else if (line.role === 'hook' && word.index === line.accent) {
          ctx.lineWidth = outline * 1.6;
          ctx.strokeStyle = palette.ink; ctx.strokeText(text, x0, 0);
          ctx.lineWidth = outline;
          ctx.strokeStyle = palette.fill; ctx.strokeText(text, x0, 0);
        } else {
          ctx.strokeStyle = palette.ink; ctx.strokeText(text, x0, 0);
          ctx.fillStyle = palette.fill; ctx.fillText(text, x0, 0);
        }
        ctx.restore();
      }
      if (line.role === 'stamp' && line.strike) {
        const k = clamp((t - line.words[line.words.length - 1].startSec) / T.strikeSec);
        const first = placed.words[0]; const last = placed.words[placed.words.length - 1];
        const y = first.y - placed.px * 0.32;
        const x0 = first.x; const x1 = last.x + last.w - measure(' ', font);
        ctx.globalAlpha = exit.alpha; ctx.strokeStyle = palette.strike; ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(3, placed.px * 0.09);
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + (x1 - x0) * k, y); ctx.stroke();
      }
      ctx.restore();
    }
  }

  const faces = [fontFor('line', 40), fontFor('hook', 40), fontFor('stamp', 40), fontFor('data', 20)];
  const ready = typeof document !== 'undefined' && document.fonts?.load
    ? Promise.all(faces.map((face) => document.fonts.load(face))).then(() => true)
    : Promise.resolve(true);

  return { lines, linesAt, wordStates, layout, unfit, draw, ready, palette, fonts };
}

// Classic-script templates (the layered engine) reach the module through this global.
if (typeof globalThis !== 'undefined') globalThis.PORTOS_LYRIC_TYPE = { createLyricType, zoneRect, SOCIAL_SAFE, LYRIC_ROLES, TEXT_ZONES, LYRIC_FIT, LYRIC_SIZE_SCALE };
