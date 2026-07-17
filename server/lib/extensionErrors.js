/**
 * Browser-extension error detection.
 *
 * Content scripts injected by extensions (wallets, password managers, ad
 * blockers) run in the page's realm, so anything they throw surfaces through
 * OUR `window.onerror` / `unhandledrejection` handlers and lands in the Review
 * Hub as an actionable alert. Those errors are not in the app's control and
 * are not actionable — a user cannot fix MetaMask by changing PortOS.
 *
 * Beyond noise, they actively displace real errors: both the client reporter
 * and the server aggregator gate on a 1/sec throttle, so an extension error
 * accepted at T causes a genuine PortOS error at T+500ms to be dropped as
 * `rate-limited` and lost. That is why both ends check this BEFORE their
 * throttle gate rather than filtering at the Review Hub on read.
 *
 * Detection is provenance-first: an extension URL scheme in the script source
 * or the stack is proof the frame is not ours. Message matching is the
 * fallback for stackless rejections (`reject('Failed to connect to MetaMask')`
 * carries no frames at all) and is deliberately kept to a short list of
 * vendor/runtime strings PortOS provably never emits — a message pattern is a
 * blunt instrument that can hide a real bug, so each addition must be verified
 * absent from our own source first.
 *
 * This module is MIRRORED at client/src/lib/extensionErrors.js. This server
 * copy is authoritative; parity is enforced by extensionErrors.mirror.test.js.
 */

// URL schemes an injected content script can run from. Provenance beats
// message matching: if a frame's script lives at one of these, it is not ours.
// NOTE: no `g` flag — `.test()` on a /g/ regex is stateful via lastIndex and
// would alternate true/false across calls.
const EXTENSION_SCHEME_RE = /(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|opera-extension|webkit-masked-url):\/\/|\bextensions::/i;

// Fallback for extension errors that arrive with NO usable stack, where
// provenance has nothing to match on. Every entry is a permanent, silent
// drop rule, so the bar is deliberately high — add one only when:
//   1. an actual observed error escaped the provenance check above, AND
//   2. the string is absent from our own source (grep before adding).
// The failure modes are asymmetric: an extension error we miss is mild noise
// the user can dismiss, while an over-broad pattern hides a real bug forever.
// When in doubt, leave it out and let provenance do the work.
const EXTENSION_MESSAGE_RE = [
  // Injected wallet providers reject with a bare string ("Failed to connect to
  // MetaMask"), which carries no frames. PortOS has no crypto/wallet code at
  // all, so any mention of one is the extension talking.
  /\bMetaMask\b/i,
];

/**
 * True when an error report originated from a browser extension rather than
 * PortOS itself.
 *
 * Checks `source` (the script URL), `stack`, and `message`. Deliberately does
 * NOT check `url` — that is the *page* location (`window.location.href`),
 * which is always ours even when an extension throws on top of it.
 *
 * Safe to call on a raw, unsanitized payload; every field is treated as
 * untrusted and non-string values are ignored.
 */
export function isExtensionError(payload) {
  if (!payload || typeof payload !== 'object') return false;

  const str = (v) => (typeof v === 'string' ? v : '');
  const source = str(payload.source);
  const stack = str(payload.stack);
  const message = str(payload.message);

  // Provenance: an extension scheme anywhere in the script URL or the stack.
  // The message is checked too — a failed dynamic import or fetch names the
  // offending extension URL in its message with no stack attached.
  if (EXTENSION_SCHEME_RE.test(source)) return true;
  if (EXTENSION_SCHEME_RE.test(stack)) return true;
  if (EXTENSION_SCHEME_RE.test(message)) return true;

  return EXTENSION_MESSAGE_RE.some(re => re.test(message));
}
