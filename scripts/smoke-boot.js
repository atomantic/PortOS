#!/usr/bin/env node
// Server boot smoke test — imports server/index.js in a child process and
// verifies it stays alive for SMOKE_WINDOW_MS without crashing. Catches the
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

function runSmoke() {
  const SMOKE_WINDOW_MS = parseMs(process.env.SMOKE_WINDOW_MS, 4000);
  // Match server/index.js's 10s graceful-shutdown budget so we don't SIGKILL a
  // healthy server that's still closing Socket.IO + HTTP + DB.
  const SHUTDOWN_GRACE_MS = parseMs(process.env.SMOKE_SHUTDOWN_GRACE_MS, 10000);
  const POST_SIGKILL_MS = parseMs(process.env.SMOKE_POST_SIGKILL_MS, 2000);

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
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  let firstErr = '';
  let crashed = false;
  let exitCode = null;

  child.stdout.on('data', (d) => process.stdout.write(`[smoke] ${d}`));
  child.stderr.on('data', (d) => {
    const s = d.toString();
    if (!firstErr) firstErr = s;
    process.stderr.write(`[smoke err] ${s}`);
  });
  child.on('exit', (code) => { crashed = true; exitCode = code; });

  // After the boot window either fail (child exited early) or send SIGTERM,
  // wait for the child to actually terminate, and fall back to SIGKILL if it
  // ignores SIGTERM.
  setTimeout(() => {
    if (crashed) {
      console.error(`❌ Server crashed during ${SMOKE_WINDOW_MS}ms boot window (exit ${exitCode}).`);
      if (firstErr) console.error('First error:\n' + firstErr);
      process.exit(1);
    }
    console.log(`✅ Server survived ${SMOKE_WINDOW_MS}ms boot window.`);

    let shutdownTimer = null;
    let forceKillTimer = null;
    child.once('exit', () => {
      if (shutdownTimer) clearTimeout(shutdownTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      process.exit(0);
    });
    child.kill('SIGTERM');
    shutdownTimer = setTimeout(() => {
      console.warn(`⚠️  Child ignored SIGTERM after ${SHUTDOWN_GRACE_MS}ms — sending SIGKILL.`);
      child.kill('SIGKILL');
      // If the child still doesn't exit after SIGKILL, it's an orphan risk in CI.
      // Fail the smoke instead of silently exiting 0.
      forceKillTimer = setTimeout(() => {
        console.error(`❌ Child did not terminate after SIGKILL (${POST_SIGKILL_MS}ms).`);
        process.exit(1);
      }, POST_SIGKILL_MS);
    }, SHUTDOWN_GRACE_MS);
  }, SMOKE_WINDOW_MS);
}

if (isDirectlyInvoked(import.meta.url)) runSmoke();
