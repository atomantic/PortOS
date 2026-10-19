/**
 * The test files each Vitest workspace collects, enumerated without Vitest.
 *
 * `scripts/run-ci-tests.js` needs the explicit set a `full` plan runs and the
 * candidate set a `related` plan selects from, before Vitest starts. The
 * globs live here and the workspace configs import them, so the runner and
 * the config cannot disagree; `workspaceTests.test.js` pins the enumeration
 * against `vitest list` as well.
 *
 * Paths are workspace-relative posix (`lib/x.test.js`, `../scripts/x.test.js`),
 * the form the configs and the runner selection file use. `toRepoPath` /
 * `toWorkspacePath` convert to and from repo-relative paths.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { BROWSER_SUITES } from './browserSuites.js';
import { DB_TEST_INCLUDE } from './dbTestFiles.js';

/**
 * Directories never walked: exactly what both Vitest configs exclude at any
 * depth (`**\/node_modules/**`, `**\/.git/**`). Anything else — a `data`,
 * `dist` or `.cache` directory with a test file in it — Vitest would
 * collect, so the walker must see it too; the `vitest list` parity tests
 * pin that.
 */
const SKIP_DIRS = new Set(['node_modules', '.git']);

/**
 * The server runner covers server, scripts/migrations, lib, autofixer and the
 * doc-parity guards. The client owns `client/src` (see each config for why).
 */
export const SERVER_TEST_INCLUDE = Object.freeze([
  '**/*.test.js',
  '../scripts/**/*.test.js',
  '../lib/**/*.test.js',
  '../autofixer/**/*.test.js',
  '../docs/**/*.test.js',
]);

/** The slashdo submodule ships node:test suites; DB suites run only under vitest.config.db.js. */
export const SERVER_TEST_EXCLUDE = Object.freeze([
  '**/node_modules/**',
  '../lib/slashdo/**',
  ...DB_TEST_INCLUDE,
]);

export const CLIENT_TEST_INCLUDE = Object.freeze(['src/**/*.{test,spec}.{js,jsx}']);
export const CLIENT_TEST_EXCLUDE = Object.freeze(['**/node_modules/**', '**/.git/**']);

/**
 * Linux CI gives the registered browser contracts one browser-owner job. An
 * explicitly exported `PORTOS_CI_BROWSER_OWNER=unit` (CI's Linux server shards,
 * and pregate on every platform) excludes them from the server unit runner, so
 * they run once in the browser stage. Local and Windows defaults keep them.
 */
export function browserOwnerExcludes({ env = process.env } = {}) {
  return env.PORTOS_CI_BROWSER_OWNER === 'unit'
    ? BROWSER_SUITES.map(path => path.slice('server/'.length)) : [];
}

export function workspaceTestGlobs(workspace, options = {}) {
  if (workspace === 'server') return { include: [...SERVER_TEST_INCLUDE], exclude: [...SERVER_TEST_EXCLUDE, ...browserOwnerExcludes(options)] };
  if (workspace === 'client') return { include: [...CLIENT_TEST_INCLUDE], exclude: [...CLIENT_TEST_EXCLUDE] };
  throw new Error(`Unknown workspace: ${workspace}`);
}

/** The subset of glob syntax the workspace configs use: `**`, `*`, `?`, `{a,b}`. */
export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      out += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const close = glob.indexOf('}', i);
      out += `(?:${glob.slice(i + 1, close).split(',').map(escape).join('|')})`;
      i = close;
    } else out += escape(c);
  }
  return new RegExp(`${out}$`);
}

const escape = (text) => text.replace(/[.+^$()|[\]\\]/g, '\\$&');

/** Walk from the literal prefix of each include glob; a walk never leaves the repository. */
function walkRoots(include) {
  return [...new Set(include.map((glob) => {
    const literal = glob.split('/').filter((part) => !/[*?{]/.test(part));
    const stop = glob.split('/').findIndex((part) => /[*?{]/.test(part));
    return (stop === -1 ? literal.slice(0, -1) : literal.slice(0, stop)).join('/') || '.';
  }))];
}

/**
 * Every test file the workspace config collects, workspace-relative, sorted.
 * `repoRoot` locates the workspace on disk; `workspaceDir` is the vitest
 * root (`server` or `client`).
 */
export function listWorkspaceTests(workspace, { repoRoot, platform, env } = {}) {
  const { include, exclude } = workspaceTestGlobs(workspace, { platform, env });
  const includes = include.map(globToRegExp);
  const excludes = exclude.map(globToRegExp);
  const workspaceAbs = join(repoRoot, workspace);
  const found = [];
  const walk = (relDir) => {
    const absDir = relDir === '.' ? workspaceAbs : join(workspaceAbs, ...relDir.split('/'));
    let entries;
    try { entries = readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const rel = relDir === '.' ? entry.name : `${relDir}/${entry.name}`;
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = statSync(join(absDir, entry.name)).isDirectory(); } catch { continue; }
      }
      if (isDirectory) { walk(rel); continue; }
      if (includes.some((re) => re.test(rel)) && !excludes.some((re) => re.test(rel))) found.push(rel);
    }
  };
  for (const root of walkRoots(include)) walk(root);
  return found.sort();
}

/** `lib/x.test.js` in `server` -> `server/lib/x.test.js`; `../scripts/x.test.js` -> `scripts/x.test.js`. */
export function toRepoPath(workspace, workspaceRel) {
  return posix.normalize(posix.join(workspace, workspaceRel.split(sep).join('/')));
}

/** The inverse of `toRepoPath`. */
export function toWorkspacePath(workspace, repoRel) {
  const normalized = repoRel.split(sep).join('/');
  return normalized.startsWith(`${workspace}/`) ? normalized.slice(workspace.length + 1) : `../${normalized}`;
}
