// Pure, deterministic helpers for CyberCity's "federation horizon": placing sync
// peers as distant skyline silhouettes and deriving their reachability (opacity)
// and sync-bridge state from real instance data. A void marker is always present
// so the horizon stays meaningful even on a single-instance install. No three.js
// / React imports so the topology is unit-testable (mirrors cityFlowLines.js).

import { hashString } from './hashString';

export const FEDERATION = {
  radius: 76, // distant ring, beyond CitySkyline (~55–70) so peers read as far cities
  bridgeReach: 16, // how far the sync bridge stretches inward from a peer toward the city
  onlineColor: '#8b5cf6', // violet — matches the existing INSTANCE MESH beacon
  offlineColor: '#ef4444',
  unknownColor: '#64748b', // slate — also the void marker's color
};

// Silhouette opacity by reachability. Online peers read clearly; unknown/unprobed
// are dim; offline are barely visible — but never zero, so the horizon never goes
// empty when a peer drops.
export function reachabilityOpacity(status) {
  if (status === 'online') return 0.55;
  if (status === 'offline') return 0.18;
  return 0.3; // unknown / not yet probed
}

export function statusColor(status) {
  if (status === 'online') return FEDERATION.onlineColor;
  if (status === 'offline') return FEDERATION.offlineColor;
  return FEDERATION.unknownColor;
}

// The sync "bridge" between this install and a peer. It's `active` (solid, bright)
// only when the peer is online AND sync is enabled; `broken` (dashed) when the
// peer is offline or has recent sync failures; otherwise a faint idle link.
export function bridgeState(peer) {
  const online = peer?.status === 'online';
  const failing = peer?.status === 'offline' || (peer?.consecutiveFailures || 0) > 0;
  const active = online && !!peer?.syncEnabled;
  return {
    active,
    broken: failing,
    intensity: active ? 1 : online ? 0.5 : 0.2,
  };
}

// Place one peer on the distant ring. Angle/height/width are derived from a stable
// hash of the peer id, so a peer keeps its spot (and shape) across reloads and is
// independent of its position in the list.
export function placePeer(peer, index, { radius = FEDERATION.radius } = {}) {
  const seed = hashString(peer?.id || peer?.name || peer?.address || `peer-${index}`);
  const angle = ((seed % 3600) / 3600) * Math.PI * 2;
  const r = radius + (seed % 11); // slight depth variation across the ring
  return {
    id: peer?.id || `peer-${index}`,
    name: peer?.name || peer?.host || peer?.address || 'peer',
    status: peer?.status || 'unknown',
    online: peer?.status === 'online',
    angle,
    position: [Math.cos(angle) * r, 0, Math.sin(angle) * r],
    height: 18 + (seed % 14), // taller than the faint skyline so peers stand out
    width: 3 + (seed % 3),
    opacity: reachabilityOpacity(peer?.status),
    color: statusColor(peer?.status),
    bridge: bridgeState(peer),
  };
}

// Build the full horizon: a placement per peer plus a fixed "void machine" marker
// (the reserved zone for the remote primary instance) that is always rendered, so
// the federation horizon is visible even with zero peers.
export function computeFederationHorizon(peers, opts = {}) {
  const radius = opts.radius ?? FEDERATION.radius;
  const placed = (peers || []).map((peer, i) => placePeer(peer, i, { radius }));
  const voidMarker = {
    id: 'void-machine',
    position: [0, 0, -(radius + 6)],
    height: 28,
    width: 6,
    color: FEDERATION.unknownColor,
    opacity: 0.22,
  };
  return { peers: placed, voidMarker };
}
