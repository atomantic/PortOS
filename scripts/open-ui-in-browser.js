#!/usr/bin/env node
// Open the PortOS dashboard in the PortOS-managed Chrome instance.
// Used after setup.sh / update.sh / update.ps1 finish PM2 boot so the user
// lands on the dashboard without having to manually open a tab.
//
// Fail-soft: every failure path logs and exits 0 — never break setup/update
// because Chrome happens to be unreachable.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CERT_PATH = join(ROOT, 'data', 'certs', 'cert.pem');
const KEY_PATH = join(ROOT, 'data', 'certs', 'key.pem');
const API_PORT = Number(process.env.PORT) || 5555;
const HTTP_LOOPBACK_PORT = Number(process.env.PORTOS_HTTP_PORT) || 5553;
// The server only enables HTTPS when BOTH cert and key exist (matches
// lib/tailscale-https.js loadCert) — checking only cert.pem would falsely
// route to the loopback mirror during a half-finished setup:cert.
const HTTPS_MODE = existsSync(CERT_PATH) && existsSync(KEY_PATH);

// When HTTPS is on, :5555 speaks TLS only — plain http:// requests hit a TLS
// mismatch and time out. The loopback HTTP mirror on :5553 serves the same
// app and skips the cert warning. We use it for both polling and the URL
// handed to the browser. See docs/PORTS.md.
const LOCAL_BASE = HTTPS_MODE
  ? `http://localhost:${HTTP_LOOPBACK_PORT}`
  : `http://localhost:${API_PORT}`;
const TARGET_URL = LOCAL_BASE;

// First-boot startup can take a while: the server binds, opens the DB pool,
// loads the brain index, attaches Socket.IO, then health responds. 90s is
// roomy for a fresh checkout on slow disks; if PortOS still isn't up, the
// user has bigger problems than the auto-open script.
const API_TIMEOUT_MS = 90_000;
const BROWSER_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 500;

async function poll(checkFn, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkFn()) return true;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.warn(`⚠️  ${label} didn't respond within ${timeoutMs / 1000}s — skipping auto-open. Check \`pm2 logs portos-server\` for startup errors.`);
  return false;
}

async function ping(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  const ok = await fetch(url, { signal: controller.signal })
    .then(r => r.ok)
    .catch(() => false);
  clearTimeout(timeout);
  return ok;
}

const apiHealthUrl = `${LOCAL_BASE}/api/system/health`;
const browserHealthUrl = `${LOCAL_BASE}/api/browser/health`;
const navigateUrl = `${LOCAL_BASE}/api/browser/navigate`;

const apiReady = await poll(() => ping(apiHealthUrl), 'PortOS API', API_TIMEOUT_MS);
if (!apiReady) process.exit(0);

// Browser process may take a few seconds longer than the API to reach Chrome.
// We don't gate strictly on it — even if the health endpoint says "unhealthy"
// we still POST navigate, which will trigger a launch via the route handler
// when CDP isn't yet up. The poll just gives Chrome a head start.
await poll(async () => {
  // Use the same per-request AbortController guard that ping() uses — without
  // a timeout, a hung TCP connection (accepted but never responds) would let
  // a single fetch await forever and ignore BROWSER_TIMEOUT_MS entirely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  const res = await fetch(browserHealthUrl, { signal: controller.signal }).catch(() => null);
  clearTimeout(timer);
  if (!res?.ok) return false;
  const json = await res.json().catch(() => null);
  return json?.connected === true;
}, 'PortOS browser CDP', BROWSER_TIMEOUT_MS);

const res = await fetch(navigateUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: TARGET_URL })
}).catch(err => {
  console.warn(`⚠️  Could not reach navigate endpoint: ${err.message}`);
  return null;
});

if (!res) process.exit(0);
if (!res.ok) {
  const text = await res.text().catch(() => '');
  console.warn(`⚠️  Navigate failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  process.exit(0);
}

console.log(`🌐 Opened ${TARGET_URL} in PortOS browser`);
