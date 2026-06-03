import { describe, it, expect } from 'vitest';
import {
  FEDERATION,
  reachabilityOpacity,
  statusColor,
  bridgeState,
  placePeer,
  computeFederationHorizon,
} from './cityFederation';

describe('reachabilityOpacity', () => {
  it('orders online > unknown > offline, all non-zero', () => {
    const online = reachabilityOpacity('online');
    const unknown = reachabilityOpacity('unknown');
    const offline = reachabilityOpacity('offline');
    expect(online).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(offline);
    expect(offline).toBeGreaterThan(0); // offline peers stay faintly visible
  });

  it('treats an unrecognised/missing status as unknown', () => {
    expect(reachabilityOpacity(undefined)).toBe(reachabilityOpacity('unknown'));
  });
});

describe('statusColor', () => {
  it('maps each status to its color', () => {
    expect(statusColor('online')).toBe(FEDERATION.onlineColor);
    expect(statusColor('offline')).toBe(FEDERATION.offlineColor);
    expect(statusColor('whatever')).toBe(FEDERATION.unknownColor);
  });
});

describe('bridgeState', () => {
  it('is active and unbroken when online and syncing', () => {
    const b = bridgeState({ status: 'online', syncEnabled: true });
    expect(b).toMatchObject({ active: true, broken: false });
    expect(b.intensity).toBe(1);
  });

  it('is broken when offline', () => {
    const b = bridgeState({ status: 'offline', syncEnabled: true });
    expect(b.active).toBe(false);
    expect(b.broken).toBe(true);
  });

  it('is broken when online but accumulating sync failures', () => {
    const b = bridgeState({ status: 'online', syncEnabled: true, consecutiveFailures: 3 });
    expect(b.broken).toBe(true);
  });

  it('is an idle (not active, not broken) link when online with sync disabled', () => {
    const b = bridgeState({ status: 'online', syncEnabled: false });
    expect(b.active).toBe(false);
    expect(b.broken).toBe(false);
    expect(b.intensity).toBe(0.5); // online but idle sits between active (1) and unreachable (0.2)
  });
});

describe('placePeer', () => {
  const peer = { id: 'peer-abc', name: 'studio', status: 'online', syncEnabled: true };

  it('is deterministic for the same peer id', () => {
    expect(placePeer(peer, 0)).toEqual(placePeer(peer, 5));
  });

  it('places the peer on the distant ring near the configured radius', () => {
    const { position } = placePeer(peer, 0);
    const r = Math.hypot(position[0], position[2]);
    expect(r).toBeGreaterThanOrEqual(FEDERATION.radius);
    expect(r).toBeLessThan(FEDERATION.radius + 11);
  });

  it('carries the peer color, opacity, and bridge derived from status', () => {
    const placed = placePeer(peer, 0);
    expect(placed.color).toBe(FEDERATION.onlineColor);
    expect(placed.opacity).toBe(reachabilityOpacity('online'));
    expect(placed.bridge.active).toBe(true);
    expect(placed.online).toBe(true);
  });

  it('gives distinct peers distinct angles', () => {
    const a = placePeer({ id: 'aaa' }, 0);
    const b = placePeer({ id: 'zzz' }, 1);
    expect(a.angle).not.toBeCloseTo(b.angle, 3);
  });

  it('falls back to a stable label and unknown status for a bare peer', () => {
    const placed = placePeer({ id: 'x' }, 2);
    expect(placed.name).toBe('peer');
    expect(placed.status).toBe('unknown');
    expect(placed.color).toBe(FEDERATION.unknownColor);
  });
});

describe('computeFederationHorizon', () => {
  it('always returns a void marker, even with no peers', () => {
    expect(computeFederationHorizon([]).voidMarker.id).toBe('void-machine');
    expect(computeFederationHorizon(undefined).voidMarker.id).toBe('void-machine');
    expect(computeFederationHorizon([]).peers).toEqual([]);
  });

  it('places the void marker behind downtown beyond the ring', () => {
    const { voidMarker } = computeFederationHorizon([], { radius: 50 });
    expect(voidMarker.position).toEqual([0, 0, -56]);
  });

  it('returns one placement per peer', () => {
    const peers = [{ id: 'a', status: 'online' }, { id: 'b', status: 'offline' }];
    const { peers: placed } = computeFederationHorizon(peers);
    expect(placed).toHaveLength(2);
    expect(placed.map(p => p.id)).toEqual(['a', 'b']);
  });
});
