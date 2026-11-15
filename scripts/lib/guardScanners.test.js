import { describe, it, expect } from 'vitest';
import { scansTrackedTree, readsUnnamedCrossRootFile } from './guardScanners.js';

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
