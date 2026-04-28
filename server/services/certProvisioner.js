/**
 * Cert provisioner — runtime equivalent of `npm run setup:cert`.
 *
 * Invokes `tailscale cert` to fetch a Let's Encrypt cert for this instance's
 * MagicDNS hostname, writes it to data/certs/{cert,key}.pem, and updates
 * meta.json. Returns a structured result the API can surface to the UI.
 *
 * The HTTPS listener type is decided at server boot (lib/tailscale-https.js).
 * If PortOS booted in HTTP mode (no cert present), the new cert only takes
 * effect after a restart — the response sets requiresRestart=true so the UI
 * can prompt the user.
 */
import { execFile } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { PATHS } from '../lib/fileUtils.js';
import { findTailscale } from '../lib/tailscale.js';

const execFileAsync = promisify(execFile);

const CERT_DIR = join(PATHS.data, 'certs');
const KEY_PATH = join(CERT_DIR, 'key.pem');
const CERT_PATH = join(CERT_DIR, 'cert.pem');
const META_PATH = join(CERT_DIR, 'meta.json');

async function tailscaleStatus(bin) {
  const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 5000 });
  return JSON.parse(stdout);
}

/**
 * Run `tailscale cert` for the local MagicDNS hostname. Returns a result
 * object describing what happened. Never throws — all known failure modes
 * surface as `{ ok: false, reason, message }` so the UI can render an
 * actionable toast.
 */
export async function provisionTailscaleCert() {
  const bin = findTailscale();
  if (!bin) {
    return {
      ok: false,
      reason: 'tailscale-not-installed',
      message: 'Tailscale CLI not found. Install Tailscale first.'
    };
  }

  const status = await tailscaleStatus(bin).catch(err => ({ _err: err.message }));
  if (status?._err) {
    return {
      ok: false,
      reason: 'tailscale-status-failed',
      message: `tailscale status failed: ${status._err}`
    };
  }

  if (status?.BackendState !== 'Running') {
    return {
      ok: false,
      reason: 'tailscale-not-running',
      message: `Tailscale is ${status?.BackendState || 'not running'}. Start the Tailscale app, then try again.`
    };
  }

  const hostname = (status?.Self?.DNSName || '').replace(/\.$/, '');
  if (!hostname) {
    return {
      ok: false,
      reason: 'no-magic-dns',
      message: 'No MagicDNS hostname for this device. Enable MagicDNS at login.tailscale.com/admin/dns.'
    };
  }

  // If cert files don't exist yet, PortOS booted in HTTP mode — restart is
  // required to actually serve HTTPS. If they already exist, certRenewer's
  // hot-swap path will pick up the new cert on its next tick.
  const httpAtBoot = !existsSync(CERT_PATH) || !existsSync(KEY_PATH);

  mkdirSync(CERT_DIR, { recursive: true });

  const beforeMtime = existsSync(CERT_PATH) ? statSync(CERT_PATH).mtimeMs : 0;

  const certResult = await execFileAsync(bin, [
    'cert',
    `--cert-file=${CERT_PATH}`,
    `--key-file=${KEY_PATH}`,
    hostname
  ], { timeout: 60_000 }).catch(err => ({ _err: err.stderr?.toString() || err.message }));

  if (certResult?._err) {
    const stderr = certResult._err.trim();
    const httpsHint = /HTTPS.*not.*enabled|invalid request/i.test(stderr)
      ? ' Enable "HTTPS Certificates" at login.tailscale.com/admin/dns and retry.'
      : '';
    return {
      ok: false,
      reason: 'tailscale-cert-failed',
      message: `tailscale cert failed: ${stderr.split('\n')[0]}.${httpsHint}`
    };
  }

  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) {
    return {
      ok: false,
      reason: 'cert-files-missing',
      message: 'tailscale cert returned success but cert files are missing.'
    };
  }

  const afterMtime = statSync(CERT_PATH).mtimeMs;
  const wroteNew = afterMtime > beforeMtime;

  writeFileSync(META_PATH, JSON.stringify({
    mode: 'tailscale',
    hostname,
    issuedAt: new Date().toISOString(),
    certMtime: afterMtime
  }, null, 2));

  console.log(`🔒 Provisioned Tailscale cert for ${hostname} (new=${wroteNew}, restart=${httpAtBoot})`);

  const restartHint = httpAtBoot
    ? ' Restart PortOS (npm start) to enable HTTPS on :5555.'
    : '';

  return {
    ok: true,
    mode: 'tailscale',
    hostname,
    wroteNew,
    requiresRestart: httpAtBoot,
    message: `Cert installed for ${hostname}.${restartHint}`
  };
}
