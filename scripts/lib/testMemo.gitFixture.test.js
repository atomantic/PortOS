import { describe, expect, it } from 'vitest';
import { extractFileFacts } from './testMemo/fileFacts.js';

describe('git-fixture contradictions', () => {
  const PROBE_FIXTURE = [
    '// test-memo: git-fixture',
    "import { execFileSync as runCommand } from 'node:child_process';",
    "import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os';",
    "const repo = mkdtempSync(tmpdir() + '/git-fixture-');",
    "runCommand('git', ['init'], { cwd: repo });",
  ].join('\n');
  const probeFacts = (source) => extractFileFacts(source, { fileRel: 'server/lib/repo.test.js', cwdRel: 'server' });

  it('accepts the isolated synthetic fixture', () => {
    expect(probeFacts(PROBE_FIXTURE).gitFixture).toBe(true);
  });

  const PROBE_WRAPPER = "const __probe = (__probeDir) => runCommand('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });";
  it.each([
    ['names no directory', "runCommand('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['gives a nullish directory', "runCommand('git', ['rev-parse', 'HEAD'], { cwd: undefined });", /nullish directory/],
    ['names git through a constant', "const __probeProgram = 'git';\nrunCommand(__probeProgram, ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['hands git to a runner as its program', "const __probe = (__probeProgram, __probeArgs) => runCommand(__probeProgram, __probeArgs);\n__probe('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['starts git through an alias of the spawn callee', "const __probeSpawn = runCommand;\n__probeSpawn('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['takes the process directory out of the environment', "runCommand('git', ['rev-parse', 'HEAD'], { cwd: process.env.PWD });", /process\.env\.PWD/],
    ['hands a shell a git command line', "runCommand('sh', ['-c', 'git rev-parse HEAD']);", /runs git through a command line/],
    ['hands the checkout to code it does not define', '__probeImported(process.cwd());', /hands the repository directory \S+ to code that may run git there/],
    ['calls a wrapper without its directory', `${PROBE_WRAPPER}\n__probe();`, /__probe\(\) is called without the directory/],
    ['calls a wrapper with an undefined directory', `${PROBE_WRAPPER}\n__probe(undefined);`, /nullish directory/],
    ['calls a wrapper with a relative directory', `${PROBE_WRAPPER}\n__probe('.');`, /relative to the test process/],
    ['calls a wrapper with the process directory', `${PROBE_WRAPPER}\n__probe(process.cwd());`, /hands git a path in this repository/],
    ['defaults a wrapper to the process directory', "const __probe = (__probeDir = process.cwd()) => runCommand('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });\n__probe();", /hands git a path in this repository/],
    ['reaches a wrapper through .call', `${PROBE_WRAPPER}\n__probe.call(null);`, /__probe\(\) runs git and is used other than by a direct call/],
    ['reaches a wrapper through .apply', `${PROBE_WRAPPER}\n__probe.apply(null, []);`, /__probe\(\) runs git and is used other than by a direct call/],
    ['reaches a wrapper through .bind', `${PROBE_WRAPPER}\n__probe.bind(null)();`, /__probe\(\) runs git and is used other than by a direct call/],
    ['gives an options pattern no directory', "const __probe = ({ __probeDir }) => runCommand('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });\n__probe({});", /__probe\(\) is called without the directory/],
    ['gives an options parameter no directory', "const __probe = (__probeOptions = {}) => runCommand('git', ['rev-parse', 'HEAD'], { cwd: __probeOptions.cwd });\n__probe();", /__probe\(\) is called without the directory/],
  ])('refuses a declaration when the suite %s', (_label, addition, reason) => {
    const facts = probeFacts(`${PROBE_FIXTURE}\n${addition}\n`);
    expect(facts.gitFixture).toBe(false);
    expect(facts.gitFixtureProblem).toMatch(reason);
  });
});
