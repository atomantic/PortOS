/**
 * uuid v4 that also works on insecure origins.
 *
 * `uuidv4()` is a spec-valid v4 uuid for **insecure origins**: `crypto.randomUUID()` only exists in a secure context (HTTPS / localhost) and throws for the many users who reach PortOS over plain HTTP via Tailscale.
 * Falls back to `crypto.getRandomValues` (available on insecure origins; callers handing the id to a Zod `.uuid()` route need it spec-valid), then `Math.random`. Use this instead of `crypto.randomUUID()` directly.
 */

/** @returns {string} A spec-valid v4 uuid. */
export function uuidv4() {
  // `globalThis.crypto` rather than bare `crypto`, which throws ReferenceError in some non-secure-context envs; the `typeof` check on the RESULT also covers a stubbed randomUUID that returns nothing.
  const native = globalThis.crypto?.randomUUID?.();
  if (typeof native === 'string') return native;

  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10

  // Slice a single hex string rather than interpolating 16 indexed bytes: the indexed form invites a silent mis-index (a repeated `h[1]`) that still yields a unique-looking uuid no test would catch.
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
