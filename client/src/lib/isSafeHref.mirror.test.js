import { describe, expect, it } from 'vitest';
import { isSafeHref as clientIsSafeHref } from './isSafeHref.js';
import { isSafeHref as serverIsSafeHref } from '../../../server/lib/isSafeHref.js';

// Shared input matrix so the client and server copies must agree on every
// case, not merely both exist (server/lib/mirrorCoverage.test.js's parity
// guard only proves a test reads both files).
const CASES = [
  'https://host/path',
  'http://host/path',
  'https:foo',
  'https:/host',
  'https:///host',
  '//host',
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  '',
  null,
  undefined,
];

describe('isSafeHref client/server parity', () => {
  it.each(CASES)('agrees on %p', (input) => {
    expect(clientIsSafeHref(input)).toBe(serverIsSafeHref(input));
  });
});
