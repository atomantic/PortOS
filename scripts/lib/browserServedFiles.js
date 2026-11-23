/**
 * What a real-Chromium fixture's Vite server, Vite bundle or static server
 * read, recorded for the test memo: the recorder plugin, instrumented
 * Vite/static fixture helpers, and the reader of their records.
 *
 * The memo keys a real-browser suite by what Chrome could render, which
 * Vitest's module recording never sees. Without a record every file of the
 * root a suite hands to Vite or a static server is an input, so an edit to any
 * unrelated client page re-ran every client fixture (#17616, #17894).
 * `startBrowserFixture` and the instrumented Vite/static helpers below add the
 * recorder when the memo runner names a directory (`SERVED_FILES_ENV`) and
 * write one record per fixture/root; `readServedFiles` folds them into
 * `{ roots, files }` per test, which the memo record stores and the analyzer
 * keys instead of the whole root (`servedTree` in `testMemo/analyzer.js`).
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Inputs of a served real-browser root that no recorded request names
 * (#17616): what the fixture's Vite run served is recorded file by file
 * (`startBrowserFixture`), but the global stylesheet's Tailwind build, its
 * theme tokens and the PostCSS config shape every rendered page without
 * each being requested. Paths are repository-relative; a directory stands
 * for its tree. Every served root also keys its own direct non-dot files
 * and the manifests above it (`servedTree`).
 */
export const BROWSER_SERVED_SHARED_INPUTS = Object.freeze({
  client: Object.freeze(['client/src/index.css', 'client/src/themes']),
});

/** The directory the memo runner names for served-file records; unset, the fixture records nothing. */
export const SERVED_FILES_ENV = 'PORTOS_TEST_MEMO_SERVED_DIR';
export const SERVED_FILES_VERSION = 1;

const isFile = (path) => {
  try { return statSync(path).isFile(); } catch { return false; }
};

const isDir = (path) => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};

const within = (base, path) => path === base || path.startsWith(`${base}${sep}`);

const writeServedRecord = (dir, testFile, root, files) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}-${randomBytes(6).toString('hex')}.json`),
    JSON.stringify({ version: SERVED_FILES_VERSION, test: testFile, root, files: [...files].sort() }));
};

const walkFiles = (dir, out = []) => {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile() || (entry.isSymbolicLink() && isFile(full))) out.push(full);
  }
  return out;
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
    note,
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

const addIgnoredDir = (ignore, path) => {
  if (typeof path !== 'string' || !path) return;
  ignore.push(resolve(path));
  try { ignore.push(realpathSync(path)); } catch { /* a missing dir holds nothing to ignore */ }
};

/**
 * The recorder for one fixture's Vite config, or null when the memo runner
 * did not ask (`SERVED_FILES_ENV`) or no test file is running. `write()`
 * stores one record per fixture, so several fixtures of a file never race.
 * `temp` is the fixture's private directory, left out of the record.
 * `recordedRoot` names the repository root to record when `config.root` is a
 * temporary staging directory outside the repository.
 */
export const servedFilesRecording = (config, env, testFile, temp = null, { recordedRoot = null, ignore: extraIgnore = [] } = {}) => {
  const dir = env[SERVED_FILES_ENV];
  if (!dir || !testFile) return null;
  const configRoot = resolve(config.root ?? process.cwd());
  const root = recordedRoot ? resolve(recordedRoot) : configRoot;
  const publicDir = config.publicDir === false ? null : resolve(configRoot, config.publicDir ?? 'public');
  const ignore = [];
  addIgnoredDir(ignore, temp);
  addIgnoredDir(ignore, config.cacheDir);
  if (typeof config.build?.outDir === 'string') addIgnoredDir(ignore, resolve(configRoot, config.build.outDir));
  if (recordedRoot && configRoot !== root && !within(configRoot, root)) addIgnoredDir(ignore, configRoot);
  for (const path of extraIgnore) addIgnoredDir(ignore, path);
  const recorder = servedFilesRecorder({ root, publicDir, ignore });
  return {
    plugin: recorder.plugin,
    files: recorder.files,
    note: recorder.note,
    root,
    publicDir,
    write: () => writeServedRecord(dir, testFile, root, recorder.files),
  };
};

/**
 * Runs Vite `build()` with the served-file recorder attached (#17894): notes
 * every module Vite loads or transforms plus any copied `publicDir` assets,
 * and writes the served-file record once the build completes.
 */
export async function buildRecordedViteFixture({
  build, config, recordedRoot = null, temp = null, ignore = [], env = process.env, testFile = runningTestFile(),
}) {
  const recording = servedFilesRecording(config, env, testFile, temp, { recordedRoot, ignore });
  const result = await build({
    ...config,
    plugins: recording ? [config.plugins, recording.plugin] : config.plugins,
  });
  if (recording) {
    const dir = env[SERVED_FILES_ENV];
    const copiedPublic = config.publicDir !== false && config.build?.copyPublicDir !== false
      && recording.publicDir && isDir(recording.publicDir);
    const publicFiles = copiedPublic ? walkFiles(recording.publicDir) : [];
    for (const file of publicFiles) recording.note(file);
    recording.write();
    if (copiedPublic && config.publicDir !== undefined && recording.publicDir !== recording.root) {
      writeServedRecord(dir, testFile, recording.publicDir, publicFiles);
    }
  }
  return result;
}

/**
 * Starts and listens a Vite dev server with the served-file recorder attached
 * (#17894). Closing the returned server writes its served-file record once
 * before tearing down Vite.
 */
export async function startRecordedViteServer({
  createServer, config, recordedRoot = null, temp = null, ignore = [], env = process.env, testFile = runningTestFile(),
}) {
  const recording = servedFilesRecording(config, env, testFile, temp, { recordedRoot, ignore });
  const server = await createServer({
    ...config,
    plugins: recording ? [config.plugins, recording.plugin] : config.plugins,
  });
  try {
    await server.listen();
  } catch (error) {
    await server.close().catch(() => {});
    throw error;
  }
  if (recording) {
    const close = server.close.bind(server);
    let written = false;
    server.close = async (...args) => {
      let writeError;
      if (!written) {
        written = true;
        try { recording.write(); } catch (error) { writeError = error; }
      }
      await close(...args);
      if (writeError) throw writeError;
    };
  }
  return server;
}

/**
 * Instrumented Express static-middleware + HTTP listener helper (#17894).
 * Each `serve(dir, options)` mount records every file requested under `dir`,
 * and `start(app)` binds an ephemeral loopback port and writes one
 * served-file record per mount when the server closes.
 */
export function createRecordedStaticServer(express, { env = process.env, testFile = runningTestFile() } = {}) {
  const outDir = env[SERVED_FILES_ENV];
  const mounts = [];

  const serve = (dir, options) => {
    const root = resolve(dir);
    const handler = express.static(root, options);
    if (!outDir || !testFile) return handler;
    const files = new Set();
    mounts.push({ root, files });
    const indexOption = options?.index;
    const indexNames = indexOption === false ? [] : Array.isArray(indexOption) ? indexOption : [typeof indexOption === 'string' ? indexOption : 'index.html'];
    return (req, res, next) => {
      if (req.method === 'GET' || req.method === 'HEAD') {
        let pathname;
        try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture.invalid').pathname); } catch { pathname = null; }
        if (pathname !== null) {
          const candidate = resolve(root, `.${pathname}`);
          if (within(root, candidate)) {
            if (isFile(candidate)) files.add(candidate);
            else if (isDir(candidate)) {
              for (const name of indexNames) {
                const indexFile = resolve(candidate, name);
                if (within(root, indexFile) && isFile(indexFile)) { files.add(indexFile); break; }
              }
            }
          }
        }
      }
      handler(req, res, next);
    };
  };

  let flushed = false;
  const flush = () => {
    if (flushed || !outDir || !testFile) return;
    flushed = true;
    for (const { root, files } of mounts) writeServedRecord(outDir, testFile, root, files);
  };

  const start = (app, host = '127.0.0.1') => new Promise((done, reject) => {
    const server = app.listen(0, host, () => {
      server.off('error', reject);
      const close = server.close.bind(server);
      server.close = (...args) => {
        flush();
        return close(...args);
      };
      server.once('close', () => {
        try { flush(); } catch (error) { console.error(`❌ served-file record write failed: ${error.message}`); }
      });
      done(server);
    });
    server.once('error', reject);
  });

  return { serve, start, flush };
}

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
