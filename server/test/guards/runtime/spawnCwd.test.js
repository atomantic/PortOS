import { describe, it, expect, afterAll } from 'vitest';
import { collectServerSources, readServerSource } from '../../guardSources.js';

let serverSourcesCache;
const trackedServerSources = () => (serverSourcesCache ??= collectServerSources());

let scanCache;
function scanTree(spawnSitesInScope) {
  if (scanCache) return scanCache;
  const sources = trackedServerSources();
  const sitesByFile = new Map();
  const inScopeFiles = [];

  for (const rel of sources) {
    const src = readServerSource(rel);
    const sites = spawnSitesInScope(src);
    if (sites > 0) {
      sitesByFile.set(rel, { sites, src });
      inScopeFiles.push(rel);
    }
  }

  scanCache = { sitesByFile, inScopeFiles };
  return scanCache;
}

afterAll(() => {
  scanCache = undefined;
  serverSourcesCache = undefined;
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
    ['lib/windowsGitProcess.js', 'Git supervisor and its system compiler resolve paths from the actual cwd'],
    ['lib/planIds.js', 'git only'],
    ['services/gitlab.js', 'glab only'],
    ['services/pm2.js', 'pm2 only'],
    ['services/xcodeScripts.js', 'xcodebuild/ls, not an AI CLI'],
    ['services/imageTo3d/laneRunner.js', 'git/bash/python install + render steps inside a target install root, not an AI CLI'],
    ['services/dbAdmin.js', 'psql/pg_dump, not an AI CLI'],
    ['routes/scaffold.js', 'npm/git scaffolding, not an AI CLI'],
    ['routes/scaffoldVite.js', 'npm scaffolding, not an AI CLI'],
    ['routes/apps/launch.js', "detached launch into the user's own terminal; the CLI reads process.cwd()"],
  ]);

  // Files whose cwd-passing spawns all go through a shared wrapper that already
  // pins, so they need no call of their own.
  const DELEGATES = new Map([
    ['services/appBuilder.js', 'bufferedSpawn'],
    ['services/appDeployer.js', 'bufferedSpawn'],
    ['services/repoCloner.js', 'bufferedSpawn'],
  ]);

  // Files that pin by inlining the assignment instead of calling the shared
  // helper, with the reason they cannot call it.
  const INLINE_PIN = new Map([
    ['lib/aiToolkit/internal/codexModelListProbe.js', 'vendored toolkit metadata probe — must not import host modules'],
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
  // wrapper like lib/runCliBounded). The forwarding case matters as
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
    const found = scanTree(spawnSitesInScope).inScopeFiles;
    // If this ever collapses toward zero the scan broke (a rename, a new spawn
    // wrapper) and every assertion below would pass for the wrong reason.
    expect(found.length, 'expected the scan to still find the known spawn sites').toBeGreaterThan(10);
    expect(found).toContain('cos-runner/index.js');
    expect(found).toContain('services/shell.js');
    // The forwarding-wrapper shape specifically — this one is invisible to a
    // scan that only reads inline `cwd:` literals, and missing it is what let an
    // unpinned caller-forwarded cwd through.
    expect(found).toContain('lib/runCliBounded.js');
  });

  // Every EXEMPT entry must correspond to a file the scan actually finds.
  // A stale entry is worse than no entry: it silently pre-approves whatever
  // cwd-passing spawn is added to that file later.
  it('has no dead EXEMPT / DELEGATES / INLINE_PIN entries', () => {
    const inScope = new Set(scanTree(spawnSitesInScope).inScopeFiles);
    const dead = [...EXEMPT.keys(), ...DELEGATES.keys(), ...INLINE_PIN.keys()].filter((rel) => !inScope.has(rel));
    expect(dead, 'these entries name files the scan no longer finds — delete them').toEqual([]);
  });

  it('every cwd-passing spawn either pins PWD or is explicitly exempt', () => {
    const unpinned = [];
    const { sitesByFile } = scanTree(spawnSitesInScope);
    for (const [rel, { sites, src }] of sitesByFile.entries()) {
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
