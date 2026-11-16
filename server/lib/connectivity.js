/**
 * Internet-reachability probe over bare TCP connects, never rejecting: `isMachineOnline` and `isPortReachable`.
 *
 * `isMachineOnline({timeoutMs?, hosts?})`: bare TCP `connect` to public
 * anycast resolvers on :443 (no DNS, no HTTP), resolves `true` on the first connect and `false` only
 * after all fail; never rejects. Reuse when a caller needs a best-effort local reachability signal.
 * Also `isPortReachable({host?, port, timeoutMs?})` — the same connect primitive aimed at ONE address,
 * for "is anything listening there yet?"; use it rather than a bind probe whenever another process is
 * expected to own the port, since a bind probe can win the race and kill that process with
 * `EADDRINUSE`.
 *
 * Deliberately NOT a DNS lookup (IPs are dialed directly so a broken resolver
 * can't read as an outage) and NOT HTTP/TLS. It never rejects: callers use it as
 * a gate and a failed probe proves nothing.
 *
 * Assumes normal outbound egress: in a proxy-only network blocking both anycast
 * IPs, an online machine reads as offline, so treat `false` as indeterminate.
 */

import net from 'net';

// Two independent resolvers so one blocked IP doesn't read as an outage.
export const DEFAULT_PROBE_HOSTS = [
  { host: '1.1.1.1', port: 443 }, // Cloudflare
  { host: '8.8.8.8', port: 443 }, // Google
];

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;
export const DEFAULT_PORT_PROBE_TIMEOUT_MS = 500;

// Resolve on connect; reject on error/timeout. The socket timeout guarantees a terminal
// event even if the caller abandons the promise, so no path leaks a socket/fd.
function probeHost({ host, port }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      ok ? resolve() : reject(new Error('unreachable'));
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * `true` as soon as ANY host connects; `false` only after every probe fails. Never rejects.
 * @param {{ timeoutMs?: number, hosts?: Array<{host:string,port:number}> }} [opts]
 * @returns {Promise<boolean>}
 */
export function isMachineOnline({ timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, hosts = DEFAULT_PROBE_HOSTS } = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) return Promise.resolve(false);
  // Promise.any rejects (AggregateError) only when every probe fails; the handler swallows it.
  return Promise.any(hosts.map((h) => probeHost(h, timeoutMs))).then(() => true, () => false);
}

/**
 * Is anything listening on `host:port`? Never rejects. Prefer this over a *bind*
 * probe when another process should own the port: a bind can win the race and
 * make that process die with `EADDRINUSE`.
 */
export function isPortReachable({ host = '127.0.0.1', port, timeoutMs = DEFAULT_PORT_PROBE_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return probeHost({ host, port }, timeoutMs).then(() => true, () => false);
}
