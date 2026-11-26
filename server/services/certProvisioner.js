/**
 * Cert provisioner — runtime equivalent of the Tailscale `setup:cert` path.
 *
 * Invokes `tailscale cert` to fetch a Let's Encrypt cert for this instance's
 * MagicDNS hostname, writes it to data/certs/{cert,key}.pem, and updates
 * meta.json. Returns a structured result the API can surface to the UI.
 *
 * This service only handles Tailscale-backed certificate provisioning. It
 * does not generate self-signed certs or implement the regeneration/expiry
 * logic that exists in scripts/setup-cert.js.
 *
 * The HTTPS listener type is decided at server boot (lib/tailscale-https.js).
 * If PortOS booted in HTTP mode, the new cert only takes effect after a
 * restart — the response sets requiresRestart=true so the UI can prompt the
 * user. This is keyed off the boot-time HTTPS state (httpsState.js), not
 * cert file presence, because cert files can exist on disk while the running
 * process is still serving HTTP (e.g. provision was run twice without a
 * restart in between).
 */
import { execFile } from '../lib/childProcess.js';
import { promisify } from 'util';
import { PATHS } from '../lib/fileUtils.js';
import { findTailscale, isSandboxedTailscale } from '../lib/tailscale.js';
import { getHttpsEnabledAtBoot } from '../lib/httpsState.js';
import { PORTS } from '../lib/ports.js';
import { certPaths } from '../../lib/certPaths.js';
import { installTailscaleCert, TAILSCALE_CERT_TIMEOUT_MS } from '../../lib/tailscaleCertInstall.js';

const execFileAsync = promisify(execFile);
const CERT_PATHS = certPaths(PATHS.data);

async function tailscaleStatus(bin) {
  const { stdout } = await execFileAsync(bin, ['status', '--json'], { timeout: 5000, killSignal: 'SIGKILL' });
  return JSON.parse(stdout);
}

function certFailure(bin, err) {
  if (err.code === 'cert-files-missing') {
    return { ok: false, reason: err.code, message: err.message };
  }
  if (err.code === 'cert-pair-invalid') {
    return { ok: false, reason: 'tailscale-cert-failed', message: err.message };
  }
  if (err.code !== 'tailscale-cert-command-failed') throw err;

  const cause = err.cause;
  const stderr = cause.stderr?.toString().trim() || cause.message || 'unknown error';
  if (isSandboxedTailscale(bin) && /operation not permitted/i.test(stderr)) {
    return {
      ok: false,
      reason: 'tailscale-sandboxed',
      message: 'The macOS Tailscale.app CLI is sandboxed and can\'t write the cert file. Install the unsandboxed CLI with `brew install tailscale`, then restart PortOS and retry.'
    };
  }

  const firstLine = stderr.split('\n')[0].trim() || 'unknown error';
  const needsPeriod = !/[.!?]$/.test(firstLine);
  const httpsHint = /HTTPS.*not.*enabled|invalid request/i.test(stderr)
    ? ' Enable "HTTPS Certificates" at login.tailscale.com/admin/dns and retry.'
    : '';
  return {
    ok: false,
    reason: 'tailscale-cert-failed',
    message: `tailscale cert failed: ${firstLine}${needsPeriod ? '.' : ''}${httpsHint}`
  };
}

/**
 * Run `tailscale cert` for the local MagicDNS hostname. Returns a result
 * object describing what happened. Expected Tailscale/provisioning failure
 * modes surface as `{ ok: false, reason, message }` so the UI can render an
 * actionable toast, but unexpected filesystem or process errors (mkdir
 * permission denied, atomic write failure, etc.) may still throw and bubble
 * to the route's error middleware as a 500.
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

  const installed = await installTailscaleCert(CERT_PATHS, {
    hostname,
    runCert: args => execFileAsync(bin, args, {
      timeout: TAILSCALE_CERT_TIMEOUT_MS,
      killSignal: 'SIGKILL'
    }).catch(cause => {
      throw Object.assign(new Error('tailscale cert command failed', { cause }), {
        code: 'tailscale-cert-command-failed'
      });
    })
  }).catch(err => certFailure(bin, err));
  if (installed.ok === false) return installed;
  const wroteNew = installed.changed;

  // requiresRestart is keyed off the boot-time HTTPS state, not cert file
  // presence. The listener type was frozen at boot — if PortOS started in
  // HTTP mode, no amount of subsequent provisioning can flip it without a
  // restart, even when the cert files now exist on disk.
  const httpsState = getHttpsEnabledAtBoot();
  const requiresRestart = !httpsState.value;

  console.log(`🔒 Provisioned Tailscale cert for ${hostname} (new=${wroteNew}, restart=${requiresRestart})`);

  const apiPort = Number(process.env.PORT) || PORTS.API;
  const restartHint = requiresRestart
    ? ` Restart PortOS to enable HTTPS on :${apiPort}.`
    : '';

  return {
    ok: true,
    mode: 'tailscale',
    hostname,
    wroteNew,
    requiresRestart,
    message: `Cert installed for ${hostname}.${restartHint}`
  };
}
