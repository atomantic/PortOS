import { describe, it, expect } from 'vitest';

import { parsePm2JlistStdout } from '../lib/pm2Jlist.js';

describe('parsePm2JlistStdout (issue #968 — custom PM2_HOME absent-vs-empty)', () => {
  it('parses a populated jlist array', () => {
    const out = '[{"name":"svc-a","pm2_env":{"status":"online"}}]';
    const list = parsePm2JlistStdout(out);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('svc-a');
  });

  it('parses the first complete array when trailing output follows it', () => {
    const entry = { name: 'svc-a', pm2_env: { status: 'online', args: ['literal ] and [', 'other'] } };
    expect(parsePm2JlistStdout(`${JSON.stringify([entry])}\n[2K`)).toEqual([entry]);
    expect(parsePm2JlistStdout(`${JSON.stringify([entry])}\n${JSON.stringify([{ name: 'svc-b' }])}`)).toEqual([entry]);
    expect(parsePm2JlistStdout('[]\n[2K')).toEqual([]);
    expect(parsePm2JlistStdout('[{"name":"svc-a"}\n[2K')).toBeNull();
  });

  it('parses a genuine empty array as [] (read OK, no processes)', () => {
    // The literal '[]' is a successful "nothing running" — NOT a failure.
    expect(parsePm2JlistStdout('[]')).toEqual([]);
    // Tolerates ANSI/log noise around the array literal.
    expect(parsePm2JlistStdout('[2K[]\n')).toEqual([]);
  });

  it('returns null for empty stdout (failed read, not "no processes")', () => {
    // exit-0 with no output is a failed read — must NOT collapse to [].
    expect(parsePm2JlistStdout('')).toBeNull();
    expect(parsePm2JlistStdout('   \n')).toBeNull();
  });

  it('returns null for garbage / non-array stdout', () => {
    expect(parsePm2JlistStdout('pm2 daemon not running')).toBeNull();
    expect(parsePm2JlistStdout('{"not":"an array"}')).toBeNull();
    expect(parsePm2JlistStdout(undefined)).toBeNull();
    expect(parsePm2JlistStdout(null)).toBeNull();
  });

  it('does not mistake an ANSI color code like [31m for an empty array', () => {
    // The /\[\](?![0-9])/ guard means '[]' inside '[31m' style noise without a
    // real array still resolves to null, not a bogus empty success.
    expect(parsePm2JlistStdout('[31mERROR[0m no pm2')).toBeNull();
  });
});
