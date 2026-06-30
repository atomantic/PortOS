import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The PATH-prepend is only half the safety mechanism — the actual kill-blocking
// lives in the bin/pm2 bash shim. Exercise it directly with a STUB real-pm2 so a
// passed-through command is observable (and no real pm2 ever runs). POSIX-only:
// the shim is bash, so skip on Windows (where the prepend is a documented no-op).
const SHIM = join(AGENT_GUARD_BIN, 'pm2');
const describeShim = process.platform === 'win32' ? describe.skip : describe;

describeShim('pm2 guard shim (bin/pm2)', () => {
  let workDir;
  let stubPm2;
  let marker;
  let cleanBin; // a PATH dir with the coreutils the shim needs but NO pm2

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'agentguard-'));
    marker = join(workDir, 'execed.txt');
    stubPm2 = join(workDir, 'pm2');
    // Stub real-pm2: records the args it was invoked with, then exits 0. If the
    // shim blocks, this never runs and the marker stays absent.
    writeFileSync(stubPm2, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > '${marker}'\nexit 0\n`);
    chmodSync(stubPm2, 0o755);

    // Build a pm2-free PATH dir holding just the externals the shim invokes
    // (`tr`, `dirname`) so the "no real pm2 resolvable" test is hermetic instead
    // of depending on whether the host's /usr/bin happens to contain pm2.
    cleanBin = join(workDir, 'cleanbin');
    mkdirSync(cleanBin);
    for (const tool of ['tr', 'dirname']) {
      const src = [`/usr/bin/${tool}`, `/bin/${tool}`].find((p) => existsSync(p));
      if (src) symlinkSync(src, join(cleanBin, tool));
    }
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const runShim = (args) => {
    if (existsSync(marker)) rmSync(marker);
    const res = spawnSync('bash', [SHIM, ...args], {
      env: { ...process.env, PORTOS_REAL_PM2: stubPm2 },
      encoding: 'utf8',
    });
    return { code: res.status, execedArgs: existsSync(marker) ? readFileSync(marker, 'utf8').trim() : null };
  };

  it('ships an executable shim file', () => {
    expect(existsSync(SHIM)).toBe(true);
    // Owner-executable bit set (0o100) — an un-chmod'd shim would silently not run.
    expect(statSync(SHIM).mode & 0o100).toBe(0o100);
  });

  it('blocks `pm2 kill` (exit 1, never reaches real pm2)', () => {
    const { code, execedArgs } = runShim(['kill']);
    expect(code).toBe(1);
    expect(execedArgs).toBeNull();
  });

  it('blocks `pm2 startup` and `pm2 unstartup`', () => {
    expect(runShim(['startup']).code).toBe(1);
    expect(runShim(['unstartup']).code).toBe(1);
  });

  it('blocks the subcommand case-insensitively (`pm2 KILL`)', () => {
    const { code, execedArgs } = runShim(['KILL']);
    expect(code).toBe(1);
    expect(execedArgs).toBeNull();
  });

  it('blocks every mirrored daemon-wide verb when the target is `all`', () => {
    // Must match PM2_ALL_TARGET_VERBS in commandSecurity.js.
    for (const verb of ['stop', 'delete', 'del', 'restart', 'reload', 'gracefulreload', 'scale']) {
      const { code, execedArgs } = runShim([verb, 'all']);
      expect(code, `${verb} all should be blocked`).toBe(1);
      expect(execedArgs).toBeNull();
    }
  });

  it('blocks `all` case-insensitively (`pm2 delete ALL`)', () => {
    expect(runShim(['delete', 'ALL']).code).toBe(1);
  });

  it('blocks `all` even when it appears after earlier flags/args', () => {
    // The shim scans every arg after the subcommand, not just the first.
    const { code, execedArgs } = runShim(['restart', '--update-env', 'all']);
    expect(code).toBe(1);
    expect(execedArgs).toBeNull();
  });

  it('passes a scoped `pm2 restart <name>` through to the real pm2', () => {
    const { code, execedArgs } = runShim(['restart', 'my-app']);
    expect(code).toBe(0);
    expect(execedArgs).toBe('restart my-app');
  });

  it('passes a read-only `pm2 list` through to the real pm2', () => {
    const { code, execedArgs } = runShim(['list']);
    expect(code).toBe(0);
    expect(execedArgs).toBe('list');
  });

  it('exits 127 when no real pm2 can be resolved', () => {
    // Empty PORTOS_REAL_PM2 + a hermetic PATH containing only tr/dirname (no pm2)
    // → the resolver finds none and the shim bails with 127. bash is invoked by
    // absolute path so it need not be on the restricted PATH.
    const bash = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) || 'bash';
    const res = spawnSync(bash, [SHIM, 'list'], {
      env: { PORTOS_REAL_PM2: '', PATH: cleanBin },
      encoding: 'utf8',
    });
    expect(res.status).toBe(127);
  });
});
