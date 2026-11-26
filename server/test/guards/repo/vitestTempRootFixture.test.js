import { describe, expect, it } from 'vitest';
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { createDiskFs, createTestMemoAnalyzer } from '../../../../scripts/lib/testMemo.js';
import { REPO_ROOT, trackedFiles } from '../../../../scripts/lib/guardCorpus.js';

const WORKSPACE_TESTS = trackedFiles(REPO_ROOT, ['*.test.js', '*.test.jsx']);

describe('vitestTempRootFixture memo closure', () => {
  it('keeps each fixture consumer memoizable unless policy explicitly refuses it', () => {
    const fs = createDiskFs(REPO_ROOT, nodeFs, nodePath);
    const analyzer = createTestMemoAnalyzer({ fs, workspaceRel: 'server', env: process.env, listFiles: () => WORKSPACE_TESTS });
    const consumers = WORKSPACE_TESTS.filter(path => {
      const source = fs.read(path)?.toString('utf8') ?? '';
      return /(?:from|import\()\s*['"][^'"]*vitestTempRootFixture\.js['"]/.test(source);
    });
    expect(consumers).toHaveLength(9);
    const baseClosure = analyzer.workspaceBase([], []);

    for (const test of consumers) {
      const verdict = analyzer.analyzeTest(test, { baseClosure });
      if (verdict.floor.reason === 'spawns git' || verdict.floor.reason === 'test-memo: never marker') {
        expect(verdict.floor.memoizable, `${test}: ${verdict.floor.reason}`).toBe(false);
      } else {
        expect(verdict.floor.memoizable, `${test}: ${verdict.floor.reason}`).toBe(true);
      }
    }
  });
});
