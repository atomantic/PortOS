/**
 * Daily TLS cert renewer.
 *
 * When `data/certs/meta.json` indicates a Tailscale-issued cert, this service
 * re-runs `tailscale cert` every 24h. The CLI is a no-op when the cached cert
 * has >1/3 lifetime remaining (~60 days for a 90-day LE cert), and fetches a
 * fresh one otherwise. If the cert file's mtime changes after the run, we
 * hot-swap the live HTTPS server's SecureContext so new TLS handshakes pick
 * up the new cert without a process restart.
 *
 * Self-signed certs don't renew (the script issues 10-year certs for local
 * use); the renewer is a no-op in that mode.
 */
import { execFile } from '../lib/childProcess.js';
import { existsSync, readFileSync, statSync } from 'fs';
import { promisify } from 'util';
import { PATHS, atomicWrite } from '../lib/fileUtils.js';
import { findTailscale } from '../lib/tailscale.js';
import { certPaths } from '../../lib/certPaths.js';
import { readCertMeta, readCertExpiresAt } from '../../lib/certMeta.js';

const execFileAsync = promisify(execFile);

const { cert: CERT_PATH, key: KEY_PATH, meta: META_PATH } = certPaths(PATHS.data);
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CERT_CLI_TIMEOUT_MS = 60_000;
let inFlight = false;

async function renewOnce(httpsServer) {
  if (inFlight) {
    console.log(`ℹ️ cert renewer: previous renewal still running, skipping`);
    return;
  }
  inFlight = true;
  try {
    await renewLocked(httpsServer);
  } finally {
    inFlight = false;
  }
}

async function renewLocked(httpsServer) {
  const meta = readCertMeta(META_PATH);
  if (!meta || meta.mode !== 'tailscale' || !meta.hostname) return;

  const bin = findTailscale();
  if (!bin) {
    console.log(`⚠️ cert renewer: tailscale CLI not found, skipping renewal`);
    return;
  }

  const mtimeBefore = existsSync(CERT_PATH) ? statSync(CERT_PATH).mtimeMs : 0;

  let stderr = '';
  try {
    ({ stderr = '' } = await execFileAsync(bin, [
      'cert',
      `--cert-file=${CERT_PATH}`,
      `--key-file=${KEY_PATH}`,
      meta.hostname
    ], { timeout: CERT_CLI_TIMEOUT_MS }));
  } catch (err) {
    // A failed or timed-out CLI may have left a half-written pair; never hot-swap it.
    console.log(`⚠️ cert renewer: tailscale cert failed: ${err.message.trim().split('\n')[0]}`);
    return;
  }

  if (stderr && !/Wrote (public|private)/.test(stderr)) {
    console.log(`⚠️ cert renewer: tailscale cert stderr: ${stderr.trim().split('\n')[0]}`);
  }

  const certMtime = existsSync(CERT_PATH) ? statSync(CERT_PATH).mtimeMs : 0;
  if (certMtime <= mtimeBefore) return;
  if (!existsSync(KEY_PATH)) {
    console.log(`⚠️ cert renewer: key file missing after renewal, skipping hot-swap`);
    return;
  }

  httpsServer.setSecureContext({
    cert: readFileSync(CERT_PATH),
    key: readFileSync(KEY_PATH)
  });
  console.log(`🔒 cert renewer: hot-swapped renewed cert for ${meta.hostname}`);

  await atomicWrite(META_PATH, {
    mode: 'tailscale',
    hostname: meta.hostname,
    issuedAt: new Date().toISOString(),
    expiresAt: readCertExpiresAt(CERT_PATH),
    certMtime
  });
}

const NOOP = () => {};

// Returns a teardown that stops the daily timer (a no-op when nothing was scheduled).
export function initCertRenewer(httpsServer) {
  if (!httpsServer || typeof httpsServer.setSecureContext !== 'function') return NOOP;
  const meta = readCertMeta(META_PATH);
  if (!meta || meta.mode !== 'tailscale') return NOOP;

  renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer initial run: ${err.message}`));
  const timer = setInterval(() => {
    renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer: ${err.message}`));
  }, RENEW_INTERVAL_MS);
  timer.unref();

  console.log(`🔒 cert renewer: scheduled daily renewal for ${meta.hostname}`);
  return () => clearInterval(timer);
}
