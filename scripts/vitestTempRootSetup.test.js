import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupRunTempRoot, setup } from './vitestTempRootSetup.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

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
    process.env.PORTOS_TEST_TEMP_ROOT = root;
    populate(root);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    cleanupRunTempRoot();
    const result = { warnings: warn.mock.calls.map((c) => c[0]), errors: error.mock.calls.map((c) => c[0]), exitCode: process.exitCode, removed: !existsSync(root) };
    rmSync(root, { recursive: true, force: true });
    return result;
  }

  it('defers root cleanup until Vitest closes its pool and retains the setup root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pvt-close-test-'));
    const onClose = vi.fn();
    try {
      process.env.PORTOS_TEST_TEMP_ROOT = root;
      expect(setup({ vitest: { onClose } })).toBeUndefined();
      expect(existsSync(root)).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      process.env.PORTOS_TEST_TEMP_ROOT = originalRoot;
      await onClose.mock.calls[0][0]();
      expect(existsSync(root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('ignores browser-owned Chrome scratch directories but still fails on a leaked fixture beside them', () => {
    const browserOnly = runTeardown((root) => {
      for (const name of ['com.google.Chrome.aB3dE9', 'com.google.Chrome.canary.aB3dE9', 'com.google.chrome.for.testing.aB3dE9', '.com.google.Chrome.xY7zQ2', '.org.chromium.Chromium.k9L2mN', 'com.google.Chrome.chrome_chrome_Unpacker_BeginUnzipping.AbC123', 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123']) {
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
      mkdirSync(join(root, 'com.google.Chrome.canary.aB3dE9'));
      writeFileSync(join(root, 'com.google.Chrome.canary.aB3dE9', 'sock'), 'x');
      mkdirSync(join(root, 'com.google.Chrome.canary_fixture.aB3dE9'));
      writeFileSync(join(root, 'com.google.Chrome.canary_fixture.aB3dE9', 'data.json'), '{}');
      mkdirSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123'));
      writeFileSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_.AbC123', 'download.crx'), 'x');
      mkdirSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_fixture.AbC123'));
      writeFileSync(join(root, 'com.google.Chrome.chrome_chrome_url_fetcher_fixture.AbC123', 'data.json'), '{}');
      mkdirSync(join(root, 'mv-review-browser-Abc123'));
      writeFileSync(join(root, 'mv-review-browser-Abc123', 'data.json'), '{}');
    });
    expect(withFixture.warnings.sort()).toEqual([
      '⚠️ test temp leak: com.google.Chrome.canary_fixture. ×1',
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
    // The only thing that fails an all-passing run must say so (#12536).
    expect(leaked.errors).toEqual(['❌ test temp leak guard: failing the run with exit code 1 for 1 leaked entry under the run temp root']);
    expect(leaked.exitCode).toBe(1);
  });

  it('removes documented .NET registration receipts without treating them as fixture leaks', () => {
    const clean = runTeardown(root => {
      const cache = join(root, 'system-commandline-sentinel-files');
      mkdirSync(cache);
      writeFileSync(join(cache, 'dotnet-suggest-registration-git-credential-manager, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null'),
        'Exception during registration: dotnet-suggest is unavailable');
    });
    expect(clean).toEqual({ warnings: [], errors: [], exitCode: undefined, removed: true });
  });

  it.each(['unknown-file', 'empty-unknown-file', 'nested-directory', 'empty-nested-directory', 'linked-directory', 'lookalike-name', 'unreadable'])(
    'still reports unrecognized content beside .NET receipts: %s', kind => {
      const leaked = runTeardown(root => {
        const cacheName = kind === 'lookalike-name'
          ? 'system-commandline-sentinel-files-fixture' : 'system-commandline-sentinel-files';
        const cache = join(root, cacheName);
        mkdirSync(cache);
        writeFileSync(join(cache, 'dotnet-suggest-registration-example'), kind.startsWith('empty-') ? '' : 'registration receipt');
        if (kind === 'unknown-file') writeFileSync(join(cache, 'fixture.json'), '{}');
        if (kind === 'empty-unknown-file') writeFileSync(join(cache, 'fixture.json'), '');
        if (kind === 'nested-directory' || kind === 'empty-nested-directory') {
          const nested = join(cache, 'dotnet-suggest-registration-nested');
          mkdirSync(nested);
          if (kind === 'nested-directory') writeFileSync(join(nested, 'fixture.json'), '{}');
        }
        if (kind === 'linked-directory') {
          const target = join(root, 'linked-target');
          mkdirSync(target);
          symlinkSync(target, join(cache, 'dotnet-suggest-registration-link'), 'junction');
        }
        if (kind === 'unreadable') {
          const original = lstatSync.getMockImplementation();
          lstatSync.mockImplementation(path => {
            if (path === cache) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
            return original(path);
          });
        }
      });
      expect(leaked.warnings).toEqual([
        `⚠️ test temp leak: system-commandline-sentinel-files${kind === 'lookalike-name' ? '-' : ''} ×1`,
      ]);
      expect(leaked.exitCode).toBe(1);
      expect(leaked.removed).toBe(true);
    },
  );

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

  it('reads a bounded owner sidecar and tolerates blank or partial lines', () => {
    const leaked = runTeardown((root) => {
      mkdirSync(join(root, 'owned-Abc123'));
      writeFileSync(join(root, 'owned-Abc123', 'data'), 'x');
      mkdirSync(join(root, 'partial-Def456'));
      writeFileSync(join(root, 'partial-Def456', 'data'), 'x');
      // A trailing line with no owner column is ignored; padding past the read
      // limit is never loaded, so the early rows still attribute.
      writeFileSync(join(root, '.leak-owners'), `\nowned-Abc123\ta.test.js\npartial-Def456\n${'x'.repeat(512 * 1024)}`);
    });
    expect(leaked.warnings.sort()).toEqual([
      '⚠️ test temp leak: owned- ×1 (created by a.test.js)',
      '⚠️ test temp leak: partial- ×1',
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
        `import { cleanupRunTempRoot } from ${JSON.stringify(new URL('./vitestTempRootSetup.js', import.meta.url).href)}; cleanupRunTempRoot();`], {
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
