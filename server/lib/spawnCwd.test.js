import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { posixPath } from './testHelper.js';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveSpawnCwd, withSpawnCwdEnv, usesCreativeDirectorScratchCwd, creativeDirectorScratchCwd, resolveAgentCliCwd, removeCreativeDirectorScratchCwd } from './spawnCwd.js';
import { PATHS } from './fileUtils.js';

describe('resolveSpawnCwd', () => {
  let dir;
  let logSpy;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawncwd-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the workspace when it exists', () => {
    expect(resolveSpawnCwd(dir, '/fallback')).toBe(dir);
  });

  it('falls back to the root when no workspace was supplied', () => {
    expect(resolveSpawnCwd(undefined, '/fallback')).toBe('/fallback');
    expect(resolveSpawnCwd(null, '/fallback')).toBe('/fallback');
    expect(resolveSpawnCwd('', '/fallback')).toBe('/fallback');
  });

  // "Nothing supplied" and "something blank supplied" must not collapse.
  // repoPath is validated as z.string().min(1), so an app CAN hold "   ";
  // treating that as absent hands the run the PortOS root and silently writes
  // there — the bug this module exists to prevent, through the one input the
  // schema still allows.
  it('rejects a whitespace-only workspace instead of falling back', () => {
    expect(() => resolveSpawnCwd('   ', '/fallback')).toThrow(/blank/);
    expect(() => resolveSpawnCwd('\t\n ', '/fallback')).toThrow(/Repository Path/);
  });

  it('logs the effective cwd so a run is never silently misrouted', () => {
    resolveSpawnCwd(dir, '/fallback', 'Run abc');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('Run abc');
    expect(logSpy.mock.calls.flat().join('\n')).toContain(dir);

    logSpy.mockClear();
    resolveSpawnCwd('', '/fallback', 'Run xyz');
    expect(logSpy.mock.calls.flat().join('\n')).toContain('no workspace selected');
  });

  it('can validate without logging when the caller reports the final directory', () => {
    logSpy.mockClear();
    expect(resolveSpawnCwd(dir, '/fallback', 'Task sys-1', { log: false })).toBe(dir);
    expect(logSpy).not.toHaveBeenCalled();
  });

  // The #3180 regression: a workspace was requested but does not exist. The old
  // behavior spawned in the PortOS root anyway, so the agent's relative file
  // writes landed in the wrong repo with no error anywhere.
  it('throws instead of falling back when the requested workspace is missing', () => {
    const missing = join(dir, 'no-such-repo');
    expect(() => resolveSpawnCwd(missing, '/fallback')).toThrow(/does not exist/);
    expect(() => resolveSpawnCwd(missing, '/fallback')).toThrow(/Repository Path/);
  });

  it('throws when the requested workspace is a file, not a directory', () => {
    const file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    expect(() => resolveSpawnCwd(file, '/fallback')).toThrow(/not a directory/);
  });
});

describe('resolveSpawnCwd — home expansion', () => {
  // repoPath is only validated as a non-empty string, so a user can save
  // `~/Projects/App`. Without expansion the new guard would hard-fail it with a
  // message naming a path that was never meant to be literal.
  it('expands a leading ~ instead of rejecting it as missing', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(resolveSpawnCwd('~', '/fallback')).toBe(homedir());
    logSpy.mockRestore();
  });
});

// Two review rounds each surfaced a different *input shape* that collapsed back
// into the silent fallback (`~` rejected as missing, a file accepted as a repo,
// whitespace-only treated as absent). The shapes differ; the invariant doesn't:
//
//   a workspace that was SUPPLIED but is not a usable directory must never
//   resolve to fallbackRoot — it throws, or it returns the real directory.
//
// Enumerating the shape space and asserting the invariant catches the next
// variant without waiting for a reviewer to name it.
describe('resolveSpawnCwd — supplied-but-unusable never reaches the fallback', () => {
  let dir, file, logSpy;
  const FALLBACK = '/the-portos-checkout';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spawncwd-inv-'));
    file = join(dir, 'a-file.txt');
    writeFileSync(file, 'x');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('never returns the fallback for any supplied-but-unusable shape', () => {
    const unusable = () => [
      '   ', '\t', '\n', ' \t\n ',            // blank after trim
      join(dir, 'no-such-dir'),                // missing
      join(dir, 'no', 'such', 'nested'),       // missing, nested
      file,                                    // exists but is a file
      `${file}  `,                             // file with trailing space
      '~/definitely-not-a-real-portos-dir',    // expands, still missing
    ];
    for (const shape of unusable()) {
      let result, threw = false;
      try { result = resolveSpawnCwd(shape, FALLBACK); } catch { threw = true; }
      expect(threw, `expected ${JSON.stringify(shape)} to be rejected`).toBe(true);
      expect(result, `${JSON.stringify(shape)} must never resolve to the fallback`).not.toBe(FALLBACK);
    }
  });

  it('returns the real directory for usable shapes, never the fallback', () => {
    for (const shape of [dir, `  ${dir}  `, `${dir}/`]) {
      const result = resolveSpawnCwd(shape, FALLBACK);
      expect(result).not.toBe(FALLBACK);
      expect(result.replace(/\/$/, '')).toBe(dir);
    }
  });

  // The complement: only a genuinely ABSENT workspace earns the fallback.
  it('returns the fallback only for absent shapes', () => {
    for (const shape of [undefined, null, '']) {
      expect(resolveSpawnCwd(shape, FALLBACK)).toBe(FALLBACK);
    }
  });
});

describe('Creative Director scratch cwd (#4650)', () => {
  const cdTask = (extra = {}) => ({
    metadata: { creativeDirector: { projectId: 'p', kind: 'plan' }, useWorktree: false, ...extra },
  });

  it('recognizes a CD no-worktree task and rejects a worktree-requested one', () => {
    expect(usesCreativeDirectorScratchCwd(cdTask())).toBe(true);
    expect(usesCreativeDirectorScratchCwd(cdTask({ useWorktree: 'false' }))).toBe(true);
    expect(usesCreativeDirectorScratchCwd(cdTask({ useWorktree: true }))).toBe(false);
    expect(usesCreativeDirectorScratchCwd(cdTask({ useWorktree: 'true' }))).toBe(false);
    expect(usesCreativeDirectorScratchCwd({ metadata: {} })).toBe(false);
    expect(usesCreativeDirectorScratchCwd(null)).toBe(false);
  });

  it('places the scratch dir under the OS temp dir, outside the PortOS checkout', () => {
    const cwd = creativeDirectorScratchCwd('agent-cd-1');
    expect(cwd).toBe(join(tmpdir(), 'portos-cd-cwd', 'agent-cd-1'));
    expect(cwd).not.toBe(PATHS.root);
    // Native AGENTS.md discovery walks parents to the git root. A path under
    // the checkout (including gitignored data/) would still leak repo AGENTS.md.
    expect(cwd.startsWith(`${PATHS.root}/`)).toBe(false);
    expect(cwd.startsWith(PATHS.root + '\\')).toBe(false);
  });

  it('refuses a missing agentId so CD runs cannot collapse onto one folder', () => {
    expect(() => creativeDirectorScratchCwd('')).toThrow(/agentId/);
    expect(() => creativeDirectorScratchCwd(null)).toThrow(/agentId/);
  });

  it('resolveAgentCliCwd swaps PATHS.root for the scratch path on a CD task', () => {
    const scratch = creativeDirectorScratchCwd('agent-cd-2');
    expect(resolveAgentCliCwd({
      workspacePath: PATHS.root,
      fallbackRoot: PATHS.root,
      task: cdTask(),
      agentId: 'agent-cd-2',
    })).toBe(scratch);
    // Non-CD keeps the caller workspace, including the root fallback.
    expect(resolveAgentCliCwd({
      workspacePath: '/tmp',
      fallbackRoot: PATHS.root,
      task: { metadata: {} },
      agentId: 'agent-cd-2',
    })).toBe('/tmp');
    expect(resolveAgentCliCwd({
      workspacePath: null,
      fallbackRoot: PATHS.root,
      task: { metadata: {} },
      agentId: 'agent-cd-2',
    })).toBe(PATHS.root);
  });

  it('removeCreativeDirectorScratchCwd deletes the scratch dir and is a no-op when missing', async () => {
    const dir = creativeDirectorScratchCwd('agent-cd-rm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leftover.txt'), 'x');
    expect(existsSync(dir)).toBe(true);
    await removeCreativeDirectorScratchCwd('agent-cd-rm');
    expect(existsSync(dir)).toBe(false);
    await expect(removeCreativeDirectorScratchCwd('agent-cd-rm')).resolves.toBeUndefined();
    // removeCreativeDirectorScratchCwd only ever removes the per-agent leaf —
    // in production the shared `portos-cd-cwd` container is meant to persist
    // and be reused across runs, so this test leaves it in place rather than
    // removing it itself (which would race agentFinalization.providerBench
    // .test.js's own use of the same literal path if Vitest runs them
    // concurrently). The run-scoped temp root's teardown (#9032,
    // server/test/runTempRoot.js) treats an empty leftover container as a
    // non-leak, so the now-empty `portos-cd-cwd` needs no cleanup at all.
  });
});

describe('withSpawnCwdEnv', () => {
  // The bug (#3193): spawn({ cwd }) changes the child's real working directory
  // but leaves the inherited PWD naming wherever the SERVER was started. OpenCode
  // resolves its project root as `process.env.PWD ?? process.cwd()`, so it ran
  // every agent in the PortOS checkout while the spawn logs correctly reported
  // the app's workspace.
  it('pins PWD to the spawn cwd, overriding a stale inherited value', () => {
    const env = withSpawnCwdEnv({ PATH: '/usr/bin', PWD: '/repos/PortOS' }, '/repos/my-app');
    expect(posixPath(env.PWD)).toBe('/repos/my-app');
    expect(posixPath(env.PATH)).toBe('/usr/bin');
  });

  it('sets PWD even when the inherited env had none', () => {
    expect(posixPath(withSpawnCwdEnv({ PATH: '/usr/bin' }, '/repos/my-app').PWD)).toBe('/repos/my-app');
  });

  // Windows env names are case-insensitive, so a spread of process.env can carry
  // `Pwd`. Leaving that key alongside a new `PWD` would hand the child two
  // spellings of one variable with no defined winner — i.e. it could still read
  // the stale one and land back in the PortOS folder.
  it('drops case-variant PWD keys so the child sees exactly one', () => {
    for (const variant of ['Pwd', 'pwd', 'pWd']) {
      const env = withSpawnCwdEnv({ [variant]: '/repos/PortOS', PATH: '/usr/bin' }, '/repos/my-app');
      const pwdKeys = Object.keys(env).filter((k) => /^pwd$/i.test(k));
      expect(pwdKeys, `${variant} must not survive alongside PWD`).toEqual(['PWD']);
      expect(posixPath(env.PWD)).toBe('/repos/my-app');
    }
  });

  // "No cwd was passed to spawn" means the child inherits the parent's real
  // working directory — so the inherited PWD is CORRECT there and deleting it
  // would substitute a different lie for the one being fixed.
  it('leaves the inherited PWD untouched when there is no cwd to pin', () => {
    for (const absent of [undefined, null, '']) {
      const env = withSpawnCwdEnv({ PWD: '/repos/PortOS', PATH: '/usr/bin' }, absent);
      expect(posixPath(env.PWD)).toBe('/repos/PortOS');
      expect(posixPath(env.PATH)).toBe('/usr/bin');
    }
  });

  it('copies rather than mutating the caller env', () => {
    const original = { PWD: '/repos/PortOS' };
    const env = withSpawnCwdEnv(original, '/repos/my-app');
    expect(posixPath(original.PWD)).toBe('/repos/PortOS');
    expect(env).not.toBe(original);
  });

  it('tolerates a null/undefined env', () => {
    expect(withSpawnCwdEnv(null, '/repos/my-app')).toEqual({ PWD: '/repos/my-app' });
    expect(withSpawnCwdEnv(undefined, undefined)).toEqual({});
  });
});
