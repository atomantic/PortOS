/**
 * Daily TLS cert renewer.
 *
 * When `data/certs/meta.json` indicates a Tailscale-issued cert, this service
 * re-runs `tailscale cert` every 24h. The CLI is a no-op when the cached cert
 * has >1/3 lifetime remaining (~60 days for a 90-day LE cert), and fetches a
 * fresh one otherwise. After installing a changed, validated certificate pair,
 * we hot-swap the live HTTPS server's SecureContext so new TLS handshakes pick
 * up the new cert without a process restart.
 *
 * Self-signed certs don't renew (the script issues 10-year certs for local
 * use); the renewer is a no-op in that mode.
 */
import { execFile } from '../lib/childProcess.js';
import { promisify } from 'util';
import { PATHS } from '../lib/fileUtils.js';
import { findTailscale } from '../lib/tailscale.js';
import { certPaths } from '../../lib/certPaths.js';
import { readCertMeta, readCertMetaAsync } from '../../lib/certMeta.js';
import { installTailscaleCert, TAILSCALE_CERT_TIMEOUT_MS } from '../../lib/tailscaleCertInstall.js';

const execFileAsync = promisify(execFile);

const CERT_PATHS = certPaths(PATHS.data);
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
  const meta = await readCertMetaAsync(CERT_PATHS.meta);
  if (!meta || meta.mode !== 'tailscale' || !meta.hostname) return;

  const bin = findTailscale();
  if (!bin) {
    console.log(`⚠️ cert renewer: tailscale CLI not found, skipping renewal`);
    return;
  }

  const { changed, credentials } = await installTailscaleCert(CERT_PATHS, {
    hostname: meta.hostname,
    runCert: async args => {
      const { stderr = '' } = await execFileAsync(bin, args, {
        timeout: TAILSCALE_CERT_TIMEOUT_MS,
        killSignal: 'SIGKILL'
      });
      if (stderr && !/Wrote (public|private)/.test(stderr)) {
        console.log(`⚠️ cert renewer: tailscale cert stderr: ${stderr.trim().split('\n')[0]}`);
      }
    }
  }).catch(err => {
    console.log(`⚠️ cert renewer: tailscale cert renewal failed: ${err.message.trim().split('\n')[0]}`);
    return { changed: false };
  });

  if (!changed) return;
  httpsServer.setSecureContext(credentials);
  console.log(`🔒 cert renewer: hot-swapped renewed cert for ${meta.hostname}`);
}

const NOOP = () => {};

// Returns a teardown that stops the daily timer (a no-op when nothing was scheduled).
export function initCertRenewer(httpsServer) {
  if (!httpsServer || typeof httpsServer.setSecureContext !== 'function') return NOOP;
  const meta = readCertMeta(CERT_PATHS.meta);
  if (!meta || meta.mode !== 'tailscale') return NOOP;

  renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer initial run: ${err.message}`));
  const timer = setInterval(() => {
    renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer: ${err.message}`));
  }, RENEW_INTERVAL_MS);
  timer.unref();

  console.log(`🔒 cert renewer: scheduled daily renewal for ${meta.hostname}`);
  return () => clearInterval(timer);
}
