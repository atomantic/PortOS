/**
 * A suite's `test-memo: git-fixture` line is a claim that every git process
 * it starts runs in a repository the suite created (docs/TEST_MEMO.md, "Git
 * fixtures"). When the file's own text contradicts the claim the memo falls
 * back to refusing the suite, which is safe and invisible: the suite quietly
 * returns to running on every plan, which is how the class this marker
 * exists for grew to dozens of files (#18634).
 *
 * This check makes that visible at the edit that causes it, and proves for
 * each declaring suite that the reading is live: each way of starting git in
 * the checkout below, added to that very file, must take the declaration
 * away, with the reason that names it.
 */
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText, REPO_ROOT as root, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';
import { GIT_FIXTURE_MARKER } from '../../../../scripts/lib/testMemo/constants.js';
import { extractFileFacts } from '../../../../scripts/lib/testMemo/fileFacts.js';

// Scans the working tree, so it is derived into the always-run set (#10312).
describe('test-memo: git-fixture declarations', () => {
  // The memo's own tests carry the marker inside fixture strings; the guard checks only mention it.
  const candidates = workingTreeFiles(root, ['*.test.js', '*.test.jsx', '*.test.mjs', ':!server/test/guards'])
    .map((file) => ({ file, source: readText(join(root, file)) }))
    .filter(({ source }) => GIT_FIXTURE_MARKER.test(source));
  const read = (file, source) => extractFileFacts(source, { fileRel: file, cwdRel: file.startsWith('client/') ? 'client' : 'server' });
  const declaring = candidates.map(({ file, source }) => ({ file, source, facts: read(file, source) }))
    .filter(({ facts }) => facts.gitFixture || facts.gitFixtureProblem !== null);

  it('stand in every suite that makes one', () => {
    expect(declaring.length).toBeGreaterThan(0);
    const refused = declaring.filter(({ facts }) => !facts.gitFixture)
      .map(({ file, facts }) => `${file}: ${facts.gitFixtureProblem}. Run git only in repositories the suite creates, or remove the marker (the suite then runs on every plan).`);
    expect(refused).toEqual([]);
  });

  // Names no suite uses, so a reason is never the suite's own.
  const WRAPPER = "const __probe = (__probeDir) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });";
  it.each([
    ['names no directory', "execFileSync('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['gives a nullish directory', "execFileSync('git', ['rev-parse', 'HEAD'], { cwd: undefined });", /nullish directory/],
    ['names git through a constant', "const __probeProgram = 'git';\nexecFileSync(__probeProgram, ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['hands git to a runner as its program', "const __probe = (__probeProgram, __probeArgs) => execFileSync(__probeProgram, __probeArgs);\n__probe('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['starts git through an alias of the spawn callee', "const __probeSpawn = execFileSync;\n__probeSpawn('git', ['rev-parse', 'HEAD']);", /starts git without naming the directory/],
    ['takes the process directory out of the environment', "execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.env.PWD });", /process\.env\.PWD/],
    ['hands a shell a git command line', "execFileSync('sh', ['-c', 'git rev-parse HEAD']);", /runs git through a command line/],
    ['hands the checkout to code it does not define', '__probeImported(process.cwd());', /hands the repository directory \S+ to code that may run git there/],
    ['calls a wrapper without its directory', `${WRAPPER}\n__probe();`, /__probe\(\) is called without the directory/],
    ['calls a wrapper with an undefined directory', `${WRAPPER}\n__probe(undefined);`, /nullish directory/],
    ['calls a wrapper with a relative directory', `${WRAPPER}\n__probe('.');`, /relative to the test process/],
    ['calls a wrapper with the process directory', `${WRAPPER}\n__probe(process.cwd());`, /hands git a path in this repository/],
    ['defaults a wrapper to the process directory', "const __probe = (__probeDir = process.cwd()) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });\n__probe();", /hands git a path in this repository/],
    ['reaches a wrapper through .call', `${WRAPPER}\n__probe.call(null);`, /__probe\(\) runs git and is used other than by a direct call/],
    ['reaches a wrapper through .apply', `${WRAPPER}\n__probe.apply(null, []);`, /__probe\(\) runs git and is used other than by a direct call/],
    ['reaches a wrapper through .bind', `${WRAPPER}\n__probe.bind(null)();`, /__probe\(\) runs git and is used other than by a direct call/],
    ['gives an options pattern no directory', "const __probe = ({ __probeDir }) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __probeDir });\n__probe({});", /__probe\(\) is called without the directory/],
    ['gives an options parameter no directory', "const __probe = (__probeOptions = {}) => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __probeOptions.cwd });\n__probe();", /__probe\(\) is called without the directory/],
  ])('fall as soon as the suite %s', (_label, addition, reason) => {
    const stillStanding = declaring.filter(({ facts }) => facts.gitFixture).filter(({ file, source }) => {
      const facts = read(file, `${source}\n${addition}\n`);
      return facts.gitFixture || !reason.test(facts.gitFixtureProblem ?? '');
    }).map(({ file }) => file);
    expect(stillStanding).toEqual([]);
  });
});
