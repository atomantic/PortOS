#!/usr/bin/env node
// Server boot smoke test — imports server/index.js in a child process and
// verifies it stays alive for SMOKE_WINDOW_MS without crashing. Catches the
// class of bug where top-level initialization code throws (e.g. chaining
// .catch on a sync function that returns undefined), which is invisible to
// unit tests that import service modules in isolation.

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse SMOKE_WINDOW_MS safely: ignore missing/empty/non-numeric values so a
// bad env var can't silently reduce the window to 0ms (which would always pass).
const parseMs = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const SMOKE_WINDOW_MS = parseMs(process.env.SMOKE_WINDOW_MS, 4000);
// Match server/index.js's 10s graceful-shutdown budget so we don't SIGKILL a
// healthy server that's still closing Socket.IO + HTTP + DB.
const SHUTDOWN_GRACE_MS = parseMs(process.env.SMOKE_SHUTDOWN_GRACE_MS, 10000);
const POST_SIGKILL_MS = parseMs(process.env.SMOKE_POST_SIGKILL_MS, 2000);
const SERVER_ENTRY = join(__dirname, '..', 'server', 'index.js');

// Use dedicated ports so a running PortOS instance doesn't collide.
// Preserve pre-existing NODE_OPTIONS (e.g. --max-old-space-size from CI)
// and append our flags instead of replacing.
const existingNodeOpts = process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : '';
const env = {
  ...process.env,
  PORT: process.env.SMOKE_PORT ?? '55559',
  PORTOS_HTTP_PORT: process.env.SMOKE_HTTP_PORT ?? '55557',
  NODE_ENV: 'test',
  NODE_OPTIONS: `${existingNodeOpts}--unhandled-rejections=strict`
};

const child = spawn(process.execPath, [SERVER_ENTRY], {
  env,
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
