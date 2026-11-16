// `isLoopbackHost(host)` / `isLoopbackOrigin()` / `describeMicAvailability()` — Secure Context /
// loopback-origin heuristics.
//
// Use these in any new mic, clipboard, or `getUserMedia`-gated surface; matches the full `127.0.0.0/8`
// range, IPv6 `::1`, and the browser-bracketed `[::1]` form.
//
// Browser secure-context rule mirrored client-side: getUserMedia (and other powerful APIs) are gated on the origin being HTTPS, localhost or a loopback IP (127.0.0.0/8, ::1, [::1]); anything else (Tailscale IP, LAN IP, plain hostname over HTTP) silently fails, and only the browser knows which origin it loaded from. Server-side counterpart: `isLoopbackHost` in server/lib/networkExposure.js (bind-audience classification); the client copy lets secure-context callers share one rule.
// Browsers report IPv6 `window.location.hostname` bracketed (`[::1]`) while env-style configs use bare `::1`; accept both so `http://[::1]:5555` doesn't false-negative. IPv4: match the full 127.0.0.0/8 range (the kernel routes every 127.x.x.x to lo0 and browsers treat the block as a Secure Context per spec).

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
