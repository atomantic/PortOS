/**
 * A suite's `test-memo: git-fixture` line is a claim that every git process
 * it starts runs in a repository the suite created (docs/TEST_MEMO.md, "Git
 * fixtures"). When the file's own text contradicts the claim the memo falls
 * back to refusing the suite, which is safe and invisible: the suite quietly
 * returns to running on every plan, which is how the class this marker
 * exists for grew to dozens of files (#18634).
 *
 * This check makes that visible at the edit that causes it, and proves for
 * each declaring suite that the reading is live: a git call that names no
 * directory, added to that very file, must take the declaration away.
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

  it('fall as soon as the suite starts git without naming a fixture directory', () => {
    const stillStanding = declaring.filter(({ facts }) => facts.gitFixture).filter(({ file, source }) => {
      const facts = read(file, `${source}\nexecFileSync('git', ['rev-parse', 'HEAD']);\n`);
      return facts.gitFixture || !/starts git without naming the directory/.test(facts.gitFixtureProblem ?? '');
    }).map(({ file }) => file);
    expect(stillStanding).toEqual([]);
  });
});
