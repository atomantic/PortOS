import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { computeTestMemoKeys, createDiskFs } from '../../../../scripts/lib/testMemo.js';
import { REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const WORKSPACE_TESTS = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);

describe('vitestTempRootFixture memo closure', () => {
  it('memoizes all nine fixture consumers without exempting direct Git callers', () => {
    const fs = createDiskFs(REPO_ROOT, nodeFs, nodePath);
    // The server CI job deliberately installs server dependencies only. Hide
    // client/node_modules to exercise its normal filesystem boundary rather
    // than inheriting the interactive checkout's linked client install.
    const serverOnlyFs = {
      read: rel => rel === 'client/node_modules' || rel.startsWith('client/node_modules/') ? null : fs.read(rel),
      kind: rel => rel === 'client/node_modules' || rel.startsWith('client/node_modules/') ? null : fs.kind(rel),
      list: rel => rel === 'client/node_modules' || rel.startsWith('client/node_modules/') ? [] : fs.list(rel),
    };
    const consumers = WORKSPACE_TESTS.filter(path => {
      const source = serverOnlyFs.read(path)?.toString('utf8') ?? '';
      return /(?:from|import\()\s*['"][^'"]*vitestTempRootFixture\.js['"]/.test(source);
    });
    expect(consumers).toHaveLength(9);
    const serverTests = consumers.filter(test => !test.startsWith('client/'));
    const serverVerdicts = computeTestMemoKeys(serverTests, {
      fs: serverOnlyFs, workspace: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS,
    });
    expect(serverVerdicts.size).toBe(8);
    for (const [test, verdict] of serverVerdicts) {
      expect(verdict.floor.memoizable, `${test}: ${verdict.floor.reasons.join('; ')}`).toBe(true);
      expect(verdict.closure.has('client/vitest.config.js'), `${test}: unrelated client config must stay out of the server closure`).toBe(false);
    }
    const clientTests = consumers.filter(test => test.startsWith('client/'));
    expect(clientTests).toHaveLength(1);
    const clientVerdicts = computeTestMemoKeys(clientTests, {
      fs: serverOnlyFs, workspace: 'client', env: process.env, listFiles: () => WORKSPACE_TESTS,
      // Server CI can still validate the client's locked config closure from
      // its lockfile without installing unrelated client dependencies.
      planBeforeClientSetup: true,
    });
    for (const [test, verdict] of clientVerdicts) {
      expect(verdict.floor.memoizable, `${test}: ${verdict.floor.reasons.join('; ')}`).toBe(true);
      expect(verdict.floor.key).not.toBeNull();
      expect(verdict.closure.has('client/vitest.config.js')).toBe(true);
      expect(verdict.closure.has('server/vitest.config.js')).toBe(false);
    }

    const directBudgetImport = computeTestMemoKeys(['scripts/lib/cosWorkerBudget.test.js'], {
      fs: serverOnlyFs, workspace: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS,
    }).get('scripts/lib/cosWorkerBudget.test.js');
    expect(directBudgetImport.floor).toMatchObject({ memoizable: false, reason: 'spawns git' });

    const unrelatedGitCaller = computeTestMemoKeys(['scripts/ci-base-sha.test.js'], {
      fs: serverOnlyFs, workspace: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS,
    }).get('scripts/ci-base-sha.test.js');
    expect(unrelatedGitCaller.floor).toMatchObject({ memoizable: false, reason: 'spawns git' });
  });
});
