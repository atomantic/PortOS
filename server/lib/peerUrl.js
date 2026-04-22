/**
 * Build the base URL for a peer.
 *
 * If `peer.host` is set, uses HTTPS with that DNS name (assumes a real cert —
 * e.g. a Tailscale-issued Let's Encrypt cert for `<host>.<tailnet>.ts.net`).
 * Otherwise falls back to plain HTTP on the peer's IP address.
 */
export function peerBaseUrl(peer) {
  if (peer.host) return `https://${peer.host}:${peer.port}`;
  return `http://${peer.address}:${peer.port}`;
}
