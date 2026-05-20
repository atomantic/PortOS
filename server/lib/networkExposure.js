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
import { getHttpsEnabledAtBoot } from './httpsState.js';
import { getSelfHost } from './peerSelfHost.js';
import { readCertMeta } from './certMeta.js';

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

  const meta = readCertMeta();
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
    },
    docsUrl: PORTS_DOCS_URL,
  };
}
