import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { lineOf, maskComments, stringLiterals } from '../../classNameScan.js';
import { trackedSourceFiles } from '../../trackedFiles.js';
import { readText, REPO_ROOT } from '../../../../../scripts/lib/guardCorpus.js';

const CLIENT_ROOT = join(REPO_ROOT, 'client');
const WRAP = 'whitespace-pre-wrap';
const BREAKS = new Set(['break-all', 'break-words', 'break-anywhere', 'wrap-anywhere']);
const TRUNCATE_TOKEN = /(?:^|[\s'"`{])truncate(?=[\s'"`}]|$)/;
const TITLE_ATTR = /(?:^|\s)title\s*=/;
const ATTRIBUTE = 'panelClassName=';
const RAW_VH_RE = /max-h-\[[\d.]+vh\]/;

/**
 * Walk a JSX opening tag to its closing `>`, ignoring any `>` that sits
 * inside a nested JSX expression or a quoted string — `title={a > b}` and a
 * `className={`…`}` template both put one there.
 */
function readOpeningTag(source, start) {
  let i = start;
  let depth = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return { attrs: source.slice(start, i), end: i + 1 };
    i += 1;
  }
  return null;
}

// Splits on everything a Tailwind class cannot contain — whitespace, but also
// the quotes, braces and `$` of a template literal — so a class supplied through
// an interpolated branch (`` `whitespace-pre-wrap ${dense ? "break-all" : ""}` ``)
// is read as the token it renders to rather than as `"break-all"`.
const classTokens = (tag) =>
  stringLiterals(tag)
    .flatMap(({ value }) => value.split(/[^A-Za-z0-9_:/[\].%-]+/))
    .filter(Boolean);

/**
 * Every `panelClassName=` attribute value in `source`, as raw text.
 *
 * A quoted literal is taken verbatim; a `{…}` expression is taken whole (brace
 * counting, so a ternary or template literal is captured entire rather than
 * truncated at the first `}`). Capturing the expression rather than parsing it
 * means a dynamic class string is still scanned for the banned idiom.
 */
function panelClassValues(source) {
  const values = [];
  let cursor = source.indexOf(ATTRIBUTE);
  while (cursor !== -1) {
    let i = cursor + ATTRIBUTE.length;
    const opener = source[i];
    if (opener === '"' || opener === "'") {
      const end = source.indexOf(opener, i + 1);
      if (end !== -1) values.push(source.slice(i + 1, end));
    } else if (opener === '{') {
      let depth = 0;
      for (; i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      values.push(source.slice(cursor + ATTRIBUTE.length + 1, i));
    }
    cursor = source.indexOf(ATTRIBUTE, cursor + ATTRIBUTE.length);
  }
  return values;
}

/**
 * The narrowest viewport the app targets is 360px; a panel at or above 256px
 * (`w-64`) is close enough to it that an anchor offset plus a gutter can push it
 * over. Widths are compared in px so the numeric scale and an arbitrary value
 * answer to one threshold.
 */
const MIN_CLAMPED_PX = 256;
// `w-64` — the numeric scale, in 0.25rem steps at a 16px root. `min-w-80` and
// `max-w-96` are not fixed widths: the token doesn't start at `w-`.
const NUMERIC_WIDTH = /^w-(\d+(?:\.\d+)?)$/;
// `w-[19rem]`, `w-[384px]` — the same bug written as an arbitrary value.
const ARBITRARY_WIDTH = /^w-\[(\d+(?:\.\d+)?)(rem|px)\]$/;
const ARBITRARY_CLAMP = /^max-w-\[(.+)\]$/;
const RELATIVE_UNIT = /[dsl]?vw|%/;
const BARE_RELATIVE = /^(\d+(?:\.\d+)?)(?:[dsl]?vw|%)$/;

/** Fixed width in px, or 0 when the token doesn't declare one. */
function fixedWidthPx(token) {
  const numeric = NUMERIC_WIDTH.exec(token);
  if (numeric) return Number(numeric[1]) * 4;
  const arbitrary = ARBITRARY_WIDTH.exec(token);
  if (!arbitrary) return 0;
  return arbitrary[2] === 'rem' ? Number(arbitrary[1]) * 16 : Number(arbitrary[1]);
}

/**
 * Whether the token caps the element against the width actually available.
 * `max-w-96` / `max-w-lg` / `max-w-none` are absolute ceilings and do not — they
 * leave the panel overflowing a phone exactly as before.
 */
function isViewportClamp(token) {
  if (token === 'max-w-full' || token === 'max-w-screen') return true;
  const arbitrary = ARBITRARY_CLAMP.exec(token);
  if (!arbitrary) return false;
  const value = arbitrary[1];
  if (!RELATIVE_UNIT.test(value)) return false;
  // `calc(100vw+10rem)` is relative, but it widens rather than clamps.
  if (value.includes('+')) return false;
  // A bare `200vw` / `200%` is over the available width, not a bound on it.
  const bare = BARE_RELATIVE.exec(value);
  return !bare || Number(bare[1]) <= 100;
}

/**
 * Grids that are legitimately N-across on a phone, with the reason they are.
 * Adding a row here is a deliberate design call, not a way past the guard — the
 * cell has to stay readable at 360px on its own merits.
 */
const ALLOWED_WIDE_GRIDS = new Map([
  [
    'src/components/calendar/MonthView.jsx',
    'A month grid is inherently seven days wide; collapsing the columns would stop it being a calendar.',
  ],
]);

// A column count that is the phone default: no `variant:` in front of it. Global,
// because a single class string can hold more than one bare token and the widest
// one is the one that decides whether the layout is legible.
const BARE_GRID = /(?:^|\s)grid-cols-(\d+)(?=\s|$)/g;
// Any variant prefix — `sm:`, `lg:`, `@3xl:`, `roomy-viewport:` — makes it conditional.
const PREFIXED_GRID = /[\w@[\]().\-/]+:grid-cols-/;
const MIN_WIDE_COLUMNS = 4;

function widestBareColumnCount(value) {
  BARE_GRID.lastIndex = 0;
  let widest = 0;
  let bare;
  while ((bare = BARE_GRID.exec(value))) widest = Math.max(widest, Number(bare[1]));
  return widest;
}

function inspectTailwind(rawSource, file, report) {
  // Each source shares one comment mask, tag scan and literal inventory across
  // these conventions. Cheap token checks skip scanner work on unrelated files.
  if (!/whitespace-pre-wrap|truncate|panelClassName=|max-h-\[|absolute|grid-cols-/.test(rawSource)) return 0;
  const source = maskComments(rawSource);

  const hasWrap = source.includes(WRAP);
  const hasTruncate = source.includes('truncate');
  const openers = hasWrap || hasTruncate ? source.matchAll(/<(pre|h1)(?=[\s/>{])/g) : [];
  for (const match of openers) {
    const [prefix, tagName] = match;
    if (tagName === 'pre' ? !hasWrap : !hasTruncate) continue;
    const tag = readOpeningTag(source, match.index + prefix.length);
    if (!tag) continue;
    if (tagName === 'pre') {
      const tokens = classTokens(tag.attrs);
      if (tokens.includes(WRAP) && !tokens.some((token) => BREAKS.has(token))) {
        report('pre', `${file}:${lineOf(source, match.index)} — wrapping <pre> needs break-all, break-words or wrap-anywhere`);
      }
    } else if (TRUNCATE_TOKEN.test(tag.attrs) && !TITLE_ATTR.test(tag.attrs)) {
      const close = source.indexOf('</h1>', tag.end);
      if (close !== -1 && source.slice(tag.end, close).includes('{')) {
        report('heading', `${file}:${lineOf(source, match.index)} — truncated dynamic <h1> needs a title`);
      }
    }
  }

  const panels = panelClassValues(source);
  for (const value of panels) {
    if (RAW_VH_RE.test(value)) report('modal', `${file} — use a dynamic viewport cap in panelClassName: ${value}`);
  }
  if (source.includes('<Modal') && RAW_VH_RE.test(source)) {
    source.split('\n').forEach((line, index) => {
      if (line.includes('bg-port-card') && RAW_VH_RE.test(line)) {
        report('modal', `${file}:${index + 1} — put the Modal card's dynamic viewport cap on panelClassName`);
      }
    });
  }

  if (source.includes('absolute') || source.includes('grid-cols-')) {
    for (const { value, index } of stringLiterals(source)) {
      if (value.includes('absolute') && value.includes('w-')) {
        const tokens = value.split(/\s+/);
        if (tokens.includes('absolute') && tokens.some((token) => fixedWidthPx(token) >= MIN_CLAMPED_PX)
          && !tokens.some(isViewportClamp)) {
          report('popover', `${file}:${lineOf(source, index)} — add a viewport-relative max-width: "${value.trim()}"`);
        }
      }
      if (value.includes('grid-cols-') && widestBareColumnCount(value) >= MIN_WIDE_COLUMNS && !PREFIXED_GRID.test(value)) {
        report('grid', `${file}:${lineOf(source, index)} — add a column breakpoint: "${value.trim()}"`);
      }
    }
  }

  return panels.length;
}

function probe(markup, rule) {
  const found = [];
  inspectTailwind(markup, 'probe.jsx', (kind, message) => {
    if (kind === rule) found.push(message);
  });
  return found;
}

describe('Tailwind class conventions', () => {
  it('keeps wrapping logs, headings, dialogs, popovers and grids usable on narrow screens', () => {
    const files = trackedSourceFiles(CLIENT_ROOT);
    expect(files.length).toBeGreaterThan(100);

    const violations = [];
    const usedGridExemptions = new Set();
    let panels = 0;
    for (const file of files) {
      const raw = readText(join(CLIENT_ROOT, file));
      panels += inspectTailwind(raw, file, (rule, message) => {
        if (rule === 'grid' && ALLOWED_WIDE_GRIDS.has(file)) usedGridExemptions.add(file);
        else violations.push(message);
      });
    }

    expect(panels).toBeGreaterThan(20);
    expect(violations).toEqual([]);
    expect([...ALLOWED_WIDE_GRIDS.keys()].filter((file) => !usedGridExemptions.has(file)), 'stale wide-grid exemptions').toEqual([]);
  });

  it('flags a wrapping <pre> with no break class and clears every safe form', () => {
    const flagged = (markup) => probe(markup, 'pre').length;
    expect(flagged('<pre className="text-xs whitespace-pre-wrap">{log}</pre>')).toBe(1);
    expect(flagged('<pre className="whitespace-pre-wrap break-all">{log}</pre>')).toBe(0);
    expect(flagged('<pre className="whitespace-pre-wrap break-words">{prose}</pre>')).toBe(0);
    // A `<pre>` with no wrap class is a horizontal scroller by design.
    expect(flagged('<pre className="text-xs font-mono">{log}</pre>')).toBe(0);
    expect(flagged('<pre>{log}</pre>')).toBe(0);
    // The opener routinely spans lines; a line-scoped scan would miss this one.
    expect(flagged('<pre\n  className="p-2 font-mono whitespace-pre-wrap"\n>\n  {log}\n</pre>')).toBe(1);
    expect(flagged('<pre\n  className="whitespace-pre-wrap break-all"\n>\n  {log}\n</pre>')).toBe(0);
    // Both halves of a composed class string count as one token set.
    expect(flagged('<pre className={`whitespace-pre-wrap ${dense ? "break-all" : "break-words"}`}>{x}</pre>')).toBe(0);
    expect(flagged('<pre className={`whitespace-pre-wrap ${dense ? "text-xs" : "text-sm"}`}>{x}</pre>')).toBe(1);
    // A `>` inside the class expression does not end the opening tag early — if
    // it did, the scan would see no class tokens at all and report nothing.
    expect(flagged('<pre className={n > 2 ? "whitespace-pre-wrap" : "text-xs"}>{x}</pre>')).toBe(1);
    // Neither `overflow-x-auto` nor a max-height substitutes for a break class:
    // the shell clips rather than scrolls, so the overflow is unreachable.
    expect(flagged('<pre className="whitespace-pre-wrap overflow-x-auto max-h-48">{log}</pre>')).toBe(1);
    // A sibling tag whose name merely starts with "pre" is not a <pre>.
    expect(flagged('<preview className="whitespace-pre-wrap" />')).toBe(0);
    // A doc comment quoting an example opener is not markup.
    expect(probe('// e.g. <pre className="whitespace-pre-wrap">', 'pre')).toEqual([]);
  });

  it('flags a truncated dynamic heading and clears every safe form', () => {
    const flagged = (markup) => probe(markup, 'heading').length;
    expect(flagged('<h1 className="text-xl font-bold truncate">{record.name}</h1>')).toBe(1);
    expect(flagged('<h1 className="truncate">#{issue.number} — {issue.title}</h1>')).toBe(1);
    // A tooltip keeps the full value reachable, whatever the clipping style.
    expect(flagged('<h1 className="truncate" title={record.name}>{record.name}</h1>')).toBe(0);
    expect(flagged('<h1 title={n} className="truncate">{n}</h1>')).toBe(0);
    // The tree's canonical fix: wrap over two lines instead of clipping.
    expect(flagged('<h1 className="line-clamp-2 break-words" title={n}>{n}</h1>')).toBe(0);
    expect(flagged('<h1 className="line-clamp-2 break-words">{n}</h1>')).toBe(0);
    // A static heading loses nothing it doesn't already say elsewhere.
    expect(flagged('<h1 className="truncate">Media Gen</h1>')).toBe(0);
    // A variant-prefixed clip leaves the phone alone.
    expect(flagged('<h1 className="md:truncate">{n}</h1>')).toBe(0);
    // A `>` inside an attribute expression must not end the tag early.
    expect(flagged('<h1 className={n.length > 3 ? "truncate" : "x"}>{n}</h1>')).toBe(1);
    expect(flagged('<h1 className={n.length > 3 ? "truncate" : "x"} title={n}>{n}</h1>')).toBe(0);
    // Section headings are out of scope.
    expect(flagged('<h2 className="truncate">{n}</h2>')).toBe(0);
    // Example markup inside a doc block is documentation, not markup.
    expect(probe('// <h1 className="truncate">{record.name}</h1>', 'heading')).toEqual([]);
  });

  it('flags an unclamped fixed-width popover and clears every safe form', () => {
    const flagged = (markup) => probe(`<div className="${markup}" />`, 'popover').length;
    expect(flagged('absolute top-12 right-3 z-20 p-4 w-96 shadow-xl')).toBe(1);
    expect(flagged('absolute right-0 mt-1 w-72 rounded-lg')).toBe(1);
    expect(flagged('absolute right-0 top-full w-64 max-h-80 overflow-y-auto')).toBe(1);
    // A max-height is not a width clamp.
    expect(flagged('absolute w-96 max-h-dvh-cap [--dvh-cap:80dvh]')).toBe(1);
    // The clamp, in either of the tree's two forms, plus the keyword equivalents.
    expect(flagged('absolute right-3 w-96 max-w-[calc(100vw-1rem)] p-4')).toBe(0);
    expect(flagged('absolute w-80 max-w-[90vw] p-3')).toBe(0);
    expect(flagged('absolute w-96 max-w-full')).toBe(0);
    expect(flagged('absolute w-96 max-w-[calc(100%-1rem)]')).toBe(0);
    // An absolute ceiling is not a clamp — it still overflows a 360px phone.
    expect(flagged('absolute w-96 max-w-none')).toBe(1);
    expect(flagged('absolute w-96 max-w-96')).toBe(1);
    expect(flagged('absolute w-96 max-w-lg')).toBe(1);
    expect(flagged('absolute w-96 max-w-screen-sm')).toBe(1);
    // A variant-gated clamp leaves the narrow viewport — the one that clips — bare.
    expect(flagged('absolute w-96 sm:max-w-[calc(100vw-1rem)]')).toBe(1);
    // `min-w-*` is not a fixed width, at any variant prefix.
    expect(flagged('absolute bottom-3 left-3 right-3 sm:right-auto sm:min-w-80')).toBe(0);
    expect(flagged('absolute min-w-96 w-full')).toBe(0);
    // A fixed width that belongs to a variant where the element is no longer
    // absolute is not the bug; the base viewport already clamps.
    expect(flagged('absolute md:static inset-y-0 left-0 w-[80vw] max-w-xs md:w-64')).toBe(0);
    // Narrow panels fit a 360px phone unclamped.
    expect(flagged('absolute right-0 w-56 rounded-lg')).toBe(0);
    // The same bug written as an arbitrary value.
    expect(flagged('absolute top-20 right-4 bottom-24 w-[19rem]')).toBe(1);
    expect(flagged('absolute w-[384px] rounded-lg')).toBe(1);
    expect(flagged('absolute w-[19rem] max-w-[calc(100vw-1rem)]')).toBe(0);
    expect(flagged('absolute w-[12rem] rounded-lg')).toBe(0);
    // Relative units that are not actually a bound.
    expect(flagged('absolute w-96 max-w-[200%]')).toBe(1);
    expect(flagged('absolute w-96 max-w-[calc(100vw+10rem)]')).toBe(1);
    // `fixed` escapes the shell's overflow box; it is positioned to the viewport.
    expect(flagged('fixed bottom-4 right-4 w-96 rounded-lg')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(probe('// e.g. "absolute right-0 w-96"', 'popover')).toEqual([]);
  });

  it('flags a bare wide grid and clears every conditional form', () => {
    const flagged = (markup) => probe(`<div className="${markup}" />`, 'grid').length;
    expect(flagged('grid grid-cols-4 gap-4 mb-6')).toBe(1);
    expect(flagged('grid grid-cols-5 gap-2')).toBe(1);
    // A widened gap is not a column breakpoint — it leaves four columns frozen.
    expect(flagged('grid grid-cols-4 gap-4 sm:gap-6 text-center')).toBe(1);
    // The widest bare token decides, not the first one seen.
    expect(flagged('grid grid-cols-2 gap-2 grid-cols-6')).toBe(1);
    expect(flagged('grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4')).toBe(0);
    expect(flagged('grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-12 gap-1.5')).toBe(0);
    expect(flagged('grid grid-cols-2 gap-3 @3xl:grid-cols-4')).toBe(0);
    // Narrow grids are fine unprefixed — three stat cards still fit at 360px.
    expect(flagged('grid grid-cols-3 gap-2')).toBe(0);
    // A doc comment quoting an example class string is not markup.
    expect(probe('// e.g. "grid grid-cols-4 gap-4"', 'grid')).toEqual([]);
  });

  it('extracts panelClassName values in every syntactic form a caller can use', () => {
    // Proves the sweep below can actually see an offender — otherwise a
    // collector that silently matched nothing would make it vacuously green.
    // The banned classes are interpolated rather than written out so Tailwind's
    // source scanner doesn't emit CSS for a fixture nothing renders.
    const vh = (n) => `max-h-[${n}vh]`;
    const fixture = `
      <Modal panelClassName="a ${vh(85)} b" />
      <Modal panelClassName={ 'c ${vh(80)}' } />
      <Modal panelClassName={\`d ${vh(42.5)}\`} />
      <Modal panelClassName={wide ? 'e ${vh(90)}' : 'f'} />
      <Modal panelClassName="clean [--dvh-cap:60dvh]" />
    `;
    const offenders = probe(fixture, 'modal');
    expect(offenders).toHaveLength(4);
  });

  it('rejects a raw viewport cap on a Modal card and ignores quoted comment examples', () => {
    const fixture = '<Modal><div className="bg-port-card max-h-[' + '85vh]">Text</div></Modal>';
    expect(probe(fixture, 'modal')).toHaveLength(1);
    expect(probe('// ' + fixture, 'modal')).toEqual([]);
  });
});
