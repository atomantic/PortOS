/**
 * Shared test helpers: HTTP request harness, fetch `Response` mocks, loopback server, source scanner and cross-platform helpers.
 *
 * Shared test helpers: fetch-based `request()` HTTP harness (replaces supertest), fetch `Response` mocks, `startLoopbackServer`, the server-source scanner for whole-tree
 * guard suites, and cross-platform helpers (`posixPath`, `resolveTestPython`, `pinPlatform`).
 */

import { createServer } from 'http';
import { execFileSync } from './childProcess.js';
import { homedir } from 'os';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';

/** The `server/` root — the scan root for the source-guard helpers below. */
export const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

/** The `client/src/` root — the scan root for the client-side source guards. */
export const CLIENT_SRC_DIR = fileURLToPath(new URL('../../client/src/', import.meta.url));

function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

/** Start a real loopback HTTP server for tests that need an actual socket (raw disconnect, SSE streaming); rejects on a listen error instead of hanging. */
export function startLoopbackServer(app) {
  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Close a server started with `startLoopbackServer`. */
export function closeLoopbackServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/** Resolve once an `AbortSignal` fires (or immediately if already aborted). */
export function waitForAbort(signal) {
  return signal.aborted
    ? Promise.resolve()
    : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}

class RequestBuilder {
  constructor(app, method, path) {
    this._app = app;
    this._method = method;
    this._path = path;
    this._body = undefined;
    this._headers = {};
  }

  send(body) {
    this._body = body;
    return this;
  }

  set(header, value) {
    this._headers[header.toLowerCase()] = value;
    return this;
  }

  then(resolve, reject) {
    return this._execute().then(resolve, reject);
  }

  catch(fn) {
    return this._execute().catch(fn);
  }

  async _execute() {
    const server = await startServer(this._app);
    const { port } = server.address();

    const headers = { ...this._headers };
    let body;
    if (this._body !== undefined) {
      if (Buffer.isBuffer(this._body) || this._body instanceof Uint8Array) {
        // Raw bytes (e.g. a multipart body) — pass through untouched; the
        // caller sets its own content-type (multipart boundary, etc.).
        body = this._body;
      } else if (typeof this._body === 'object' && this._body !== null) {
        body = JSON.stringify(this._body);
        headers['content-type'] ??= 'application/json';
      } else {
        body = String(this._body);
      }
    }

    let response;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${this._path}`, {
        method: this._method,
        headers,
        body
      });

      const text = await res.text();
      const ct = res.headers.get('content-type') || '';
      let parsedBody = text;
      if (text && ct.includes('application/json')) {
        parsedBody = JSON.parse(text);
      }

      response = {
        status: res.status,
        body: parsedBody,
        text,
        headers: Object.fromEntries(res.headers.entries())
      };
    } finally {
      await closeServer(server);
    }

    return response;
  }
}

export function request(app) {
  return {
    get: (path) => new RequestBuilder(app, 'GET', path),
    head: (path) => new RequestBuilder(app, 'HEAD', path),
    post: (path) => new RequestBuilder(app, 'POST', path),
    put: (path) => new RequestBuilder(app, 'PUT', path),
    delete: (path) => new RequestBuilder(app, 'DELETE', path),
    patch: (path) => new RequestBuilder(app, 'PATCH', path),
  };
}

/**
 * Mock a fetch `Response` whose JSON body is read via `.text()` (the path `readResponseJson` uses):
 *   fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [] }));
 *
 * @param {*} body - serialized into the response body via JSON.stringify
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
export function mockJsonResponse(body, { ok = true, status = 200, contentType = 'application/json' } = {}) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => text,
    json: async () => body,
  };
}

/**
 * Mock a fetch `Response` with a raw-string `.text()` body (non-JSON / HTML / blank / error text):
 *   fetchWithTimeout.mockResolvedValue(mockTextResponse('boom', { ok: false, status: 500 }));
 *
 * @param {string} [body] - returned verbatim by `text()`
 * @param {{ ok?: boolean, status?: number }} [opts]
 */
export function mockTextResponse(body = '', { ok = true, status = 200, contentType = 'text/plain' } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null },
    text: async () => body,
    json: async () => { throw new SyntaxError('Unexpected token in JSON'); },
  };
}

/** Non-test module extensions this tree ships: `.mjs` under `server/scripts/`, `.cjs` nowhere yet but supported. */
const SOURCE_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/**
 * Every non-test source file under `server/` (`.js`, `.mjs`, `.cjs`) as server-relative paths. Shared by the source-scanning guard suites (`spawnCwd`, `cliChildEnv`,
 * `childProcess.guards`), which overlap on purpose and so must agree on what "a source file" is; a `.js`-only walk missed the `.mjs` operator scripts.
 *
 * @param {string} [dir] - directory to walk (defaults to the `server/` root)
 * @returns {string[]} paths relative to `server/`, e.g. `services/runner.js`
 */
export function collectServerSources(dir = SERVER_DIR) {
  // A directory can vanish BETWEEN the readdir that named it and the recursion (sibling suites create and remove scratch dirs under `server/`, e.g. `test-data/`),
  // which threw ENOENT as a shard-order-dependent flake. A gone directory holds no sources, so skip it.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return collectServerSources(abs);
    const ext = SOURCE_EXTENSIONS.find((e) => entry.name.endsWith(e));
    if (!ext || entry.name.endsWith(`.test${ext}`)) return [];
    // POSIX separators always: these paths are IDENTIFIERS compared against literals and EXEMPT/DELEGATES tables, and Windows `relative()` would yield backslashes.
    // readServerSource joins them back; Windows accepts '/'.
    return [relative(SERVER_DIR, abs).split('\\').join('/')];
  });
}

/** Read a source file named by a `collectServerSources()` path. */
export function readServerSource(rel) {
  return readFileSync(join(SERVER_DIR, rel), 'utf8');
}

/**
 * Walk `client/src/` and return every source file relative to that root: the client counterpart of `collectServerSources`, for guards covering BOTH sides of a mirror.
 * Differences from the server walk: `.jsx` counts (half the client tree), and `*.test.js` is INCLUDED (the server walk skips tests only because its own guard lives there).
 *
 * @param {string} [dir] - directory to walk (defaults to `client/src/`)
 * @returns {string[]} paths relative to `client/src/`, e.g. `lib/scenePrompt.js`
 */
export function collectClientSources(dir = CLIENT_SRC_DIR) {
  // Same vanishing-directory tolerance as the server walk.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
    throw err;
  }
  return entries.flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return collectClientSources(abs);
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.jsx')) return [];
    // POSIX separators always (identifiers, not paths to open); see `collectServerSources`.
    return [relative(CLIENT_SRC_DIR, abs).split('\\').join('/')];
  });
}

/** Read a source file named by a `collectClientSources()` path. */
export function readClientSource(rel) {
  return readFileSync(join(CLIENT_SRC_DIR, rel), 'utf8');
}

/**
 * Normalize a path for comparison against a POSIX-spelled literal (`path.join` emits `\` on Windows). Apply it to the RECEIVED value, never the expectation
 * (that would hide a genuinely wrong path); a no-op on POSIX.
 */
export const posixPath = (value) => String(value).split('\\').join('/');

// Save the own descriptor, define the pinned value, return a restore that reinstates exactly what was there.
const pinProcessProperty = (name) => (value) => {
  const original = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, name, original);
    else delete process[name];
  };
};

/**
 * Pin `process.platform` for a test, and return the restore:
 *   const restore = pinPlatform('darwin');
 *   try { … } finally { restore(); }
 *
 * **Never pin before importing a module that loads a native addon**: those pick their prebuilt binary from `process.platform` at load time
 * (pinning `'darwin'` ahead of a `sharp` import breaks the run on Linux). Pin inside the test or a `beforeEach`, never at module scope above a static import or before an `await import(…)` of such a module.
 *
 * The restore reinstates the ORIGINAL descriptor (or deletes the pin when `process` had no own `platform` descriptor).
 *
 * @param {string} value - the platform to report, e.g. `'darwin'` / `'win32'`
 * @returns {() => void} restore — idempotent, safe to call from `afterEach`
 */
export const pinPlatform = pinProcessProperty('platform');

/** `pinPlatform`'s companion for `process.arch`: `isAppleSilicon()` reads BOTH, so a test meaning "on an Apple Silicon Mac" must pin the pair. */
export const pinArch = pinProcessProperty('arch');

/**
 * Budget for a vitest test that shells out to a real Python interpreter; pass as `it()`'s third argument. Wall time tracks machine load, so state the budget here
 * rather than loosening the deliberately tight global `testTimeout`.
 */
export const PY_TEST_TIMEOUT_MS = 120_000;

/**
 * Budget for the Python subprocess itself (`execFileSync`'s `timeout`). Deliberately BELOW `PY_TEST_TIMEOUT_MS` so a hung interpreter fails with the spawn's own ETIMEDOUT
 * naming the command, not a bare vitest timeout.
 */
export const PY_SUBPROCESS_TIMEOUT_MS = 90_000;

/**
 * Resolve a Python interpreter that actually RUNS, or `null` when none does, for suites that shell out to PortOS's `.py` scripts (pair with `describe.skipIf(!resolveTestPython())`).
 * A name on PATH is not enough on Windows (the Microsoft Store ALIAS STUB exists but exits non-zero, and `py` can point at an uninstalled version), so each candidate is probed
 * by executing something trivial. PortOS's own venvs (`setup:image` / `setup:video`, under `~/.portos`) are searched before concluding there is none,
 * so these suites don't silently skip on machines that exercise the scripts.
 *
 * `PORTOS_TEST_PYTHON` overrides the search. `modules` keeps only interpreters that can import each named module (e.g. `['numpy']`).
 *
 * @param {{ modules?: string[] }} [options]
 * @returns {string|null} a runnable interpreter path/name, or null
 */
export function resolveTestPython({ modules = [] } = {}) {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? ['Scripts', 'python.exe'] : ['bin', 'python3'];
  const portosPythons = ['venv-flux2', 'venv-mflux', 'venv-video', 'voice']
    .map((venv) => join(homedir(), '.portos', venv, ...venvBin))
    .concat(isWin ? [join(homedir(), 'miniconda3', 'python.exe')] : [])
    .filter((candidate) => existsSync(candidate));

  const candidates = [
    process.env.PORTOS_TEST_PYTHON,
    isWin ? 'python' : 'python3',
    isWin ? 'python3' : 'python',
    ...(isWin ? ['py'] : []),
    ...portosPythons,
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      execFileSync(candidate, ['-c', modules.length ? `import ${modules.join(', ')}` : 'pass'],
        { stdio: 'ignore', timeout: PY_SUBPROCESS_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }) || null;
}

/**
 * Fail the CI job, rather than silently skip, when `lib/slashdo` was expected to be initialized but isn't: ci.yml sets `CI_EXPECT_SLASHDO_SUBMODULE` when the impact
 * planner selected slashdo's adapter contracts. With it unset (local/minimal checkout) this is a no-op.
 */
export function requireSlashdoSubmoduleInCi(hasSubmodule) {
  if (process.env.CI_EXPECT_SLASHDO_SUBMODULE === 'true' && !hasSubmodule) {
    throw new Error('lib/slashdo submodule is missing but this CI job expected it to be initialized');
  }
}
