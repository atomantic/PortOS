/**
 * uuid v4 that also works on insecure origins.
 *
 * `crypto.randomUUID` only exists in a SECURE context (HTTPS / localhost).
 * PortOS is commonly reached over plain HTTP via Tailscale, where it is
 * undefined — so a bare `crypto.randomUUID()` throws `crypto.randomUUID is not
 * a function` for exactly the users on the app's most common deployment.
 * `crypto.getRandomValues` IS available on insecure origins, so derive a
 * spec-valid v4 from it (callers that hand the id to a Zod `.uuid()` route
 * depend on it being spec-valid); Math.random is the last-ditch fallback.
 *
 * Use this instead of calling `crypto.randomUUID()` directly.
 */

/** @returns {string} A spec-valid v4 uuid. */
export function uuidv4() {
  // `globalThis.crypto` rather than bare `crypto`: bare `crypto?.…` throws
  // ReferenceError in some non-secure-context envs, where going through
  // globalThis short-circuits cleanly. The `typeof` check on the RESULT (not
  // just on the method) also covers a stubbed randomUUID that returns nothing.
  const native = globalThis.crypto?.randomUUID?.();
  if (typeof native === 'string') return native;

  const b = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10

  // Slice a single hex string rather than interpolating 16 indexed bytes — the
  // indexed form invites a silent mis-index (a repeated `h[1]`) that still
  // produces a well-formed, unique-looking uuid, so no test would catch it.
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
