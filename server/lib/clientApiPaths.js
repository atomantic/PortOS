/**
 * Static scanner for the URL paths `client/src/services/api*.js` asks the server
 * for.
 *
 * The client's ~87 `apiX.js` wrappers are the only place a browser learns which
 * server route a feature lives at, and their co-located tests assert the wrapper
 * produced the string the wrapper produces — nothing compares those strings to
 * the routes `server/index.js` actually mounts. `apiRouteParity.test.js` closes
 * that gap by diffing this scanner's output against
 * `apiRouteCatalog.generated.json` (the existing server-side route inventory
 * built by `scripts/generate-api-route-catalog.js`); this module is only the
 * client half.
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
 * Nothing here records a line number in a checked-in artifact — the results are
 * computed fresh in the test and used only to name a failing call site.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { escapeRegExp } from './textUtils.js';

/** Client wrappers live here; the scan reads `api*.js` minus tests. */
const CLIENT_SERVICES_DIR = 'client/src/services';

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
const REQUEST_CALL = /\b(request|fetch)\s*\(/g;
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

const lineOf = (source, index) => source.slice(0, index).split('\n').length;

/**
 * Scan the client service modules and return every `/api/...` path they request.
 *
 * `sources` injects `{ 'apiThing.js': '<source>' }` instead of reading the tree —
 * the parity test's bypass probes use it to prove the matcher still reports a
 * path the server does not mount.
 */
export function scanClientApiPaths({ repoRoot, sources } = {}) {
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
      const values = resolvePathExpression(text.trim(), { helpers, scope: API_BASE_SCOPE });
      if (!values) { unresolved.push(site); continue; }
      for (const value of values) {
        const path = normalizeClientPath(value);
        if (path) paths.push({ ...site, path });
        else unresolved.push(site);
      }
    }
  }

  return { paths, unresolved };
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
