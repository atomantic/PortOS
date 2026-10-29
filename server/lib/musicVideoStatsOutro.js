/**
 * Music Video — the cutting room floor outro: an optional closing scene that
 * plays after the song ends under a heading ("Human Directed") and an orange
 * subheading ("Human Imagined") and tallies the work behind the video (every
 * render reviewed, the images and videos generated against the ones used, the
 * cuts, moves and effects placed), over a floor of the stills that did not
 * make it. One record on the project (`project.statsOutro`, null = off) turns
 * it on, sets how long it runs, its two heading lines and which tally lines
 * show; it adds its time after the song and never shortens it.
 *
 * Every count comes from what the project records (`musicVideoOutroStats`):
 * its shots' takes and selections, its media collection and its asset marks.
 * Media deleted from the library drops out of the counts with it.
 *
 * `drawStatsOutro` is the one painter for the storyboard animatic (a canvas
 * over the picture) and the final render (the ending page of
 * lib/musicVideoEnding.js, captured frame by frame and appended to the cut),
 * so both show the same frames. Every frame is a pure
 * function of the scene's own time. Browser-safe, no imports.
 */

export const STATS_OUTRO_LIMITS = Object.freeze({ durationMin: 4, durationMax: 20, textMax: 40 });
/** The tally's lines a project can hide, in the order they show. */
export const STATS_OUTRO_LINES = Object.freeze([
  Object.freeze({ key: 'renders', label: 'Renders reviewed' }),
  Object.freeze({ key: 'images', label: 'Images generated & used' }),
  Object.freeze({ key: 'videos', label: 'Videos generated & used' }),
  Object.freeze({ key: 'edits', label: 'Cuts, moves & effects' }),
  Object.freeze({ key: 'floor', label: 'Left on the floor' }),
]);
export const STATS_OUTRO_DEFAULTS = Object.freeze({
  enabled: false, durationSec: 8, title: 'Human Directed', subtitle: 'Human Imagined', hidden: Object.freeze([]),
});
/** How many unused stills are piled into the floor collage behind the tally. */
export const STATS_OUTRO_FLOOR_MAX = 48;
/** The fonts the scene draws in (bundled OFL faces, registered by each page). */
export const STATS_OUTRO_FONTS = Object.freeze({
  head: Object.freeze({ family: 'MV Archivo', file: 'archivo-variable.woff2' }),
  body: Object.freeze({ family: 'MV Mono', file: 'ibm-plex-mono-500.woff2' }),
});

/**
 * A stored outro from any input (null for none). A heading line left out takes
 * its default; one stored empty stays empty (that line is not drawn).
 */
export function normalizeStatsOutro(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { durationMin, durationMax, textMax } = STATS_OUTRO_LIMITS;
  const raw = typeof input.durationSec === 'number' && Number.isFinite(input.durationSec) ? input.durationSec : STATS_OUTRO_DEFAULTS.durationSec;
  const text = (value, fallback) => (typeof value === 'string' ? value.trim().slice(0, textMax) : fallback);
  const hidden = new Set(Array.isArray(input.hidden) ? input.hidden : []);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : STATS_OUTRO_DEFAULTS.enabled,
    durationSec: Math.round(Math.min(durationMax, Math.max(durationMin, raw)) * 10) / 10,
    title: text(input.title, STATS_OUTRO_DEFAULTS.title),
    subtitle: text(input.subtitle, STATS_OUTRO_DEFAULTS.subtitle),
    hidden: STATS_OUTRO_LINES.map((line) => line.key).filter((key) => hidden.has(key)),
  };
}

/** The seconds the outro adds after the song (0 when it is off). */
export function statsOutroSeconds(input) {
  const outro = normalizeStatsOutro(input);
  return outro?.enabled ? outro.durationSec : 0;
}

const SLOT_KINDS = Object.freeze({ referenceImageId: 'image', endImageId: 'image', videoHistoryId: 'video' });
const TAKE_KINDS = Object.freeze({ image: 'image', endImage: 'image', video: 'video' });

/**
 * The tally from what the project records. `collectionItems` are the rows of
 * the video's media collection (`{ kind, ref }`): every still and clip made
 * for it, including ones no shot holds any more. Returns
 * `{ stills: { made, kept }, clips: { made, kept }, rejected, shots, lipSyncs,
 * transitions, imageEffects, cameraMoves, floorImages }` — `kept` is what a
 * shot uses now, `rejected` the takes rejected or marked ✕ bad, and
 * `floorImages` up to STATS_OUTRO_FLOOR_MAX unused stills (rejected first) to
 * lay on the floor. Pure.
 */
export function musicVideoOutroStats(project, { collectionItems = [] } = {}) {
  const scenes = Array.isArray(project?.scenes) ? project.scenes : [];
  const made = new Set();
  const used = new Set();
  const rejected = new Set();
  const marks = project?.assetMarks && typeof project.assetMarks === 'object' ? project.assetMarks : {};
  const note = (kind, ref) => (kind && typeof ref === 'string' && ref ? `${kind}:${ref}` : null);
  for (const item of Array.isArray(collectionItems) ? collectionItems : []) {
    const key = item?.kind === 'image' || item?.kind === 'video' ? note(item.kind, item.ref) : null;
    if (key) made.add(key);
  }
  let lipSyncs = 0;
  let transitions = 0;
  let imageEffects = 0;
  let cameraMoves = 0;
  for (const scene of scenes) {
    for (const take of Array.isArray(scene?.takes) ? scene.takes : []) {
      const key = note(TAKE_KINDS[take?.kind], take?.assetId);
      if (!key) continue;
      made.add(key);
      if (take.status === 'rejected') rejected.add(key);
    }
    for (const [field, kind] of Object.entries(SLOT_KINDS)) {
      const key = note(kind, scene?.[field]);
      if (key) { made.add(key); used.add(key); }
    }
    if (scene?.shotMode === 'performance') lipSyncs += 1;
    if (scene?.transitionIn) transitions += 1;
    if (scene?.transitionOut) transitions += 1;
    if (scene?.imageEffect) imageEffects += 1;
    if (scene?.camera?.move) cameraMoves += 1;
  }
  for (const [key, mark] of Object.entries(marks)) {
    if (mark === 'bad' && made.has(key)) rejected.add(key);
  }
  // A take put back on a shot is no longer a rejection.
  for (const key of used) rejected.delete(key);
  const count = (keys, kind) => [...keys].filter((key) => key.startsWith(`${kind}:`)).length;
  const unusedStills = [...made].filter((key) => key.startsWith('image:') && !used.has(key)).sort();
  const floorPick = [...unusedStills.filter((key) => rejected.has(key)), ...unusedStills.filter((key) => !rejected.has(key))];
  // Spread over the whole pile rather than its first few, so the floor shows the project's range.
  const step = floorPick.length > STATS_OUTRO_FLOOR_MAX ? floorPick.length / STATS_OUTRO_FLOOR_MAX : 1;
  const floorImages = [];
  for (let i = 0; i < Math.min(STATS_OUTRO_FLOOR_MAX, floorPick.length); i++) floorImages.push(floorPick[Math.floor(i * step)].slice('image:'.length));
  return {
    stills: { made: count(made, 'image'), kept: count(used, 'image') },
    clips: { made: count(made, 'video'), kept: count(used, 'video') },
    rejected: rejected.size,
    shots: scenes.length,
    lipSyncs,
    transitions,
    imageEffects,
    cameraMoves,
    floorImages,
  };
}

/* The functions below are inlined into the render page by toString()
 * (endingPageSource in lib/musicVideoEnding.js), so each must stay self-contained: no references to
 * module scope, only to each other by name. */

/**
 * The tally's lines, in order: `{ key, label, value, accent? }`, `key` naming
 * its STATS_OUTRO_LINES entry. The images and videos lines always show unless
 * `hidden` names them; cuts, moves and effects are left out when there are
 * none. The last line is what was left on the floor.
 */
function statsOutroRows(stats, hidden = []) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
  const s = stats || {};
  const stills = s.stills || {};
  const clips = s.clips || {};
  const rows = [
    { key: 'renders', label: 'Renders reviewed', value: n(stills.made) + n(clips.made) },
    { key: 'images', label: 'Images generated', value: n(stills.made) },
    { key: 'images', label: 'Images used', value: n(stills.kept) },
    { key: 'videos', label: 'Videos generated', value: n(clips.made) },
    { key: 'videos', label: 'Videos used', value: n(clips.kept) },
    { key: 'edits', label: 'Cuts, moves & effects', value: n(s.transitions) + n(s.imageEffects) + n(s.cameraMoves) + n(s.lipSyncs), optional: true },
  ].filter((row) => !row.optional || row.value > 0).map(({ optional: _optional, ...row }) => row);
  const floor = Math.max(0, n(stills.made) - n(stills.kept)) + Math.max(0, n(clips.made) - n(clips.kept));
  rows.push({ key: 'floor', label: 'Left on the floor', value: floor, accent: true });
  const off = Array.isArray(hidden) ? hidden : [];
  return rows.filter((row) => !off.includes(row.key));
}

/**
 * Paint the outro at scene time `t` (0 = the song's last frame) on a
 * width × height 2D context. `images[i]` is the loaded still for
 * `stats.floorImages[i]` (null while loading, or when none). `outro` is the
 * normalized record: its heading, subheading and hidden lines (an empty
 * heading line is not drawn). Everything sits inside the title-safe area and
 * shrinks to fit, at any aspect.
 */
function drawStatsOutro(ctx, { width, height, t, durationSec, stats, outro = null, images = [], fonts = {} }) {
  const head = fonts.head || '"MV Archivo", "Arial Black", Impact, sans-serif';
  const body = fonts.body || '"MV Mono", Menlo, Consolas, "Courier New", monospace';
  const clamp = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const ease = (p) => 1 - Math.pow(1 - clamp(p), 3);
  const D = Math.max(1, Number(durationSec) || 8);
  const unit = Math.min(width, height);
  // Deterministic scatter: the same print lands in the same place on every frame and every page.
  const hash = (i, salt) => {
    const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
  };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  // The floor: a dark, warm edit-bay floor lit from above.
  const floorGrad = ctx.createRadialGradient(width / 2, height * 0.42, unit * 0.1, width / 2, height / 2, Math.max(width, height) * 0.75);
  floorGrad.addColorStop(0, '#2a2420');
  floorGrad.addColorStop(1, '#0b0908');
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, 0, width, height);

  // The floor is a collage: prints and film offcuts piled edge to edge over the whole frame,
  // dropping in one after another. A grid of overlapping, tilted prints leaves no floor showing,
  // and a second, sparser layer on top makes it read as a pile rather than a wall.
  const floorCount = stats && Array.isArray(stats.floorImages) ? stats.floorImages.length : 0;
  const cell = unit * 0.22;
  const cols = Math.ceil(width / cell) + 1;
  const rowsN = Math.ceil(height / (cell * 0.8)) + 1;
  const spots = [];
  for (let r = 0; r < rowsN; r++) {
    for (let c = 0; c < cols; c++) spots.push({ x: (c - 0.5 + (r % 2) * 0.5) * cell, y: (r - 0.5) * cell * 0.8, scale: 1.3 });
  }
  const base = spots.length;
  for (let k = 0; k < Math.ceil(base / 3); k++) spots.push({ x: hash(k, 7) * width, y: hash(k, 8) * height, scale: 1.1 });
  // Shuffled so the pile lands all over the frame rather than row by row.
  const order = spots.map((_, i) => i).sort((a, b) => hash(a, 9) - hash(b, 9));
  const landOrder = [...order.filter((i) => i < base), ...order.filter((i) => i >= base)];
  const dropGap = 1.6 / Math.max(1, landOrder.length);
  landOrder.forEach((spotIndex, i) => {
    const land = ease((t - 0.05 - i * dropGap) / 0.35);
    if (land <= 0) return;
    const spot = spots[spotIndex];
    const size = cell * spot.scale * (0.92 + hash(spotIndex, 1) * 0.2);
    const w = size * 1.25;
    const h = size;
    const x = spot.x + (hash(spotIndex, 2) - 0.5) * cell * 0.35;
    const y = spot.y + (hash(spotIndex, 3) - 0.5) * cell * 0.3 + (1 - land) * -unit * 0.04;
    const drift = t * unit * 0.002 * (0.5 + hash(spotIndex, 4));
    const angle = (hash(spotIndex, 5) - 0.5) * 0.6;
    ctx.save();
    ctx.translate(x + drift, y);
    ctx.rotate(angle);
    ctx.scale(1 + (1 - land) * 0.15, 1 + (1 - land) * 0.15);
    ctx.globalAlpha = land;
    // A soft shadow under each print gives the pile its depth.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    ctx.fillRect(-w / 2 - size * 0.02, -h / 2 + size * 0.04, w + size * 0.1, h + size * 0.14);
    const img = floorCount ? images[spotIndex % floorCount] || null : null;
    const iw = img ? img.naturalWidth || img.width : 0;
    const ih = img ? img.naturalHeight || img.height : 0;
    if (iw > 0 && ih > 0) {
      // A print: a cream border around the still, cropped to fill.
      const border = size * 0.05;
      ctx.fillStyle = '#e9e1cf';
      ctx.fillRect(-w / 2 - border, -h / 2 - border, w + border * 2, h + border * 2.6);
      const scale = Math.max(w / iw, h / ih);
      const sw = w / scale;
      const sh = h / scale;
      ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, -w / 2, -h / 2, w, h);
    } else {
      // A strip of film: dark frame, sprocket holes along both edges.
      ctx.fillStyle = '#1b1715';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.fillStyle = '#3a312b';
      const hole = h * 0.07;
      for (let k = 0; k < 6; k++) {
        const hx = -w / 2 + (k + 0.5) * (w / 6) - hole / 2;
        ctx.fillRect(hx, -h / 2 + hole * 0.6, hole, hole * 0.8);
        ctx.fillRect(hx, h / 2 - hole * 1.4, hole, hole * 0.8);
      }
      ctx.fillStyle = '#2b2420';
      ctx.fillRect(-w / 2 + w * 0.06, -h / 2 + hole * 2, w * 0.88, h - hole * 4);
    }
    ctx.restore();
  });
  // The prints sit in shadow, under the tally.
  ctx.fillStyle = 'rgba(8, 6, 5, 0.5)';
  ctx.fillRect(0, 0, width, height);

  // The tally: an edit log on a dark plate, inside the title-safe area.
  const rows = statsOutroRows(stats, outro && outro.hidden);
  const insetX = width * 0.1;
  const insetY = height * 0.1;
  const safeW = width - insetX * 2;
  const safeH = height - insetY * 2;
  const panelW = height > width ? safeW : Math.min(safeW, Math.max(safeW * 0.62, unit * 1.1));
  const measure = (text, font) => { ctx.font = font; return ctx.measureText(text).width; };
  const fmt = (v) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pad = 0.9; // plate padding, in row heights
  const lineH = 1.5;
  const headScale = 1.45;
  const line = (value) => (typeof value === 'string' ? value.trim().toUpperCase() : '');
  const headText = line(outro ? outro.title : 'Human Directed');
  const subText = line(outro ? outro.subtitle : 'Human Imagined');
  // Fit the block's height first, then its widest line.
  // Plate: padding, heading, subheading, a gap under the rule, the rows, a foot, padding (in units of the row size).
  const headUnits = headText ? headScale : 0;
  const subUnits = subText ? (headText ? 1.25 : 1) : 0;
  const ruled = headUnits + subUnits > 0;
  const blockUnits = pad + headUnits + subUnits + (ruled ? 0.7 : -0.5) + rows.length * lineH + 0.5 + pad;
  let px = safeH / blockUnits;
  const rowFont = (size, weight = 500) => `${weight} ${Math.floor(size * 100) / 100}px ${body}`;
  const headFont = (size) => `800 ${Math.floor(size * 100) / 100}px ${head}`;
  const widest = (size) => Math.max(
    size * 8,
    headText ? measure(headText, headFont(size * headScale)) + size * pad * 2 : 0,
    subText ? measure(subText, rowFont(size, 600)) + size * pad * 2 : 0,
    ...rows.map((row) => measure(row.label.toUpperCase(), rowFont(size)) + measure(fmt(Math.max(row.value, 1000)), rowFont(size, 600)) + size * (2 + pad * 2)),
  );
  const wide = widest(px);
  if (wide > panelW) px *= panelW / wide;
  const plateW = Math.min(panelW, widest(px));
  const plateH = px * blockUnits;
  const left = (width - plateW) / 2;
  const top = (height - plateH) / 2;
  const plateIn = ease((t - 0.25) / 0.6);
  ctx.globalAlpha = plateIn;
  ctx.fillStyle = 'rgba(14, 11, 9, 0.86)';
  ctx.fillRect(left, top, plateW, plateH);
  ctx.strokeStyle = 'rgba(243, 196, 107, 0.55)';
  ctx.lineWidth = Math.max(1, px * 0.06);
  ctx.strokeRect(left + px * 0.25, top + px * 0.25, plateW - px * 0.5, plateH - px * 0.5);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const headY = top + px * pad + px * headUnits;
  if (headText) {
    ctx.font = headFont(px * headScale);
    ctx.fillStyle = '#f3ead7';
    ctx.fillText(headText, width / 2, headY);
  }
  // Under it, the subheading in orange.
  const subY = headY + px * subUnits;
  if (subText) {
    ctx.font = rowFont(px, 600);
    ctx.fillStyle = '#ff8a4c';
    ctx.fillText(subText, width / 2, subY);
  }
  // A rule under the heading.
  if (ruled) {
    ctx.fillStyle = 'rgba(243, 196, 107, 0.7)';
    ctx.fillRect(left + px * pad, subY + px * 0.55, plateW - px * pad * 2, Math.max(1, px * 0.06));
  }
  const rowBase = subY + px * (ruled ? 0.7 : -0.5);
  // Rows arrive one by one in the first half of the scene, each counting up to its number.
  const firstRow = 0.9;
  const stagger = Math.min(0.4, Math.max(0.12, (D * 0.5 - firstRow) / Math.max(1, rows.length)));
  rows.forEach((row, i) => {
    const start = firstRow + i * stagger;
    const show = ease((t - start) / 0.35);
    if (show <= 0) return;
    const counted = row.value * ease((t - start) / 0.9);
    const y = rowBase + px * lineH * (i + 1) + (1 - show) * px * 0.4;
    ctx.globalAlpha = plateIn * show;
    if (row.accent) {
      ctx.fillStyle = 'rgba(255, 122, 61, 0.14)';
      ctx.fillRect(left + px * pad * 0.6, y - px * 1.1, plateW - px * pad * 1.2, px * 1.5);
    }
    ctx.font = rowFont(px, row.accent ? 600 : 500);
    ctx.textAlign = 'left';
    ctx.fillStyle = row.accent ? '#ff8a4c' : '#e8c27a';
    ctx.fillText(row.label.toUpperCase(), left + px * pad, y);
    ctx.font = rowFont(px, 600);
    ctx.textAlign = 'right';
    ctx.fillStyle = row.accent ? '#ffb27a' : '#f3ead7';
    ctx.fillText(fmt(counted), left + plateW - px * pad, y);
  });

  // CRT scanlines over the whole frame, faint.
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#000';
  const gap = Math.max(2, Math.round(height / 270));
  for (let y = 0; y < height; y += gap * 2) ctx.fillRect(0, y, width, gap);
  // In from black, out to black.
  const dark = Math.max(1 - clamp(t / 0.6), clamp((t - (D - 0.8)) / 0.8));
  if (dark > 0) {
    ctx.globalAlpha = dark;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.restore();
}

export { statsOutroRows, drawStatsOutro };
