import { describe, expect, it } from 'vitest';
import { processLiveness, processStartedAt } from './processIdentity.js';

describe('processLiveness', () => {
  it('reports dead only for ESRCH; EPERM and other failures read as alive', () => {
    const failing = code => () => { throw Object.assign(new Error(code), { code }); };
    expect(processLiveness(42, { kill: failing('ESRCH') })).toBe('dead');
    expect(processLiveness(42, { kill: failing('EPERM') })).toBe('alive');
    expect(processLiveness(42, { kill: failing('EIO') })).toBe('alive');
    expect(processLiveness(42, { kill: () => true })).toBe('alive');
    expect(processLiveness(0)).toBe('dead');
    expect(processLiveness(1.5)).toBe('dead');
  });
  it('sees this process as alive', () => {
    expect(processLiveness(process.pid)).toBe('alive');
  });
});

describe('processStartedAt', () => {
  it('parses ps lstart output and the Windows ISO form', () => {
    expect(processStartedAt(7, { platform: 'darwin', run: () => 'Mon Jan  5 10:11:12 2026\n' })).toBe(Date.parse('Mon Jan  5 10:11:12 2026'));
    expect(processStartedAt(7, { platform: 'win32', run: () => '2026-01-05T10:11:12.0000000Z\r\n' })).toBe(Date.parse('2026-01-05T10:11:12Z'));
  });
  it('returns null when the probe fails or prints nothing', () => {
    expect(processStartedAt(7, { run: () => { throw new Error('boom'); } })).toBeNull();
    expect(processStartedAt(7, { run: () => '\n' })).toBeNull();
    expect(processStartedAt(-1)).toBeNull();
  });
  it('reads a stable start for the real current process', () => {
    const first = processStartedAt(process.pid);
    expect(Number.isFinite(first)).toBe(true);
    expect(processStartedAt(process.pid)).toBe(first);
  });
});
