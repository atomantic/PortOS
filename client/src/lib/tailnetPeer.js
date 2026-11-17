/**
 * Is a peer reachable ONLY over the tailnet? The browser's copy of the server gate (`server/lib/tailnetPeer.js`).
 *
 * `isTailnetPeer(peer)` is a faithful port of `server/lib/tailnetPeer.js`, which stays authoritative (MagicDNS `.ts.net`, the 100.64.0.0/10 CGNAT range with every octet range-checked, the `fd7a:115c:a1e0::/48` ULA; an explicit non-tailnet `host` overrides a tailnet-looking `address`).
 * FAIL-CLOSED: anything not positively recognized is not tailnet. It only keeps the unattended-render-routing picker from OFFERING a peer the server refuses (on save in `server/services/federatedMedia/routingPolicy.js` and on every enqueue; ADR `docs/decisions/2026-08-20-federated-visual-prompts.md` rule 5).
 * It is its own module because an inline copy skipped the octet-range validation (`100.64.999.1` read as tailnet in the browser, public on the server); keep the table in `tailnetPeer.test.js` identical to the server suite's so either side's edit fails loudly.
 */

// Tailscale's MagicDNS suffix.
const MAGIC_DNS = /\.ts\.net$/i;
// Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48.
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// 100.64.0.0/10, the CGNAT range Tailscale assigns from: the second octet must be 64-127 (100.0.0.0/10 and 100.128.0.0/9 are public space).
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
  // An explicit host wins: it is what the server dials, so a non-tailnet hostname isn't rescued by a tailnet-looking `address`.
  if (host) return MAGIC_DNS.test(host);
  const address = trimmed(peer?.address);
  if (!address) return false;
  // Strip brackets from a literal IPv6 address (`[fd7a:…]`).
  const bare = address.replace(/^\[|\]$/g, '');
  return MAGIC_DNS.test(bare) || isCgnatV4(bare) || TAILSCALE_ULA.test(bare);
}
