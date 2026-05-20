// Browser secure-context rule mirrored client-side: getUserMedia (and other
// powerful APIs) are gated on the page origin being HTTPS, localhost, or a
// loopback IP (127.0.0.0/8, ::1, [::1]) — anything else (Tailscale IP, LAN
// IP, plain hostname over HTTP) silently fails. Server-side we know the
// scheme + bind, but only the browser knows which of those origins it
// actually loaded from.
//
// Server-side counterpart: server/lib/networkExposure.js exports its own
// `isLoopbackHost` for bind-audience classification. The client copy lives
// here so secure-context callers (mic, clipboard heuristics, future voice
// surfaces) can share one rule instead of re-declaring inline sets.
//
// Browsers report IPv6 `window.location.hostname` with brackets (`[::1]`)
// while the bare-form `::1` shows up in env-style configs; accept both so
// the heuristic doesn't false-negative on `http://[::1]:5555`.
//
// IPv4: match the full 127.0.0.0/8 range, not just `127.0.0.1`. The kernel
// routes every 127.x.x.x address to lo0 and browsers treat the whole block
// as a Secure Context per the spec.

const LOOPBACK_HOSTS = new Set(['localhost', '::1', '[::1]']);
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

export function isLoopbackHost(host) {
  if (typeof host !== 'string' || !host) return false;
  const normalized = host.toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  return IPV4_LOOPBACK.test(normalized);
}

export function isLoopbackOrigin() {
  if (typeof window === 'undefined' || !window.location) return false;
  return isLoopbackHost(window.location.hostname);
}

export function describeMicAvailability() {
  if (typeof window === 'undefined' || !window.location) {
    return { available: true, reason: 'unknown' };
  }
  if (window.location.protocol === 'https:') {
    return { available: true, reason: 'https' };
  }
  if (isLoopbackOrigin()) {
    return { available: true, reason: 'loopback' };
  }
  return { available: false, reason: 'insecure-context' };
}
