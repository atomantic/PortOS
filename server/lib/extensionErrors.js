/**
 * Browser-extension error detection.
 *
 * `isExtensionError(payload)` — true when a client error report came from an extension's
 * injected content script rather than PortOS. Both client and server check it BEFORE their
 * 1/sec throttle, since extension noise would displace real errors. Provenance-first;
 * message matching only backstops stackless rejections. A pure leaf re-exported by
 * `client/src/lib/extensionErrors.js`: import no Node built-in and nothing outside `server/lib`.
 */

// URL schemes an injected content script can run from. No `g` flag: `.test()` on a /g/
// regex is stateful via lastIndex and would alternate true/false.
const EXTENSION_SCHEME_RE = /(?:chrome-extension|moz-extension|safari-extension|safari-web-extension|ms-browser-extension|opera-extension|webkit-masked-url):\/\/|\bextensions::/i;

// Fallback for stackless extension errors. Every entry is a permanent silent drop: add
// one only for an observed escape whose string is absent from our own source.
const EXTENSION_MESSAGE_RE = [
  // Injected wallet providers reject with a bare string; PortOS has no wallet code.
  /\bMetaMask\b/i,
];

/**
 * The originating (top) frame of a stack, the throw site. Only this frame proves
 * provenance: an extension that wraps our code (a patched `fetch`) leaves its frames
 * BELOW ours, and matching any frame would silently drop a genuine PortOS error forever.
 * Handles V8 (`at fn (url)`) and Firefox/Safari (`fn@url`) stacks.
 */
function originatingFrame(stack) {
  for (const raw of stack.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^at\s/.test(line) || line.includes('@')) return line;
  }
  return '';
}

/** True when a report came from a browser extension; checks source, originating frame and message, not `url` (the page, always ours). Non-string fields are ignored. */
export function isExtensionError(payload) {
  if (!payload || typeof payload !== 'object') return false;

  const str = (v) => (typeof v === 'string' ? v : '');
  const source = str(payload.source);
  const stack = str(payload.stack);
  const message = str(payload.message);

  // `source` is already the originating script.
  if (EXTENSION_SCHEME_RE.test(source)) return true;
  if (EXTENSION_SCHEME_RE.test(originatingFrame(stack))) return true;
  // A failed dynamic import/fetch names the extension URL in its message, no stack.
  if (EXTENSION_SCHEME_RE.test(message)) return true;

  return EXTENSION_MESSAGE_RE.some(re => re.test(message));
}
