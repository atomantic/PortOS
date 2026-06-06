import { describe, it, expect } from 'vitest';
import {
  DOMAIN_MODES,
  DEFAULT_DOMAIN_MODE,
  AUTONOMY_DOMAINS,
  DOMAIN_IDS,
  normalizeDomainAutonomy,
  getDomainMode
} from './domainAutonomy.js';

describe('domainAutonomy constants', () => {
  it('exposes the three modes with execute as default', () => {
    expect(DOMAIN_MODES).toEqual(['off', 'dry-run', 'execute']);
    expect(DEFAULT_DOMAIN_MODE).toBe('execute');
  });

  it('lists the four domains with unique ids', () => {
    expect(DOMAIN_IDS).toEqual(['brain', 'memory', 'cos', 'messages']);
    expect(new Set(DOMAIN_IDS).size).toBe(DOMAIN_IDS.length);
    for (const d of AUTONOMY_DOMAINS) {
      expect(d.id).toBeTruthy();
      expect(d.label).toBeTruthy();
      expect(d.description).toBeTruthy();
    }
  });
});

describe('normalizeDomainAutonomy', () => {
  it('fills every domain with execute when given an empty/garbage value', () => {
    for (const raw of [undefined, null, {}, [], 'nope', 42]) {
      const result = normalizeDomainAutonomy(raw);
      expect(Object.keys(result).sort()).toEqual([...DOMAIN_IDS].sort());
      for (const id of DOMAIN_IDS) expect(result[id]).toBe('execute');
    }
  });

  it('keeps valid modes and drops unknown keys', () => {
    const result = normalizeDomainAutonomy({ brain: 'off', memory: 'dry-run', bogus: 'execute' });
    expect(result.brain).toBe('off');
    expect(result.memory).toBe('dry-run');
    expect(result.cos).toBe('execute'); // unspecified → default
    expect(result.messages).toBe('execute');
    expect(result.bogus).toBeUndefined();
  });

  it('coerces invalid mode values to execute', () => {
    const result = normalizeDomainAutonomy({ brain: 'sometimes', cos: '' });
    expect(result.brain).toBe('execute');
    expect(result.cos).toBe('execute');
  });
});

describe('getDomainMode', () => {
  it('resolves execute for absent config / domainAutonomy', () => {
    expect(getDomainMode(undefined, 'brain')).toBe('execute');
    expect(getDomainMode(null, 'brain')).toBe('execute');
    expect(getDomainMode({}, 'brain')).toBe('execute');
    expect(getDomainMode({ domainAutonomy: {} }, 'brain')).toBe('execute');
  });

  it('reads a stored valid mode', () => {
    const config = { domainAutonomy: { brain: 'off', messages: 'dry-run' } };
    expect(getDomainMode(config, 'brain')).toBe('off');
    expect(getDomainMode(config, 'messages')).toBe('dry-run');
    expect(getDomainMode(config, 'cos')).toBe('execute');
  });

  it('falls back to execute for an invalid stored value', () => {
    expect(getDomainMode({ domainAutonomy: { brain: 'haywire' } }, 'brain')).toBe('execute');
  });
});
