/**
 * Snapshot of how PortOS is exposed on the network — scheme, bind address,
 * loopback HTTP mirror, Tailscale-vs-self-signed cert mode. Drives the
 * dashboard's Network Exposure widget so the security posture is visible
 * product UX, not a docs-only invariant.
 *
 * The HTTPS decision and the bind host/port are frozen at boot (see
 * lib/tailscale-https.js + httpsState.js). After running `npm run setup:cert`
 * the user must restart for the scheme to flip — this snapshot reflects what
 * the running process is actually serving, which is exactly what the widget
 * should show.
 */
import { PORTS } from './ports.js';
import { PATHS } from './fileUtils.js';
import { getHttpsEnabledAtBoot } from './httpsState.js';
import { getSelfHost } from './peerSelfHost.js';
import { getTailscaleStatus } from './tailscale.js';
import { certPaths } from '../../lib/certPaths.js';
import { getTailscaleCertHostname, readCertMeta } from '../../lib/certMeta.js';
import { hasTailscaleCert } from '../../lib/tailscale-https.js';

const { dir: CERT_DIR, meta: META_PATH } = certPaths(PATHS.data);

export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';

// docs/PORTS.md is checked into the repo but the server doesn't serve the
// docs/ directory, so link out to GitHub for the canonical guide rather than
// to a 404. The widget shows this as "Learn more →".
const PORTS_DOCS_URL = 'https://github.com/atomantic/PortOS/blob/main/docs/PORTS.md';

// Loopback-only bind hosts — for these, the browser treats the page as
// "potentially trustworthy" (Secure Contexts spec), so getUserMedia and other
// powerful APIs work over plain HTTP. Any other host (Tailscale IP, LAN IP,
// 0.0.0.0 → resolves to the actual interface) requires HTTPS.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
export function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function getNetworkExposureStatus() {
  const { value: httpsEnabled, initialized } = getHttpsEnabledAtBoot();
  const scheme = httpsEnabled ? 'https' : 'http';
  const bindHost = process.env.HOST || '0.0.0.0';
  const bindPort = Number(process.env.PORT) || PORTS.API;
  const loopbackPort = Number(process.env.PORTOS_HTTP_PORT) || PORTS.API_LOCAL;

  const meta = readCertMeta(META_PATH);
  const certProvisioned = hasTailscaleCert(CERT_DIR);
  const provisionedMode = certProvisioned ? (meta?.mode || 'unknown') : null;
  const provisionedHost = certProvisioned ? getTailscaleCertHostname(meta) : null;
  // The listener may still be serving the certificate loaded at boot even if
  // its files or metadata were removed afterward. Preserve the runtime-facing
  // `unknown` sentinel instead of incorrectly reporting plain HTTP/no cert.
  const certMode = httpsEnabled ? (meta?.mode || 'unknown') : null;
  const tailscaleHost = getSelfHost();
  const tailscaleIps = Array.isArray(meta?.ips) ? meta.ips : [];

  // Bind audience — informational summary shown to the user so they know
  // *who* can reach the listener. 0.0.0.0 means every interface (Tailscale,
  // LAN, loopback); 127.0.0.1 / localhost is loopback-only.
  const bindAudience = isLoopbackHost(bindHost)
    ? 'loopback-only'
    : bindHost === '0.0.0.0' || bindHost === '::'
      ? 'all-interfaces'
      : 'specific-interface';

  return {
    scheme,
    httpsEnabled,
    httpsStateInitialized: initialized,
    bind: {
      host: bindHost,
      port: bindPort,
      audience: bindAudience,
    },
    loopbackMirror: {
      enabled: httpsEnabled,
      port: loopbackPort,
    },
    cert: {
      mode: certMode,
      tailscaleHost,
      ips: tailscaleIps,
      provisioned: certProvisioned,
      provisionedMode,
      provisionedHost,
    },
    docsUrl: PORTS_DOCS_URL,
  };
}

/**
 * Plain-HTTP base URL for reaching this install's own API from the same
 * machine — what local scripts, curl snippets, and the shell commands PortOS
 * hands its CoS agents should target.
 *
 * When HTTPS is active, `:5555` is TLS-only and a plain-HTTP request to it
 * fails at the transport layer; the loopback-only HTTP mirror (`PORTS.API_LOCAL`,
 * overridable via `PORTOS_HTTP_PORT`) is the right target. When HTTPS is off,
 * the API port itself already speaks HTTP and no mirror is bound.
 *
 * Uses `127.0.0.1` rather than `localhost` because the mirror listener binds to
 * 127.0.0.1 specifically — a `::1`-preferring resolver can miss it.
 */
export function localApiBaseUrl() {
  const status = getNetworkExposureStatus();
  const port = status.loopbackMirror.enabled
    ? status.loopbackMirror.port
    : status.bind.port;
  return `http://127.0.0.1:${port}`;
}

const setupStep = (id, title, status, detail, action = null) => ({
  id,
  title,
  status,
  detail,
  action,
});

const tailscaleStatusUnknown = (tailscale) => [
  'tailscale-status-failed',
  'tailscale-parse-error',
].includes(tailscale?.reason);

/**
 * Ordered, side-effect-free remote-access walkthrough shared by the API and
 * the setup/update CLI. `status` is one of complete/action/blocked/unknown;
 * callers render the same facts in their own medium and execute actions only
 * after an explicit user click (the CLI provisioner is invoked separately).
 */
export function buildNetworkSetupGuide(network = {}, tailscale = {}) {
  const cert = network?.cert ?? {};
  const port = Number(network?.bind?.port) || PORTS.API;
  const currentDnsName = getTailscaleCertHostname({
    mode: 'tailscale',
    hostname: tailscale?.dnsName,
  });
  const provisionedHost = typeof cert?.provisionedHost === 'string' && cert.provisionedHost
    ? cert.provisionedHost.replace(/\.$/, '').toLowerCase()
    : null;
  const accessHost = currentDnsName || provisionedHost;
  const installed = tailscale?.available === true;
  const running = tailscale?.running === true;
  const statusUnknown = tailscaleStatusUnknown(tailscale);
  const magicDnsReady = running && Boolean(currentDnsName);
  const trustedCertProvisioned = cert?.provisioned === true
    && cert?.provisionedMode === 'tailscale';
  const certMatchesCurrentHost = trustedCertProvisioned
    && Boolean(provisionedHost)
    && (!currentDnsName || provisionedHost === currentDnsName);
  const canActivate = certMatchesCurrentHost && magicDnsReady;
  const trustedHttpsActive = network?.httpsEnabled === true
    && cert?.mode === 'tailscale'
    && canActivate;
  const trustedUrl = trustedHttpsActive && accessHost
    ? `https://${accessHost}:${port}`
    : null;
  const pendingTrustedUrl = canActivate && accessHost
    ? `https://${accessHost}:${port}`
    : null;

  const writableCli = installed && tailscale?.sandboxed !== true;
  const canProvision = magicDnsReady && writableCli;

  const steps = [
    setupStep(
      'tailscale-install',
      'Install Tailscale',
      installed ? 'complete' : 'action',
      installed
        ? 'The Tailscale CLI is installed on this machine.'
        : 'Install Tailscale on the PortOS host so other devices can reach it privately.',
      installed ? null : { type: 'external', label: 'Install Tailscale', url: TAILSCALE_DOWNLOAD_URL },
    ),
    setupStep(
      'tailscale-connect',
      'Connect this machine',
      running ? 'complete' : installed && statusUnknown ? 'unknown' : installed ? 'action' : 'blocked',
      running
        ? 'This machine is connected to its tailnet.'
        : statusUnknown
          ? 'PortOS could not read Tailscale status. Open Tailscale and confirm this machine is connected.'
          : installed
            ? `Tailscale is ${tailscale?.state || 'not connected'}. Open the Tailscale app and sign in.`
            : 'Install Tailscale before connecting this machine.',
      installed && !running
        ? { type: 'external', label: 'Tailscale connection help', url: TAILSCALE_DOWNLOAD_URL }
        : null,
    ),
    setupStep(
      'magic-dns',
      'Enable MagicDNS',
      magicDnsReady ? 'complete' : running ? 'action' : 'blocked',
      magicDnsReady
        ? `MagicDNS assigned ${currentDnsName}.`
        : running
          ? 'Enable MagicDNS in the tailnet DNS admin so this machine gets a stable .ts.net name.'
          : 'Connect Tailscale before checking the MagicDNS name.',
      running && !magicDnsReady
        ? { type: 'external', label: 'Open Tailscale DNS admin', url: TAILSCALE_DNS_ADMIN_URL }
        : null,
    ),
    setupStep(
      'https-cert',
      'Provision a trusted HTTPS certificate',
      certMatchesCurrentHost
        ? 'complete'
        : canProvision || (magicDnsReady && tailscale?.sandboxed === true)
          ? 'action'
          : 'blocked',
      certMatchesCurrentHost
        ? `A Tailscale certificate is installed for ${provisionedHost}.`
        : tailscale?.sandboxed
          ? 'The macOS App Store CLI cannot write PortOS certificate files. Install the writable CLI with `brew install tailscale`, then retry.'
          : trustedCertProvisioned && currentDnsName && provisionedHost !== currentDnsName
            ? `The installed certificate is for ${provisionedHost}; reprovision it for ${currentDnsName}.`
            : canProvision
              ? 'Enable HTTPS Certificates in the Tailscale DNS admin, then let PortOS fetch the certificate automatically.'
              : 'Complete the Tailscale and MagicDNS steps first.',
      certMatchesCurrentHost
        ? null
        : magicDnsReady && tailscale?.sandboxed
        ? { type: 'command', label: 'Install writable CLI', command: 'brew install tailscale' }
        : canProvision && !certMatchesCurrentHost
          ? { type: 'provision-cert', label: 'Enable HTTPS', adminUrl: TAILSCALE_DNS_ADMIN_URL }
          : null,
    ),
    setupStep(
      'activate-https',
      'Launch PortOS on its trusted URL',
      trustedHttpsActive ? 'complete' : canActivate ? 'action' : 'blocked',
      trustedHttpsActive
        ? `PortOS is live at ${trustedUrl}.`
        : canActivate
          ? `Restart PortOS, then open ${pendingTrustedUrl}.`
          : certMatchesCurrentHost
            ? 'Connect Tailscale and confirm its current MagicDNS name before launching the trusted URL.'
            : 'Provision the trusted certificate before switching the listener to HTTPS.',
      canActivate && !trustedHttpsActive
        ? { type: 'restart', label: 'Restart PortOS', targetUrl: pendingTrustedUrl }
        : trustedHttpsActive
          ? { type: 'external', label: 'Open PortOS', url: trustedUrl }
          : null,
    ),
  ];

  const nextStep = trustedHttpsActive
    ? null
    : steps.find((step) => step.status === 'action')
      || steps.find((step) => step.status === 'unknown')
      || steps.find((step) => step.status !== 'complete')
      || null;

  return {
    complete: trustedHttpsActive,
    canProvision,
    dnsName: currentDnsName,
    trustedUrl,
    pendingTrustedUrl,
    nextStep,
    steps,
    summary: trustedHttpsActive
      ? `Trusted Tailscale HTTPS is active at ${trustedUrl}`
      : canActivate
        ? 'Trusted certificate installed — restart PortOS to activate HTTPS'
        : nextStep?.detail || 'Tailscale HTTPS setup is incomplete',
    urls: {
      download: TAILSCALE_DOWNLOAD_URL,
      dnsAdmin: TAILSCALE_DNS_ADMIN_URL,
    },
  };
}

/** Runtime snapshot plus the ordered setup guide consumed by API clients. */
export async function getNetworkExposureSetupStatus() {
  const [network, tailscale] = await Promise.all([
    Promise.resolve().then(() => getNetworkExposureStatus()),
    getTailscaleStatus(),
  ]);
  return {
    ...network,
    // Setup surfaces need the local daemon/MagicDNS facts, not the peer map or
    // peer IPs returned by `tailscale status`. Keep that separate for the
    // explicitly peer-oriented Instances endpoint.
    tailscale: {
      available: tailscale.available,
      running: tailscale.running,
      state: tailscale.state,
      reason: tailscale.reason,
      sandboxed: tailscale.sandboxed,
      dnsName: tailscale.dnsName,
    },
    setup: buildNetworkSetupGuide(network, tailscale),
  };
}
