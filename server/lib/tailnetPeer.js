/**
 * Is a peer reachable ONLY over the tailnet — as a security gate.
 *
 * This deliberately duplicates the shape of `peerRequiresTailscale()` in
 * `server/services/instances.js` instead of re-exporting it, because the two
 * answer different questions and must be free to diverge:
 *
 * - That one is an **availability heuristic** driving probe deferral ("don't
 *   spam DNS failures for a tailnet-only peer while Tailscale is down"). It is
 *   tuning, and a future polling-noise fix is entitled to loosen it.
 * - This one is a **security boundary**. ADR
 *   `docs/decisions/2026-08-20-federated-visual-prompts.md` (rule 5) requires an
 *   unattended standing route to refuse a peer that is not a tailnet host: a
 *   standing route exports every future prompt of its kind with nobody
 *   reviewing, so a misconfigured counterparty is a permanent leak rather than a
 *   one-time mistake. Authentication does not save it — the prompt rides the
 *   request body, so an impostor holding the connection reads it before failing
 *   to answer — and `peerFetch` sets `rejectUnauthorized: false`, so a plain-LAN
 *   or non-`.ts.net` peer gets no server authentication at all.
 *
 * Borrowing the heuristic would let a tuning change silently widen a privacy
 * boundary, which is precisely what that ADR ruled out.
 *
 * FAIL-CLOSED, and that is the other real difference: an address this cannot
 * positively recognize as tailnet is treated as NOT tailnet. The heuristic's
 * `false` means "probe it now" (harmless if wrong); this one's `false` means
 * "refuse to export prompts to it" (safe if wrong).
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
  // An explicit host wins: it is what `peerBaseUrl` actually dials, so a
  // non-tailnet hostname is not rescued by a tailnet-looking `address`.
  if (host) return MAGIC_DNS.test(host);
  const address = trimmed(peer?.address);
  if (!address) return false;
  // Strip brackets from a literal IPv6 address (`[fd7a:…]`).
  const bare = address.replace(/^\[|\]$/g, '');
  return MAGIC_DNS.test(bare) || isCgnatV4(bare) || TAILSCALE_ULA.test(bare);
}
