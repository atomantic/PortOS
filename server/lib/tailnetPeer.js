/**
 * `isTailnetPeer(peer)`: fail-closed security predicate for "is this peer reachable ONLY over the tailnet", required by the unattended-routing gate in ADR 2026-08-20-federated-visual-prompts.
 *
 * Deliberately duplicates the shape of `peerRequiresTailscale()` (`server/services/instances.js`) instead of re-exporting it: that one is an **availability heuristic** driving probe deferral ("don't spam DNS failures for a tailnet-only peer while Tailscale is down"), which a polling-noise fix may loosen;
 * this one is a **security boundary**: ADR `docs/decisions/2026-08-20-federated-visual-prompts.md` (rule 5) requires an unattended standing route to refuse a non-tailnet peer, since it exports every future prompt of its kind with nobody reviewing (a misconfigured counterparty is a permanent leak) and authentication doesn't save it (the prompt rides the request body, and `peerFetch`
 * sets `rejectUnauthorized: false`, so a plain-LAN or non-`.ts.net` peer gets no server authentication). Borrowing the heuristic would let a tuning change silently widen a privacy boundary.
 * FAIL-CLOSED: an address not positively recognized as tailnet is NOT tailnet (the heuristic's `false` means "probe it now", harmless if wrong; this `false` means "refuse to export prompts", safe if wrong).
 */

// Tailscale's MagicDNS suffix.
const MAGIC_DNS = /\.ts\.net$/i;
// Tailscale's IPv6 ULA prefix, fd7a:115c:a1e0::/48.
const TAILSCALE_ULA = /^fd7a:115c:a1e0:/i;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

// 100.64.0.0/10, the CGNAT range Tailscale assigns IPv4 from: the second octet must be 64-127 (100.0.0.0/10 and 100.128.0.0/9 are ordinary public space).
function isCgnatV4(address) {
  const match = address.match(/^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] >= 64 && octets[0] <= 127;
}

/**
 *
 * @param {object} peer - Registered peer record (`host` and/or `address`).
 * @returns {boolean} True only when the peer is positively recognized as a
 *   tailnet host.
 */
export function isTailnetPeer(peer) {
  const host = trimmed(peer?.host);
  // An explicit host wins: it is what `peerBaseUrl` dials, so a non-tailnet hostname isn't rescued by a tailnet-looking `address`.
  if (host) return MAGIC_DNS.test(host);
  const address = trimmed(peer?.address);
  if (!address) return false;
  const bare = address.replace(/^\[|\]$/g, '');
  return MAGIC_DNS.test(bare) || isCgnatV4(bare) || TAILSCALE_ULA.test(bare);
}
