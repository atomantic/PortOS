import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { posixPath } from './testHelper.js';

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { resolveSpawnCwd, withSpawnCwdEnv, usesCreativeDirectorScratchCwd, creativeDirectorScratchCwd, resolveAgentCliCwd, removeCreativeDirectorScratchCwd } from './spawnCwd.js';
import { PATHS } from './fileUtils.js';
import { collectServerSources, readServerSource } from './testHelper.js';

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
  // Files whose cwd-passing spawn does NOT need the pin, each with the reason it
  // is safe. Anything not listed here must pin. The common reason is "this spawns
  // a tool that resolves paths from its real cwd, never from PWD" — git, gh,
  // glab, pm2, psql, npm, xcodegen, python.
  const EXEMPT = new Map([
    ['services/git.js', 'git/gh resolve from real cwd (and -C), never PWD'],
    ['lib/execGit.js', 'git only'],
    ['lib/planIds.js', 'git only'],
    ['services/repoCloner.js', 'git clone/fetch only'],
    ['services/gitlab.js', 'glab only'],
    ['services/perpetualWork.js', 'git/gh/glab probes only'],
    ['services/pm2Standardizer.js', 'git + pm2 only'],
    ['services/pm2.js', 'pm2 only'],
    ['services/appDeployer.js', 'deploy shell commands, not an AI CLI'],
    ['services/xcodeScripts.js', 'xcodebuild/ls, not an AI CLI'],
    ['services/imageTo3d/laneRunner.js', 'git/bash/python install + render steps inside a target install root, not an AI CLI'],
    ['services/updateExecutor.js', "PortOS's own update scripts, run in the PortOS root by design"],
    ['services/dbAdmin.js', 'psql/pg_dump, not an AI CLI'],
    ['routes/scaffold.js', 'npm/git scaffolding, not an AI CLI'],
    ['routes/scaffoldVite.js', 'npm scaffolding, not an AI CLI'],
    ['services/xcodeScaffold.js', 'xcodegen, not an AI CLI'],
    ['routes/apps/launch.js', "detached launch into the user's own terminal; the CLI reads process.cwd()"],
  ]);

  // Files whose cwd-passing spawns all go through a shared wrapper that already
  // pins, so they need no call of their own.
  const DELEGATES = new Map([
    ['services/appBuilder.js', 'bufferedSpawn'],
  ]);

  // Files that pin by inlining the assignment instead of calling the shared
  // helper, with the reason they cannot call it.
  const INLINE_PIN = new Map([
    ['lib/aiToolkit/runner.js', 'vendored toolkit — must not import out to other PortOS modules'],
  ]);

  const SPAWN_CALL_RE = /\b(?:spawn|ptySpawn|spawnImpl|pty\.spawn|bufferedSpawn|execFile|execAsync)\s*\(/g;

  /**
   * Count `buildCliChildEnv({ … cwd … })` calls — the shared AI-CLI env composer
   * (#3194), which pins PWD internally. Only a call that actually PASSES a cwd
   * counts: `cwd` is an optional key there, so a bare `buildCliChildEnv({ provider })`
   * next to a `spawn(cmd, args, { cwd })` would otherwise satisfy this guard while
   * reintroducing #3193 verbatim. `withSpawnCwdEnv(x, cwd)` can't be called without
   * one, so requiring the key keeps the two markers equally strong.
   *
   * This reads the call's OWN argument list via a balanced-paren walk — NOT a
   * fixed character window. A window is wrong here in the exact shape that
   * matters: the statement after the composer is nearly always the spawn, whose
   * options carry `cwd`, so a window sees the SPAWN's cwd and passes an unpinned
   * composer call. That is not hypothetical — it is the natural way to write a
   * new site, and it silently reopens #3193 with every test still green.
   */
  const countCwdBearingComposerCalls = (src) => {
    let count = 0;
    for (const m of src.matchAll(/\bbuildCliChildEnv\s*\(/g)) {
      // Walk from the call's open paren to its matching close paren, so nested
      // object/array/call braces inside the argument (e.g. `before: { … }`) are
      // spanned but the argument list is never overrun.
      let depth = 0;
      let end = src.length;
      for (let i = src.indexOf('(', m.index); i < src.length; i += 1) {
        const ch = src[i];
        if (ch === '(' || ch === '{' || ch === '[') depth += 1;
        else if (ch === ')' || ch === '}' || ch === ']') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (/\bcwd\s*[:,}]/.test(src.slice(m.index, end))) count += 1;
    }
    return count;
  };

  // A spawn is in scope when its options carry a `cwd` — either written inline
  // (`spawn(cmd, args, { cwd, ... })`) or FORWARDED from a caller-supplied
  // options object (`spawn(cmd, args, { ...options })`, the shape of a generic
  // wrapper like layeredIntelligence/runCli). The forwarding case matters as
  // much as the inline one: a wrapper that passes a caller's cwd through is
  // exactly where an unpinned spawn hides from a scan that only reads literals.
  //
  // Scanning a window after the call's open-paren keeps this a regex rather than
  // a parser. It over-matches sometimes — a false positive costs one EXEMPT line,
  // whereas a false negative silently reopens #3193, so the bias is deliberate.
  //
  // KNOWN BLIND SPOT, stated rather than papered over: a call whose options are
  // hoisted into a variable first (`const opts = { cwd, … }; spawn(c, a, opts)`)
  // is invisible here — the window sees only the identifier. Detecting it needs
  // real parsing, and the identifier-shaped heuristics all collide with the
  // ordinary two-argument `spawn(cmd, args)` form. No such call exists in the
  // tree today; if one is added, add it to EXEMPT/DELEGATES deliberately or
  // rewrite it inline. Everything else — inline `cwd:` and forwarded
  // `...options` — is covered.
  const OPTIONS_SPREAD_RE = /\.\.\.\s*(?:options|opts|spawnOptions|spawnOpts)\b/;
  const spawnSitesInScope = (src) => {
    // `function bufferedSpawn(cmd, args, { cwd, … })` matches SPAWN_CALL_RE, and
    // its destructured params contain `cwd` — so a wrapper's own DECLARATION
    // reads as a second cwd-passing call site and inflates the count past the
    // pin count. Only actual invocations count.
    const starts = [...src.matchAll(SPAWN_CALL_RE)]
      .filter((m) => !/\bfunction\s+$/.test(src.slice(Math.max(0, m.index - 20), m.index)))
      .map((m) => m.index);
    let count = 0;
    for (const [i, start] of starts.entries()) {
      // End the window at the NEXT spawn call so two adjacent calls can't share
      // one `cwd`. Without this, a cwd-less `spawn('taskkill', …)` sitting within
      // 400 chars of a cwd-passing spawn is counted as in-scope itself, inflating
      // the site count past the pin count and failing a correctly-pinned file.
      const end = Math.min(starts[i + 1] ?? src.length, start + 400);
      const window = src.slice(start, end);
      if (/\bcwd\s*[:,]/.test(window) || OPTIONS_SPREAD_RE.test(window)) count += 1;
    }
    return count;
  };

  // The composer marker must read the COMPOSER call, not its surroundings. A
  // fixed-width window failed exactly here: the statement after the composer is
  // nearly always the spawn, whose options carry `cwd`, so the window matched the
  // SPAWN's cwd and counted an unpinned composer call as pinned — passing this
  // whole suite while the child inherited a stale PWD (#3193 reopened, silently).
  it('does not count a composer call that omits cwd, even next to a cwd-passing spawn', () => {
    const unpinned = [
      'const childEnv = buildCliChildEnv({ provider, model });',
      'const child = spawn(command, args, { cwd, env: childEnv });',
    ].join('\n');
    expect(spawnSitesInScope(unpinned), 'the spawn must still be in scope').toBe(1);
    expect(
      countCwdBearingComposerCalls(unpinned),
      'a buildCliChildEnv call with no cwd must NOT count as a PWD pin',
    ).toBe(0);
  });

  it('counts a composer call that passes cwd, including across a nested argument', () => {
    expect(countCwdBearingComposerCalls('buildCliChildEnv({ provider, cwd });')).toBe(1);
    // A nested object in an earlier slot must not end the argument-list walk.
    expect(countCwdBearingComposerCalls(
      'buildCliChildEnv({\n  before: { ...forgeTokenEnv, ...claudeSettingsEnv },\n  provider,\n  cwd,\n  guard: true,\n});',
    )).toBe(1);
    // ...and a nested object must not let the walk run on into the NEXT statement.
    expect(countCwdBearingComposerCalls(
      'buildCliChildEnv({ before: { A: 1 } });\nspawn(c, a, { cwd });',
    )).toBe(0);
  });

  it('discovers the cwd-passing spawn sites (guard is not vacuous)', () => {
    const found = collectServerSources().filter((rel) => spawnSitesInScope(readServerSource(rel)) > 0);
    // If this ever collapses toward zero the scan broke (a rename, a new spawn
    // wrapper) and every assertion below would pass for the wrong reason.
    expect(found.length, 'expected the scan to still find the known spawn sites').toBeGreaterThan(10);
    expect(found).toContain('cos-runner/index.js');
    expect(found).toContain('services/shell.js');
    // The forwarding-wrapper shape specifically — this one is invisible to a
    // scan that only reads inline `cwd:` literals, and missing it is what let an
    // unpinned caller-forwarded cwd through.
    expect(found).toContain('services/layeredIntelligence/runCli.js');
  });

  // Every EXEMPT entry must correspond to a file the scan actually finds.
  // A stale entry is worse than no entry: it silently pre-approves whatever
  // cwd-passing spawn is added to that file later.
  it('has no dead EXEMPT / DELEGATES / INLINE_PIN entries', () => {
    const inScope = new Set(collectServerSources().filter((rel) => spawnSitesInScope(readServerSource(rel)) > 0));
    const dead = [...EXEMPT.keys(), ...DELEGATES.keys(), ...INLINE_PIN.keys()].filter((rel) => !inScope.has(rel));
    expect(dead, 'these entries name files the scan no longer finds — delete them').toEqual([]);
  });

  it('every cwd-passing spawn either pins PWD or is explicitly exempt', () => {
    const unpinned = [];
    for (const rel of collectServerSources()) {
      const src = readServerSource(rel);
      const sites = spawnSitesInScope(src);
      if (sites === 0) continue;
      if (EXEMPT.has(rel)) continue;
      if (DELEGATES.has(rel) && src.includes(DELEGATES.get(rel))) continue;
      // Count pins rather than merely asserting one exists: a file that already
      // pins its first spawn would otherwise pass forever, even after a second,
      // unpinned cwd-spawn is added to it.
      // Two markers count as a pin: the low-level helper, and buildCliChildEnv —
      // the shared AI-CLI env composer, which calls withSpawnCwdEnv internally
      // (#3194). Counting the composer here is what lets the AI-CLI spawn sites
      // collapse to one call each without going dark to this guard.
      //
      // The composer's marker REQUIRES a `cwd` in the call. `withSpawnCwdEnv(x, cwd)`
      // cannot be called without one, but `buildCliChildEnv({ … })` takes `cwd` as an
      // optional key — so a bare `buildCliChildEnv({ provider })` followed by a
      // `spawn(cmd, args, { cwd })` would otherwise satisfy this guard while
      // reintroducing #3193 verbatim. Requiring the key keeps the two markers
      // equally strong. (askService.js legitimately calls it with no cwd — it also
      // spawns with no cwd, so it is not in scope here at all.)
      const pins = INLINE_PIN.has(rel)
        ? (src.match(/childEnv\.PWD\s*=/g) || []).length
        : (src.match(/withSpawnCwdEnv\(/g) || []).length + countCwdBearingComposerCalls(src);
      if (pins < sites) unpinned.push(`${rel} (${sites} cwd-passing spawn(s), ${pins} pin(s))`);
    }
    expect(
      unpinned,
      'These files spawn a child with an explicit (or forwarded) cwd without pinning PWD '
      + 'for it. A CLI that resolves its project root from PWD (OpenCode does) will ignore '
      + 'that cwd and run in the PortOS checkout instead — see withSpawnCwdEnv in '
      + 'server/lib/spawnCwd.js (#3193). Either pin PWD, or add the file to EXEMPT above '
      + 'with the reason it is safe.',
    ).toEqual([]);
  });
});
