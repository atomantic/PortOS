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
import { execFile } from 'child_process';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { PATHS } from '../lib/fileUtils.js';
import { findTailscale } from '../lib/tailscale.js';

const execFileAsync = promisify(execFile);

const CERT_DIR = join(PATHS.data, 'certs');
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const KEY_PATH = join(CERT_DIR, 'key.pem');
const META_PATH = join(CERT_DIR, 'meta.json');
const RENEW_INTERVAL_MS = 24 * 60 * 60 * 1000;

function readMeta() {
  if (!existsSync(META_PATH)) return null;
  return JSON.parse(readFileSync(META_PATH, 'utf-8'));
}

async function renewOnce(httpsServer) {
  const meta = readMeta();
  if (!meta || meta.mode !== 'tailscale' || !meta.hostname) return;

  const bin = findTailscale();
  if (!bin) {
    console.log(`⚠️ cert renewer: tailscale CLI not found, skipping renewal`);
    return;
  }

  const mtimeBefore = existsSync(CERT_PATH) ? statSync(CERT_PATH).mtimeMs : 0;

  const { stderr } = await execFileAsync(bin, [
    'cert',
    `--cert-file=${CERT_PATH}`,
    `--key-file=${KEY_PATH}`,
    meta.hostname
  ]).catch(err => ({ stderr: err.message }));

  if (stderr && !/Wrote (public|private)/.test(stderr)) {
    console.log(`⚠️ cert renewer: tailscale cert stderr: ${stderr.trim().split('\n')[0]}`);
  }

  const mtimeAfter = existsSync(CERT_PATH) ? statSync(CERT_PATH).mtimeMs : 0;
  if (mtimeAfter > mtimeBefore) {
    httpsServer.setSecureContext({
      cert: readFileSync(CERT_PATH),
      key: readFileSync(KEY_PATH)
    });
    console.log(`🔒 cert renewer: hot-swapped renewed cert for ${meta.hostname}`);
  }
}

export function initCertRenewer(httpsServer) {
  if (!httpsServer || typeof httpsServer.setSecureContext !== 'function') return;
  const meta = readMeta();
  if (!meta || meta.mode !== 'tailscale') return;

  renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer initial run: ${err.message}`));
  setInterval(() => {
    renewOnce(httpsServer).catch(err => console.error(`❌ cert renewer: ${err.message}`));
  }, RENEW_INTERVAL_MS).unref();

  console.log(`🔒 cert renewer: scheduled daily renewal for ${meta.hostname}`);
}
