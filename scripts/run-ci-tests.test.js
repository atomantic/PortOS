import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  recordVitestDuration,
  relatedInputs,
  requiresSourceFiles,
  toRunnerPath,
} from './run-ci-tests.js';

describe('toRunnerPath', () => {
  it('maps repo paths onto each workspace runner root', () => {
    expect(toRunnerPath('client', 'client/src/lib/index.test.js')).toBe('./src/lib/index.test.js');
    expect(toRunnerPath('server', 'server/lib/index.test.js')).toBe('./lib/index.test.js');
    expect(toRunnerPath('server', 'scripts/checkNodeVersion.test.js')).toBe('../scripts/checkNodeVersion.test.js');
  });
});

describe('recordVitestDuration', () => {
  const originalSummary = process.env.GITHUB_STEP_SUMMARY;
  let summaryDir;

  afterEach(() => {
    if (originalSummary === undefined) delete process.env.GITHUB_STEP_SUMMARY;
    else process.env.GITHUB_STEP_SUMMARY = originalSummary;
    if (summaryDir) {
      rmSync(summaryDir, { recursive: true, force: true });
      summaryDir = undefined;
    }
  });

  it('writes wall time to the GitHub step summary when one is configured', () => {
    summaryDir = mkdtempSync(join(tmpdir(), 'vitest-duration-'));
    const summaryPath = join(summaryDir, 'summary.md');
    process.env.GITHUB_STEP_SUMMARY = summaryPath;
    recordVitestDuration('server', 'full suite', Date.now() - 1500);
    expect(readFileSync(summaryPath, 'utf8')).toMatch(/^⏱ server full suite: 1\.\ds\n$/);
  });
});

describe('requiresSourceFiles', () => {
  it('fails closed only when related mode has no source selector', () => {
    expect(requiresSourceFiles('related', [])).toBe(true);
    expect(requiresSourceFiles('related', ['server/services/auth.js'])).toBe(false);
    expect(requiresSourceFiles('files', [])).toBe(false);
    expect(requiresSourceFiles('full', [])).toBe(false);
  });
});

describe('relatedInputs', () => {
  it('runs source-related tests and explicit guards in one deduplicated invocation', () => {
    expect(relatedInputs(
      ['./services/auth.js', './services/auth.test.js'],
      ['./services/auth.test.js', '../scripts/repo-scan-guards.test.js'],
    )).toEqual([
      './services/auth.js',
      './services/auth.test.js',
      '../scripts/repo-scan-guards.test.js',
    ]);
  });
});
