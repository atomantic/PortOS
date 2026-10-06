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

/** The title's lines as the design sets them (one line when it runs up the edge). */
export function titleLinesFor(title, d, size, fonts = []) {
  const text = caseOf(String(title || '').trim(), d.letterCase);
  if (d.layout === 'vertical-left') return [text];
  const room = size * (1 - 2 * MARGIN);
  return titleLines(text, Math.max(6, Math.round(room / (size * SCALES[d.scale] * faceFor(d.typeface, fonts).width * (1 + d.tracking)))));
}

/** The artist tag as the design sets it: cased, trimmed, empty when the design has none. */
export const tagTextFor = (tag, d) => (d.tagStyle === 'none' ? '' : caseOf(String(tag || '').trim().slice(0, 24), d.letterCase));

// A stencil cuts each line with one thin gap at mid-height (never under 0.2% of the canvas, so a small title still shows it); `strips` are `[x, y, w, h]` in canvas space.
const stencilGap = (fontSize, size) => Math.max(fontSize * 0.05, size * 0.002);
const stencilMask = (size, strips) => `<mask id="stencil" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}"><rect width="${size}" height="${size}" fill="#fff"/>${strips.map(([x, y, w, h]) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="#000"/>`).join('')}</mask>`;

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
function titleParts(title, d, size, widthOf, fonts, tagText) {
  const face = faceFor(d.typeface, fonts);
  const margin = size * MARGIN;
  const room = size - 2 * margin;
  const parts = [];
  const defs = [];
  const lines = titleLinesFor(title, d, size, fonts);
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
    const fontSize = Math.min(size * SCALES[d.scale], room / unitWidest);
    if (d.backdrop !== 'none') {
      parts.push(`<rect x="0" y="0" width="${n(margin * 2 + fontSize)}" height="${size}" fill="${d.backdrop === 'band' ? d.accentColor : '#000'}" fill-opacity="${d.backdrop === 'band' ? 1 : 0.6}"/>`);
    }
    const attrs = `transform="translate(${n(margin + fontSize * ASCENT)} ${n(size - margin)}) rotate(-90)" ${fontAttrs(d, 'title', fontSize, fonts)} ${inkFor(d, fontSize)} font-size="${n(fontSize)}"`;
    text(attrs, lines[0], strips, [margin + fontSize * ASCENT * 0.5, 0, stencilGap(fontSize, size), size]);
    if (stencil) { defs.push(stencilMask(size, strips)); parts.splice(parts.length - 1, 1, `<g mask="url(#stencil)">${parts[parts.length - 1]}</g>`); }
    return { parts, defs, tagSpot: null };
  }

  const center = d.layout.endsWith('center');
  const atTop = d.layout.startsWith('top');
  // As large as the design's scale allows; a long title shrinks to fit.
  const fontSize = Math.min(size * SCALES[d.scale], room / unitWidest);
  const lineH = fontSize * 1.08;
  const textH = lineH * (lines.length - 1) + fontSize * ASCENT;
  // The tag sits under the title (and under its rule, when the rule is below it).
  const ruleBelow = d.rule && (atTop || d.layout === 'center');
  const tagFs = size * TAG_SCALE;
  const tagGap = fontSize * (ruleBelow ? 0.6 : 0.3);
  const reserve = tagText ? tagGap + tagFs * 1.45 : 0;
  const blockH = textH + reserve;
  const widest = Math.min(room, unitWidest * fontSize);
  const x = center ? size / 2 : margin;
  const left = center ? (size - widest) / 2 : margin;
  const top = atTop ? margin + size * 0.06 : d.layout === 'center' ? (size - blockH) / 2 : size - margin - blockH;

  if (d.backdrop === 'fade' && d.layout !== 'center') {
    defs.push(`<linearGradient id="fade" x1="0" y1="${atTop ? 1 : 0}" x2="0" y2="${atTop ? 0 : 1}"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.7"/></linearGradient>`);
    const h = blockH + margin * 3;
    parts.push(`<rect x="0" y="${n(atTop ? 0 : size - h)}" width="${size}" height="${n(h)}" fill="url(#fade)"/>`);
  } else if (d.backdrop === 'band') {
    const pad = fontSize * 0.35;
    parts.push(`<rect x="0" y="${n(top - pad)}" width="${size}" height="${n(blockH + pad * 2)}" fill="${d.accentColor}"/>`);
  } else if (d.backdrop === 'box' || (d.backdrop === 'fade' && d.layout === 'center')) {
    const pad = fontSize * 0.4;
    parts.push(`<rect x="${n(left - pad)}" y="${n(top - pad)}" width="${n(widest + pad * 2)}" height="${n(blockH + pad * 2)}" fill="#000" fill-opacity="0.65"/>`);
  }
  if (d.rule) {
    const ry = atTop ? top + textH + fontSize * 0.35 : top - fontSize * 0.35;
    parts.push(`<rect x="${n(left)}" y="${n(ry)}" width="${n(widest)}" height="${n(size * 0.004)}" fill="${d.accentColor}"/>`);
  }
  const ink = `${fontAttrs(d, 'title', fontSize, fonts)} ${inkFor(d, fontSize)}`;
  const titleStart = parts.length;
  lines.forEach((line, i) => {
    const baseline = top + fontSize * ASCENT + i * lineH;
    text(`x="${n(x)}" y="${n(baseline)}" ${ink} font-size="${n(fontSize)}" text-anchor="${center ? 'middle' : 'start'}"`, line, strips, [0, baseline - fontSize * ASCENT * 0.5, size, stencilGap(fontSize, size)]);
  });
  if (stencil) {
    defs.push(stencilMask(size, strips));
    parts.splice(titleStart, parts.length - titleStart, `<g mask="url(#stencil)">${parts.slice(titleStart).join('')}</g>`);
  }
  const tagSpot = tagText ? { x, anchor: center ? 'middle' : 'start', baseline: top + textH + tagGap + tagFs * 1.05 } : null;
  return { parts, defs, tagSpot };
}

/** The artist tag, small: under the title, or at the edge across from it. */
function tagParts(tagText, d, size, widthOf, fonts, spot) {
  if (!tagText) return [];
  const margin = size * MARGIN;
  const fs = size * TAG_SCALE;
  const w = (widthOf?.(tagText) ?? tagText.length * faceFor(d.typeface, fonts).width * 1.08) * fs;
  const center = d.layout.endsWith('center') && d.layout !== 'center';
  const anchor = spot ? spot.anchor : center ? 'middle' : 'end';
  const tx = spot ? spot.x : center ? size / 2 : size - margin;
  const baseline = spot ? spot.baseline : d.layout.startsWith('top') ? size - margin : margin + fs * ASCENT;
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
 * `widths` is `{ title(text), tag(text) }`, each a text's width at a 1px font
 * size, or null to lay out by the faces' average advance; `fonts` is the
 * uploaded typefaces.
 */
export function coverOverlaySvg({ title, tag = '', design, size = COVER_ART_SIZE, widths = null, fonts = [] }) {
  const d = normalizeCoverDesign(design, { fonts });
  const tagText = tagTextFor(tag, d);
  const withTitle = d.tagLayout === 'with-title' && d.layout !== 'vertical-left';
  const { parts, defs, tagSpot } = titleParts(title, d, size, widths?.title, fonts, withTitle ? tagText : '');
  const tagSvg = tagParts(tagText, d, size, widths?.tag, fonts, withTitle ? tagSpot : null);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${[...parts, ...tagSvg].join('')}</svg>`;
}
