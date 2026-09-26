#!/usr/bin/env node
// Server boot smoke test — imports server/index.js in a child process and
// waits for readiness, verifies it stays alive for SMOKE_WINDOW_MS, and
// requires a clean shutdown. Catches the
// class of bug where top-level initialization code throws (e.g. chaining
// .catch on a sync function that returns undefined), which is invisible to
// unit tests that import service modules in isolation.
//
// The child is a HERMETIC boot (#8343). Run from an install that holds real
// runtime data, a smoke that inherited the parent environment read that
// install's records and armed its configured background services. So the
// child gets:
//   - a disposable install root (PORTOS_DATA_ROOT) seeded like a fresh install
//     — a copy of the shipped `data.reference/` plus the `data/` that
//     `scripts/setup-data.js` would seed from it — and the disposable-root
//     marker `server/lib/dataRoot.js` requires before a worktree may honor the pin;
//   - HOME / TMPDIR inside that root, so nothing reads or writes user config;
//   - an allowlisted environment — no provider keys, tokens, database
//     credentials, or test escape hatches from the parent;
//   - a test-only database name, so even a reachable Postgres is never the
//     install's real one;
//   - PORTOS_SMOKE_BOOT=1, which makes boot skip schedulers, agent
//     spawning/recovery, crash-recovery passes, peer polling/sync, and other
//     external integrations (SMOKE_BOOT_DISABLED_STEPS in bootstrapSequence.js).
// The root is removed on every exit path, success or failure.

import { spawn } from 'child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DATA_ROOT_ENV, DISPOSABLE_ROOT_MARKER } from '../server/lib/dataRoot.js';
import { SMOKE_BOOT_ENV } from '../server/lib/runtimeEnv.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { isSeedableReferencePath } from './lib/migrationOwnedPaths.js';
import { rewriteAppsPortosRoot } from './lib/rewriteAppsPortosRoot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_ROOT = join(__dirname, '..');
const SERVER_ENTRY = join(CODE_ROOT, 'server', 'index.js');

/** Ends in `_test`, so `server/lib/db.js` treats it as a test database. */
export const SMOKE_DATABASE = 'portos_smoke_test';

// Only what a Node process needs to start and spawn helpers on each platform.
// Everything else — provider API keys, PORTOS_API_TOKEN, PG* credentials,
// TEST_DB_OK, MEMORY_BACKEND, a leaked PORTOS_DATA_ROOT — stays behind.
const PASSTHROUGH_ENV = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'CI'];

// Parse SMOKE_WINDOW_MS safely: ignore missing/empty/non-numeric values so a
// bad env var can't silently reduce the window to 0ms (which would always pass).
const parseMs = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Create the disposable install root: marker, private home and temp dirs, a
 * physical copy of the shipped `data.reference/` (boot migrations read it from
 * the install root; a copy, never a link, so nothing the child writes can land
 * in the checkout), and `data/` seeded from it exactly as setup-data seeds a
 * fresh install — so boot migrations see the tree a real first boot sees.
 */
export function createSmokeRoot({ codeRoot = CODE_ROOT, tmpBase = tmpdir() } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpBase, 'portos-smoke-')));
  try {
    writeFileSync(join(root, DISPOSABLE_ROOT_MARKER), 'Disposable PortOS boot-smoke root; deleted when the smoke exits.\n');
    for (const dir of ['home', 'tmp']) mkdirSync(join(root, dir));
    const referenceDir = join(root, 'data.reference');
    const dataDir = join(root, 'data');
    cpSync(join(codeRoot, 'data.reference'), referenceDir, { recursive: true, dereference: true });
    cpSync(referenceDir, dataDir, { recursive: true, filter: isSeedableReferencePath(referenceDir) });
    rewriteAppsPortosRoot(dataDir, codeRoot);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  return root;
}

/** The child's complete environment — built from an allowlist, never a spread. */
export function buildSmokeEnv({ root, parentEnv = process.env }) {
  const env = {};
  for (const key of PASSTHROUGH_ENV) {
    if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  }
  const home = join(root, 'home');
  const tmp = join(root, 'tmp');
  // Preserve pre-existing NODE_OPTIONS (e.g. --max-old-space-size from CI)
  // and append our flags instead of replacing.
  const existingNodeOpts = parentEnv.NODE_OPTIONS ? `${parentEnv.NODE_OPTIONS} ` : '';
  return {
    ...env,
    NODE_ENV: 'test',
    [SMOKE_BOOT_ENV]: '1',
    [DATA_ROOT_ENV]: root,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    PGDATABASE: SMOKE_DATABASE,
    // Loopback only, on dedicated ports so a running PortOS instance doesn't
    // collide and nothing on the network can reach the throwaway server.
    HOST: '127.0.0.1',
    PORT: parentEnv.SMOKE_PORT ?? '55559',
    PORTOS_HTTP_PORT: parentEnv.SMOKE_HTTP_PORT ?? '55557',
    NODE_OPTIONS: `${existingNodeOpts}--unhandled-rejections=strict`
  };
}

/**
 * Observe the actual child lifecycle. Readiness belongs to this child (IPC),
 * not another process that happens to answer on the smoke port.
 * All failure cleanup is bounded and can never turn a failure into a pass.
 */
export function monitorSmokeChild(child, {
  startupMs = 120000,
  windowMs = 4000,
  shutdownMs = 10000,
  postKillMs = 2000
} = {}) {
  return new Promise((resolve) => {
    let phase = 'startup';
    let failure = null;
    let timer;
    const finish = (error) => {
      if (phase === 'done') return;
      phase = 'done';
      clearTimeout(timer);
      child.removeListener('message', onMessage);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      resolve({ ok: !error, error });
    };
    const forceKill = () => {
      failure ??= 'Server required SIGKILL during shutdown.';
      phase = 'killing';
      timer = setTimeout(() => finish(failure), postKillMs);
      child.kill('SIGKILL');
    };
    const shutdown = () => {
      clearTimeout(timer);
      phase = 'shutdown';
      timer = setTimeout(forceKill, shutdownMs);
      child.kill('SIGTERM');
    };
    const onMessage = (message) => {
      if (phase !== 'startup' || message?.type !== 'portos:smoke-ready') return;
      clearTimeout(timer);
      phase = 'survival';
      console.log('🚀 Smoke child is ready; starting survival window.');
      timer = setTimeout(shutdown, windowMs);
    };
    const onExit = (code, signal) => {
      const clean = phase === 'shutdown' && code === 0 && !signal;
      finish(failure ?? (clean ? null : `Server exited during ${phase} (code ${code}, signal ${signal}).`));
    };
    const onError = (err) => {
      failure ??= `Child process error: ${err.message}`;
      // Spawn failure has no process to reap. A kill error still needs the
      // existing shutdown/escalation timers to bound cleanup.
      if (!child.pid) finish(failure);
      else if (phase === 'startup' || phase === 'survival') shutdown();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.on('error', onError);
    timer = setTimeout(() => {
      failure = `Server did not become ready within ${startupMs}ms.`;
      shutdown();
    }, startupMs);
  });
}

async function runSmoke() {
  const windowMs = parseMs(process.env.SMOKE_WINDOW_MS, 4000);
  const startupMs = parseMs(process.env.SMOKE_STARTUP_TIMEOUT_MS, 120000);
  // Match the server's graceful-shutdown budget; escalation is a failure.
  const shutdownMs = parseMs(process.env.SMOKE_SHUTDOWN_GRACE_MS, 10000);
  const postKillMs = parseMs(process.env.SMOKE_POST_SIGKILL_MS, 2000);

  let root = null;
  let child = null;
  // Every exit path — success, crash, timeout, signal, a throw during setup —
  // goes through process.exit, so one synchronous 'exit' hook removes the root.
  process.on('exit', () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      console.error(`❌ Smoke interrupted by ${signal}.`);
      process.exit(1);
    });
  }

  root = createSmokeRoot();
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: root,
    env: buildSmokeEnv({ root }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true
  });

  child.stdout.on('data', (d) => process.stdout.write(`[smoke] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[smoke err] ${d}`));
  const result = await monitorSmokeChild(child, { startupMs, windowMs, shutdownMs, postKillMs });
  if (result.ok) console.log(`✅ Server ready, survived ${windowMs}ms, and shut down cleanly.`);
  else console.error(`❌ ${result.error}`);
  process.exit(result.ok ? 0 : 1);
}

if (isDirectlyInvoked(import.meta.url)) {
  runSmoke().catch((err) => {
    console.error(`❌ Boot smoke failed: ${err.message}`);
    process.exit(1);
  });
}
