/**
 * Is a peer reachable ONLY over the tailnet? — the browser's copy of the gate.
 *
 * `isTailnetPeer(peer)` — is this registered peer reachable ONLY over the tailnet? A faithful port of
 * `server/lib/tailnetPeer.js` (MagicDNS `.ts.net`, the 100.64.0.0/10 CGNAT range with every octet
 * range-checked, and the `fd7a:115c:a1e0::/48` ULA; an explicit non-tailnet `host` overrides a
 * tailnet-looking `address`). FAIL-CLOSED — anything not positively recognized is not tailnet. Used to
 * keep the unattended-render-routing picker from OFFERING a peer the server would refuse under ADR
 * [federated visual prompts](../../../docs/decisions/2026-08-20-federated-visual-prompts.md) rule 5;
 * the server stays authoritative and refuses such a route both on save and on every enqueue. Keep the
 * table in `tailnetPeer.test.js` identical to the server suite’s.
 *
 * A faithful port of `server/lib/tailnetPeer.js`, which stays authoritative:
 * the server refuses a standing route to a non-tailnet peer both when the route
 * is SAVED (`server/services/federatedMedia/routingPolicy.js`) and again on
 * every enqueue, per ADR `docs/decisions/2026-08-20-federated-visual-prompts.md`
 * rule 5. All this copy does is keep a picker from OFFERING a peer the server is
 * about to refuse, which is the difference between an explained absence and a
 * click that fails.
 *
 * It exists as its own module because it previously lived inline in one
 * component, where its CGNAT check quietly skipped the octet-range validation
 * the server does — so `100.64.999.1` read as tailnet in the browser and as
 * public space on the server. A port that diverges is worse than no port; this
 * module's test table is the server's, case for case, so a future edit to
 * either side fails loudly.
 *
 * FAIL-CLOSED: an address this cannot positively recognize as tailnet is
 * treated as NOT tailnet.
 */

// Tailscale's MagicDNS suffix.
const MAGIC_DNS = /\.ts\.net$/i;
// Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48.
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// 100.64.0.0/10 — the CGNAT range Tailscale assigns IPv4 addresses from. The
// second octet must be 64-127; 100.0.0.0/10 and 100.128.0.0/9 are ordinary
// public space and must NOT read as tailnet.
function isCgnatV4(address) {
  const match = address.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] >= 64 && octets[0] <= 127;
}

/**
 * @param {object} peer - Registered peer record (`host` and/or `address`).
 * @returns {boolean} True only when the peer is positively recognized as a
 *   tailnet host.
 */
export function isTailnetPeer(peer) {
  const host = trimmed(peer?.host);
  // An explicit host wins: it is what the server actually dials, so a
  // non-tailnet hostname is not rescued by a tailnet-looking `address`.
  if (host) return MAGIC_DNS.test(host);
  const address = trimmed(peer?.address);
  if (!address) return false;
  // Strip brackets from a literal IPv6 address (`[fd7a:…]`).
  const bare = address.replace(/^\[|\]$/g, '');
  return MAGIC_DNS.test(bare) || isCgnatV4(bare) || TAILSCALE_ULA.test(bare);
}
