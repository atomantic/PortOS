/**
 * What a real-Chromium fixture's Vite server served, recorded for the test memo: the recorder plugin and the reader of its records.
 *
 * The memo keys a real-browser suite by what Chrome could render, which
 * Vitest's module recording never sees. Without a record every file of the
 * root a suite hands to Vite is an input, so an edit to any unrelated client
 * page re-ran every client fixture (#17616). `startBrowserFixture` adds the
 * recorder when the memo runner names a directory (`SERVED_FILES_ENV`) and
 * writes one record per fixture on close; `readServedFiles` folds them into
 * `{ roots, files }` per test, which the memo record stores and the analyzer
 * keys instead of the whole root (`servedTree` in `testMemo/analyzer.js`).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** The directory the memo runner names for served-file records; unset, the fixture records nothing. */
export const SERVED_FILES_ENV = 'PORTOS_TEST_MEMO_SERVED_DIR';
export const SERVED_FILES_VERSION = 1;

const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

/** The test file Vitest is running in this worker, or null outside Vitest. */
export const runningTestFile = () => {
  const worker = globalThis.__vitest_worker__;
  const file = worker?.current?.file?.filepath ?? worker?.filepath;
  return typeof file === 'string' && isAbsolute(file) ? file : null;
};

/**
 * A Vite plugin noting the absolute path of every file the server reads for
 * a page: each module id it loads or transforms (query stripped, virtual
 * modules skipped), and each request a file under `publicDir` or `root`
 * answers, which covers static assets no module hook sees. `/@fs/` requests
 * name the file directly. Files under `ignore` (the fixture's private temp
 * directory, where Vite keeps its pre-bundled dependencies: products of the
 * installed packages, which the lockfile keys) are left out. Recording only
 * adds to a set and never changes what is served.
 */
export function servedFilesRecorder({ root, publicDir, ignore = [] }) {
  const files = new Set();
  const within = (base, path) => path === base || path.startsWith(`${base}${sep}`);
  // Vite ids use forward slashes on every platform; compare the ignored directories in that form.
  const slashed = (path) => path.replaceAll('\\', '/');
  const ignored = ignore.map(slashed);
  const note = (id) => {
    if (typeof id !== 'string' || id.includes('\0')) return;
    const path = id.replace(/[?#].*$/, '');
    const form = slashed(path);
    if (isAbsolute(path) && !ignored.some((dir) => form === dir || form.startsWith(`${dir}/`))) files.add(path);
  };
  const noteRequest = (url) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(url, 'http://fixture.invalid').pathname); } catch { return; }
    if (pathname.startsWith('/@fs/')) {
      const path = pathname.slice('/@fs'.length);
      note(/^\/[A-Za-z]:/.test(path) ? path.slice(1) : path);
      return;
    }
    if (pathname.startsWith('/@')) return;
    for (const base of [publicDir, root]) {
      if (!base) continue;
      const candidate = resolve(base, `.${pathname}`);
      if (within(base, candidate) && isFile(candidate)) note(candidate);
    }
  };
  return {
    files,
    plugin: {
      name: 'portos-test-memo-served-files',
      enforce: 'pre',
      load(id) { note(id); return null; },
      transform(_code, id) { note(id); return null; },
      configureServer(server) {
        server.middlewares.use((req, _res, next) => { noteRequest(req.url ?? ''); next(); });
      },
    },
  };
}

/**
 * The recorder for one fixture's Vite config, or null when the memo runner
 * did not ask (`SERVED_FILES_ENV`) or no test file is running. `write()`
 * stores one record per fixture, so several fixtures of a file never race.
 * `temp` is the fixture's private directory, left out of the record.
 */
export const servedFilesRecording = (config, env, testFile, temp = null) => {
  const dir = env[SERVED_FILES_ENV];
  if (!dir || !testFile) return null;
  const root = resolve(config.root ?? process.cwd());
  const publicDir = config.publicDir === false ? null : resolve(root, config.publicDir ?? 'public');
  const ignore = [];
  if (temp) {
    ignore.push(resolve(temp));
    try { ignore.push(realpathSync(temp)); } catch { /* a missing temp holds nothing to ignore */ }
  }
  const recorder = servedFilesRecorder({ root, publicDir, ignore });
  return {
    plugin: recorder.plugin,
    write: () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${process.pid}-${randomBytes(6).toString('hex')}.json`),
        JSON.stringify({ version: SERVED_FILES_VERSION, test: testFile, root, files: [...recorder.files].sort() }));
    },
  };
};

/**
 * What each real-Chromium suite's fixture served in this run, from the
 * records `startBrowserFixture` writes under `dir` (`SERVED_FILES_ENV`):
 * test (repo-relative) -> `{ roots, files }`, the union of the test's
 * fixtures. Paths are compared after resolving symlinks, so a worktree path
 * and the real path Vite reports agree. A record for a test or root outside
 * the repository, or of another shape, is ignored, which keys that root
 * whole. A served file under `node_modules` (an installed package, keyed by
 * its lockfile, wherever a linked install resolves) or no longer present is
 * dropped. Any other file outside the repository is one no key can hash, so
 * the test gets no served record at all and keeps its root keyed whole.
 */
export function readServedFiles(dir, repoRoot) {
  const out = new Map();
  if (!dir) return out;
  let names;
  try { names = readdirSync(dir).filter((name) => name.endsWith('.json')); } catch { return out; }
  const real = (path) => { try { return realpathSync(path); } catch { return null; } };
  const repo = real(repoRoot);
  if (repo === null) return out;
  const toRepo = (path) => {
    const resolved = typeof path === 'string' && isAbsolute(path) ? real(path) : null;
    const rel = resolved === null ? null : relative(repo, resolved).split(sep).join('/');
    return rel === null || rel === '' || rel.startsWith('..') || isAbsolute(rel) ? null : rel;
  };
  const installed = (path) => [path, real(path) ?? ''].some((form) => form.split(/[\\/]/).includes('node_modules'));
  const unkeyable = new Set();
  for (const name of names) {
    let record;
    try { record = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (record?.version !== SERVED_FILES_VERSION || !Array.isArray(record.files)) continue;
    const test = toRepo(record.test);
    const root = toRepo(record.root);
    if (test === null || root === null) continue;
    const entry = out.get(test) ?? { roots: new Set(), files: new Set() };
    entry.roots.add(root);
    for (const file of record.files) {
      if (typeof file !== 'string' || installed(file)) continue;
      const rel = toRepo(file);
      if (rel !== null) { if (isFile(join(repo, rel))) entry.files.add(rel); } else if (real(file) !== null) unkeyable.add(test);
    }
    out.set(test, entry);
  }
  for (const test of unkeyable) out.delete(test);
  return new Map([...out].map(([test, { roots, files }]) => [test, { roots: [...roots].sort(), files: [...files].sort() }]));
}
