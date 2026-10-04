/**
 * Repo-wide guard: a route handler must validate the `req.body` or `req.query` it reads.
 *
 * Root `AGENTS.md` says every route input is validated through
 * `lib/validation.js`, but a hand-rolled `if (!path) throw …` is easy to write
 * and nothing noticed (#9950): ~50 POST/PUT/PATCH handlers read `req.body` with
 * no schema, so a wrong-typed field (`path: {}`, `enabled: "yes"`) reached the
 * service layer instead of bouncing as a 400.
 *
 * ## The rule
 *
 * Every `router.post|put|patch(…)` call under `server/routes/` (and the
 * vendored toolkit's `lib/aiToolkit/routes/`, plus the CoS runner's own
 * `app.post|put|patch(…)` in `cos-runner/index.js`) whose handler text mentions
 * `req.body` must also contain one of
 *
 *   - `validateRequest(schema, …)` (the default — throws the 400),
 *   - `validate(schema, …)` (the non-throwing sibling providers/social routes use),
 *   - `parseBody(schema, …)` (the toolkit prompts router's local wrapper over `validate`), or
 *   - `<name>Schema….safeParse(…)` / `<name>Schema….parse(…)` (the CoS runner's shape:
 *     it is a separate process, so it answers its own `{ error }` 400).
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
 * It checks that the validation call's DATA argument carries `req.body` (or a
 * name assigned from it, incl. a `...rest` copy), so validating `req.params` while
 * reading `req.body` raw is flagged. It cannot see a body validated field-by-field
 * through a helper. It does not follow a handler delegated to a named function declared elsewhere;
 * and it only sees `router.<verb>(…)` call sites (not `router.route(…).post`).
 * The toolkit cannot import `lib/validation.js` (self-contained), so its schemas
 * live in `lib/aiToolkit/validation.js`; the runner's are `cos-runner/requestSchemas.js`.
 *
 * ## Query strings (#10024)
 *
 * The same rule applies to `req.query` on `get|post|put|patch|delete` handlers in
 * the same trees: the validation call's data argument must be the query object
 * (or a name assigned from it, including a `...rest` copy), not one field.
 * `parsePagination(req.query)` only clamps limit/offset, so it does not count.
 * `UNVALIDATED_QUERY_BASELINE` is the burn-down of handlers that already read
 * `req.query` without that call. It may only SHRINK — delete a line when the
 * handler validates or disappears. A new reader gets a schema, not a new line.
 * The lexer limits above apply to this scan too.
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

const trackedRouteSources = () => execFileSync('git', ['ls-files', ...SCANNED_PATHS], {
  cwd: SERVER_ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
}).split('\n').filter((f) => f.endsWith('.js') && !f.includes('.test.'));

const scanWith = (finder) => trackedRouteSources().flatMap((file) => (
  finder(readFileSync(join(SERVER_ROOT, file), 'utf8')).map((hit) => `${file} ${hit}`)
));

const scanTree = () => scanWith(findUnvalidatedBodyHandlers);
const scanQueries = () => scanWith(findUnvalidatedQueryHandlers);

// Handlers that already read `req.query` without a schema call on the query
// object. Shrink-only: delete a line when it validates or disappears; never add
// one. Keyed by file + verb + path so an unrelated edit above the handler does
// not churn the list (#10024).
const UNVALIDATED_QUERY_BASELINE = [
  'lib/aiToolkit/routes/runs.js DELETE /',
  'lib/aiToolkit/routes/runs.js GET /',
  'routes/agentPersonalities.js GET /',
  'routes/agentTools.js DELETE /drafts/:draftId',
  'routes/agentTools.js GET /drafts',
  'routes/agentTools.js GET /feed',
  'routes/agentTools.js GET /post/:postId',
  'routes/agentTools.js GET /published',
  'routes/agentTools.js GET /rate-limits',
  'routes/agentTools.js GET /relevant-posts',
  'routes/agentTools.js GET /submolts',
  'routes/agentTools.js PUT /drafts/:draftId',
  'routes/albums.js GET /',
  'routes/appleHealth.js GET /correlation',
  'routes/appleHealth.js GET /metrics/:metricName',
  'routes/appleHealth.js GET /metrics/:metricName/daily',
  'routes/appleHealth.js GET /metrics/latest',
  'routes/apps/agents.js GET /:id/agents',
  'routes/apps/taskTypes.js GET /:id/work-items',
  'routes/apps/viteTls.js GET /:id/vite-host-check',
  'routes/artists.js GET /',
  'routes/authors.js GET /',
  'routes/autobiography.js GET /prompt',
  'routes/autobiography.js GET /stories',
  'routes/automationSchedules.js GET /',
  'routes/avatar.js GET /model.glb',
  'routes/brainCrud.js GET /admin',
  'routes/brainCrud.js GET /ideas',
  'routes/brainCrud.js GET /projects',
  'routes/brainDailyLog.js GET /daily-log',
  'routes/brainDigest.js GET /digests',
  'routes/brainDigest.js GET /reviews',
  'routes/brainImport.js GET /chatgpt/archive/:name',
  'routes/brainOnThisDay.js GET /on-this-day',
  'routes/browser.js GET /downloads/:name',
  'routes/calendar.js GET /agenda',
  'routes/calendar.js GET /events',
  'routes/calendar.js GET /google/oauth/callback',
  'routes/calendar.js GET /review/history',
  'routes/catalog.js DELETE /types/:id',
  'routes/catalog.js GET /ingredients/:id',
  'routes/catalog.js GET /ingredients/:id/details',
  'routes/catalog.js GET /scraps',
  'routes/catalog.js GET /sync',
  'routes/codeAnimation.js GET /accepted-assets',
  'routes/codeAnimation.js GET /projects',
  'routes/codeAnimation.js GET /projects/:id/history',
  'routes/cosInsightRoutes.js GET /activity-calendar',
  'routes/cosInsightRoutes.js GET /decisions',
  'routes/cosInsightRoutes.js GET /recent-tasks',
  'routes/cosLearningRoutes.js GET /digest/compare',
  'routes/cosLearningRoutes.js GET /learning/insights',
  'routes/cosScheduleRoutes.js GET /upcoming',
  'routes/cosTaskRoutes.js DELETE /tasks/:id',
  'routes/cosTemplateRoutes.js GET /templates/popular',
  'routes/cosWorkflowRoutes.js GET /workflow',
  'routes/creativeCommissions.js GET /',
  'routes/creativeDirector.js GET /:id',
  'routes/digital-twin/documents.js GET /documents',
  'routes/digital-twin/feedback.js GET /feedback/recent',
  'routes/eidoverseWorldRoutes.js DELETE /foundations/:id',
  'routes/eidoverseWorldRoutes.js GET /foundations/:id',
  'routes/eidoverseWorldRoutes.js POST /foundations/:id/adopt',
  'routes/featureAgents.js GET /:id/runs',
  'routes/feeds.js GET /items',
  'routes/feeds.js POST /items/read-all',
  'routes/games.js GET /',
  'routes/genome.js GET /epigenetic/compliance',
  'routes/genome.js GET /epigenetic/recommendations',
  'routes/harnesses.js GET /',
  'routes/harnesses.js POST /action',
  'routes/harnesses.js POST /models/refresh',
  'routes/identity.js GET /goals/:id/calendar-events',
  'routes/imageGen.js GET /models/:modelId/download',
  'routes/imageGen.js GET /regen/availability',
  'routes/imageGen.js GET /status',
  'routes/imageGenSetup.js POST /install',
  'routes/jira.js GET /instances/:instanceId/board-columns/:projectKey',
  'routes/jira.js GET /instances/:instanceId/projects/:projectKey/epics',
  'routes/jira.js GET /reports',
  'routes/localLlm.js GET /catalog',
  'routes/localLlm.js GET /loaded',
  'routes/loras.js GET /',
  'routes/loras.js GET /suggestions',
  'routes/meatspaceAlcoholRoutes.js GET /alcohol/daily',
  'routes/meatspaceNicotineRoutes.js GET /nicotine/daily',
  'routes/meatspacePostRoutes.js GET /post/morse/progress',
  'routes/meatspacePostRoutes.js GET /post/recommendations',
  'routes/meatspacePostRoutes.js GET /post/review/reps',
  'routes/meatspacePostRoutes.js GET /post/sessions',
  'routes/meatspacePostRoutes.js GET /post/stats',
  'routes/meatspacePostRoutes.js GET /post/training/entries',
  'routes/meatspacePostRoutes.js GET /post/training/stats',
  'routes/mediaCollections.js GET /',
  'routes/memory.js DELETE /:id',
  'routes/memory.js GET /:id/related',
  'routes/memory.js GET /sync',
  'routes/messages.js GET /drafts',
  'routes/messages.js POST /debug/test-token',
  'routes/moltworldTools.js GET /balance',
  'routes/moltworldTools.js GET /rate-limits',
  'routes/moltworldTools.js GET /status',
  'routes/moodBoard.js GET /',
  'routes/music.js POST /setup/runtime-install',
  'routes/notifications.js GET /',
  'routes/openclaw.js GET /sessions/:id/messages',
  'routes/peerSync.js GET /cos-agent-archive',
  'routes/peerSync.js GET /integrity',
  'routes/peerSync.js GET /manifest',
  'routes/peerSync.js GET /record',
  'routes/peerSync.js GET /subscriptions',
  'routes/pipeline/covers.js GET /issues/:id/comic.pdf',
  'routes/pipeline/covers.js GET /series/:id/seasons/:seasonId/volume.pdf',
  'routes/pipeline/issues.js GET /issues/recent',
  'routes/pipeline/manuscript.js GET /series/:id/manuscript',
  'routes/pipeline/series.js GET /series',
  'routes/platformAccounts.js GET /',
  'routes/prompts.js DELETE /:stage',
  'routes/providers.js GET /codex/account',
  'routes/providers.js GET /codex/models',
  'routes/providers.js GET /fleet-host',
  'routes/providers.js GET /readiness',
  'routes/providers.js POST /readiness/serve-model',
  'routes/providers.js POST /readiness/setup',
  'routes/providers.js POST /runtimes/install',
  'routes/quotaBurn.js GET /',
  'routes/remoteDesktopViewer.js GET /',
  'routes/review.js GET /items',
  'routes/scaffold.js GET /directories',
  'routes/sharing.js GET /subscriptions',
  'routes/socialAccounts.js GET /',
  'routes/spotify.js GET /oauth/callback',
  'routes/sprites.js GET /',
  'routes/storyBuilder.js GET /',
  'routes/tracks.js GET /',
  'routes/tribe.js GET /care',
  'routes/tribe.js GET /outreach',
  'routes/tribe.js GET /people/:id/touchpoints',
  'routes/universeBuilder/canon.js GET /:id/characters/integrity',
  'routes/universeBuilder/crud.js GET /',
  'routes/uploads.js DELETE /',
  'routes/usage.js GET /claude-code',
  'routes/videoDownload.js GET /downloads',
  'routes/videoGen.js GET /ic-loras/:mode/download',
  'routes/videoGen.js GET /models/:modelId/download',
  'routes/videoGen.js GET /text-encoder/download',
  'routes/videoGen.js GET /text-encoders/:id/download',
  'routes/videoGen.js POST /setup/runtime-install',
  'routes/videoTimeline.js GET /projects',
  'routes/voice.js GET /voices',
  'routes/voicePublic.js GET /voices',
  'routes/writersRoom.js GET /exercises',
];

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
  it('has no unvalidated req.query read outside the burn-down baseline', () => {
    const baseline = new Set(UNVALIDATED_QUERY_BASELINE);
    const offenders = scanQueries().filter((key) => !baseline.has(key));
    expect(
      offenders,
      'These handlers read `req.query` with no schema on the query object. Add a Zod schema '
      + 'and call `validateRequest(schema, req.query)` (toolkit routes: `lib/aiToolkit/validation.js`). '
      + 'Do NOT add a line to UNVALIDATED_QUERY_BASELINE — that list only shrinks.\n'
      + `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('only baselines handlers that still exist and are still unvalidated', () => {
    const live = new Set(scanQueries());
    const stale = UNVALIDATED_QUERY_BASELINE.filter((key) => !live.has(key));
    expect(
      stale,
      `These baseline entries are compliant or gone — delete them from UNVALIDATED_QUERY_BASELINE:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
    expect(new Set(UNVALIDATED_QUERY_BASELINE).size).toBe(UNVALIDATED_QUERY_BASELINE.length);
    expect([...UNVALIDATED_QUERY_BASELINE].sort()).toEqual(UNVALIDATED_QUERY_BASELINE);
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
