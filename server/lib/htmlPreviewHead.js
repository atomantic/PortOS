/** Inserts trusted markup at the start of an HTML preview's head. */

const SPACE = /[\t\n\f\r ]*/y;
const DOCTYPE = /<!doctype[\t\n\f\r ][^>]*>/iy;
// Abrupt and malformed comment endings need the fallback, since browsers can
// resume parsing markup before the next `-->`.
const COMMENT = /<!--(?!-?>)(?:(?!--!?>|<!--).)*-->/sy;
const ROOT = /<html(?=[\t\n\f\r />])/iy;
const HEAD = /<head(?=[\t\n\f\r />])/iy;
const ATTRIBUTE = /[^\t\n\f\r "'<>/=\0]+/y;
const VALUE = /"[^"]*"|'[^']*'|[^\t\n\f\r "'`=<>\0]+/y;

function matchEnd(pattern, html, at) {
  pattern.lastIndex = at;
  return pattern.test(html) ? pattern.lastIndex : at;
}

function skipTrivia(html, at) {
  let start = matchEnd(SPACE, html, at);
  let end = matchEnd(COMMENT, html, start);
  while (end > start) {
    start = matchEnd(SPACE, html, end);
    end = matchEnd(COMMENT, html, start);
  }
  return start;
}

function openingTagEnd(pattern, html, start) {
  let at = matchEnd(pattern, html, start);
  if (at === start) return start;
  while (at < html.length) {
    const name = matchEnd(SPACE, html, at);
    if (html[name] === '>') return name + 1;
    if (name === at) return start;
    at = matchEnd(ATTRIBUTE, html, name);
    if (at === name) return start;
    const equals = matchEnd(SPACE, html, at);
    if (html[equals] !== '=') continue;
    const value = matchEnd(SPACE, html, equals + 1);
    at = matchEnd(VALUE, html, value);
    if (at === value) return start;
  }
  return start;
}

export function injectPreviewHead(html, markup) {
  // A BOM is an encoding marker, but the preview also accepts decoded strings.
  if (html.startsWith('\uFEFF')) html = html.slice(1);
  const doctypeStart = matchEnd(SPACE, html, 0);
  const doctypeEnd = matchEnd(DOCTYPE, html, doctypeStart);
  const hasDoctype = doctypeEnd !== doctypeStart;
  const start = skipTrivia(html, hasDoctype ? doctypeEnd : 0);
  const rootEnd = openingTagEnd(ROOT, html, start);
  const headStart = rootEnd === start ? start : skipTrivia(html, rootEnd);
  const headEnd = openingTagEnd(HEAD, html, headStart);

  const doctype = hasDoctype ? '' : '<!doctype html>';
  if (headEnd !== headStart) return `${doctype}${html.slice(0, headEnd)}${markup}${html.slice(headEnd)}`;
  // Any other token may already have closed the browser's head insertion mode.
  const at = hasDoctype ? doctypeEnd : 0;
  return `${doctype}${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
}
