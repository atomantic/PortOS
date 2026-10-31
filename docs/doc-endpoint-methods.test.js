/**
 * Method guard for `METHOD /api/...` mentions outside docs/API.md.
 *
 * `api-doc.test.js` guards API.md's tables, but feature docs and instruction
 * files name endpoints in prose too, and nothing checked those. Two of them
 * told callers to `PATCH /api/cos/config` and `PATCH /api/providers/:id`, which
 * only accept PUT — a script following the doc got a 404.
 *
 * Only single-method mentions are checked. Slash shorthand (`GET/PUT /api/x`)
 * and brace/glob placeholders (`/api/{id}`, `/api/x/*`) are not parseable as
 * one operation, so they are skipped rather than guessed at. A mention that
 * deliberately records a removed or proposed endpoint goes in
 * `DELIBERATE_NON_ROUTES` with its reason.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { buildApiRouteCatalog } from '../server/lib/apiRouteGraph.js';

const DOCS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(DOCS_DIR, '..');

const mdIn = (dir) => readdirSync(join(REPO_ROOT, dir))
  .filter((name) => name.endsWith('.md'))
  .map((name) => `${dir}/${name}`);

const DOC_FILES = [
  ...mdIn('docs').filter((file) => file !== 'docs/API.md'),
  ...mdIn('docs/features'),
  'AGENTS.md',
  'server/AGENTS.md',
  'client/src/AGENTS.md',
  'client/src/components/dashboard/AGENTS.md',
  'server/lib/aiToolkit/AGENTS.md',
  'server/lib/README.md',
  'client/src/lib/README.md',
  'client/src/hooks/README.md',
  'client/src/utils/README.md',
  'client/src/services/README.md',
].filter((file) => existsSync(join(REPO_ROOT, file)));

/** Records that name an endpoint which does not (or does not yet) exist, on purpose. */
const DELIBERATE_NON_ROUTES = [
  { file: 'docs/features/eidoverse.md', method: 'GET', path: '/api/eidoverse/world/contributions', reason: 'recorded as a removed endpoint' },
  { file: 'docs/features/chief-of-staff.md', method: 'POST', path: '/api/cos/merge-admission/external', reason: 'recorded as a removed endpoint (#14320)' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'POST', path: '/api/openclaw/sessions', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'GET', path: '/api/openclaw/jobs', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'GET', path: '/api/openclaw/subagents', reason: 'proposed but not built' },
  { file: 'docs/features/openclaw-operator-chat.md', method: 'POST', path: '/api/openclaw/context/compose', reason: 'proposed but not built' },
];

const MENTION = /(?<![\w/])(GET|POST|PUT|PATCH|DELETE)(\s*\/\s*(?:GET|POST|PUT|PATCH|DELETE))*\s+`?(\/api\/[^\s`<>]+)/g;

/** Same positional param comparison as api-doc.test.js: renaming a param is not observable. */
const normalizePath = (path) => path
  .replace(/[?#].*$/, '')
  .replace(/:[A-Za-z0-9_]+/g, ':param')
  .replace(/\/+$/, '') || '/';

const PLACEHOLDER = /[*{}[\]]/;

export const findMentions = (file, text) => {
  const mentions = [];
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(MENTION)) {
      const path = match[3].replace(/[).,;:\]]+$/, '');
      if (match[2] || PLACEHOLDER.test(path)) continue;
      mentions.push({ file, line: i + 1, method: match[1], path });
    }
  });
  return mentions;
};

const CATALOG = buildApiRouteCatalog({ repoRoot: REPO_ROOT });
const live = new Set(CATALOG.routes.map(({ method, path }) => `${method} ${normalizePath(path)}`));
const isRoutable = ({ method, path }) => live.has(`${method} ${normalizePath(path)}`);

const mentions = DOC_FILES.flatMap((file) => findMentions(file, readFileSync(join(REPO_ROOT, file), 'utf8')));
const isAllowed = (m) => DELIBERATE_NON_ROUTES.some((a) => a.file === m.file && a.method === m.method && a.path === m.path);

describe('endpoint mentions outside API.md name a route the server mounts', () => {
  it('parses a meaningful number of mentions', () => {
    // A regex that silently matches nothing would pass every assertion below.
    expect(mentions.length).toBeGreaterThan(50);
    expect(CATALOG.routes.length).toBeGreaterThan(500);
  });

  it('names no method/path pair that no router declares', () => {
    const drift = mentions
      .filter((m) => !isRoutable(m) && !isAllowed(m))
      .map((m) => `${m.file}:${m.line} ${m.method} ${m.path}`);
    expect(drift, [
      'These docs name a method/path no router declares. Fix the mention, or — if the doc deliberately',
      'records a removed/proposed endpoint — add it to DELIBERATE_NON_ROUTES with a reason.',
      'The live inventory is GET /api/api-docs/catalog.json (or buildApiRouteCatalog()).',
    ].join('\n')).toEqual([]);
  });

  it('keeps every allowlist entry honest', () => {
    const stale = DELIBERATE_NON_ROUTES.flatMap((a) => {
      if (!a.reason) return [`${a.file} ${a.method} ${a.path}: missing reason`];
      if (isRoutable(a)) return [`${a.file} ${a.method} ${a.path}: now routable — drop the entry`];
      if (!mentions.some((m) => isAllowed(m) && m.file === a.file && m.method === a.method && m.path === a.path)) {
        return [`${a.file} ${a.method} ${a.path}: mention no longer present — drop the entry`];
      }
      return [];
    });
    expect(stale).toEqual([]);
  });

  it('skips slash shorthand and brace/glob placeholders', () => {
    const text = 'x `GET/PUT/DELETE /api/foo` y `GET /api/foo/{id}` z `POST /api/foo/*` `PATCH /api/foo/bar`';
    expect(findMentions('f.md', text)).toEqual([{ file: 'f.md', line: 1, method: 'PATCH', path: '/api/foo/bar' }]);
  });

  it('reports a wrong verb with file:line', () => {
    const line = 'writes through `PATCH /api/cos/config` only';
    const [m] = findMentions('docs/features/chief-of-staff.md', `a\n${line}`);
    expect(m).toMatchObject({ file: 'docs/features/chief-of-staff.md', line: 2, method: 'PATCH', path: '/api/cos/config' });
    expect(isRoutable(m)).toBe(false);
    expect(isRoutable({ method: 'PUT', path: '/api/cos/config' })).toBe(true);
  });
});
