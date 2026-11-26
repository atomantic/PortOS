/**
 * A suite's `test-memo: git-fixture` line is a claim that every git process
 * it starts runs in a repository the suite created (docs/TEST_MEMO.md, "Git
 * fixtures"). When the file's own text contradicts the claim the memo falls
 * back to refusing the suite, which is safe and invisible: the suite quietly
 * returns to running on every plan, which is how the class this marker
 * exists for grew to dozens of files (#18634).
 *
 * This check reports contradictions at the edit that introduces them.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readText, REPO_ROOT as root, workingTreeFiles } from '../../../../scripts/lib/guardCorpus.js';
import { computeTestMemoKeys, createDiskFs } from '../../../../scripts/lib/testMemo.js';
import { listRepositoryFiles } from '../../../../scripts/lib/testMemoRunner.js';
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

  it('keys all four isolated repository tools and keeps live Docker ineligible', () => {
    const fixtures = [
      'scripts/check-import-case.test.js', 'scripts/contained-run.test.js',
      'scripts/lib/guardCorpus.test.js', 'scripts/lib/importGrowth.test.js',
    ];
    const liveDocker = 'server/services/dockerContainment.live.test.js';
    const verdicts = computeTestMemoKeys([...fixtures, liveDocker], {
      fs: createDiskFs(root, nodeFs, nodePath),
      listFiles: () => listRepositoryFiles(root),
      workspace: 'server',
      // Exercise fixture scope independent of the installed Git version.
      toolVersion: (tool) => tool === 'git' ? 'fixture-git' : null,
    });
    for (const file of fixtures) {
      const { floor } = verdicts.get(file);
      expect(floor, file).toMatchObject({ memoizable: true, key: expect.any(String) });
    }
    expect(verdicts.get(liveDocker).floor).toMatchObject({ memoizable: false, reason: 'test-memo: never marker' });
  });

  it('refuses an unscoped git call added to a declaring suite', () => {
    const entry = declaring.find(({ facts }) => facts.gitFixture);
    expect(entry).toBeDefined();
    const facts = read(entry.file, `${entry.source}\nexecFileSync('git', ['rev-parse', 'HEAD']);\n`);
    expect(facts.gitFixture).toBe(false);
    expect(facts.gitFixtureProblem).toMatch(/starts git without naming the directory/);
  });
});
