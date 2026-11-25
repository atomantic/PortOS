// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseJsonText } from './parseJsonText';

describe('parseJsonText', () => {
  it('parses valid JSON', () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
  });
  it('wraps a SyntaxError in a user-readable message', () => {
    expect(() => parseJsonText('<html>')).toThrow(/^Invalid JSON: /);
  });
});
