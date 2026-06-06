import { describe, it, expect, vi } from 'vitest';

// pm2.js imports the `pm2` package at module load (no daemon connection until a
// call is made), so importing it for a pure-helper test is safe. We still mock
// the package to keep the import side-effect-free in CI.
vi.mock('pm2', () => ({ default: { connect: vi.fn(), list: vi.fn(), disconnect: vi.fn() } }));

import { parseJlistStdout } from './pm2.js';

describe('parseJlistStdout (issue #968 — custom PM2_HOME absent-vs-empty)', () => {
  it('parses a populated jlist array', () => {
    const out = '[{"name":"svc-a","pm2_env":{"status":"online"}}]';
    const list = parseJlistStdout(out);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('svc-a');
  });

  it('parses a genuine empty array as [] (read OK, no processes)', () => {
    // The literal '[]' is a successful "nothing running" — NOT a failure.
    expect(parseJlistStdout('[]')).toEqual([]);
    // Tolerates ANSI/log noise around the array literal.
    expect(parseJlistStdout('[2K[]\n')).toEqual([]);
  });

  it('returns null for empty stdout (failed read, not "no processes")', () => {
    // exit-0 with no output is a failed read — must NOT collapse to [].
    expect(parseJlistStdout('')).toBeNull();
    expect(parseJlistStdout('   \n')).toBeNull();
  });

  it('returns null for garbage / non-array stdout', () => {
    expect(parseJlistStdout('pm2 daemon not running')).toBeNull();
    expect(parseJlistStdout('{"not":"an array"}')).toBeNull();
    expect(parseJlistStdout(undefined)).toBeNull();
    expect(parseJlistStdout(null)).toBeNull();
  });

  it('does not mistake an ANSI color code like [31m for an empty array', () => {
    // The /\[\](?![0-9])/ guard means '[]' inside '[31m' style noise without a
    // real array still resolves to null, not a bogus empty success.
    expect(parseJlistStdout('[31mERROR[0m no pm2')).toBeNull();
  });
});
