/**
 * Repo-wide guard: a body-bearing route handler must validate `req.body`.
 *
 * Root `AGENTS.md` says every route input is validated through
 * `lib/validation.js`, but a hand-rolled `if (!path) throw …` is easy to write
 * and nothing noticed (#9950): ~50 POST/PUT/PATCH handlers read `req.body` with
 * no schema, so a wrong-typed field (`path: {}`, `enabled: "yes"`) reached the
 * service layer instead of bouncing as a 400.
 *
 * ## The rule
 *
 * Every `router.post|put|patch(…)` call under `server/routes/` whose handler
 * text mentions `req.body` must also contain one of
 *
 *   - `validateRequest(schema, …)` (the default — throws the 400),
 *   - `validate(schema, …)` (the non-throwing sibling providers/social routes use), or
 *   - `<name>Schema….safeParse(…)` / `<name>Schema….parse(…)`.
 *
 * ## Allowlist
 *
 * `ALLOWED_UNVALIDATED` holds the handlers that are exempt, each with a
 * one-line reason. It may only SHRINK: the test fails when an entry names a
 * handler that no longer exists or now validates, so a fixed handler is pruned
 * here in the same change. A genuinely new violation is a bug to fix with a
 * schema in `lib/validation.js`, not an entry to add.
 *
 * ## What this guard CANNOT see
 *
 * It is a lexer-assisted source scan (`lib/sourceScan.js`), not an AST pass.
 * It cannot tell WHICH value a `validateRequest(…)` call validates, so a handler
 * that validates `req.params` and reads `req.body` raw reads as compliant; it
 * does not follow a handler delegated to a named function declared elsewhere;
 * and it only sees `router.<verb>(…)` call sites (not `router.route(…).post`).
 * Out of scope on purpose: `lib/aiToolkit/routes/` (the vendored toolkit is
 * self-contained and cannot import `lib/validation.js`) and `cos-runner/` (a
 * separate process with its own spawn API). `req.query` reads are a follow-up
 * rule once this body list is empty.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { blankLiterals, matchBracket } from './lib/sourceScan.js';

const SERVER_ROOT = dirname(fileURLToPath(import.meta.url));

// Key: `<file> <VERB> <path>` — the declaring file plus the handler's semantic
// identity, never a line number, so unrelated edits above it do not churn the list.
const ALLOWED_UNVALIDATED = new Map([
  ['routes/brainImport.js POST /chatgpt/zip', 'multipart upload: req.body only carries optional text fields beside the ZIP'],
  ['routes/federatedMedia.js POST /assets', 'raw binary body (express.raw); authenticated and byte-validated by storeFederatedMediaAsset'],
  ['routes/imageTo3d.js POST /models/:id/usdz', 'raw binary body (express.raw); validated by byte checks (non-empty, size cap, zip magic)'],
  ['routes/pipeline/audio.js POST /issues/:id/stages/audio/music/upload', 'multipart upload: req.body only carries an optional label text field'],
]);

const ROUTE_CALL = /\b(?:router|[A-Za-z]*Router)\.(post|put|patch)\s*\(/g;
const READS_BODY = /\breq\.body\b/;
const VALIDATES = /\bvalidateRequest\s*\(|\bvalidate\s*\(|\.safeParse\s*\(|[Ss]chema\w*\.parse\s*\(/;

/** `<VERB> <path>` for every handler in one file's source that reads `req.body` without validating it. */
export function findUnvalidatedBodyHandlers(src) {
  const blanked = blankLiterals(src);
  const hits = [];
  for (const match of blanked.matchAll(ROUTE_CALL)) {
    const open = match.index + match[0].length - 1;
    const end = matchBracket(blanked, open);
    if (end === -1) continue;
    const text = blanked.slice(open, end);
    if (!READS_BODY.test(text) || VALIDATES.test(text)) continue;
    // `blankLiterals` keeps offsets, so the path literal is read from the real source.
    const routePath = /^\(\s*(['"`])(.*?)\1/.exec(src.slice(open, end))?.[2] ?? '<dynamic>';
    hits.push(`${match[1].toUpperCase()} ${routePath}`);
  }
  return hits;
}

const trackedRouteSources = () => execFileSync('git', ['ls-files', 'routes'], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f.endsWith('.js') && !f.includes('.test.'));

const scanTree = () => trackedRouteSources().flatMap((file) => (
  findUnvalidatedBodyHandlers(readFileSync(join(SERVER_ROOT, file), 'utf8')).map((hit) => `${file} ${hit}`)
));

describe('route handlers validate req.body (#9950)', () => {
  it('scans the route tree', () => {
    // A broken `git ls-files` would otherwise let the assertions below pass by scanning nothing.
    expect(trackedRouteSources().length).toBeGreaterThan(100);
  });

  it('has no unvalidated req.body read outside the allowlist', () => {
    const offenders = scanTree().filter((key) => !ALLOWED_UNVALIDATED.has(key));
    expect(
      offenders,
      'These POST/PUT/PATCH handlers read `req.body` with no schema. Add a Zod schema to '
      + '`lib/validation.js` and call `validateRequest(schema, req.body)` (root AGENTS.md: '
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

  it('ignores handlers that never read the body and mentions inside comments or strings', () => {
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { res.json({ ok: true }); });")).toEqual([]);
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { // req.body is ignored\n res.json('req.body'); });")).toEqual([]);
    // `JSON.parse` is not a schema parse.
    expect(findUnvalidatedBodyHandlers("router.post('/x', (req, res) => { JSON.parse(req.body.raw); });"))
      .toEqual(['POST /x']);
  });
});
