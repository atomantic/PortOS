import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveSpawnCwd, withSpawnCwdEnv } from './spawnCwd.js';

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

describe('withSpawnCwdEnv', () => {
  // The bug (#3193): spawn({ cwd }) changes the child's real working directory
  // but leaves the inherited PWD naming wherever the SERVER was started. OpenCode
  // resolves its project root as `process.env.PWD ?? process.cwd()`, so it ran
  // every agent in the PortOS checkout while the spawn logs correctly reported
  // the app's workspace.
  it('pins PWD to the spawn cwd, overriding a stale inherited value', () => {
    const env = withSpawnCwdEnv({ PATH: '/usr/bin', PWD: '/repos/PortOS' }, '/repos/my-app');
    expect(env.PWD).toBe('/repos/my-app');
    expect(env.PATH).toBe('/usr/bin');
  });

  it('sets PWD even when the inherited env had none', () => {
    expect(withSpawnCwdEnv({ PATH: '/usr/bin' }, '/repos/my-app').PWD).toBe('/repos/my-app');
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
      expect(env.PWD).toBe('/repos/my-app');
    }
  });

  // "No cwd was passed to spawn" means the child inherits the parent's real
  // working directory — so the inherited PWD is CORRECT there and deleting it
  // would substitute a different lie for the one being fixed.
  it('leaves the inherited PWD untouched when there is no cwd to pin', () => {
    for (const absent of [undefined, null, '']) {
      const env = withSpawnCwdEnv({ PWD: '/repos/PortOS', PATH: '/usr/bin' }, absent);
      expect(env.PWD).toBe('/repos/PortOS');
      expect(env.PATH).toBe('/usr/bin');
    }
  });

  it('copies rather than mutating the caller env', () => {
    const original = { PWD: '/repos/PortOS' };
    const env = withSpawnCwdEnv(original, '/repos/my-app');
    expect(original.PWD).toBe('/repos/PortOS');
    expect(env).not.toBe(original);
  });

  it('tolerates a null/undefined env', () => {
    expect(withSpawnCwdEnv(null, '/repos/my-app')).toEqual({ PWD: '/repos/my-app' });
    expect(withSpawnCwdEnv(undefined, undefined)).toEqual({});
  });
});

// Source invariant: every place PortOS spawns an AI CLI/TUI into a user
// workspace must pin PWD, or that provider silently runs in the PortOS checkout
// again (#3193). A unit-tested helper is worthless if a new spawn site forgets
// to call it, and the failure is invisible in normal use — the spawn logs still
// print the right cwd, only the FILES land in the wrong repo. So assert the call
// at each site rather than trusting convention.
describe('every AI CLI/TUI spawn site pins PWD to its spawn cwd', () => {
  const SPAWN_SITES = [
    // The #3193 repro: CoS task → runner → OpenCode agent.
    ['../cos-runner/index.js', 'withSpawnCwdEnv('],
    // Settings → Providers → Run Prompt (the #3180 repro path).
    ['../services/runner.js', 'withSpawnCwdEnv('],
    // CoS agent spawned in-process rather than through the runner.
    ['../services/agentCliSpawning.js', 'withSpawnCwdEnv('],
    // Every PTY session: the user's Shell page and agent-TUI sessions, which
    // inject the CLI command into this shell.
    ['../services/shell.js', 'withSpawnCwdEnv('],
    // Fire-and-collect CLI prompts (vision, app detect, feature helpers).
    ['./cliProviderRun.js', 'withSpawnCwdEnv('],
    // TUI-driven one-shot prompt runs (PTY spawned directly, no login shell to
    // rewrite PWD for us).
    ['./tuiPromptRunner.js', 'withSpawnCwdEnv('],
    // `/usage` quota scraping — spawns the TUI in a throwaway sandbox dir.
    ['./tuiUsageScrape.js', 'withSpawnCwdEnv('],
    // The vendored toolkit must not import out to other PortOS modules, so it
    // inlines the same pin instead of calling the shared helper.
    ['./aiToolkit/runner.js', 'childEnv.PWD = workspacePath'],
  ];

  for (const [relPath, marker] of SPAWN_SITES) {
    it(`${relPath} pins PWD`, () => {
      const src = readFileSync(new URL(relPath, import.meta.url), 'utf8');
      expect(src, `${relPath} spawns an AI CLI/TUI — it must pin PWD to the spawn cwd (see withSpawnCwdEnv)`).toContain(marker);
    });
  }
});
