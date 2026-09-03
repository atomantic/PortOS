#!/usr/bin/env node
/**
 * "Did portos-server actually come back after the update restarted it?"
 *
 * `update.sh` / `update.ps1` delete every PortOS PM2 entry and start it again.
 * When that bracket half-fails, the install is left headless — and nothing else
 * on the machine notices, because the thing that would have noticed is the
 * server that did not come back (#5976: a no-op update left the install down
 * for hours). The update script is the last PortOS process still running at
 * that point, so the check has to live here.
 *
 * Usage as a CLI (what update.sh and update.ps1 call):
 *   node scripts/verify-server-health.js
 *
 * Exit 0  → the server answered /api/system/health with status "ok".
 * Exit 1  → it did not, within the budget. The caller re-runs `pm2 start`.
 *
 * Fails CLOSED, unlike `pm2-daemon-refresh.js`: an unreachable server is
 * exactly the condition being detected, so anything short of a positive "ok"
 * is reported as unhealthy. The recovery it triggers is one extra `pm2 start`,
 * which cannot make an already-healthy install worse.
 *
 * `/api/system/health` is in the always-public set (`PUBLIC_API_PATHS`), so
 * this works with the optional instance password on. All three candidate URLs
 * are probed because the listening scheme/port depends on whether a cert is
 * provisioned: HTTPS on :5555 plus the loopback HTTP mirror on :5553, or plain
 * HTTP on :5555. Probing beats re-deriving the cert state — the answer we want
 * is "is something serving", not "which URL should we advertise".
 */

import http from 'node:http';
import https from 'node:https';
import { PORTS } from '../server/lib/ports.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const HEALTH_PATH = '/api/system/health';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_INTERVAL_MS = 2_000;
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Read a non-negative millisecond budget from the environment. `|| DEFAULT`
 * would be wrong here: it collapses "unset" and "not a number" together with a
 * deliberate `0` (fail fast, one pass and out), which `waitForHealthy`
 * explicitly supports.
 *
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number}
 */
export function parseTimeoutMs(raw, fallback = DEFAULT_TIMEOUT_MS) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The loopback URLs a healthy PortOS could be answering on, in the order worth
 * trying: the plain-HTTP mirror first (always cert-free), then the API port
 * over each scheme. Deduped so a plain-HTTP install (mirror port unbound,
 * API port serving HTTP) does not probe the same URL twice.
 *
 * @param {{apiPort: number, mirrorPort: number}} ports
 * @returns {string[]}
 */
export function healthProbeUrls({ apiPort, mirrorPort }) {
  const urls = [
    `http://127.0.0.1:${mirrorPort}${HEALTH_PATH}`,
    `http://127.0.0.1:${apiPort}${HEALTH_PATH}`,
    `https://127.0.0.1:${apiPort}${HEALTH_PATH}`,
  ];
  return [...new Set(urls)];
}

/**
 * One request. Resolves true only on a 200 whose JSON body says status "ok" —
 * a 502 from something else on the port, a hung socket, or a half-booted
 * server that answers but not with "ok" all count as not-yet-healthy.
 *
 * `rejectUnauthorized: false` matches the rest of PortOS's loopback probing:
 * the cert is issued for the Tailscale hostname, so 127.0.0.1 never validates,
 * and there is no trust boundary to cross on loopback.
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
export function probeHealth(url, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.get(url, { timeout: timeoutMs, rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(false);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        // A response that is not the health payload — a proxy error page, a
        // truncated body — is not a healthy server.
        try {
          resolve(JSON.parse(body)?.status === 'ok');
        } catch {
          resolve(false);
        }
      });
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Poll the candidate URLs until one reports healthy or the budget runs out.
 * Clock and probe are injected so the timeout contract is testable without
 * real sleeps or a real server.
 *
 * @param {object} options
 * @param {string[]} options.urls
 * @param {number} [options.timeoutMs] - total budget across all attempts
 * @param {number} [options.intervalMs] - pause between full passes
 * @param {(url: string) => Promise<boolean>} [options.probe]
 * @param {() => number} [options.now]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<{healthy: boolean, url: string|null, attempts: number}>}
 */
export async function waitForHealthy({
  urls,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  intervalMs = DEFAULT_INTERVAL_MS,
  probe = probeHealth,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const deadline = now() + timeoutMs;
  let attempts = 0;
  // Always make one full pass, even with a zero/expired budget — the check is
  // worthless if it can report "unhealthy" without having asked.
  for (;;) {
    for (const url of urls) {
      attempts += 1;
      if (await probe(url)) return { healthy: true, url, attempts };
    }
    if (now() >= deadline) return { healthy: false, url: null, attempts };
    await sleep(intervalMs);
  }
}

async function runCli() {
  const apiPort = Number(process.env.PORT) || PORTS.API;
  const mirrorPort = Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;
  const timeoutMs = parseTimeoutMs(process.env.PORTOS_HEALTH_WAIT_MS);
  const urls = healthProbeUrls({ apiPort, mirrorPort });

  const result = await waitForHealthy({ urls, timeoutMs });
  if (result.healthy) {
    console.log(`✅ PortOS is serving ${HEALTH_PATH} (${result.url})`);
    return 0;
  }
  console.error(`❌ PortOS did not answer ${HEALTH_PATH} within ${Math.round(timeoutMs / 1000)}s (${result.attempts} attempts)`);
  return 1;
}

if (isDirectlyInvoked(import.meta.url)) process.exit(await runCli());
