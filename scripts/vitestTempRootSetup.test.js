import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
      for (const name of ['com.google.Chrome.aB3dE9', '.com.google.Chrome.xY7zQ2', '.org.chromium.Chromium.k9L2mN', 'com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.AbC123', 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123']) {
        mkdirSync(join(root, name));
        writeFileSync(join(root, name, 'sock'), 'x');
      }
    });
    expect(browserOnly.warnings).toEqual([]);
    expect(browserOnly.exitCode).toBeUndefined();
    expect(browserOnly.removed).toBe(true);

    const withFixture = runTeardown((root) => {
      mkdirSync(join(root, 'com.google.Chrome.aB3dE9'));
      writeFileSync(join(root, 'com.google.Chrome.aB3dE9', 'sock'), 'x');
      mkdirSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123'));
      writeFileSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123', 'download.crx'), 'x');
      mkdirSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_fixture.AbC123'));
      writeFileSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_fixture.AbC123', 'data.json'), '{}');
      mkdirSync(join(root, 'mv-review-browser-Abc123'));
      writeFileSync(join(root, 'mv-review-browser-Abc123', 'data.json'), '{}');
    });
    expect(withFixture.warnings.sort()).toEqual([
      '⚠️ test temp leak: com.google.Chrome.chrome_chrome_url_fetcher_fixture. ×1',
      '⚠️ test temp leak: mv-review-browser- ×1',
    ]);
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

  it('names the test file that minted a leaked root, and never reports the owner sidecar itself', () => {
    const leaked = runTeardown((root) => {
      mkdirSync(join(root, 'mv-song-browser-Abc123'));
      writeFileSync(join(root, 'mv-song-browser-Abc123', 'chrome-profile'), 'x');
      mkdirSync(join(root, 'unowned-Xyz789'));
      writeFileSync(join(root, 'unowned-Xyz789', 'data.json'), '{}');
      writeFileSync(join(root, '.leak-owners'), 'mv-song-browser-Abc123\tsongRevision.browser.test.js\n');
    });
    expect(leaked.warnings.sort()).toEqual([
      '⚠️ test temp leak: mv-song-browser- ×1 (created by songRevision.browser.test.js)',
      '⚠️ test temp leak: unowned- ×1',
    ]);
    expect(leaked.exitCode).toBe(1);
  });

  it('removes leaked cyclic and dangling links without walking or changing their targets', () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'pvt-link-teardown-'));
    const root = join(sandbox, 'run');
    const outside = join(sandbox, 'outside');
    const fixture = join(root, 'fixture-links');
    const directoryLink = process.platform === 'win32' ? 'junction' : 'dir';
    try {
      mkdirSync(fixture, { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep'), 'host data');
      // Two links make the old follow-symlinks walk branch until ELOOP at
      // every leaf. Run the real teardown in a bounded child so a regression
      // cannot block the enclosing runner's event loop and its test timeout.
      symlinkSync(fixture, join(fixture, 'a'), directoryLink);
      symlinkSync(fixture, join(fixture, 'b'), directoryLink);
      symlinkSync(outside, join(root, 'outside-link'), directoryLink);
      symlinkSync(join(sandbox, 'missing'), join(root, 'dangling-link'), directoryLink);
      const result = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { teardown } from ${JSON.stringify(new URL('./vitestTempRootSetup.js', import.meta.url).href)}; teardown();`], {
        env: { ...process.env, PORTOS_TEST_TEMP_ROOT: root },
        encoding: 'utf8', timeout: 5000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      for (const name of ['fixture-links', 'outside-link', 'dangling-link']) {
        expect(result.stderr).toContain(`test temp leak: ${name} ×1`);
      }
      expect(existsSync(root)).toBe(false);
      expect(readFileSync(join(outside, 'keep'), 'utf8')).toBe('host data');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
