/**
 * Static scanner for the URL paths the browser client asks the server for.
 *
 * The client's ~87 `apiX.js` wrappers are where a browser mostly learns which
 * server route a feature lives at (components, hooks and pages also call `fetch`,
 * `EventSource` and `api.<verb>` directly, and services build URL strings for
 * `href`/`src`), and their co-located tests assert the wrapper
 * produced the string the wrapper produces — nothing compares those strings to
 * the routes `server/index.js` actually mounts. `apiRouteParity.test.js` closes
 * that gap by diffing this scanner's output against the server-side route
 * inventory `apiRouteGraph.js` derives from the mounted routers; this module
 * is only the client half.
 *
 * Why a source scan rather than importing the modules: `apiCore.request` builds
 * its URL at call time from arguments the wrapper supplies, so the paths exist
 * only as expressions until someone calls them, and a server-suite test cannot
 * import a client module anyway (different workspace, different vitest env).
 * The scan therefore constant-folds those expressions: string and template
 * literals, module-local path helpers (`loomPath(id, '/episodes')`), ternaries,
 * and nested combinations of the three. Anything it cannot fold is REPORTED as
 * unresolved rather than silently dropped, so a wrapper shape this scanner
 * stops understanding surfaces as a review signal instead of shrinking the
 * guard.
 *
 * The scan carries its own small lexer rather than reusing `sourceScan.js`:
 * that module's primitives exist to find CODE constructs, so `blankLiterals`
 * blanks literal content to spaces — which is exactly the text this scan has to
 * read — and its `blankComments` is line-based, which shifts the offsets a
 * balanced expression scan depends on.
 *
 * Two passes, with different strictness (#18656):
 *
 * 1. The CALL pass reads `client/src/services/api*.js` and folds the first argument
 *    of `request(`, `api.<verb>(` and `fetch(` (the last only when it mentions
 *    `API_BASE`). Its paths feed both directions of the parity test, and what it
 *    cannot fold is reported as `unresolved`.
 * 2. The REFERENCE pass reads every non-test file under `client/src` and collects
 *    (a) `api.<verb>(` first arguments and (b) string or template literals that
 *    BEGIN with `/api/` or `${API_BASE}/`. Its paths (`referenced`) only mark
 *    server routes as reached; they never feed the unmounted-path check and are
 *    never reported as unresolved, so help text cannot fail the forward direction.
 *
 * How pass 2 tells a call site from a mention: comments are blanked first, test
 * files are never read, and a literal counts only when the whole literal IS the URL
 * (a prose string like `'GET /api/x'` or `'/api/x is gone'` does not start with the
 * prefix or has whitespace in its path). Literals that are an operand of a
 * comparison or a string-matching call (`=== '/api/x'`, `.startsWith('/api/')`,
 * `case`) or sit inside a `console.*(` call are skipped. What remains is a URL the
 * code builds, hands to `fetch`/`EventSource`/`href`/`src` or returns from a
 * builder; a mention that still has that exact shape is indistinguishable from a
 * call statically, so the matcher stays permissive only in that direction.
 *
 * Nothing here records a line number in a checked-in artifact — the results are
 * computed fresh in the test and used only to name a failing call site.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { escapeRegExp } from './textUtils.js';

/** Client wrappers live here; the call pass reads `api*.js` minus tests. */
const CLIENT_SERVICES_DIR = 'client/src/services';

/** The reference pass reads every non-test source file under here. */
const CLIENT_SRC_DIR = 'client/src';
const CLIENT_SOURCE_FILE = /\.(?:js|jsx)$/;
const CLIENT_TEST_FILE = /(?:\.(?:test|spec)\.[jt]sx?$|(?:^|\/)(?:__tests__|__mocks__|test)\/)/;

/**
 * `apiCore.js` is the transport itself — its `request(endpoint, …)` calls take a
 * caller-supplied path by design, so scanning it would only produce noise.
 */
const TRANSPORT_MODULE = 'apiCore.js';

/**
 * Call shapes that name a server path. `request(endpoint, …)` is the shared
 * transport; the streaming and blob wrappers bypass it and call `fetch` on
 * `` `${API_BASE}/…` `` directly, so those are scanned too — but only when the
 * argument mentions `API_BASE`, since a bare `fetch` may target any origin.
 */
const REQUEST_CALL = /(?<![.\w$])(request|fetch|api\.(?:get|post|put|patch|delete))\s*\(/g;
const API_VERB_CALL = /(?<![.\w$])(?:request|api\.(?:get|post|put|patch|delete))\s*\(/g;
const API_BASE_SCOPE = new Map([['API_BASE', ['']]]);

/**
 * Stand-in for an interpolated value the scan cannot fold to a literal (an id,
 * a query string, a `URLSearchParams`). Braces never occur in a route path, so
 * the marker cannot collide with real path text.
 */
const DYNAMIC = '{dyn}';

/** Every `:param` segment normalizes to this, on both sides of the diff. */
const PARAM_SEGMENT = ':p';

const MAX_DEPTH = 8;

const skipQuoted = (source, start, quote) => {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i++;
  }
  return i;
};

/**
 * Skip a template literal whole, returning the index just past its closing
 * backtick. `depth` counts open braces INSIDE an interpolation, not just `${`
 * — an object literal in there (`${new URLSearchParams({ repoPath })}`) closes
 * a brace the scan never opened, and a counter that only tracked `${` fell out
 * of the interpolation early and then treated the next backtick as the
 * literal's end. A backtick reached while inside an interpolation starts a
 * NESTED template, skipped by recursion.
 */
const skipTemplate = (source, start) => {
  let i = start + 1;
  let depth = 0;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === '$' && source[i + 1] === '{') { depth += 1; i += 2; continue; }
    if (depth > 0 && source[i] === '{') { depth += 1; i++; continue; }
    if (depth > 0 && source[i] === '}') { depth -= 1; i++; continue; }
    if (source[i] === '`') {
      if (depth === 0) return i + 1;
      i = skipTemplate(source, i);
      continue;
    }
    if (depth > 0 && (source[i] === "'" || source[i] === '"')) { i = skipQuoted(source, i, source[i]); continue; }
    i++;
  }
  return i;
};

/**
 * Replace every comment with spaces, preserving offsets and newlines so line
 * numbers and the balanced-scan below stay accurate. A `//` inside a string or
 * template literal (`'https://…'`) must not start a comment, which is why this
 * walks quote state rather than running a regex.
 */
function stripComments(source) {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '/' && source[i + 1] === '/') {
      let end = i;
      while (end < source.length && source[end] !== '\n') end++;
      for (let k = i; k < end; k++) out[k] = ' ';
      i = end;
      continue;
    }
    if (char === '/' && source[i + 1] === '*') {
      const found = source.indexOf('*/', i + 2);
      const end = found === -1 ? source.length : found + 2;
      for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
      i = end;
      continue;
    }
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char); continue; }
    if (char === '`') { i = skipTemplate(source, i); continue; }
    i++;
  }
  return out.join('');
}

const CLOSERS = { '(': ')', '[': ']', '{': '}' };

/**
 * Read forward from `start` until a top-level character in `stops`, or the
 * bracket that closes the enclosing group. Strings, template literals, and
 * nested brackets are skipped whole, so a comma inside `f(a, b)` or `${x ? 1 : 2}`
 * does not terminate the scan.
 */
function scanTo(source, start, stops) {
  const stack = [];
  let i = start;
  while (i < source.length) {
    const char = source[i];
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char); continue; }
    if (char === '`') { i = skipTemplate(source, i); continue; }
    if (CLOSERS[char]) { stack.push(CLOSERS[char]); i++; continue; }
    if (char === ')' || char === ']' || char === '}') {
      if (stack.length === 0) return { text: source.slice(start, i), end: i };
      stack.pop();
      i++;
      continue;
    }
    if (stack.length === 0 && stops.includes(char)) return { text: source.slice(start, i), end: i };
    i++;
  }
  return { text: source.slice(start), end: source.length };
}

function splitArguments(text) {
  const args = [];
  let i = 0;
  while (i <= text.length) {
    const { text: arg, end } = scanTo(text, i, [',']);
    args.push(arg.trim());
    if (end >= text.length) break;
    i = end + 1;
  }
  return args;
}

const parseParameter = (text) => {
  const { text: before, end } = scanTo(text, 0, ['=']);
  const name = before.trim();
  return {
    name: /^[A-Za-z_$][\w$]*$/.test(name) ? name : null,
    fallback: end < text.length ? text.slice(end + 1).trim() : null,
  };
};

/**
 * Collect module-level `const name = (args) => <expression>;` path helpers.
 * Block-bodied arrows are skipped: their result is a statement sequence, not an
 * expression this scanner can fold, and the call sites that use one land in
 * `unresolved` where they are visible.
 */
function parsePathHelpers(source) {
  const helpers = new Map();
  const declaration = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g;
  for (const match of source.matchAll(declaration)) {
    const parenStart = match.index + match[0].length;
    const { text: parameterText, end } = scanTo(source, parenStart, []);
    const arrow = source.slice(end + 1).match(/^\s*=>\s*/);
    if (!arrow) continue;
    const bodyStart = end + 1 + arrow[0].length;
    if (source[bodyStart] === '{') continue;
    // Bounded by the declaration's own semicolon, NOT by the newline: a concise
    // body wrapped across lines would otherwise be truncated to its first line
    // and fold to a WRONG path instead of failing loudly.
    const { text: body } = scanTo(source, bodyStart, [';']);
    helpers.set(match[1], {
      parameters: splitArguments(parameterText).map(parseParameter),
      body: body.trim(),
    });
  }
  return helpers;
}

const stringLiteralValue = (expression) => {
  const match = expression.match(/^(['"])((?:\\.|[^\\])*)\1$/s);
  return match ? match[2].replace(/\\(.)/g, '$1') : null;
};

/**
 * Fold a path expression to the set of strings it can produce, or `null` when
 * the shape is not one this scanner understands. A ternary contributes both
 * branches, so `seriesId ? '/x?s=1' : '/x'` yields both.
 */
function resolvePathExpression(expression, { helpers, scope = new Map(), depth = 0 } = {}) {
  const text = (expression ?? '').trim();
  if (!text || depth > MAX_DEPTH) return null;

  const literal = stringLiteralValue(text);
  if (literal !== null) return [literal];

  if (text.startsWith('`') && skipTemplate(text, 0) === text.length) {
    return resolveTemplate(text, { helpers, scope, depth });
  }

  if (/^[A-Za-z_$][\w$]*$/.test(text)) return scope.get(text) ?? null;

  const condition = scanTo(text, 0, ['?']);
  if (condition.end < text.length && text[condition.end + 1] !== '.') {
    const rest = text.slice(condition.end + 1);
    const branch = scanTo(rest, 0, [':']);
    if (branch.end < rest.length) {
      const consequent = resolvePathExpression(branch.text, { helpers, scope, depth: depth + 1 });
      const alternate = resolvePathExpression(rest.slice(branch.end + 1), { helpers, scope, depth: depth + 1 });
      if (!consequent || !alternate) return null;
      return [...consequent, ...alternate];
    }
  }

  // `request(...scoped('/privacy/vault', options))` — the helper returns the
  // whole `[path, options]` ARGUMENT PAIR, so the request path is the helper's
  // own first argument. (It may append a query string; normalization drops it.)
  if (text.startsWith('...')) {
    const spread = text.slice(3).trimStart();
    const spreadCall = spread.match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (!spreadCall) return null;
    const [first] = splitArguments(scanTo(spread, spreadCall[0].length, []).text);
    return resolvePathExpression(first, { helpers, scope, depth: depth + 1 });
  }

  const call = text.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  const helper = call && helpers?.get(call[1]);
  if (helper) {
    const args = splitArguments(scanTo(text, call[0].length, []).text);
    const inner = new Map();
    for (const [index, parameter] of helper.parameters.entries()) {
      if (!parameter.name) continue;
      // splitArguments yields '' for a position the call omitted, so `||` (not `??`)
      // is what falls through to the parameter's default expression.
      const argument = args[index] || parameter.fallback;
      inner.set(
        parameter.name,
        argument == null ? [DYNAMIC] : (resolvePathExpression(argument, { helpers, scope, depth: depth + 1 }) ?? [DYNAMIC]),
      );
    }
    return resolvePathExpression(helper.body, { helpers, scope: inner, depth: depth + 1 });
  }

  return null;
}

function resolveTemplate(text, context) {
  const body = text.slice(1, -1);
  let prefixes = [''];
  let chunk = '';
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') { chunk += body[i + 1] ?? ''; i += 2; continue; }
    if (body[i] === '$' && body[i + 1] === '{') {
      const { text: inner, end } = scanTo(body, i + 2, []);
      const values = resolvePathExpression(inner, { ...context, depth: context.depth + 1 }) ?? [DYNAMIC];
      prefixes = prefixes.flatMap((prefix) => values.map((value) => prefix + chunk + value));
      chunk = '';
      i = end + 1;
      continue;
    }
    chunk += body[i];
    i++;
  }
  return prefixes.map((prefix) => prefix + chunk);
}

/**
 * Turn one folded string into the `/api/...` path shape the server catalog uses,
 * or `null` when it is not a request path at all.
 *
 * A segment that is entirely dynamic becomes `:p`. A dynamic tail fused onto the
 * END of the last static segment is a query-string builder — `…/projections${qs(f)}`
 * where `qs` returns `'?a=b'` or `''` — so the marker is dropped rather than
 * swallowing the segment. A dynamic fused anywhere else is a genuinely variable
 * segment and normalizes to `:p`.
 */
function normalizeClientPath(raw) {
  const withoutQuery = raw.split('?')[0].split('#')[0];
  if (!withoutQuery.startsWith('/')) return null;
  const segments = withoutQuery.split('/').filter(Boolean);
  const normalized = segments.map((segment, index) => {
    if (!segment.includes(DYNAMIC)) return segment;
    if (segment === DYNAMIC) return PARAM_SEGMENT;
    const isTrailingSuffix = index === segments.length - 1
      && segment.endsWith(DYNAMIC)
      && !segment.slice(0, -DYNAMIC.length).includes(DYNAMIC);
    return isTrailingSuffix ? segment.slice(0, -DYNAMIC.length) : PARAM_SEGMENT;
  });
  return `/api${normalized.map((segment) => `/${segment}`).join('')}`;
}

/** Collapse a server catalog path's named params so both sides compare equal. */
const normalizeServerPath = (path) =>
  path.split('/').map((segment) => (segment.startsWith(':') ? PARAM_SEGMENT : segment)).join('/');

const isWildcard = (segment) => segment.startsWith('*');

/**
 * Express 5 wildcard segments (`/apps/:id/documents/*docPath`) swallow one or
 * more path segments, so the client's `…/documents/:p/:p` is a legitimate match
 * for them and plain string equality is not. Only wildcard routes need the
 * regex; everything else stays in an O(1) Set.
 */
const wildcardMatcher = (path) => new RegExp(`^${
  path.split('/').filter(Boolean)
    .map((segment) => (isWildcard(segment) ? '[^/]+(?:/[^/]+)*' : escapeRegExp(segment)))
    .map((pattern) => `/${pattern}`)
    .join('')
}$`);

/** A literal operand of a comparison or a string-matching call is a test on a URL, not a request for it. */
const MATCHING_CONTEXT = /(?:\.(?:startsWith|endsWith|includes|indexOf|lastIndexOf|replace|replaceAll|match|split|test)\s*\(\s*|[=!]==?\s*|\bcase\s+)$/;

/** Keep a reference only when it names at least one static segment under `/api`. */
const isNamedApiPath = (path) => path !== null && (path.split('/')[2] ?? PARAM_SEGMENT) !== PARAM_SEGMENT;

/**
 * Fold one string or template literal into the `/api/...` path it is the whole
 * URL of, or `null` when it is anything else. The raw literal must BEGIN with
 * `/api/` or `${API_BASE}/`, and its path (up to the query) must hold no
 * whitespace — prose that merely mentions a route fails one or the other. A
 * trailing `/` is a prefix a caller appends an id to (`'/api/x/' + id`).
 */
function foldReferencedLiteral(literal, context) {
  const quoted = stringLiteralValue(literal);
  const isApiBase = literal.startsWith('`${API_BASE}/');
  if (quoted === null && !isApiBase && !/^`(?:\$\{[\w$.]+\})?\/api(?:\/|\$\{)/.test(literal)) return null;
  if (quoted !== null && !quoted.startsWith('/api/')) return null;
  const values = quoted !== null ? [quoted] : resolveTemplate(literal, context);
  const paths = values
    .map((value) => (isApiBase || !/^(?:\{dyn\})?\/api\//.test(value) ? (isApiBase ? value : null) : value.replace(/^(?:\{dyn\})?\/api(?=\/)/, '')))
    .filter((value) => value !== null)
    .filter((value) => !/\s/.test(value.split(/[?#]/)[0]))
    .map((value) => normalizeClientPath(value.endsWith('/') ? `${value}${DYNAMIC}` : value))
    .filter(isNamedApiPath);
  return paths.length ? paths : null;
}

/**
 * Pass 2 over one file: every `api.<verb>(` first argument and every URL-shaped
 * literal, as `/api/...` paths. See the header for how a call differs from a mention.
 */
function scanReferencedPaths(rawSource) {
  const source = stripComments(rawSource);
  const helpers = parsePathHelpers(source);
  const context = { helpers, scope: API_BASE_SCOPE, depth: 0 };
  const found = [];

  // Literal spans first: a call-shaped text INSIDE a string (`'api.get("/x")'` in help text or a log)
  // is a mention, so the verb scan below skips matches that start inside one.
  const literals = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char !== "'" && char !== '"' && char !== '`') { i++; continue; }
    const end = char === '`' ? skipTemplate(source, i) : skipQuoted(source, i, char);
    // A quote that does not close on its own line is an apostrophe in JSX text, not a literal.
    if (char !== '`' && source.slice(i, end).includes('\n')) { i++; continue; }
    literals.push([i, end]);
    i = end;
  }
  const insideLiteral = (index) => literals.some(([from, to]) => index > from && index < to);

  for (const match of source.matchAll(API_VERB_CALL)) {
    if (insideLiteral(match.index)) continue;
    const { text } = scanTo(source, match.index + match[0].length, [',']);
    const values = resolvePathExpression(text.trim(), context) ?? [];
    for (const value of values) {
      const path = normalizeClientPath(value);
      if (isNamedApiPath(path)) found.push(path);
    }
  }

  const loggingSpans = [...source.matchAll(/\bconsole\.\w+\s*\(/g)]
    .map((match) => [match.index, scanTo(source, match.index + match[0].length, []).end]);
  for (const [from, to] of literals) {
    const insideLog = loggingSpans.some(([start, stop]) => from > start && from < stop);
    if (insideLog || MATCHING_CONTEXT.test(source.slice(Math.max(0, from - 40), from))) continue;
    found.push(...(foldReferencedLiteral(source.slice(from, to), context) ?? []));
  }
  return found;
}

/**
 * Module-local helpers that forward a `path` PARAMETER into `request(path, …)`
 * (apiTimeline's `importFile`): the path lives at the helper's call sites, so
 * fold the argument each caller passes in that position. Returns `null` when the
 * expression is not a parameter of an earlier helper or any call site is unfoldable,
 * which leaves the site `unresolved` for the caller to declare.
 */
function resolveForwardedParameter(source, siteIndex, name, context) {
  const declaration = /(?:^|\n)[ \t]*(?:export\s+)?(?:(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\()/g;
  let helper = null;
  for (const match of source.slice(0, siteIndex).matchAll(declaration)) {
    const { text } = scanTo(source, match.index + match[0].length, []);
    const position = splitArguments(text).map(parseParameter).findIndex((parameter) => parameter.name === name);
    if (position !== -1) helper = { name: match[1] ?? match[2], position, declaredAt: match.index };
  }
  if (!helper) return null;
  const calls = [...source.matchAll(new RegExp(`(?<![.\\w$])${escapeRegExp(helper.name)}\\s*\\(`, 'g'))]
    .filter((call) => call.index > helper.declaredAt + 1 && !/(?:function\s+|(?:const|let)\s+)$/.test(source.slice(Math.max(0, call.index - 12), call.index)));
  const values = [];
  for (const call of calls) {
    const args = splitArguments(scanTo(source, call.index + call[0].length, []).text);
    const folded = resolvePathExpression(args[helper.position], context);
    if (!folded) return null;
    values.push(...folded);
  }
  return values.length ? values : null;
}

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/** Every non-test `.js`/`.jsx` under client/src, relative to it. */
const listClientSourceFiles = (repoRoot) => readdirSync(join(repoRoot, CLIENT_SRC_DIR), { recursive: true })
  .map((file) => file.split(sep).join('/'))
  .filter((file) => CLIENT_SOURCE_FILE.test(file) && !CLIENT_TEST_FILE.test(file))
  .sort();

/**
 * Scan the client and return the `/api/...` paths its service modules request
 * (`paths`, `unresolved`) and the wider set any client file references (`referenced`).
 *
 * `sources` injects `{ 'apiThing.js': '<source>' }` instead of reading the tree —
 * the parity test's bypass probes use it to prove the matcher still reports a
 * path the server does not mount.
 */
export function scanClientApiPaths({ repoRoot, sources } = {}) {
  const referencedSources = sources
    ? Object.entries(sources).filter(([file]) => !CLIENT_TEST_FILE.test(file))
    : listClientSourceFiles(repoRoot).map((file) => [file, readFileSync(join(repoRoot, CLIENT_SRC_DIR, file), 'utf8')]);
  const referenced = [...new Set(referencedSources.flatMap(([, source]) => scanReferencedPaths(source)))].sort();

  const modules = sources
    ? Object.entries(sources)
    : readdirSync(join(repoRoot, CLIENT_SERVICES_DIR))
      .filter((file) => /^api.*\.js$/.test(file) && !file.endsWith('.test.js') && file !== TRANSPORT_MODULE)
      .sort()
      .map((file) => [file, readFileSync(join(repoRoot, CLIENT_SERVICES_DIR, file), 'utf8')]);

  const paths = [];
  const unresolved = [];

  for (const [file, rawSource] of modules) {
    const source = stripComments(rawSource);
    const helpers = parsePathHelpers(source);
    for (const match of source.matchAll(REQUEST_CALL)) {
      const { text } = scanTo(source, match.index + match[0].length, [',']);
      const expression = text.trim().replace(/\s+/g, ' ');
      if (match[1] === 'fetch' && !/\bAPI_BASE\b/.test(expression)) continue;
      const site = { file: `${CLIENT_SERVICES_DIR}/${file}`, line: lineOf(source, match.index), expression };
      const context = { helpers, scope: API_BASE_SCOPE };
      const values = resolvePathExpression(text.trim(), context)
        ?? (/^[A-Za-z_$][\w$]*$/.test(text.trim()) ? resolveForwardedParameter(source, match.index, text.trim(), context) : null);
      if (!values) { unresolved.push(site); continue; }
      for (const value of values) {
        const path = normalizeClientPath(value);
        if (path) paths.push({ ...site, path });
        else unresolved.push(site);
      }
    }
  }

  return { paths, unresolved, referenced };
}

/** Client call sites whose path no mounted server route can serve. */
export const findUnmountedClientPaths = (clientPaths, serverPaths) => {
  const normalized = [...serverPaths].map(normalizeServerPath);
  const exact = new Set(normalized.filter((path) => !path.split('/').some(isWildcard)));
  const wildcards = normalized.filter((path) => path.split('/').some(isWildcard)).map(wildcardMatcher);
  return clientPaths.filter(
    (entry) => !exact.has(entry.path) && !wildcards.some((matcher) => matcher.test(entry.path)),
  );
};

/**
 * Mounted server routes no client wrapper path can reach — the reverse of
 * `findUnmountedClientPaths`, returned as one entry per distinct route path with
 * the methods declared on it.
 *
 * A route counts as reached when a client path matches it segment by segment, where
 * a `:param` (server) or `:p` (client, fully dynamic) segment matches anything and
 * an Express wildcard swallows one or more segments. A client param does NOT reach a
 * server literal when a sibling mounted route (same segment count, same preceding
 * segments) has a param at that position: Express registers the literal as its own
 * handler, so a wrapper for `/jobs/:id` only hits `/jobs/due` by accident, and
 * counting it as a caller hid dead static routes beside every id wrapper (#18655).
 * Matching is by path, not method, mirroring the forward check, so a GET wrapper
 * still counts as calling a POST route on the same path.
 */
export const findUncalledServerRoutes = (serverRoutes, clientPaths) => {
  const clientSegments = [...new Set(clientPaths.map((entry) => entry.path))]
    .map((path) => path.split('/').filter(Boolean));
  const isParam = (segment) => segment.startsWith(':');
  const serverSegments = [...new Set(serverRoutes.map((route) => route.path))]
    .map((path) => path.split('/').filter(Boolean))
    .filter((segments) => !segments.some(isWildcard));
  const siblingParamCache = new Map();
  const hasSiblingParam = (segments, index) => {
    const key = `${segments.join('/')}|${index}`;
    if (!siblingParamCache.has(key)) {
      siblingParamCache.set(key, serverSegments.some((other) =>
        other.length === segments.length
        && isParam(other[index])
        && segments.slice(0, index).every((segment, at) => isParam(segment) || isParam(other[at]) || segment === other[at])));
    }
    return siblingParamCache.get(key);
  };
  const reached = (route) => {
    const segments = route.split('/').filter(Boolean);
    const wildcardAt = segments.findIndex(isWildcard);
    return clientSegments.some((client) => {
      if (wildcardAt === -1 && client.length !== segments.length) return false;
      if (wildcardAt !== -1 && client.length < segments.length) return false;
      const limit = wildcardAt === -1 ? segments.length : wildcardAt;
      return segments.slice(0, limit).every((segment, index) => {
        if (segment === client[index] || isParam(segment)) return true;
        return isParam(client[index]) && (wildcardAt !== -1 || !hasSiblingParam(segments, index));
      });
    });
  };
  const methodsByPath = new Map();
  for (const { method, path } of serverRoutes) {
    if (!methodsByPath.has(path)) methodsByPath.set(path, new Set());
    methodsByPath.get(path).add(method);
  }
  return [...methodsByPath]
    .filter(([path]) => !reached(path))
    .map(([path, methods]) => ({ path, methods: [...methods].sort() }))
    .sort((a, b) => a.path.localeCompare(b.path));
};
