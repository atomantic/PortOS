/**
 * This is a privacy boundary, so the regressions worth pinning are the ones
 * that would let something through: a leak reachable only through an object
 * KEY, a credential a value-shape scan cannot see, and the address families
 * the two older redaction tables in the tree already cover.
 */
import { describe, expect, it } from 'vitest';
import { federationSafetyFindings } from './federationSafety.js';

const codesFor = (value) => federationSafetyFindings(value).map((finding) => finding.code);

describe('federationSafetyFindings', () => {
  it('finds machine identity, network info and PII at any depth, naming the path', () => {
    const findings = federationSafetyFindings({
      install: { root: '/Users/exampleuser/portos', windows: 'C:\\Users\\exampleuser\\portos' },
      network: ['192.0.2.10', 'fe80::1ff:fe23:4567:890a', 'de:ad:be:ef:00:11', 'host-xxxx.ts.net'],
      owner: 'alice@example.com',
      reach: 'call +1 555 010 4477',
      where: 'latitude: 37.4219',
    });

    expect(new Set(findings.map((f) => f.code))).toEqual(new Set([
      'home-path', 'windows-path', 'ip-literal', 'mac-address', 'network-host', 'email-address', 'phone-number', 'gps-coordinate',
    ]));
    expect(findings.find((f) => f.code === 'home-path').path).toBe('install.root');
    expect(findings.find((f) => f.code === 'network-host').path).toBe('network.3');
  });

  it('scans object KEYS, not only values', () => {
    // A field NAMED for a host leaks the host exactly as a value would.
    expect(codesFor({ 'host-xxxx.ts.net': { status: 'up' } })).toContain('network-host');
  });

  it('catches a credential named as a key, which no value-shape scan can see', () => {
    // `hunter2` is not credential-SHAPED; only the key says what it is.
    expect(codesFor({ apiKey: 'hunter2' })).toEqual(['secret-key']);
    expect(codesFor({ nested: { refresh_token: 'hunter2' } })).toEqual(['secret-key']);
    expect(codesFor({ tokenCount: 4 })).toEqual(['secret-key']);
    expect(codesFor({ affordance: { inspect: 'reads the pulse count' } })).toEqual([]);
  });

  it('reports nothing for an ordinary payload', () => {
    expect(codesFor({ schema: { pulses: 'integer' }, summary: 'A beacon that keeps pulsing.' })).toEqual([]);
  });

  it('caps the findings it returns', () => {
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`field${i}`, 'alice@example.com']));
    expect(federationSafetyFindings(many)).toHaveLength(40);
    expect(federationSafetyFindings(many, { limit: 3 })).toHaveLength(3);
  });
});
