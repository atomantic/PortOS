import { describe, it, expect } from 'vitest';
import { redactTcAddress, isValidTcAddress, redactTailcatDiagnostics } from './tailcatAddress.js';

const EXAMPLE_TC = 'tcEXAMPLE' + 'A'.repeat(40);

describe('Tailcat capability privacy and validation', () => {
  it('redacts tc addresses so logs never hold the full capability', () => {
    const redacted = redactTcAddress(EXAMPLE_TC);
    expect(redacted).not.toBe(EXAMPLE_TC);
    expect(redacted.startsWith('tcEX')).toBe(true);
    expect(redacted.includes('…')).toBe(true);
    expect(redactTcAddress('')).toBe('(empty)');
  });

  it('validates tc address shape without accepting short garbage', () => {
    expect(isValidTcAddress(EXAMPLE_TC)).toBe(true);
    expect(isValidTcAddress('tcEXAMPLE…')).toBe(false); // ellipsis / placeholder
    expect(isValidTcAddress('not-a-tc')).toBe(false);
    expect(isValidTcAddress('tcshort')).toBe(false);
    expect(isValidTcAddress('')).toBe(false);
  });

  it('scrubs capability tokens out of diagnostics but keeps the reason readable', () => {
    const text = `Expand: fetching DERPMap for region -1: context deadline exceeded\ndial ${EXAMPLE_TC}: refused`;
    const redacted = redactTailcatDiagnostics(text);
    expect(redacted).toContain('fetching DERPMap');
    expect(redacted).toContain('refused');
    expect(redacted).not.toContain('tcEXAMPLE');
    expect(redactTailcatDiagnostics('')).toBe('');
  });

});
