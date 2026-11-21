/**
 * Rule: Every route handler reading `req.body` or `req.query` must validate it with `validateRequest`, `validate`, `parseBody`, or `…Schema.safeParse/parse` (see root `AGENTS.md`).
 * Fix: Add a Zod schema to the route family's domain `lib/<domain>Validation.js` file (or `lib/aiToolkit/validation.js` / `cos-runner/requestSchemas.js`) and pass `req.body` / `req.query` to `validateRequest(schema, …)`; prune resolved entries from `ALLOWED_UNVALIDATED`.
 * What this guard cannot see:
 *   - Lexer-assisted scan (`lib/sourceScan.js`): cannot see field-by-field validation in a helper, handlers delegated to a named function, or `router.route(…).post(…)`.
 *   - `parsePagination(req.query)` only clamps limit/offset and does not count as validation.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { join } from 'path';
import { matchBracket } from '../../../lib/sourceScan.js';
import { blankLiterals } from '../../guardSources.js';
import { readText, REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const SERVER_ROOT = join(REPO_ROOT, 'server');

let trackedFilesCache;
let scanCache;

afterAll(() => {
  trackedFilesCache = undefined;
  scanCache = undefined;
});

// Key: `<file> <VERB> <path>` — the declaring file plus the handler's semantic
// identity, never a line number, so unrelated edits above it do not churn the list.
const ALLOWED_UNVALIDATED = new Map([
  ['routes/brainImport.js POST /chatgpt/zip', 'multipart upload: req.body only carries optional text fields beside the ZIP'],
  ['routes/federatedMedia.js POST /assets', 'raw binary body (express.raw); authenticated and byte-validated by storeFederatedMediaAsset'],
  ['routes/imageClean.js POST /', 'raw image bytes (express.raw Buffer); the JSON-shaped options are validated from req.query'],
  ['routes/settings.js PUT /', 'polymorphic settings store: only the slices with a known schema are validated, slice by slice, by design'],
  ['routes/imageTo3d.js POST /models/:id/usdz', 'raw binary body (express.raw); validated by byte checks (non-empty, size cap, zip magic)'],
  ['routes/pipeline/audio.js POST /issues/:id/stages/audio/music/upload', 'multipart upload: req.body only carries an optional label text field'],
]);

const VALIDATE_CALL = /\bvalidateRequest\s*\(|\bvalidate\s*\(|\bparseBody\s*\(|\.safeParse\s*\(|[Ss]chema\w*\.parse\s*\(/g;

/**
 * Names bound to the whole `source` object (`req.body` / `req.query`) or to a
 * rest-copy of it. A field initializer (`const limit = req.query.limit`) is not
 * an alias: `\b` would stop at the dot and treat `limit` as the query object.
 */
function inputAliases(text, source) {
  const escaped = source.replaceAll('.', '\\.');
  const alias = new RegExp(
    `\\b(?:const|let|var)\\s+(\\{[^}]*\\}|[A-Za-z_$][\\w$]*)\\s*=\\s*${escaped}\\b(?!\\s*(?:\\?\\.|\\.|\\[))`,
    'g',
  );
  const names = [];
  for (const m of text.matchAll(alias)) {
    if (!m[1].startsWith('{')) names.push(m[1]);
    else for (const rest of m[1].matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)/g)) names.push(rest[1]);
  }
  return names;
}

/** Index of the first comma outside any bracket pair, or -1 (→ the whole string is one argument). */
function topLevelComma(args) {
  let depth = 0;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) return i;
  }
  return -1;
}

/**
 * True when some validation call in `text` receives `source` (`req.body` or
 * `req.query`) as its DATA argument. A field read (`req.body.name`) does not count.
 */
function validatesInput(text, source) {
  const escaped = source.replace('.', '\\.');
  const carries = new RegExp(`\\b(?:${escaped}|${inputAliases(text, source).join('|') || '(?!)'})\\b(?!\\s*(?:\\?\\.|\\.|\\[))`);
  for (const call of text.matchAll(VALIDATE_CALL)) {
    const open = call.index + call[0].length - 1;
    const end = matchBracket(text, open);
    if (end === -1) continue;
    const args = text.slice(open + 1, end);
    // `validateRequest(schema, data)` / `validate(schema, data)` / `parseBody(schema, data, label)` take the data second, so
    // a value mentioned inside the schema expression does not count. `.safeParse(data)` /
    // `Schema.parse(data)` take it first.
    const schemaFirst = /^(?:validateRequest|validate|parseBody)\b/.test(call[0].trim());
    const dataArg = schemaFirst ? args.slice(topLevelComma(args) + 1) : args;
    if (carries.test(dataArg)) return true;
  }
  return false;
}

/** `<VERB> <path>` for every matching handler that reads `source` without validating it. */
function findUnvalidatedHandlers(src, { verbs, source }) {
  const routeCall = new RegExp(`\\b(?:router|app|[A-Za-z]*Router)\\.(${verbs})\\s*\\(`, 'g');
  const reads = new RegExp(`\\b${source.replace('.', '\\.')}\\b`);
  const blanked = blankLiterals(src);
  const hits = [];
  for (const match of blanked.matchAll(routeCall)) {
    const open = match.index + match[0].length - 1;
    const end = matchBracket(blanked, open);
    if (end === -1) continue;
    const text = blanked.slice(open, end);
    if (!reads.test(text) || validatesInput(text, source)) continue;
    // `blankLiterals` keeps offsets, so the path literal is read from the real source.
    const routePath = /^\(\s*(['"`])(.*?)\1/.exec(src.slice(open, end))?.[2] ?? '<dynamic>';
    hits.push(`${match[1].toUpperCase()} ${routePath}`);
  }
  return hits;
}

/** `<VERB> <path>` for every handler in one file's source that reads `req.body` without validating it. */
export function findUnvalidatedBodyHandlers(src) {
  return findUnvalidatedHandlers(src, { verbs: 'post|put|patch', source: 'req.body' });
}

/** `<VERB> <path>` for every handler that reads `req.query` without validating the query object. */
export function findUnvalidatedQueryHandlers(src) {
  return findUnvalidatedHandlers(src, { verbs: 'get|post|put|patch|delete', source: 'req.query' });
}

// `routes/` plus the two out-of-tree HTTP surfaces (#10024): the vendored toolkit's
// routers and the CoS runner's standalone Express app.
const SCANNED_PATHS = ['routes', 'lib/aiToolkit/routes', 'cos-runner/index.js'];

const trackedRouteSources = () => (trackedFilesCache ??= trackedFiles(SERVER_ROOT, SCANNED_PATHS).filter((f) => f.endsWith('.js') && !f.includes('.test.')));

function runScan() {
  if (scanCache) return scanCache;
  const bodyOffenders = [];
  const queryOffenders = [];

  for (const file of trackedRouteSources()) {
    const src = readText(join(SERVER_ROOT, file));
    for (const hit of findUnvalidatedBodyHandlers(src)) {
      bodyOffenders.push(`${file} ${hit}`);
    }
    for (const hit of findUnvalidatedQueryHandlers(src)) {
      queryOffenders.push(`${file} ${hit}`);
    }
  }

  scanCache = { bodyOffenders, queryOffenders };
  return scanCache;
}

const scanTree = () => runScan().bodyOffenders;
const scanQueries = () => runScan().queryOffenders;

describe('route handlers validate req.body (#9950, #10024)', () => {
  it('scans the route tree', () => {
    // A broken `git ls-files` would otherwise let the assertions below pass by scanning nothing.
    expect(trackedRouteSources().length).toBeGreaterThan(100);
  });

  it('has no unvalidated req.body read outside the allowlist', () => {
    const offenders = scanTree().filter((key) => !ALLOWED_UNVALIDATED.has(key));
    expect(
      offenders,
      'These POST/PUT/PATCH handlers read `req.body` with no schema. Add a Zod schema to '
      + 'the route family\'s domain `lib/<domain>Validation.js` file (the only home for a schema) and call `validateRequest(schema, req.body)` (root AGENTS.md: '
      + 'all route inputs are validated). Do NOT add an allowlist entry for a JSON body.\n'
      + `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('only allowlists handlers that still exist and are still unvalidated', () => {
    const live = new Set(scanTree());
    const stale = [...ALLOWED_UNVALIDATED.keys()].filter((key) => !live.has(key));
    expect(
      stale,
      `These allowlist entries are compliant or gone — delete them from ALLOWED_UNVALIDATED:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
    for (const reason of ALLOWED_UNVALIDATED.values()) expect(reason.length).toBeGreaterThan(10);
  });
});

// Guards the guard: if the recognizer stops seeing the broken shape, the scan
// above goes green and the bug class walks straight back in.
describe('the unvalidated-body recognizer', () => {
  it('flags a handler that reads req.body with no schema', () => {
    expect(findUnvalidatedBodyHandlers(`
      router.post('/probe', asyncHandler(async (req, res) => {
        const { path } = req.body;
        res.json({ path });
      }));
    `)).toEqual(['POST /probe']);
    expect(findUnvalidatedBodyHandlers("router.put('/x/:id', mw, asyncHandler(async (req, res) => { use(req.body?.a); }));"))
      .toEqual(['PUT /x/:id']);
    expect(findUnvalidatedBodyHandlers("appsRouter.patch('/x', (req, res) => res.json(req.body));"))
      .toEqual(['PATCH /x']);
  });

  it('accepts each validation spelling', () => {
    for (const call of [
      'validateRequest(fooSchema, req.body)',
      'validate(fooSchema, req.body)',
      'fooSchema.safeParse(req.body)',
      'fooBodySchema.parse(req.body)',
    ]) {
      expect(findUnvalidatedBodyHandlers(`router.post('/x', asyncHandler(async (req, res) => { ${call}; }));`), call)
        .toEqual([]);
    }
  });

  it('flags a handler that validates req.params or a mere field but reads req.body raw (#10024)', () => {
    expect(findUnvalidatedBodyHandlers("router.post('/x/:id', asyncHandler(async (req, res) => { validateRequest(idSchema, req.params); use(req.body.name); }));"))
      .toEqual(['POST /x/:id']);
    expect(findUnvalidatedBodyHandlers("router.post('/x', asyncHandler(async (req, res) => { const { key, content } = req.body; validateRequest(keySchema, key); }));"))
      .toEqual(['POST /x']);
    expect(findUnvalidatedBodyHandlers("router.post('/x', asyncHandler(async (req, res) => { validateRequest(nameSchema, req.body.name); use(req.body.other); }));"))
      .toEqual(['POST /x']);
    expect(findUnvalidatedBodyHandlers("router.post('/x', asyncHandler(async (req, res) => { const body = req.body; validateRequest(nameSchema, body.name); use(body.other); }));"))
      .toEqual(['POST /x']);
    expect(findUnvalidatedBodyHandlers("router.post('/x', asyncHandler(async (req, res) => { validateRequest(schemaFor(req.body.kind), req.params); }));"))
      .toEqual(['POST /x']);
    expect(findUnvalidatedBodyHandlers("router.post('/x', asyncHandler(async (req, res) => { const path = req.body.path; validateRequest(pathSchema, path); use(req.body.other); }));"))
      .toEqual(['POST /x']);
  });

  it('accepts a body validated through an alias, a spread, or a rest copy (#10024)', () => {
    for (const body of [
      'const body = req.body; validateRequest(fooSchema, body);',
      'validateRequest(fooSchema, { ...req.body, id: req.params.id });',
      'validateRequest(fooSchema.partial(), req.body || {});',
      'const { password, ...rest } = req.body; validateRequest(fooSchema, rest);',
    ]) {
      expect(findUnvalidatedBodyHandlers(`router.put('/x', asyncHandler(async (req, res) => { ${body} }));`), body).toEqual([]);
    }
  });

  it('covers the toolkit routers and the CoS runner app (#10024)', () => {
    const files = trackedRouteSources();
    expect(files).toContain('lib/aiToolkit/routes/prompts.js');
    expect(files).toContain('cos-runner/index.js');
    expect(findUnvalidatedBodyHandlers("app.post('/spawn', lifecycle.spawnRoute(async (req, res) => { const { agentId } = req.body; }));"))
      .toEqual(['POST /spawn']);
    for (const call of ['spawnBodySchema.safeParse(req.body ?? {})', "parseBody(promptStageUpdateBodySchema, req.body, 'stage data')"]) {
      expect(findUnvalidatedBodyHandlers(`router.put('/x', asyncHandler(async (req, res) => { ${call}; }));`), call).toEqual([]);
    }
  });

  it('ignores handlers that never read the body and mentions inside comments or strings', () => {
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { res.json({ ok: true }); });")).toEqual([]);
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { // req.body is ignored\n res.json('req.body'); });")).toEqual([]);
    // `JSON.parse` is not a schema parse.
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { JSON.parse(req.body.raw); });"))
      .toEqual(['POST /x']);
  });
});

describe('route handlers validate req.query (#10024)', () => {
  it('has no unvalidated req.query read', () => {
    const offenders = scanQueries();
    expect(
      offenders,
      'These handlers read `req.query` with no schema on the query object. Add a Zod schema '
      + 'and call `validateRequest(schema, req.query)` (shared shapes: `lib/queryValidation.js`; toolkit routes: `lib/aiToolkit/validation.js`). '
      + 'There is no allowlist for query reads.\n'
      + `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('the unvalidated-query recognizer', () => {
  it('flags a query read that validates req.params, one field, or only the body (#10024)', () => {
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { use(req.query.limit); });"))
      .toEqual(['GET /x']);
    expect(findUnvalidatedQueryHandlers("router.delete('/x/:id', (req, res) => { use(req.query.force); });"))
      .toEqual(['DELETE /x/:id']);
    expect(findUnvalidatedQueryHandlers("router.get('/x/:id', (req, res) => { validateRequest(idSchema, req.params); use(req.query.view); });"))
      .toEqual(['GET /x/:id']);
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { validateRequest(limitSchema, req.query.limit); });"))
      .toEqual(['GET /x']);
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { const limit = req.query.limit; validateRequest(limitSchema, limit); use(req.query.other); });"))
      .toEqual(['GET /x']);
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { const limit = req.query?.limit; validateRequest(limitSchema, limit); });"))
      .toEqual(['GET /x']);
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { const limit = req.query['limit']; validateRequest(limitSchema, limit); });"))
      .toEqual(['GET /x']);
    expect(findUnvalidatedQueryHandlers("router.post('/x', (req, res) => { validateRequest(bodySchema, req.body); use(req.query.dryRun); });"))
      .toEqual(['POST /x']);
    // limit/offset clamping is not a schema for the query object.
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { const page = parsePagination(req.query); });"))
      .toEqual(['GET /x']);
  });

  it('accepts a query object validated directly, through an alias, a spread, or a rest copy', () => {
    for (const call of [
      'validateRequest(fooSchema, req.query)',
      'validate(fooSchema, req.query)',
      'fooSchema.safeParse(req.query)',
      'fooQuerySchema.parse(req.query)',
      'const query = req.query; validateRequest(fooSchema, query);',
      'const query = req.query ?? {}; validateRequest(fooSchema, query);',
      'const query = req.query || {}; validateRequest(fooSchema, query);',
      'validateRequest(fooSchema, { ...req.query, id: req.params.id });',
      'const { token, ...rest } = req.query; validateRequest(fooSchema, rest);',
    ]) {
      expect(findUnvalidatedQueryHandlers(`router.get('/x', (req, res) => { ${call}; });`), call).toEqual([]);
    }
  });

  it('ignores handlers that never read the query and mentions inside comments or strings', () => {
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { res.json({ ok: true }); });")).toEqual([]);
    expect(findUnvalidatedQueryHandlers("router.get('/x', (req, res) => { // req.query is ignored\n res.json('req.query'); });")).toEqual([]);
  });
});
