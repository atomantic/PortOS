/**
 * Shared test helpers: HTTP request harness, fetch-Response mocks, the
 * server-source scanner used by the whole-tree guard suites, and the three
 * cross-platform helpers (`posixPath`, `resolveTestPython`, `pinPlatform`) that
 * keep path-, interpreter- and platform-sensitive suites running on Windows as
 * well as POSIX.
 *
 * fetch-based replacement for supertest — creates a real HTTP server on a
 * random port, makes a single request, then shuts the server down.
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

/**
 * Start a real loopback HTTP server for tests that need to drive an actual
 * socket (raw disconnect via `httpRequest(...).destroy()`, SSE streaming) —
 * scenarios `request()`'s fetch-based harness can't model because it always
 * runs a request to completion. Reject on a listen error instead of hanging.
 */
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
 * Mock a fetch `Response` whose body is read via `.text()` — the read path used
 * by `readResponseJson` and every fetch-based client. Use this for the common
 * case of a JSON body: pass the value, it's serialized into `text()`.
 *
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
 * Mock a fetch `Response` with a raw-string body read via `.text()` — for
 * non-JSON / HTML / blank bodies (the masquerade cases) and error text.
 *
 *   fetchWithTimeout.mockResolvedValue(mockTextResponse('<html>502</html>'));
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

/**
 * Every non-test `.js` file under `server/`, as server-relative paths.
 *
 * Shared by the source-scanning guard suites — `spawnCwd.test.js` (every
 * cwd-passing spawn pins PWD, #3193) and `cliChildEnv.test.js` (every AI-CLI
 * spawn composes its env through the shared builder, #3194). Those two guards
 * deliberately overlap, so they must agree on what "a source file" is: a change
 * to the ignore rules here (a new extension, a skipped directory) has to apply
 * to both, or one guard silently stops covering files the other still checks.
 *
 * @param {string} [dir] - directory to walk (defaults to the `server/` root)
 * @returns {string[]} paths relative to `server/`, e.g. `services/runner.js`
 */
export function collectServerSources(dir = SERVER_DIR) {
  // A directory can vanish BETWEEN the readdir that named it and the recursion
  // into it: vitest runs suites concurrently in one process, and sibling suites
  // create-and-remove scratch directories under `server/` (aiToolkit's
  // `providers.test.js` cycles `server/test-data/` in beforeEach/afterEach). The
  // walk hitting that window threw ENOENT and failed whichever guard suite was
  // mid-scan — a flake that reproduces roughly one run in three and depends on
  // shard ordering, so it lands in CI and not locally. A directory that is gone
  // holds no sources to check, so skipping it is the honest answer, not a
  // papered-over error.
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
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) return [];
    // POSIX separators always. These relative paths are IDENTIFIERS, not paths
    // to open: guard suites compare them against literals like
    // 'cos-runner/index.js' and list them in EXEMPT/DELEGATES tables. On
    // Windows `relative()` yields 'cos-runner\index.js', so every one of those
    // comparisons missed — the guards reported both "the scan no longer finds
    // these" for live files AND "these spawn without pinning PWD" for exempt
    // ones. readServerSource joins them back, and Windows accepts '/' there.
    return [relative(SERVER_DIR, abs).split('\\').join('/')];
  });
}

/** Read a source file named by a `collectServerSources()` path. */
export function readServerSource(rel) {
  return readFileSync(join(SERVER_DIR, rel), 'utf8');
}

/**
 * Walk `client/src/` and return every source file, relative to that root.
 *
 * The client counterpart of `collectServerSources`, for the guards that must
 * cover BOTH sides of a server/client mirror — `textUtils.test.js`'s
 * "no private escapeRegExp" scan is the first, since the escape's client copies
 * are exactly what a `server/`-only walk could never see.
 *
 * Two deliberate differences from the server walk:
 *   - `.jsx` counts. Half the client tree is components, and the escape was
 *     re-inlined in two of them — a `.js`-only walk would report a clean tree.
 *   - `*.test.js` is INCLUDED. The server walk skips tests because the guard
 *     that reads it lives in `server/` and would flag itself; a client test has
 *     no such exemption to claim, and one of the re-inlined copies this closes
 *     lived in a client test file.
 *
 * @param {string} [dir] - directory to walk (defaults to `client/src/`)
 * @returns {string[]} paths relative to `client/src/`, e.g. `lib/scenePrompt.js`
 */
export function collectClientSources(dir = CLIENT_SRC_DIR) {
  // Same vanishing-directory tolerance as the server walk — see the note there.
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
    // POSIX separators always — these are IDENTIFIERS compared against literals
    // in guard tables, not paths to open. See `collectServerSources`.
    return [relative(CLIENT_SRC_DIR, abs).split('\\').join('/')];
  });
}

/** Read a source file named by a `collectClientSources()` path. */
export function readClientSource(rel) {
  return readFileSync(join(CLIENT_SRC_DIR, rel), 'utf8');
}

/**
 * Normalize a path for comparison against a POSIX-spelled literal.
 *
 * The overwhelmingly common Windows test failure is an assertion that names a
 * path as `'/some/path'` while the code under test built it with `path.join`,
 * which emits `\` there. Normalizing the RECEIVED value keeps the readable
 * literal meaningful on both platforms; it is a no-op on POSIX.
 *
 * Use it on what the code returned, never on the expectation — a normalized
 * expectation would also hide a genuinely wrong path.
 */
export const posixPath = (value) => String(value).split('\\').join('/');

/**
 * Pin `process.platform` for a test, and return the restore.
 *
 *   const restore = pinPlatform('darwin');
 *   try { … } finally { restore(); }
 *
 *   // describe-scope pinning
 *   let restorePlatform = () => {};
 *   beforeEach(() => { restorePlatform = pinPlatform('linux'); });
 *   afterEach(() => restorePlatform());
 *
 * **Never pin before importing a module that loads a native addon.** Those pick
 * their prebuilt binary from `process.platform` at load time, so pinning
 * `'darwin'` ahead of a `sharp` import sends it looking for a `darwin-x64`
 * binary and breaks the whole run on Linux (cost a CI round-trip in #4082).
 * Pin inside the test — or inside a `beforeEach` — never at module scope above
 * a static import, and never before an `await import(…)` of such a module.
 *
 * The restore reinstates the ORIGINAL descriptor, so a suite that pins a value
 * over Node's own accessor leaves the accessor behind, not a frozen snapshot of
 * whatever it read. When `process` carried no own `platform` descriptor, the
 * restore deletes the pinned one rather than fabricating a value.
 *
 * @param {string} value - the platform to report, e.g. `'darwin'` / `'win32'`
 * @returns {() => void} restore — idempotent, safe to call from `afterEach`
 */
export function pinPlatform(value) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => {
    if (original) Object.defineProperty(process, 'platform', original);
    else delete process.platform;
  };
}

/**
 * Budget for a vitest test that shells out to a real Python interpreter.
 *
 * Pass it as `it()`'s third argument (`it('…', () => { … }, PY_TEST_TIMEOUT_MS)`)
 * on every case that spawns one. Such a test's wall time tracks how loaded the
 * machine is, not anything the assertion controls: a case that runs in ~4s alone
 * crosses the global 10s `testTimeout` on a contended worker during a full-suite
 * run. Stating the budget where the cost actually is beats loosening the global
 * default, which is deliberately tight so it still catches genuinely hung async
 * work across the rest of the tree.
 */
export const PY_TEST_TIMEOUT_MS = 120_000;

/**
 * Budget for the Python subprocess itself — pass it as `execFileSync`'s
 * `timeout` at every site that spawns an interpreter.
 *
 * Deliberately BELOW `PY_TEST_TIMEOUT_MS` so an actually-hung interpreter trips
 * this guard first and fails with the spawn's own ETIMEDOUT (naming the command)
 * instead of a bare vitest timeout that says only that the test ran long. A
 * subprocess allowance above the vitest budget is dead intent — vitest always
 * wins — so the two must stay nested in this order.
 */
export const PY_SUBPROCESS_TIMEOUT_MS = 90_000;

/**
 * Resolve a Python interpreter that actually RUNS, or `null` when there is
 * none — for suites that shell out to one of PortOS's `.py` scripts. Pair it
 * with `describe.skipIf(!resolveTestPython())`.
 *
 * Trusting a name on PATH is not enough on Windows: a machine with no
 * Store-installed Python still has `python` on PATH as a Microsoft Store ALIAS
 * STUB, which exists, exits non-zero, and prints "Python was not found". A
 * `where`-style check passes on that stub and every case then fails with an
 * opaque "Command failed" — so each candidate is probed by executing something
 * trivial. The `py` launcher gets the same treatment: it is the standard
 * Windows entry point but is itself a shim that can point at an uninstalled
 * version.
 *
 * PortOS also provisions its OWN interpreters (`setup:image` / `setup:video`
 * build venvs under `~/.portos`), so a machine can be fully set up for
 * image/video gen while the bare `python` name is still a stub. Those are
 * searched before concluding there is no interpreter — otherwise these suites
 * silently skip on exactly the machines that exercise the scripts they cover.
 *
 * `PORTOS_TEST_PYTHON` overrides the whole search.
 *
 * @returns {string|null} a runnable interpreter path/name, or null
 */
export function resolveTestPython() {
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
      execFileSync(candidate, ['-c', 'pass'], { stdio: 'ignore', timeout: PY_SUBPROCESS_TIMEOUT_MS });
      return true;
    } catch {
      return false;
    }
  }) || null;
}

/**
 * Fail the CI job — rather than silently skip — when `lib/slashdo` was
 * expected to be initialized but isn't (issue #6263). ci.yml sets
 * `CI_EXPECT_SLASHDO_SUBMODULE` on the "Run server tests" step whenever the
 * impact planner selected slashdo's bundled adapter contracts; a missing
 * submodule there means the "Initialize slashdo submodule" step failed. With
 * the env var unset — a local or intentionally minimal checkout — this is a
 * no-op and the caller's own skip/early-return applies instead.
 */
export function requireSlashdoSubmoduleInCi(hasSubmodule) {
  if (process.env.CI_EXPECT_SLASHDO_SUBMODULE === 'true' && !hasSubmodule) {
    throw new Error('lib/slashdo submodule is missing but this CI job expected it to be initialized');
  }
}
