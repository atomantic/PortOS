import { describe, it, expect } from 'vitest';
import { ALWAYS_PUBLIC_API_PATHS, isAlwaysPublicApiPath, isPeerApiRequestAllowed, isPeerBasicBootstrapRequest } from './apiAccessPolicy.js';

describe('peer API surface (#8387)', () => {
  it('matches only the exact always-public API paths', () => {
    for (const path of ALWAYS_PUBLIC_API_PATHS) {
      expect(isAlwaysPublicApiPath(path), path).toBe(true);
    }

    for (const path of [
      '/api/auth/status-extra',
      '/api/auth/status/',
      '/api/system/health/details',
      '/api/system/health/warnings/x/dismiss',
      '/api/eidoverse/travel/guest/x',
    ]) {
      expect(isAlwaysPublicApiPath(path), path).toBe(false);
    }
  });

  it('scopes methods, exact paths, and prefixes', () => {
    expect(isPeerApiRequestAllowed('POST', '/api/peer-sync/push')).toBe(true);
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/manifest')).toBe(true);
    expect(isPeerApiRequestAllowed('HEAD', '/data/images/example.png')).toBe(true);
    expect(isPeerApiRequestAllowed('GET', '/api/usage/native-matrix')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/api/apps/')).toBe(true);
    // Operator mutations beside allowed reads stay closed.
    expect(isPeerApiRequestAllowed('POST', '/api/peer-sync/sync-now')).toBe(false);
    // The integrity diagnostic bypasses per-peer sharing config, so peers never reach it.
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/integrity')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/record')).toBe(true);
    expect(isPeerApiRequestAllowed('POST', '/api/instances/peers/pair-secret')).toBe(false);
    expect(isPeerBasicBootstrapRequest('POST', '/api/instances/peers/pair-secret')).toBe(true);
    expect(isPeerBasicBootstrapRequest('GET', '/api/instances/peers/pair-secret')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/sync/brain/apply')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/apps/example-app/restart')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/api/apps/example-app')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/cos/tasks')).toBe(false);
    expect(isPeerApiRequestAllowed('PUT', '/api/settings')).toBe(false);
    expect(isPeerApiRequestAllowed('POST', '/api/providers/fleet-host/stop')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/data/voice-profiles/example.wav')).toBe(false);
    // A prefix rule never matches the bare prefix or a lookalike sibling.
    expect(isPeerApiRequestAllowed('GET', '/api/peer-sync/')).toBe(false);
    expect(isPeerApiRequestAllowed('GET', '/data/images-private/example.png')).toBe(false);
  });

  it('refuses dot, empty, and encoded separator segments', () => {
    for (const path of [
      '/api/peer-sync/../commands/execute',
      '/api/peer-sync/./manifest',
      '/api/peer-sync//manifest',
      '/data/images/%2e%2e/secret.json',
      '/data/images/a%2fb.png',
      '/data/images/a%5cb.png',
      '/data/images/a\\b.png',
      '/data/images/..',
    ]) {
      expect(isPeerApiRequestAllowed('GET', path)).toBe(false);
    }
  });
});
