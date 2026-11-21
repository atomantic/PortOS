import { describe, it, expect } from 'vitest';
import {
  scansTrackedTree, readsUnnamedCrossRootFile, hasRecursiveDirectoryWalk, shellsOutToGitEnumeration,
  findUnsuffixedScanners, isGuardTest,
  GUARD_CHECK_DIRS, guardCheckModules, registerGuardChecks,
} from './guardScanners.js';
import { mkdtempSync, readFileSync as readLog, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('guard scanner detectors (#5055, #6363, #8723)', () => {
  it('detects the scan shape it registers, and leaves ordinary tests alone', () => {
    // Bypass probe: proves the detector bites, so the assertion below cannot
    // pass because the regexes quietly stopped matching anything.
    expect(scansTrackedTree("const files = execFileSync('git', ['ls-files', '*.js'], opts);")).toBe(true);
    expect(scansTrackedTree("execFileSync(\n  'git',\n  ['grep', '-n', 'x'],\n);")).toBe(true);
    expect(scansTrackedTree("import { trackedSourceFiles } from './test/trackedFiles.js';")).toBe(true);
    expect(scansTrackedTree("import { thing } from './thing.js';\nexpect(thing()).toBe(1);")).toBe(false);
    // A comment mentioning the command is not an invocation.
    expect(scansTrackedTree('// enumerated via git ls-files rather than a walk')).toBe(false);
    // Directory walkers (#8723): the shared source walkers and a recursive readdir.
    expect(scansTrackedTree("const offenders = collectServerSources().filter(bad);")).toBe(true);
    expect(scansTrackedTree("for (const f of collectClientSources()) check(f);")).toBe(true);
    expect(scansTrackedTree("const all = readdirSync(root, { recursive: true });")).toBe(true);
    expect(scansTrackedTree("// a readdirSync(root, { recursive: true }) walk is too slow")).toBe(false);
    expect(scansTrackedTree("rmSync(dir, { recursive: true, force: true });")).toBe(false);
  });

  it('ignores scan shapes quoted as fixture strings, but not a real call', () => {
    const fixtureOnly = 'it("x", () => { expect(scansTrackedTree("execFileSync(\'git\', [\'ls-files\'])")).toBe(true); });';
    expect(scansTrackedTree(fixtureOnly)).toBe(false);
    expect(scansTrackedTree(`${fixtureOnly}\nconst f = execFileSync('git', ['ls-files'], o);`)).toBe(true);
  });

  it('detects a hand-rolled recursive directory walker in each shape it is written in (#16553)', () => {
    // Braceless arrow, the apiAccessPolicy shape.
    expect(hasRecursiveDirectoryWalk(
      "const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {\n"
      + "  const path = join(dir, entry.name);\n"
      + "  return entry.isDirectory() ? walk(path) : [path];\n});",
    )).toBe(true);
    // Function declaration with an accumulator, the dispatchLabels.audit shape.
    expect(hasRecursiveDirectoryWalk(
      "function collect(dir, found = []) {\n  for (const name of readdirSync(dir)) {\n"
      + "    const full = join(dir, name);\n    if (statSync(full).isDirectory()) collect(full, found);\n"
      + "    else found.push(full);\n  }\n  return found;\n}",
    )).toBe(true);
    // Block-bodied arrow, a function expression, and the promise API.
    expect(hasRecursiveDirectoryWalk("const walk = (dir) => { for (const e of fs.readdirSync(dir)) walk(join(dir, e)); };")).toBe(true);
    expect(hasRecursiveDirectoryWalk("const walk = function (dir) { for (const e of readdirSync(dir)) walk(join(dir, e)); };")).toBe(true);
    expect(hasRecursiveDirectoryWalk("const walk = async (dir) => { for (const e of await readdir(dir)) await walk(join(dir, e)); };")).toBe(true);
    // One level only: lists a directory but never descends.
    expect(hasRecursiveDirectoryWalk("const names = (dir) => readdirSync(dir).filter((n) => n.endsWith('.js'));")).toBe(false);
    // A recursive function that lists nothing, beside an unrelated flat listing.
    expect(hasRecursiveDirectoryWalk("const fact = (n) => (n < 2 ? 1 : n * fact(n - 1));\nconst names = readdirSync(dir);")).toBe(false);
    // A method call that merely shares the function's name is not a self-call.
    expect(hasRecursiveDirectoryWalk("const walk = (dir) => readdirSync(dir).map((n) => tree.walk(n));")).toBe(false);
    // A walker quoted as a fixture string or described in a comment is data, not a scan.
    expect(hasRecursiveDirectoryWalk("const fixture = 'const walk = (d) => readdirSync(d).flatMap((n) => walk(n));';")).toBe(false);
    expect(hasRecursiveDirectoryWalk("// const walk = (d) => readdirSync(d).flatMap((n) => walk(n));\nexpect(1).toBe(1);")).toBe(false);
  });

  it('detects git enumeration through every spawner and as one shell string (#16553)', () => {
    expect(scansTrackedTree("const out = spawnSync('git', ['grep', '-l', 'x'], { encoding: 'utf8' });")).toBe(true);
    expect(shellsOutToGitEnumeration("const files = execSync('git ls-files \"src/**/*.test.js\"', { cwd });")).toBe(true);
    expect(shellsOutToGitEnumeration('const files = execSync(`git ls-files ${glob}`, { cwd });')).toBe(true);
    expect(scansTrackedTree("const files = execSync('git ls-files', { cwd }).toString();")).toBe(true);
    // Another git subcommand, another program, and the command quoted as fixture data.
    expect(shellsOutToGitEnumeration("execSync('git status --porcelain', { cwd });")).toBe(false);
    expect(shellsOutToGitEnumeration("execSync('npm ls', { cwd });")).toBe(false);
    expect(shellsOutToGitEnumeration("const fixture = \"execSync('git ls-files')\";")).toBe(false);
    // git run in a temp repository for some other reason is not a tree scan.
    expect(scansTrackedTree("spawnSync('git', ['init'], { cwd: dir });")).toBe(false);
  });

  it('names a scanner that lacks the guard suffix, and nothing else (#16553)', () => {
    const walker = "const walk = (dir) => readdirSync(dir).flatMap((name) => walk(join(dir, name)));\nit('scans', () => expect(walk(ROOT)).toEqual([]));";
    const plain = "import { thing } from './thing.js';\nit('works', () => expect(thing()).toBe(1));";
    expect(isGuardTest('server/lib/newWalker.guard.test.js')).toBe(true);
    expect(isGuardTest('client/src/Widget.guard.test.jsx')).toBe(true);
    expect(isGuardTest('server/lib/childProcess.guards.test.js')).toBe(false);
    expect(isGuardTest('server/lib/guard.test.js')).toBe(false);
    expect(findUnsuffixedScanners({
      'server/lib/newWalker.test.js': walker,
      'server/lib/newWalker.guard.test.js': walker,
      'server/lib/thing.test.js': plain,
      'scripts/tempDirWalker.test.js': walker,
    }, new Set(['scripts/tempDirWalker.test.js']))).toEqual(['server/lib/newWalker.test.js']);
  });

  it('detects the unnamed-cross-root-read shape it registers, and leaves a named read alone (#6363)', () => {
    // Bypass probe: proves the detector bites before the assertions below rely
    // on it having stopped matching anything.
    expect(readsUnnamedCrossRootFile(
      "const DIR = join(here, '../../client/src/lib');\nreadFileSync(join(DIR, name), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(true);
    // Same directory constant, but the file IS named as one literal elsewhere —
    // that literal is what the basename `git grep` lookup matches.
    expect(readsUnnamedCrossRootFile(
      "const DIR = join(here, '../../client/src/lib');\n"
      + "readFileSync(join(DIR, name), 'utf8');\n"
      + "readFileSync(join(here, '../../client/src/lib/x.js'), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(false);
    // No readFileSync at all — an ordinary import-graph-reachable test.
    expect(readsUnnamedCrossRootFile(
      "import { x } from '../../client/src/lib/x.js';",
      'server/lib/example.test.js',
    )).toBe(false);
    // readFileSync of a same-root file is not a cross-root read.
    expect(readsUnnamedCrossRootFile(
      "readFileSync(join(here, 'sibling.js'), 'utf8');",
      'server/lib/example.test.js',
    )).toBe(false);
  });
});

describe('structural guard runner registration (#16996)', () => {
  it("logs each check's load time for the guard budget when the runner is asked to", async () => {
    const { dir, runner } = GUARD_CHECK_DIRS[0];
    const root = join(import.meta.dirname, '..', '..');
    const logDir = mkdtempSync(join(tmpdir(), 'portos-guard-load-log-'));
    try {
      const log = join(logDir, 'loads.jsonl');
      const loaded = [];
      const factories = [];
      const describe = (name, factory) => { factories.push(factory); };
      registerGuardChecks(pathToFileURL(join(root, dir, '/')), { describe, it: () => {}, load: async (name) => { loaded.push(name); }, env: { PORTOS_GUARD_LOAD_LOG: log } });
      for (const factory of factories) await factory();
      const checks = guardCheckModules(join(root, dir));
      expect(loaded).toEqual(checks);
      const records = readLog(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(records.map(({ check }) => check)).toEqual(checks.map((name) => name.replace(/\.test\.jsx?$/, '')));
      expect(records.every((record) => record.runner === runner && Number.isFinite(record.ms))).toBe(true);
      // Without the variable, nothing is written.
      registerGuardChecks(pathToFileURL(join(root, dir, '/')), { describe, it: () => {}, load: async () => {}, env: {} });
      for (const factory of factories.splice(0)) await factory();
      expect(readLog(log, 'utf8').trim().split('\n')).toHaveLength(checks.length * 2);
    } finally {
      rmSync(logDir, { recursive: true, force: true });
    }
  });
});
