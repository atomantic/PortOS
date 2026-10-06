import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { teardown } from './vitestTempRootSetup.js';

describe('vitestTempRootSetup teardown', () => {
  const originalRoot = process.env.PORTOS_TEST_TEMP_ROOT;
  const originalExit = process.exitCode;
  afterEach(() => {
    process.env.PORTOS_TEST_TEMP_ROOT = originalRoot;
    if (originalRoot === undefined) delete process.env.PORTOS_TEST_TEMP_ROOT;
    process.exitCode = originalExit;
    vi.restoreAllMocks();
  });

  function runTeardown(populate) {
    const root = mkdtempSync(join(tmpdir(), 'pvt-teardown-test-'));
    populate(root);
    process.env.PORTOS_TEST_TEMP_ROOT = root;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.exitCode = undefined;
    teardown();
    const result = { warnings: warn.mock.calls.map((c) => c[0]), exitCode: process.exitCode, removed: !existsSync(root) };
    rmSync(root, { recursive: true, force: true });
    return result;
  }

  it('ignores browser-owned Chrome scratch directories but still fails on a leaked fixture beside them', () => {
    const browserOnly = runTeardown((root) => {
      for (const name of ['com.google.Chrome.aB3dE9', '.com.google.Chrome.xY7zQ2', '.org.chromium.Chromium.k9L2mN']) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, 'sock'), 'x');
      }
    });
    expect(browserOnly.warnings).toEqual([]);
    expect(browserOnly.exitCode).toBeUndefined();

    const withFixture = runTeardown((root) => {
      mkdirSync(join(root, 'com.google.Chrome.aB3dE9'));
      writeFileSync(join(root, 'com.google.Chrome.aB3dE9', 'sock'), 'x');
      mkdirSync(join(root, 'mv-review-browser-Abc123'));
      writeFileSync(join(root, 'mv-review-browser-Abc123', 'data.json'), '{}');
    });
    expect(withFixture.warnings).toEqual(['⚠️ test temp leak: mv-review-browser- ×1']);
    expect(withFixture.exitCode).toBe(1);
  });

  it('ignores the macOS xcrun cache but still fails on a real leaked fixture', () => {
    const clean = runTeardown((root) => writeFileSync(join(root, 'xcrun_db'), 'cache'));
    expect(clean.warnings).toEqual([]);
    expect(clean.exitCode).toBeUndefined();
    expect(clean.removed).toBe(true);

    const leaked = runTeardown((root) => {
      writeFileSync(join(root, 'xcrun_db'), 'cache');
      mkdirSync(join(root, 'fixture-Abc123'));
      writeFileSync(join(root, 'fixture-Abc123', 'data.json'), '{}');
    });
    expect(leaked.warnings).toEqual(['⚠️ test temp leak: fixture- ×1']);
    expect(leaked.exitCode).toBe(1);
  });
});
