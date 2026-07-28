import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
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

// Source invariant: any spawn that names its own working directory must also
// pin PWD, or a CLI that reads PWD (OpenCode does) silently runs in the PortOS
// checkout again (#3193). A unit-tested helper is worthless if a new spawn site
// forgets to call it, and this failure is invisible in normal use — the spawn
// logs still print the right cwd, only the FILES land in the wrong repo.
//
// Deliberately DISCOVERS the spawn sites rather than listing them: an allowlist
// of "these files must contain the call" passes the day someone adds a ninth
// spawn site, which is exactly when the guard needs to fire. Here a new
// cwd-passing spawn fails the suite until it is either pinned or explicitly
// exempted below with a reason.
describe('every cwd-passing spawn pins PWD', () => {
  const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));

  // Files whose cwd-passing spawn does NOT need the pin, each with the reason it
  // is safe. Anything not listed here must pin. The common reason is "this spawns
  // a tool that resolves paths from its real cwd, never from PWD" — git, gh,
  // glab, pm2, psql, npm, xcodegen, python.
  const EXEMPT = new Map([
    ['services/git.js', 'git/gh resolve from real cwd (and -C), never PWD'],
    ['lib/execGit.js', 'git only'],
    ['lib/planIds.js', 'git only'],
    ['services/githubCloner.js', 'git clone/fetch only'],
    ['services/gitlab.js', 'glab only'],
    ['services/perpetualWork.js', 'git/gh/glab probes only'],
    ['services/pm2Standardizer.js', 'git + pm2 only'],
    ['services/pm2.js', 'pm2 only'],
    ['services/appDeployer.js', 'deploy shell commands, not an AI CLI'],
    ['services/xcodeScripts.js', 'xcodebuild/ls, not an AI CLI'],
    ['services/imageTo3d/trellis2.js', 'python/uv toolchain inside its own install root'],
    ['services/updateExecutor.js', "PortOS's own update scripts, run in the PortOS root by design"],
    ['services/calendarGoogleSync.js', 'runs in process.cwd(), so the inherited PWD is already truthful'],
    ['routes/database.js', 'psql/pg_dump, not an AI CLI'],
    ['routes/scaffold.js', 'npm/git scaffolding, not an AI CLI'],
    ['routes/scaffoldVite.js', 'npm scaffolding, not an AI CLI'],
    ['routes/scaffoldIOS.js', 'xcodegen, not an AI CLI'],
    ['routes/scaffoldXcode.js', 'xcodegen, not an AI CLI'],
    ['routes/apps/launch.js', "detached launch into the user's own terminal; the CLI reads process.cwd()"],
  ]);

  // Files whose cwd-passing spawns all go through a shared wrapper that already
  // pins, so they need no call of their own.
  const DELEGATES = new Map([
    ['services/appBuilder.js', 'bufferedSpawn'],
    ['services/agentRunTracking.js', 'bufferedSpawn'],
  ]);

  // Files that pin by inlining the assignment instead of calling the shared
  // helper, with the reason they cannot call it.
  const INLINE_PIN = new Map([
    ['lib/aiToolkit/runner.js', 'vendored toolkit — must not import out to other PortOS modules'],
  ]);

  const SPAWN_CALL_RE = /\b(?:spawn|ptySpawn|spawnImpl|pty\.spawn|bufferedSpawn|execFile|execAsync)\s*\(/g;

  /** Recursively collect non-test .js files under `dir`, as server-relative paths. */
  const collectSources = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) return collectSources(abs);
    if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) return [];
    return [relative(SERVER_DIR, abs)];
  });

  // A spawn "passes a cwd" when a `cwd` option appears within the call's own
  // options object. Scanning a short window after the call open-paren keeps this
  // to a regex instead of a parser, at the cost of the occasional false positive
  // — which is fine: a false positive is an exemption line, not a wrong pass.
  const passesCwd = (src) => {
    for (const match of src.matchAll(SPAWN_CALL_RE)) {
      if (/\bcwd\s*[:,]/.test(src.slice(match.index, match.index + 400))) return true;
    }
    return false;
  };

  it('discovers the cwd-passing spawn sites (guard is not vacuous)', () => {
    const found = collectSources(SERVER_DIR).filter((rel) => passesCwd(readFileSync(join(SERVER_DIR, rel), 'utf8')));
    // If this ever collapses toward zero the scan broke (a rename, a new spawn
    // wrapper) and every assertion below would pass for the wrong reason.
    expect(found.length, 'expected the scan to still find the known spawn sites').toBeGreaterThan(10);
    expect(found).toContain('cos-runner/index.js');
    expect(found).toContain('services/shell.js');
  });

  it('every cwd-passing spawn either pins PWD or is explicitly exempt', () => {
    const unpinned = [];
    for (const rel of collectSources(SERVER_DIR)) {
      const src = readFileSync(join(SERVER_DIR, rel), 'utf8');
      if (!passesCwd(src)) continue;
      if (EXEMPT.has(rel)) continue;
      if (DELEGATES.has(rel) && src.includes(DELEGATES.get(rel))) continue;
      const pinned = INLINE_PIN.has(rel)
        ? /childEnv\.PWD\s*=/.test(src)
        : src.includes('withSpawnCwdEnv(');
      if (!pinned) unpinned.push(rel);
    }
    expect(
      unpinned,
      'These files spawn a child with an explicit cwd but never pin PWD. A CLI that '
      + 'resolves its project root from PWD (OpenCode does) will ignore that cwd and run '
      + 'in the PortOS checkout instead — see withSpawnCwdEnv in server/lib/spawnCwd.js '
      + '(#3193). Either pin PWD, or add the file to EXEMPT above with the reason it is safe.',
    ).toEqual([]);
  });
});
