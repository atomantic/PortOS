import { describe, it, expect } from 'vitest';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentGuardEnv, AGENT_GUARD_BIN } from './index.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('AGENT_GUARD_BIN', () => {
  it('points at the bin/ directory holding the guarded pm2 shim', () => {
    expect(AGENT_GUARD_BIN).toBe(join(HERE, 'bin'));
  });
});

describe('agentGuardEnv', () => {
  it('prepends the guard bin to the front of PATH, ahead of the base PATH', () => {
    const { PATH } = agentGuardEnv({ PATH: '/usr/bin:/bin' });
    expect(PATH).toBe(`${AGENT_GUARD_BIN}${delimiter}/usr/bin:/bin`);
    // Guard dir must be the FIRST entry so the shim shadows the real pm2.
    expect(PATH.split(delimiter)[0]).toBe(AGENT_GUARD_BIN);
  });

  it('still ends with delimiter+base when base PATH is empty', () => {
    const { PATH } = agentGuardEnv({ PATH: '' });
    expect(PATH).toBe(`${AGENT_GUARD_BIN}${delimiter}`);
    expect(PATH.split(delimiter)[0]).toBe(AGENT_GUARD_BIN);
  });

  it('falls back to the Windows-style Path key when PATH is absent', () => {
    const { PATH } = agentGuardEnv({ Path: 'C:\\Windows' });
    expect(PATH).toBe(`${AGENT_GUARD_BIN}${delimiter}C:\\Windows`);
  });

  it('treats a fully empty env as an empty base PATH', () => {
    const { PATH } = agentGuardEnv({});
    expect(PATH).toBe(`${AGENT_GUARD_BIN}${delimiter}`);
  });

  it('sets PORTOS_REAL_PM2 to the resolved real pm2 binary (pm2 is installed here)', () => {
    const patch = agentGuardEnv({ PATH: '/usr/bin' });
    // pm2 is a dependency of this repo, so it resolves and the shim is pointed at it.
    expect(patch.PORTOS_REAL_PM2).toBeTruthy();
    expect(patch.PORTOS_REAL_PM2.endsWith(join('bin', 'pm2'))).toBe(true);
    // The real pm2 must NOT be the guarded shim — that would defeat the guard.
    expect(patch.PORTOS_REAL_PM2.startsWith(AGENT_GUARD_BIN)).toBe(false);
  });

  it('reads PATH from process.env by default', () => {
    const { PATH } = agentGuardEnv();
    expect(PATH.startsWith(`${AGENT_GUARD_BIN}${delimiter}`)).toBe(true);
    expect(PATH).toBe(`${AGENT_GUARD_BIN}${delimiter}${process.env.PATH || ''}`);
  });

  it('returns only PATH (and PORTOS_REAL_PM2 when resolved) — no other keys leak', () => {
    const patch = agentGuardEnv({ PATH: '/usr/bin', FOO: 'bar' });
    expect(Object.keys(patch).sort()).toEqual(['PATH', 'PORTOS_REAL_PM2']);
    expect(patch.FOO).toBeUndefined();
  });
});
