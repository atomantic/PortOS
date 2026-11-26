import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { computeTestMemoKeys, createDiskFs } from '../../../../scripts/lib/testMemo.js';
import { REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const WORKSPACE_TESTS = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);

describe('vitestTempRootFixture memo closure', () => {
  it('memoizes all nine fixture consumers without exempting direct Git callers', () => {
    const fs = createDiskFs(REPO_ROOT, nodeFs, nodePath);
    const consumers = WORKSPACE_TESTS.filter(path => {
      const source = fs.read(path)?.toString('utf8') ?? '';
      return /(?:from|import\()\s*['"][^'"]*vitestTempRootFixture\.js['"]/.test(source);
    });
    expect(consumers).toHaveLength(9);
    for (const workspace of ['server', 'client']) {
      const tests = consumers.filter(test => test.startsWith(`${workspace}/`) || (!test.startsWith('client/') && workspace === 'server'));
      const verdicts = computeTestMemoKeys(tests, { fs, workspace, env: process.env, listFiles: () => WORKSPACE_TESTS });
      for (const [test, verdict] of verdicts) {
        expect(verdict.floor.memoizable, `${test}: ${verdict.floor.reasons.join('; ')}`).toBe(true);
      }
    }

    const directBudgetImport = computeTestMemoKeys(['scripts/lib/cosWorkerBudget.test.js'], {
      fs, workspace: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS,
    }).get('scripts/lib/cosWorkerBudget.test.js');
    expect(directBudgetImport.floor).toMatchObject({ memoizable: false, reason: 'spawns git' });

    const unrelatedGitCaller = computeTestMemoKeys(['server/instructionFileReferences.test.js'], {
      fs, workspace: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS,
    }).get('server/instructionFileReferences.test.js');
    expect(unrelatedGitCaller.floor).toMatchObject({ memoizable: false, reason: 'spawns git' });
  });
});
