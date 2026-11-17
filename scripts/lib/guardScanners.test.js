import { describe, it, expect } from 'vitest';
import { scansTrackedTree, readsUnnamedCrossRootFile, hasRecursiveDirectoryWalk } from './guardScanners.js';

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
