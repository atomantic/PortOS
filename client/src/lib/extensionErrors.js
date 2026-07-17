/**
 * Browser-extension error detection — client mirror of
 * server/lib/extensionErrors.js, which is authoritative and carries the
 * rationale (why provenance-first, why the message list stays short, why both
 * ends filter). Port logic changes verbatim; parity is enforced by
 * server/lib/extensionErrors.mirror.test.js.
 */

// NOTE: no `g` flag — `.test()` on a /g/ regex is stateful via lastIndex.
const EXTENSION_SCHEME_RE = /(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|opera-extension|webkit-masked-url):\/\/|\bextensions::/i;

const EXTENSION_MESSAGE_RE = [
  /\bMetaMask\b/i,
];

/**
 * True when an error report originated from a browser extension rather than
 * PortOS itself. Checks `source` / `stack` / `message`; never `url` (the page
 * location is ours even when an extension throws on top of it).
 */
export function isExtensionError(payload) {
  if (!payload || typeof payload !== 'object') return false;

  const str = (v) => (typeof v === 'string' ? v : '');
  const source = str(payload.source);
  const stack = str(payload.stack);
  const message = str(payload.message);

  if (EXTENSION_SCHEME_RE.test(source)) return true;
  if (EXTENSION_SCHEME_RE.test(stack)) return true;
  if (EXTENSION_SCHEME_RE.test(message)) return true;

  return EXTENSION_MESSAGE_RE.some(re => re.test(message));
}
