import { describe, it, expect } from 'vitest';
import {
  defaultLayeredIntelligenceConfig,
  getEffectiveConfig,
  isScopeAllowed,
} from './config.js';
import {
  PORTOS_ONLY_SCOPES,
} from './constants.js';

describe('defaultLayeredIntelligenceConfig', () => {
  it('is off by default with the app-owned sources on', () => {
    const c = defaultLayeredIntelligenceConfig(false);
    expect(c.enabled).toBe(false);
    expect(c.sources.goals).toBe(true);
    expect(c.sources.appMetrics).toBe(true); // the app's own performance metrics
    expect(c.sources.custom).toEqual([]);
  });

  it('caps non-PortOS apps at app scopes only', () => {
    const c = defaultLayeredIntelligenceConfig(false);
    expect(c.allowedScopes).toEqual(['app-improvement', 'app-data-gap']);
    expect(c.allowedScopes).not.toContain('loop-meta');
    expect(c.allowedScopes).not.toContain('portos-self');
  });

  it('grants PortOS the meta/self scopes', () => {
    const c = defaultLayeredIntelligenceConfig(true);
    expect(c.allowedScopes).toContain('loop-meta');
    expect(c.allowedScopes).toContain('portos-self');
  });

  it('ships the Engine-A hand-off off by default', () => {
    expect(defaultLayeredIntelligenceConfig(false).handoff).toEqual({ enabled: false });
    expect(defaultLayeredIntelligenceConfig(true).handoff).toEqual({ enabled: false });
  });

  it('defaults the outcomes feedback source on for PortOS, off for managed apps', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.outcomes).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.outcomes).toBe(true);
  });

  it('defaults the selfEval source on for PortOS, off for managed apps (#2700)', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.selfEval).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.selfEval).toBe(true);
  });

  it('defaults cosMetrics on for PortOS, off for managed apps (it is a PortOS-side agent-perf metric)', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.cosMetrics).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.cosMetrics).toBe(true);
  });

  it('defaults the appMetrics (own-performance) source on for every app', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.appMetrics).toBe(true);
    expect(defaultLayeredIntelligenceConfig(true).sources.appMetrics).toBe(true);
  });

  it('defaults PortOS product-engagement metrics on only for the PortOS app', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.productMetrics).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.productMetrics).toBe(true);
  });
});

describe('getEffectiveConfig', () => {
  it('returns defaults for an app with no stored config', () => {
    expect(getEffectiveConfig({ name: 'X' })).toEqual(defaultLayeredIntelligenceConfig(false));
  });

  it('merges sources one level deep (partial toggle does not wipe others)', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { sources: { goals: false } } });
    expect(c.sources.goals).toBe(false);
    expect(c.sources.appMetrics).toBe(true); // untouched default preserved
    expect(c.sources.planMd).toBe(true);
  });

  it('uses PortOS scopes when isPortos is set and none stored', () => {
    const c = getEffectiveConfig({ isPortos: true });
    expect(c.allowedScopes).toContain('portos-self');
  });

  it('honors a stored allowedScopes override', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { allowedScopes: ['app-improvement'] } });
    expect(c.allowedScopes).toEqual(['app-improvement']);
  });

  it('repairs a non-array custom / allowedScopes', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { sources: { custom: 'bad' }, allowedScopes: 'nope' } });
    expect(c.sources.custom).toEqual([]);
    expect(Array.isArray(c.allowedScopes)).toBe(true);
  });

  it('merges handoff one level deep (partial does not wipe default enabled)', () => {
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: {} } }).handoff).toEqual({ enabled: false });
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: { enabled: true } } }).handoff).toEqual({ enabled: true });
    // A junk (non-object) handoff falls back to the default.
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: 'nope' } }).handoff).toEqual({ enabled: false });
  });
});

describe('isScopeAllowed (scope-gating)', () => {
  const allowedPortos = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];
  const allowedApp = ['app-improvement', 'app-data-gap'];

  it('allows an in-list app scope on a normal app', () => {
    expect(isScopeAllowed({ scope: 'app-improvement', allowedScopes: allowedApp, isPortos: false })).toBe(true);
  });

  it('rejects an unrecognized scope', () => {
    expect(isScopeAllowed({ scope: 'delete-everything', allowedScopes: allowedPortos, isPortos: true })).toBe(false);
  });

  it('rejects meta/self scopes on a non-PortOS app even if allowedScopes lists them', () => {
    for (const scope of PORTOS_ONLY_SCOPES) {
      // A hand-edited config that lists loop-meta on someone else's app must still be blocked.
      expect(isScopeAllowed({ scope, allowedScopes: allowedPortos, isPortos: false })).toBe(false);
    }
  });

  it('allows meta/self scopes only on PortOS', () => {
    for (const scope of PORTOS_ONLY_SCOPES) {
      expect(isScopeAllowed({ scope, allowedScopes: allowedPortos, isPortos: true })).toBe(true);
    }
  });

  it('rejects a scope not in allowedScopes', () => {
    expect(isScopeAllowed({ scope: 'app-data-gap', allowedScopes: ['app-improvement'], isPortos: false })).toBe(false);
  });
});
