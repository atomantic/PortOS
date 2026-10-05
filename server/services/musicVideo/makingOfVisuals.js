/** Static sheet graphics only: no HTML execution, resource loading or raw SVG export. */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { escapeRegExp } from '../../lib/textUtils.js';

export const MAKING_OF_VISUAL_LIMITS = Object.freeze({ count: 80, decodedBytes: 5 * 1024 * 1024, artifactBytes: 20 * 1024 * 1024, svgBytes: 512 * 1024 });
const hash = value => createHash('sha256').update(value).digest('hex');
const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const entities = value => value.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, token => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'" })[token]);
const tags = new Set(['svg', 'g', 'rect', 'circle', 'ellipse', 'line', 'polygon', 'polyline', 'path', 'text', 'tspan', 'title', 'desc', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'marker']);
const numeric = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'letter-spacing', 'offset', 'markerWidth', 'markerHeight', 'refX', 'refY', 'dx', 'dy']);
const paint = /^(?:none|transparent|currentColor|[a-z]{1,30}|#[a-f0-9]{3,8}|rgba?\([0-9.,%\s]+\)|url\(#[A-Za-z0-9_-]{1,100}\))$/i;
const list = /^[-+0-9.eE,\s]+$/;
const SAFE_STYLE = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor', 'dominant-baseline', 'letter-spacing']);
const caption = value => xml(value.replace(/[\r\n\u2028\u2029]+/g, ' ')).replace(/[\[\]\\]/g, character => escapeRegExp(character));

// CSS is never rendered or fetched. Notice graphics that stripping CSS would
// silently lose, including escaped property names and external style imports.
function unsupportedCssVisual(css) {
  const normalized = entities(css).replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([a-f0-9]{1,6})\s?|\\([^\r\n])/gi, (_, hex, character) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : character);
  return /(?:\b(?:url|(?:-webkit-)?image-set|(?:repeating-)?(?:linear|radial|conic)-gradient)\s*\(|@import\b)/i.test(normalized)
    || [...normalized.matchAll(/\b(?:background-image|border-image(?:-source)?|list-style-image|(?:-webkit-)?mask(?:-image)?)\s*:\s*([^;}]+)/gi)]
      .some(match => !/^(?:none|inherit|initial|unset|revert(?:-layer)?)$/i.test(match[1].replace(/\s*!important\s*$/i, '').trim()));
}

function attributes(raw) {
  const result = [];
  let rest = raw;
  for (const match of raw.matchAll(/([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*("[^"]*"|'[^']*')/g)) {
    result.push([match[1], entities(match[2].slice(1, -1))]);
    rest = rest.replace(match[0], '');
  }
  if (rest.trim() || new Set(result.map(([key]) => key)).size !== result.length) throw new Error('unsafe-attributes');
  return result;
}

function safeAttribute(key, value) {
  if (numeric.has(key)) return /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?%?$/i.test(value) && Math.abs(Number.parseFloat(value)) <= 100000;
  if (key === 'viewBox') { const parts = value.trim().split(/[\s,]+/).map(Number); return parts.length === 4 && parts.every(Number.isFinite) && parts.every(n => Math.abs(n) <= 100000) && parts[2] > 0 && parts[3] > 0; }
  if (key === 'fill' || key === 'stroke' || key === 'color' || key === 'stop-color') return paint.test(value);
  if (key === 'stop-opacity') return /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value);
  if (key === 'd') return value.length <= 64000 && /^[MmZzLlHhVvCcSsQqTtAa0-9.eE,+\-\s]*$/.test(value);
  if (key === 'points' || key === 'stroke-dasharray') return value.length <= 64000 && list.test(value);
  if (key === 'transform' || key === 'gradientTransform') return /^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([-+0-9.eE,\s]+\)\s*)+$/.test(value);
  if (key === 'id') return /^[A-Za-z0-9_-]{1,100}$/.test(value);
  if (key === 'clip-path' || key === 'marker-start' || key === 'marker-mid' || key === 'marker-end') return /^url\(#[A-Za-z0-9_-]{1,100}\)$/.test(value);
  if (key === 'font-family') return /^(?:Arial|Helvetica|sans-serif|serif|monospace|system-ui)(?:\s*,\s*(?:Arial|Helvetica|sans-serif|serif|monospace|system-ui))*$/i.test(value);
  if (key === 'font-weight') return /^(?:normal|bold|[1-9]00)$/.test(value);
  if (key === 'text-anchor') return /^(?:start|middle|end)$/.test(value);
  if (key === 'dominant-baseline') return /^(?:auto|middle|central|hanging|alphabetic|text-before-edge|text-after-edge)$/.test(value);
  if (key === 'stroke-linecap') return /^(?:butt|round|square)$/.test(value);
  if (key === 'stroke-linejoin') return /^(?:miter|round|bevel)$/.test(value);
  if (key === 'fill-rule' || key === 'clip-rule') return /^(?:nonzero|evenodd)$/.test(value);
  if (key === 'gradientUnits' || key === 'clipPathUnits') return /^(?:userSpaceOnUse|objectBoundingBox)$/.test(value);
  if (key === 'orient') return value === 'auto' || value === 'auto-start-reverse' || /^[-+0-9.]+$/.test(value);
  if (key === 'preserveAspectRatio') return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max)(?:\s+(?:meet|slice))?)$/.test(value);
  return false;
}

// Parse a deliberately small SVG grammar and reconstruct it from approved
// geometry and text. Never hand a rejected SVG or arbitrary markup to librsvg.
function staticSvg(source, scrub) {
  source = source.trim();
  if (Buffer.byteLength(source) > MAKING_OF_VISUAL_LIMITS.svgBytes || /<!|<\?|&(?!(?:amp|lt|gt|quot|apos|#39);)/.test(source)) throw new Error('unsafe-svg');
  const output = [];
  const stack = [];
  let count = 0;
  let viewBox = null;
  for (const token of source.match(/<[^>]*>|[^<]+/g) || []) {
    if (!token.startsWith('<')) {
      if (token.trim() && !['text', 'tspan', 'title', 'desc'].includes(stack.at(-1))) throw new Error('unsafe-svg-text');
      output.push(xml(scrub(entities(token))));
      continue;
    }
    const match = token.match(/^<(\/?)([A-Za-z]+)([^>]*?)(\/?)>$/);
    if (!match || !tags.has(match[2]) || ++count > 2000) throw new Error('unsafe-svg');
    const [, closing, name, raw, selfClosing] = match;
    if (closing) {
      if (raw.trim() || selfClosing || stack.pop() !== name) throw new Error('unsafe-svg');
      output.push(`</${name}>`); continue;
    }
    if (!stack.length && (output.length || name !== 'svg')) throw new Error('unsafe-svg');
    if (stack.length && name === 'svg') throw new Error('nested-svg');
    const safe = [];
    for (const [key, value] of attributes(raw)) {
      if (key === 'xmlns' && name === 'svg' && value === 'http://www.w3.org/2000/svg') continue;
      if (key === 'role' || key === 'aria-label') continue;
      const pairs = key === 'style' ? value.split(';').filter(v => v.trim()).map(declaration => {
        const colon = declaration.indexOf(':');
        const property = declaration.slice(0, colon).trim();
        if (colon < 0 || !SAFE_STYLE.has(property)) throw new Error('unsafe-svg-style');
        return [property, declaration.slice(colon + 1).trim()];
      }) : [[key, value]];
      for (const [property, attribute] of pairs) {
        if (!safeAttribute(property, attribute)) throw new Error('unsafe-svg-attribute');
        if (name === 'svg' && property === 'viewBox') viewBox = attribute;
        if (name === 'svg' && ['width', 'height'].includes(property)) continue;
        safe.push(`${property}="${xml(attribute)}"`);
      }
    }
    output.push(`<${name}${name === 'svg' ? ' xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"' : ''}${safe.length ? ` ${safe.join(' ')}` : ''}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) stack.push(name);
  }
  if (stack.length || !viewBox || !output.join('').endsWith('</svg>')) throw new Error('unsafe-svg');
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  const width = Math.min(1600, Math.max(1, Math.ceil(parts[2])));
  const height = Math.min(1600, Math.max(1, Math.ceil(width * parts[3] / parts[2])));
  return Buffer.from(output.join('').replace('width="1024" height="1024"', `width="${width}" height="${height}"`));
}

export async function reencodeMakingOfRaster(data, format = 'png') {
  const raster = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    || (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP');
  if (!raster) return null;
  const { default: sharp } = await import('sharp');
  return sharp(data, { limitInputPixels: 40_000_000 }).rotate().toFormat(format).toBuffer().catch(() => null);
}

export async function extractMakingOfVisuals(html, { path, parentId, allowRaster = false, scrub }) {
  const matches = [...html.matchAll(/<svg\b[\s\S]*?<\/svg\s*>|<img\b[^>]*>|<script\b[\s\S]*?(?:<\/script\s*>|$)|<canvas\b[\s\S]*?(?:<\/canvas\s*>|$)|<style\b[\s\S]*?(?:<\/style\s*>|$)|<(?:link|iframe|object|embed|video|audio|image)\b[^>]*>/gi)]
    .filter(match => {
      if (/^<style\b/i.test(match[0])) match.unsupportedCss = unsupportedCssVisual(match[0].replace(/^<style\b[^>]*>|<\/style\s*>$/gi, ''));
      else if (/^<link\b/i.test(match[0])) match.unsupportedCss = /\brel\s*=\s*(?:"[^"]*\bstylesheet\b|'[^']*\bstylesheet\b|stylesheet\b)/i.test(match[0]);
      else return true;
      return match.unsupportedCss;
    });
  if (matches.length > MAKING_OF_VISUAL_LIMITS.count) return { status: 'excluded', reason: 'visual-count-limit' };
  for (const match of html.matchAll(/<[A-Za-z][^>]*>/g)) {
    const style = match[0].match(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!style || !unsupportedCssVisual(style[1] ?? style[2] ?? style[3])
      || matches.some(existing => match.index >= existing.index && match.index < existing.index + existing[0].length)) continue;
    match.unsupportedCss = true;
    matches.push(match);
    if (matches.length > MAKING_OF_VISUAL_LIMITS.count) return { status: 'excluded', reason: 'visual-count-limit' };
  }
  matches.sort((a, b) => a.index - b.index);
  const visuals = [];
  const documentHash = hash(html).slice(0, 16);
  let decodedTotal = 0;
  let outputTotal = 0;
  let cleaned = html;
  // Reverse substitutions keep original source offsets and image order intact.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const source = match[0];
    const ordinal = index + 1;
    const visual = { id: `${parentId}:visual:${ordinal}`, sourceSha256: hash(source), status: 'excluded', reason: null, path: null, data: null, label: `Graphic ${ordinal}` };
    let decoded;
    let svg = /^<svg\b/i.test(source);
    if (match.unsupportedCss) visual.reason = 'css-visual-not-exported';
    else if (/^<(?:script|canvas|iframe|object|embed|video|audio|image)\b/i.test(source)) visual.reason = 'active-visual-not-exported';
    else {
      try {
        if (svg) decoded = Buffer.from(source);
        else {
          const imageAttributes = attributes(source.replace(/^<img\b/i, '').replace(/\/?\s*>$/, ''));
          if (imageAttributes.some(([key]) => /^on|^(?:srcset|style)$/i.test(key))) throw new Error('unsafe-image-attributes');
          const src = imageAttributes.find(([key]) => key.toLowerCase() === 'src')?.[1];
          visual.label = scrub(imageAttributes.find(([key]) => key.toLowerCase() === 'alt')?.[1] || visual.label);
          const uri = src?.match(/^data:image\/(png|jpe?g|webp|svg\+xml)(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]+={0,2})$/i);
          if (!uri) throw new Error(src && /^(?:https?:)?\/\//i.test(src) ? 'remote-visual-not-exported' : 'unsupported-image-source');
          if (uri[2].length > Math.ceil(MAKING_OF_VISUAL_LIMITS.decodedBytes / 3) * 4) throw new Error('visual-size-limit');
          decoded = Buffer.from(uri[2], 'base64');
          if (decoded.toString('base64') !== uri[2]) throw new Error('invalid-base64');
          svg = uri[1].toLowerCase() === 'svg+xml';
        }
        decodedTotal += decoded.length;
        if (decoded.length > MAKING_OF_VISUAL_LIMITS.decodedBytes || decodedTotal > MAKING_OF_VISUAL_LIMITS.artifactBytes) throw new Error('visual-size-limit');
        visual.sourceSha256 = hash(decoded);
        if (!svg && !allowRaster) throw new Error('embedded-raster-ownership-unverified');
        if (svg) {
          const safe = staticSvg(decoded.toString('utf8'), scrub);
          const { default: sharp } = await import('sharp');
          visual.data = await sharp(safe, { limitInputPixels: 4_000_000 }).png().toBuffer();
        } else visual.data = await reencodeMakingOfRaster(decoded);
        if (!visual.data || visual.data.length > MAKING_OF_VISUAL_LIMITS.decodedBytes) throw new Error('invalid-or-oversize-image');
        if (outputTotal + visual.data.length > MAKING_OF_VISUAL_LIMITS.artifactBytes) throw new Error('visual-size-limit');
        outputTotal += visual.data.length;
        const folder = path.replace(/\.md$/, '-visuals');
        visual.path = `${folder}/visual-${String(ordinal).padStart(2, '0')}-${visual.sourceSha256.slice(0, 16)}.png`;
        visual.status = 'included';
      } catch (err) { visual.data = null; visual.reason = ['unsafe-image-attributes', 'remote-visual-not-exported', 'unsupported-image-source', 'visual-size-limit', 'invalid-base64', 'embedded-raster-ownership-unverified', 'invalid-or-oversize-image'].includes(err.message) ? err.message : 'unsafe-or-invalid-svg'; }
    }
    const replacement = visual.data ? `\n![${caption(visual.label)}](${posix.relative(posix.dirname(path), visual.path)})\n` : `\n[Graphic ${ordinal} omitted: ${visual.reason}]\n`;
    // Protect generated relative links from generic HTML stripping/redaction.
    const placeholder = `PORTOSVISUAL${documentHash}NUMBER${ordinal}PLACEHOLDER`;
    visual.markdown = replacement;
    visual.placeholder = placeholder;
    cleaned = `${cleaned.slice(0, match.index)}\n${placeholder}\n${cleaned.slice(match.index + source.length)}`;
    visuals.unshift(visual);
  }
  cleaned = cleaned.replace(/<style\b[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<[^>]*>/g, '\n');
  cleaned = scrub(entities(cleaned)).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1 [link omitted]')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const visual of visuals) cleaned = cleaned.replace(visual.placeholder, visual.markdown);
  return { status: visuals.some(visual => visual.status !== 'included') ? 'partial' : 'included',
    reason: visuals.some(visual => visual.status !== 'included') ? 'some-visuals-not-exported' : null,
    data: Buffer.from(`${cleaned}\n`), visuals,
    transformation: 'static sheet: safe graphics extracted to relative PNGs; no active HTML exported' };
}
