/**
 * Music Video cover art: one square image for the song's release (Spotify via
 * DistroKid, Suno). A photo or still, cropped square, with the title and the
 * artist set by code from the song's own cover design: where the title sits,
 * its typeface, weight, case, spacing and colors, and what sits behind it.
 * Each song gets its own design (coverArt.js drafts it from the song); this
 * module only renders one. Lettering is set here rather than drawn by an image
 * model, so it stays crisp.
 *
 * Pure apart from the files it reads and writes; `sharp` is loaded lazily so
 * the many suites that reach the publish services never pay for it.
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
});

export const DEFAULT_COVER_DESIGN = Object.freeze({
  layout: 'bottom-left', typeface: 'sans', weight: 'bold', letterCase: 'upper', scale: 'medium',
  tracking: 0.02, titleColor: '#ffffff', accentColor: '#ffffff', backdrop: 'fade', tagStyle: 'plain', rule: false,
});

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

const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const pick = (value, list, fallback) => (list.includes(value) ? value : fallback);
const n = (v) => v.toFixed(1);

/** A design with every field valid: unknown or missing values take the default's. */
export function normalizeCoverDesign(design = {}) {
  const d = design && typeof design === 'object' ? design : {};
  const out = {};
  for (const [key, list] of Object.entries(COVER_DESIGN_OPTIONS)) out[key] = pick(d[key], list, DEFAULT_COVER_DESIGN[key]);
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

const titleFont = (d, fontSize) => `font-family="${FACES[d.typeface].family}" font-weight="${WEIGHTS[d.weight]}" letter-spacing="${n(d.tracking * fontSize)}"`;
const tagFont = (d, fontSize) => `font-family="${FACES[d.typeface].family}" font-weight="${Math.max(400, WEIGHTS[d.weight] - 200)}" letter-spacing="${n(0.08 * fontSize)}"`;

/** The title's lines as the design sets them (one line when it runs up the edge). */
function titleLinesFor(title, d, size) {
  const text = caseOf(String(title || '').trim(), d.letterCase);
  if (d.layout === 'vertical-left') return [text];
  const room = size * (1 - 2 * MARGIN);
  return titleLines(text, Math.max(6, Math.round(room / (size * SCALES[d.scale] * FACES[d.typeface].width * (1 + d.tracking)))));
}

/**
 * The title block: lines, size and where it sits, plus whatever the design
 * puts behind it. `widthOf(text)` is the text's rendered width at a 1px font
 * size (measured by composeCoverArt, since the face a stack resolves to varies
 * by machine); without it the face's average advance stands in.
 */
function titleParts(title, d, size, widthOf) {
  const face = FACES[d.typeface];
  const margin = size * MARGIN;
  const room = size - 2 * margin;
  const ink = (fontSize) => `${titleFont(d, fontSize)} fill="${d.titleColor}"`;
  const parts = [];
  const defs = [];
  const lines = titleLinesFor(title, d, size);
  const unitW = (line) => widthOf?.(line) ?? line.length * face.width * (1 + d.tracking);
  const unitWidest = Math.max(0.001, ...lines.map(unitW));

  if (d.layout === 'vertical-left') {
    // One line reading bottom to top along the left edge.
    const text = lines[0];
    const fontSize = Math.min(size * SCALES[d.scale], room / unitWidest);
    if (d.backdrop !== 'none') {
      parts.push(`<rect x="0" y="0" width="${n(margin * 2 + fontSize)}" height="${size}" fill="${d.backdrop === 'band' ? d.accentColor : '#000'}" fill-opacity="${d.backdrop === 'band' ? 1 : 0.6}"/>`);
    }
    parts.push(`<text transform="translate(${n(margin + fontSize * ASCENT)} ${n(size - margin)}) rotate(-90)" ${ink(fontSize)} font-size="${n(fontSize)}">${escapeXml(text)}</text>`);
    return { parts, defs };
  }

  const center = d.layout.endsWith('center');
  const atTop = d.layout.startsWith('top');
  // As large as the design's scale allows; a long title shrinks to fit.
  const fontSize = Math.min(size * SCALES[d.scale], room / unitWidest);
  const lineH = fontSize * 1.08;
  const blockH = lineH * (lines.length - 1) + fontSize * ASCENT;
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
    const ry = atTop ? top + blockH + fontSize * 0.35 : top - fontSize * 0.35;
    parts.push(`<rect x="${n(left)}" y="${n(ry)}" width="${n(widest)}" height="${n(size * 0.004)}" fill="${d.accentColor}"/>`);
  }
  lines.forEach((line, i) => {
    parts.push(`<text x="${n(x)}" y="${n(top + fontSize * ASCENT + i * lineH)}" ${ink(fontSize)} font-size="${n(fontSize)}" text-anchor="${center ? 'middle' : 'start'}">${escapeXml(line)}</text>`);
  });
  return { parts, defs };
}

/** The artist tag, small, at the edge across from the title. */
const tagTextFor = (tag, d) => (d.tagStyle === 'none' ? '' : caseOf(String(tag || '').trim().slice(0, 24), d.letterCase));

function tagParts(tag, d, size, widthOf) {
  const text = tagTextFor(tag, d);
  if (!text) return [];
  const margin = size * MARGIN;
  const fs = size * 0.03;
  const w = (widthOf?.(text) ?? text.length * FACES[d.typeface].width * 1.08) * fs;
  const center = d.layout.endsWith('center') && d.layout !== 'center';
  const anchor = center ? 'middle' : 'end';
  const tx = center ? size / 2 : size - margin;
  const baseline = d.layout.startsWith('top') ? size - margin : margin + fs * ASCENT;
  const font = `${tagFont(d, fs)} font-size="${n(fs)}" text-anchor="${anchor}"`;
  if (d.tagStyle !== 'boxed') return [`<text x="${n(tx)}" y="${n(baseline)}" ${font} fill="${d.accentColor}">${escapeXml(text)}</text>`];
  const pad = fs * 0.5;
  const bx = anchor === 'end' ? tx - w - pad : tx - w / 2 - pad;
  return [
    `<rect x="${n(bx)}" y="${n(baseline - fs * 1.05)}" width="${n(w + pad * 2)}" height="${n(fs * 1.45)}" fill="${d.accentColor}"/>`,
    `<text x="${n(tx)}" y="${n(baseline)}" ${font} fill="#111">${escapeXml(text)}</text>`,
  ];
}

/** The overlay as SVG: the song's title and artist tag, laid out by its design. */
function coverOverlaySvg({ title, tag = '', design, size = COVER_ART_SIZE, widths = null }) {
  const d = normalizeCoverDesign(design);
  const { parts, defs } = titleParts(title, d, size, widths?.title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${[...parts, ...tagParts(tag, d, size, widths?.tag)].join('')}</svg>`;
}

const PROBE_PX = 100;

/** Each text's rendered width at a 1px font size, by drawing it at PROBE_PX and trimming the empty canvas around it. */
async function measureWidths(sharp, texts, font) {
  const out = new Map();
  for (const text of texts) {
    if (!text || out.has(text)) continue;
    const w = Math.ceil(text.length * PROBE_PX * 1.5) + 40;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${PROBE_PX * 2}"><text x="20" y="${PROBE_PX * 1.3}" ${font} font-size="${PROBE_PX}" fill="#fff">${escapeXml(text)}</text></svg>`;
    const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true }).catch(() => ({ info: null }));
    if (info?.width) out.set(text, info.width / PROBE_PX);
  }
  return (text) => out.get(text);
}

/**
 * Write `out` (a JPEG): `source` cropped to its largest square at `focusX`
 * (0 = left edge, 1 = right edge), scaled to `size`, with the song's design on
 * top. With `lettering` false the source is already a finished cover: no overlay.
 */
export async function composeCoverArt({ source, out, title, tag = '', design = null, focusX = 0.5, lettering = true, size = COVER_ART_SIZE }, deps = {}) {
  const sharp = deps.sharp || (await import('sharp')).default;
  // Apply the EXIF orientation first, so the crop is measured on the upright image.
  const { data, info } = await sharp(source).rotate().toBuffer({ resolveWithObject: true });
  const side = Math.min(info.width, info.height);
  const fx = Math.min(1, Math.max(0, Number.isFinite(focusX) ? focusX : 0.5));
  const left = Math.round((info.width - side) * fx);
  const top = Math.round((info.height - side) / 2);
  const square = sharp(data).extract({ left, top, width: side, height: side }).resize(size, size, { kernel: 'lanczos3' });
  if (!lettering) {
    await square.jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(out);
    return { width: size, height: size };
  }
  const d = normalizeCoverDesign(design);
  const widths = {
    title: await measureWidths(sharp, titleLinesFor(title, d, size), titleFont(d, PROBE_PX)),
    tag: await measureWidths(sharp, [tagTextFor(tag, d)], tagFont(d, PROBE_PX)),
  };
  const overlay = Buffer.from(coverOverlaySvg({ title, tag, design: d, size, widths }));
  await square
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toFile(out);
  return { width: size, height: size };
}
