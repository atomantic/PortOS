/**
 * This table is the convergence target for #7474: three independently
 * maintained redaction tables (`federationSafety.js`, `agentContextMcp.js`,
 * `agentErrorAnalysis.js`) drifted apart, so a fix to one never reached the
 * others. The regressions worth pinning here are the ones that would let
 * that drift resume: every machine-identity/PII shape the union of the old
 * three tables caught must still be caught by `redactPii`, and the pattern
 * objects must stay safe for `federationSafetyFindings` to reuse across many
 * `.test()` calls without a stateful `lastIndex` bug.
 */
import { describe, expect, it } from 'vitest';
import { PII_PATTERNS, globalPattern, redactPii } from './piiRedactionPatterns.js';

// One sample per CODE the table declares (not per pattern — `ip-literal`
// covers both an IPv4 and an IPv6 entry, exercised separately below). If a
// future entry adds a code with no sample here, this map is the thing to
// extend — the loop below fails loudly on a missing key rather than skipping it.
const SAMPLE_BY_CODE = {
  'home-path': { text: 'notes live at /Users/exampleuser/journal', leak: 'exampleuser' },
  'windows-path': { text: 'checkout at C:\\Users\\exampleuser\\portos', leak: 'exampleuser' },
  'ip-literal': { text: 'reachable at 203.0.113.5 today', leak: '203.0.113.5' },
  'network-host': { text: 'peer is host-example.ts.net', leak: 'host-example' },
  'mac-address': { text: 'interface de:ad:be:ef:00:11 up', leak: 'de:ad:be:ef:00:11' },
  'email-address': { text: 'reach person@example.com', leak: 'person@example.com' },
  'phone-number': { text: 'call +1 555 010 4477', leak: '555 010 4477' },
  'gps-coordinate': { text: 'recorded latitude: 37.4219', leak: '37.4219' },
};

describe('PII_PATTERNS / redactPii', () => {
  it('declares a sample for every code it exports (fixture stays in sync with the table)', () => {
    const codes = new Set(PII_PATTERNS.map((entry) => entry.code));
    expect(Object.keys(SAMPLE_BY_CODE).sort()).toEqual([...codes].sort());
  });

  it('redacts every code the union of the three old tables caught', () => {
    for (const [code, { text, leak }] of Object.entries(SAMPLE_BY_CODE)) {
      const out = redactPii(text);
      expect(out, `code ${code}`).not.toContain(leak);
    }
  });

  it('catches an IPv6 literal as well as IPv4 under the same "ip-literal" code', () => {
    // Both entries share a code, so the coverage loop above only exercises
    // one of the two patterns — pin the IPv6 side, which neither
    // agentContextMcp.js nor agentErrorAnalysis.js redacted before #7474.
    expect(redactPii('address fe80::1ff:fe23:4567:890a active')).not.toContain('fe80::1ff:fe23:4567:890a');
  });

  it('applies patterns in table order over one string carrying several kinds at once', () => {
    const out = redactPii('alice@example.com from /Users/alice/notes, host node.ts.net');
    expect(out).not.toContain('alice@example.com');
    expect(out).not.toContain('/Users/alice');
    expect(out).not.toContain('node.ts.net');
  });

  it('keeps every pattern non-global, so federationSafetyFindings can .test() it across many strings without a stateful lastIndex miss', () => {
    // A 'g'-flagged regex object remembers `lastIndex` between calls; the
    // second `.test()` on a matching string can come back false purely
    // because the first call advanced past it. This is the bypass this table
    // exists to prevent: catch it here before it reaches federationSafety.js.
    for (const { code, pattern } of PII_PATTERNS) {
      expect(pattern.global, `code ${code} must not carry the 'g' flag`).toBe(false);
    }
    const emailPattern = PII_PATTERNS.find((entry) => entry.code === 'email-address').pattern;
    expect(emailPattern.test('first@example.com')).toBe(true);
    expect(emailPattern.test('second@example.com')).toBe(true);
  });

  it('globalPattern derives a replace-safe copy without mutating the shared regex object', () => {
    const homePathPattern = PII_PATTERNS.find((entry) => entry.code === 'home-path').pattern;
    const asGlobal = globalPattern(homePathPattern);
    expect(asGlobal.global).toBe(true);
    expect(homePathPattern.global).toBe(false);
    expect('/Users/alice/a and /Users/bob/b'.replace(asGlobal, '/$1/<user>')).toBe('/Users/<user>/a and /Users/<user>/b');
  });
});
