/**
 * Music Video cover lettering, as a pure function of a song's cover design.
 *
 * The design vocabulary (`COVER_DESIGN_OPTIONS`), the normalizer that accepts
 * any stored design, and `coverOverlaySvg`, which lays the song title and
 * artist tag out as one SVG. Pure and dependency-free so the server render
 * (coverArtCompose.js, through sharp/librsvg) and the client's live Lettering
 * preview run the SAME layout code; they differ only in who measures the text.
 */

export const COVER_ART_SIZE = 3000;
// YouTube's recommended custom thumbnail size (16:9, under its 2 MB cap as a JPEG).
export const YOUTUBE_THUMBNAIL_SIZE = Object.freeze({ width: 1280, height: 720 });

// How the lettering sits on each frame. A thumbnail is seen small in a feed
// beside the channel name, so its title is set larger, keeps to one side of the
// frame (leaving the rest for the picture), stays clear of the bottom-right
// corner where YouTube draws the duration, carries no artist name, and casts
// a soft shadow so it reads over a busy frame.
const FRAMES = {
  cover: { textScale: 1, textWidth: 1, bottomClear: 0, tag: true, shadow: false },
  thumbnail: { textScale: 1.7, textWidth: 0.46, bottomClear: 0.14, tag: false, shadow: true },
};
const SHADOW_FILTER = '<filter id="shadow" x="-10%" y="-20%" width="120%" height="140%"><feGaussianBlur in="SourceAlpha" stdDeviation="6"/><feOffset dx="0" dy="3" result="b"/><feComponentTransfer><feFuncA type="linear" slope="0.75"/></feComponentTransfer><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
export const COVER_FRAMES = Object.freeze(Object.keys(FRAMES));

// The vocabulary a design is written in (the drafting prompt offers exactly these).
export const COVER_DESIGN_OPTIONS = Object.freeze({
  layout: ['bottom-left', 'bottom-center', 'top-left', 'top-center', 'center', 'vertical-left'],
  typeface: ['sans', 'condensed', 'serif', 'mono'],
  weight: ['light', 'regular', 'bold', 'black'],
  letterCase: ['upper', 'lower', 'as-written'],
  scale: ['small', 'medium', 'large'],
  backdrop: ['none', 'fade', 'band', 'box'],
  tagStyle: ['plain', 'boxed', 'none'],
  titleStyle: ['fill', 'outline', 'stencil'],
  tagLayout: ['opposite-corner', 'with-title'],
});

export const DEFAULT_COVER_DESIGN = Object.freeze({
  layout: 'bottom-left', typeface: 'sans', weight: 'bold', letterCase: 'upper', scale: 'medium',
  tracking: 0.02, titleColor: '#ffffff', accentColor: '#ffffff', backdrop: 'fade', tagStyle: 'plain', rule: false,
  titleStyle: 'fill', tagLayout: 'opposite-corner',
});

// A typeface the director uploaded is written `font:<id>` in a design.
export const CUSTOM_TYPEFACE_PREFIX = 'font:';
export const customTypeface = (fontId) => `${CUSTOM_TYPEFACE_PREFIX}${fontId}`;

// Font stacks: the first face a Mac has, then what a Linux install has. `width`
// is the average advance per character as a fraction of the font size.
const FACES = {
  sans: { family: "'Helvetica Neue','Helvetica','Arial','DejaVu Sans',sans-serif", width: 0.6 },
  condensed: { family: "'Futura Condensed ExtraBold','Avenir Next Condensed','Impact','Arial Narrow','DejaVu Sans Condensed',sans-serif", width: 0.46 },
  serif: { family: "'Didot','Bodoni 72','Georgia','DejaVu Serif',serif", width: 0.58 },
  mono: { family: "'Menlo','SF Mono','DejaVu Sans Mono',monospace", width: 0.62 },
};
const WEIGHTS = { light: 300, regular: 400, bold: 700, black: 900 };
const SCALES = { small: 0.075, medium: 0.11, large: 0.16 };
const HEX = /^#[0-9a-f]{6}$/i;
const ASCENT = 0.78;
const MARGIN = 0.065;
const TAG_SCALE = 0.03;

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const n = (v) => v.toFixed(1);

/** Every typeface a design may name: the built-in four, then each uploaded font. */
export const coverTypefaceChoices = (fonts = []) => [...COVER_DESIGN_OPTIONS.typeface, ...fonts.map((f) => customTypeface(f.id))];

/** The face a typeface names: its font stack (CSS) and average advance. An unknown one is the default's. */
function faceFor(typeface, fonts = []) {
  if (FACES[typeface]) return FACES[typeface];
  const custom = typeof typeface === 'string' && typeface.startsWith(CUSTOM_TYPEFACE_PREFIX)
    ? fonts.find((f) => customTypeface(f.id) === typeface) : null;
  return custom ? { family: `'${custom.family}',sans-serif`, width: custom.width } : FACES[DEFAULT_COVER_DESIGN.typeface];
}

/**
 * A design with every field valid: unknown or missing values take the default's.
 * `fonts` (the uploaded typefaces, `{ id, family, width }`) is what lets a
 * `font:<id>` typeface through; a design naming a font that is gone, or one
 * normalized without the list, falls back to the default typeface.
 */
export function normalizeCoverDesign(design = {}, { fonts = [] } = {}) {
  const d = design && typeof design === 'object' ? design : {};
  const out = {};
  for (const [key, list] of Object.entries(COVER_DESIGN_OPTIONS)) {
    out[key] = pick(d[key], key === 'typeface' ? coverTypefaceChoices(fonts) : list, DEFAULT_COVER_DESIGN[key]);
  }
  const tracking = Number(d.tracking);
  out.tracking = Number.isFinite(tracking) ? Math.min(0.3, Math.max(-0.05, tracking)) : DEFAULT_COVER_DESIGN.tracking;
  out.titleColor = HEX.test(d.titleColor || '') ? d.titleColor : DEFAULT_COVER_DESIGN.titleColor;
  out.accentColor = HEX.test(d.accentColor || '') ? d.accentColor : DEFAULT_COVER_DESIGN.accentColor;
  out.rule = d.rule === true;
  return out;
}

const caseOf = (text, letterCase) => (letterCase === 'upper' ? text.toUpperCase() : letterCase === 'lower' ? text.toLowerCase() : text);

/** Break the title into at most 3 lines of about `perLine` characters, at word boundaries. */
function titleLines(title, perLine) {
  const words = String(title || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  for (const word of words) {
    const last = lines[lines.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= perLine) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length > 3 ? [...lines.slice(0, 2), lines.slice(2).join(' ')] : lines;
}

/**
 * How a text is set: its font stack, weight and letter spacing (in em). The
 * server's width probe and the client's canvas measure read this, and
 * `fontAttrs` writes the same values as SVG attributes, so a measured width
 * is the width the overlay draws.
 */
export function coverFontSpec(d, kind, fonts = []) {
  const weight = WEIGHTS[d.weight];
  return kind === 'tag'
    ? { family: faceFor(d.typeface, fonts).family, weight: Math.max(400, weight - 200), trackingEm: 0.08 }
    : { family: faceFor(d.typeface, fonts).family, weight, trackingEm: d.tracking };
}

export function fontAttrs(d, kind, fontSize, fonts = []) {
  const { family, weight, trackingEm } = coverFontSpec(d, kind, fonts);
  return `font-family="${escapeFamilyStack(family)}" font-weight="${weight}" letter-spacing="${n(trackingEm * fontSize)}"`;
}

// A stack's own quotes are SVG-safe inside a double-quoted attribute; only a custom family's name can carry markup.
const escapeFamilyStack = (family) => family.replace(/[<>&"]/g, (c) => escapeXml(c));

/**
 * The canvas the lettering is laid out on: `size` is a square's side or a
 * `{ width, height }` box, `frame` a FRAMES key. Margins and the type scale
 * follow the shorter side, so a square cover lays out exactly as before.
 */
function coverBox(size, frame = 'cover') {
  const width = typeof size === 'object' && size ? size.width : size;
  const height = typeof size === 'object' && size ? size.height : size;
  const unit = Math.min(width, height);
  return { width, height, unit, margin: unit * MARGIN, ...(FRAMES[frame] || FRAMES.cover) };
}

// The width a title may take: centered layouts span the frame, the others keep to the frame's textWidth.
const titleRoom = (d, box) => {
  const full = box.width - 2 * box.margin;
  return d.layout.endsWith('center') ? full : Math.min(full, box.width * box.textWidth - box.margin);
};

/** The title's lines as the design sets them (one line when it runs up the edge). */
export function titleLinesFor(title, d, size, fonts = [], frame = 'cover') {
  const text = caseOf(String(title || '').trim(), d.letterCase);
  if (d.layout === 'vertical-left') return [text];
  const box = coverBox(size, frame);
  const fontBase = box.unit * SCALES[d.scale] * box.textScale;
  return titleLines(text, Math.max(6, Math.round(titleRoom(d, box) / (fontBase * faceFor(d.typeface, fonts).width * (1 + d.tracking)))));
}

/** The artist tag as the design sets it: cased, trimmed, empty when the design (or the frame) has none. */
export const tagTextFor = (tag, d, frame = 'cover') => (d.tagStyle === 'none' || !coverBox(1, frame).tag ? '' : caseOf(String(tag || '').trim().slice(0, 24), d.letterCase));

// A stencil cuts each line with one thin gap at mid-height (never under 0.2% of the canvas, so a small title still shows it); `strips` are `[x, y, w, h]` in canvas space.
const stencilGap = (fontSize, unit) => Math.max(fontSize * 0.05, unit * 0.002);
const stencilMask = ({ width, height }, strips) => `<mask id="stencil" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#fff"/>${strips.map(([x, y, w, h]) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#000"/>`).join('')}</mask>`;

/** The fill/stroke that paints the title's glyphs for its `titleStyle`. */
const inkFor = (d, fontSize) => (d.titleStyle === 'outline'
  ? `fill="none" stroke="${d.titleColor}" stroke-width="${n(Math.max(2, fontSize * 0.035))}" stroke-linejoin="round"`
  : `fill="${d.titleColor}"`);

/**
 * The title block: lines, size and where it sits, plus whatever the design
 * puts behind it. `widthOf(text)` is the text's rendered width at a 1px font
 * size (measured by the caller, since the face a stack resolves to varies by
 * machine); without it the face's average advance stands in. A tag set
 * `with-title` is part of the block, so the backdrop and the margins hold it;
 * `tagSpot` says where it goes.
 */
function titleParts(title, d, box, widthOf, fonts, tagText, frame) {
  const face = faceFor(d.typeface, fonts);
  const { width: W, height: H, unit, margin } = box;
  const parts = [];
  const defs = [];
  const lines = titleLinesFor(title, d, box, fonts, frame);
  const maxSize = unit * SCALES[d.scale] * box.textScale;
  const unitW = (line) => widthOf?.(line) ?? line.length * face.width * (1 + d.tracking);
  const unitWidest = Math.max(0.001, ...lines.map(unitW));
  const stencil = d.titleStyle === 'stencil';
  const text = (attrs, body, strips, cut) => {
    parts.push(`<text ${attrs}>${escapeXml(body)}</text>`);
    if (stencil) strips.push(cut);
  };
  const strips = [];

  if (d.layout === 'vertical-left') {
    // One line reading bottom to top along the left edge.
    const fontSize = Math.min(maxSize, (H - 2 * margin) / unitWidest);
    if (d.backdrop !== 'none') {
      parts.push(`<rect x="0" y="0" width="${n(margin * 2 + fontSize)}" height="${H}" fill="${d.backdrop === 'band' ? d.accentColor : '#000'}" fill-opacity="${d.backdrop === 'band' ? 1 : 0.6}"/>`);
    }
    const attrs = `transform="translate(${n(margin + fontSize * ASCENT)} ${n(H - margin)}) rotate(-90)" ${fontAttrs(d, 'title', fontSize, fonts)} ${inkFor(d, fontSize)} font-size="${n(fontSize)}"`;
    text(attrs, lines[0], strips, [margin + fontSize * ASCENT * 0.5, 0, stencilGap(fontSize, unit), H]);
    if (stencil) { defs.push(stencilMask(box, strips)); parts.splice(parts.length - 1, 1, `<g mask="url(#stencil)">${parts[parts.length - 1]}</g>`); }
    if (box.shadow) { defs.push(SHADOW_FILTER); parts.splice(parts.length - 1, 1, `<g filter="url(#shadow)">${parts[parts.length - 1]}</g>`); }
    return { parts, defs, tagSpot: null };
  }

  const center = d.layout.endsWith('center');
  const atTop = d.layout.startsWith('top');
  // As large as the design's scale allows; a long title shrinks to fit.
  const room = titleRoom(d, box);
  const fontSize = Math.min(maxSize, room / unitWidest);
  const lineH = fontSize * 1.08;
  const textH = lineH * (lines.length - 1) + fontSize * ASCENT;
  // The tag sits under the title (and under its rule, when the rule is below it).
  const ruleBelow = d.rule && (atTop || d.layout === 'center');
  const tagFs = unit * TAG_SCALE;
  const tagGap = fontSize * (ruleBelow ? 0.6 : 0.3);
  const reserve = tagText ? tagGap + tagFs * 1.45 : 0;
  const blockH = textH + reserve;
  const widest = Math.min(room, unitWidest * fontSize);
  const x = center ? W / 2 : margin;
  const left = center ? (W - widest) / 2 : margin;
  const clear = H * box.bottomClear;
  const top = atTop ? margin + unit * 0.06 : d.layout === 'center' ? (H - blockH) / 2 : H - margin - clear - blockH;

  if (d.backdrop === 'fade' && d.layout !== 'center') {
    defs.push(`<linearGradient id="fade" x1="0" y1="${atTop ? 1 : 0}" x2="0" y2="${atTop ? 0 : 1}"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient>`);
    const h = blockH + margin * 3 + (atTop ? 0 : clear);
    parts.push(`<rect x="0" y="${n(atTop ? 0 : H - h)}" width="${W}" height="${n(h)}" fill="url(#fade)"/>`);
  } else if (d.backdrop === 'band') {
    const pad = fontSize * 0.35;
    parts.push(`<rect x="0" y="${n(top - pad)}" width="${W}" height="${n(blockH + pad * 2)}" fill="${d.accentColor}"/>`);
  } else if (d.backdrop === 'box' || (d.backdrop === 'fade' && d.layout === 'center')) {
    const pad = fontSize * 0.4;
    parts.push(`<rect x="${n(left - pad)}" y="${n(top - pad)}" width="${n(widest + pad * 2)}" height="${n(blockH + pad * 2)}" fill="#000" fill-opacity="0.65"/>`);
  }
  if (d.rule) {
    const ry = atTop ? top + textH + fontSize * 0.35 : top - fontSize * 0.35;
    parts.push(`<rect x="${n(left)}" y="${n(ry)}" width="${n(widest)}" height="${n(unit * 0.004)}" fill="${d.accentColor}"/>`);
  }
  const ink = `${fontAttrs(d, 'title', fontSize, fonts)} ${inkFor(d, fontSize)}`;
  const titleStart = parts.length;
  lines.forEach((line, i) => {
    const baseline = top + fontSize * ASCENT + i * lineH;
    text(`x="${n(x)}" y="${n(baseline)}" ${ink} font-size="${n(fontSize)}" text-anchor="${center ? 'middle' : 'start'}"`, line, strips, [0, baseline - fontSize * ASCENT * 0.5, W, stencilGap(fontSize, unit)]);
  });
  if (stencil) {
    defs.push(stencilMask(box, strips));
    parts.splice(titleStart, parts.length - titleStart, `<g mask="url(#stencil)">${parts.slice(titleStart).join('')}</g>`);
  }
  if (box.shadow) {
    defs.push(SHADOW_FILTER);
    parts.splice(titleStart, parts.length - titleStart, `<g filter="url(#shadow)">${parts.slice(titleStart).join('')}</g>`);
  }
  const tagSpot = tagText ? { x, anchor: center ? 'middle' : 'start', baseline: top + textH + tagGap + tagFs * 1.05 } : null;
  return { parts, defs, tagSpot };
}

/** The artist tag, small: under the title, or at the edge across from it. */
function tagParts(tagText, d, box, widthOf, fonts, spot) {
  if (!tagText) return [];
  const { width: W, height: H, margin } = box;
  const fs = box.unit * TAG_SCALE;
  const w = (widthOf?.(tagText) ?? tagText.length * faceFor(d.typeface, fonts).width * 1.08) * fs;
  const center = d.layout.endsWith('center') && d.layout !== 'center';
  const anchor = spot ? spot.anchor : center ? 'middle' : 'end';
  const tx = spot ? spot.x : center ? W / 2 : W - margin;
  const baseline = spot ? spot.baseline : d.layout.startsWith('top') ? H - margin : margin + fs * ASCENT;
  const font = `${fontAttrs(d, 'tag', fs, fonts)} font-size="${n(fs)}" text-anchor="${anchor}"`;
  if (d.tagStyle !== 'boxed') return [`<text x="${n(tx)}" y="${n(baseline)}" ${font} fill="${d.accentColor}">${escapeXml(tagText)}</text>`];
  const pad = fs * 0.5;
  const bx = anchor === 'end' ? tx - w - pad : anchor === 'start' ? tx - pad : tx - w / 2 - pad;
  return [
    `<rect x="${n(bx)}" y="${n(baseline - fs * 1.05)}" width="${n(w + pad * 2)}" height="${n(fs * 1.45)}" fill="${d.accentColor}"/>`,
    `<text x="${n(tx)}" y="${n(baseline)}" ${font} fill="#111">${escapeXml(tagText)}</text>`,
  ];
}

/**
 * The overlay as SVG: the song's title and artist tag, laid out by its design.
 * `size` is a square's side or a `{ width, height }` box and `frame` how the
 * lettering sits on it (`cover`, or `thumbnail` for a YouTube thumbnail).
 * `widths` is `{ title(text), tag(text) }`, each a text's width at a 1px font
 * size, or null to lay out by the faces' average advance; `fonts` is the
 * uploaded typefaces.
 */
export function coverOverlaySvg({ title, tag = '', design, size = COVER_ART_SIZE, frame = 'cover', widths = null, fonts = [] }) {
  const d = normalizeCoverDesign(design, { fonts });
  const box = coverBox(size, frame);
  const tagText = tagTextFor(tag, d, frame);
  const withTitle = d.tagLayout === 'with-title' && d.layout !== 'vertical-left';
  const { parts, defs, tagSpot } = titleParts(title, d, box, widths?.title, fonts, withTitle ? tagText : '', frame);
  const tagSvg = tagParts(tagText, d, box, widths?.tag, fonts, withTitle ? tagSpot : null);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${box.width}" height="${box.height}" viewBox="0 0 ${box.width} ${box.height}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${[...parts, ...tagSvg].join('')}</svg>`;
}
