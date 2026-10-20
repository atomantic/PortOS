import { appendFileSync, lstatSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { cleanupTempDataRoots, lazyTempDataRoot } from '../server/lib/mockPathsDataRoot.js';
import { describeStageFixtureRoot, observeOwnedBrowsers, readOwnedBrowserObservations } from '../server/test/ownedBrowserDiagnostics.js';
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
    process.exitCode = undefined;
    cleanupRunTempRoot();
    const result = { warnings: warn.mock.calls.map((c) => c[0]), exitCode: process.exitCode, removed: !existsSync(root) };
    rmSync(root, { recursive: true, force: true });
    return result;
  }

  it('defers root cleanup until Vitest closes its pool and retains the setup root', () => {
    const root = mkdtempSync(join(tmpdir(), 'pvt-close-test-'));
    const onClose = vi.fn();
    try {
      process.env.PORTOS_TEST_TEMP_ROOT = root;
      expect(setup({ vitest: { onClose } })).toBeUndefined();
      expect(existsSync(root)).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      process.env.PORTOS_TEST_TEMP_ROOT = originalRoot;
      onClose.mock.calls[0][0]();
      expect(existsSync(root)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

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

  it('removes documented .NET registration receipts without treating them as fixture leaks', () => {
    const clean = runTeardown(root => {
      const cache = join(root, 'system-commandline-sentinel-files');
      mkdirSync(cache);
      writeFileSync(join(cache, 'dotnet-suggest-registration-git-credential-manager, Version=2.0.0.0, Culture=neutral, PublicKeyToken=null'),
        'Exception during registration: dotnet-suggest is unavailable');
    });
    expect(clean).toEqual({ warnings: [], exitCode: undefined, removed: true });
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

  it('projects exact-child snapshots after observer disposal and preserves a later-appearance leak', () => {
    const observations = channel('portos.composition-browser.lifecycle');
    const leaked = runTeardown(root => {
      const dispose = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
      const profile = join(root, 'portos-composition-browser-Abc123');
      mkdirSync(profile);
      const child = new EventEmitter();
      const productionClose = vi.fn();
      child.on('close', productionClose);
      observations.publish({ event: 'allocated', profile });
      observations.publish({ event: 'child', profile, child });
      observations.publish({ event: 'remove-start', profile });
      rmSync(profile, { recursive: true });
      observations.publish({ event: 'remove-resolved', profile });
      child.exitCode = 0; // Public status alone does not fabricate a native exit event.
      dispose();
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listeners('close')).toEqual([productionClose]);
      const ended = readFileSync(join(root, '.leak-owners'), 'utf8');
      child.emit('exit');
      child.emit('close');
      observations.publish({ event: 'remove-rejected', profile, code: 'EACCES' });
      expect(readFileSync(join(root, '.leak-owners'), 'utf8')).toBe(ended);
      // Reusing the environment must not revive the prior observer.
      const disposeNext = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
      observations.publish({ event: 'child', profile, child });
      expect(child.listenerCount('exit')).toBe(0);
      disposeNext();
      mkdirSync(profile);
      writeFileSync(join(profile, 'later'), 'synthetic later writer');
    });
    expect(leaked.exitCode).toBe(1);
    expect(leaked.removed).toBe(true);
    const report = leaked.warnings.join('\n');
    expect(report).toContain('owner=scripts/vitestTempRootSetup.test.js');
    expect(report).toContain('removal=resolved presentAfterRemoval=false presentAtGlobalGuard=true observer=ended');
    expect(report).toContain('exitObserved=false closeObserved=false exitCode=0 signalCode=none');
    expect(report).not.toContain('Abc123');
  });

  it('distinguishes a removed stage root recreated by a writer from a later lazy allocation', () => {
    const leaked = runTeardown(root => {
      const tempKeys = ['TMPDIR', 'TMP', 'TEMP'];
      const prior = Object.fromEntries(tempKeys.map(key => [key, process.env[key]]));
      for (const key of tempKeys) process.env[key] = root;
      const dispose = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
      try {
        const first = lazyTempDataRoot('portos-code-animation-stages-');
        const child = new EventEmitter();
        child.exitCode = null;
        child.signalCode = null;
        channel('portos.composition-browser.lifecycle').publish({ event: 'child', profile: first, child });
        child.exitCode = 0;
        child.emit('exit'); // Inherited stderr can remain open; do not fabricate close.
        cleanupTempDataRoots();
        expect(existsSync(first)).toBe(false);
        mkdirSync(join(first, 'chrome-test-profile'), { recursive: true });
        writeFileSync(join(first, 'chrome-test-profile', 'private-profile-sentinel'), 'private content');
        const second = lazyTempDataRoot('portos-code-animation-stages-');
        mkdirSync(join(second, 'code-animations'));
        writeFileSync(join(second, 'code-animations', 'private-project-sentinel'), 'private content');
        dispose();
      } finally {
        dispose();
        for (const key of tempKeys) {
          if (prior[key] === undefined) delete process.env[key];
          else process.env[key] = prior[key];
        }
      }
    });
    cleanupTempDataRoots();
    expect(leaked.exitCode).toBe(1);
    const reports = leaked.warnings.filter(line => line.startsWith('⚠️ stage fixture'));
    expect(reports).toHaveLength(2);
    const first = reports.find(line => line.includes('generation=1'));
    expect(first).toContain('exitObserved=true closeObserved=false exitCode=0');
    expect(first).toContain('removal=resolved presentAfterRemoval=false presentAtGlobalGuard=true');
    expect(first).toContain('profileEntries=2 applicationEntries=0');
    const second = reports.find(line => line.includes('generation=2'));
    expect(second).toContain('removal=not-started');
    expect(second).toContain('profileEntries=0 applicationEntries=2');
    expect(reports.join('\n')).not.toContain('private-');
    expect(reports.join('\n')).not.toContain('private content');
  });

  it('retains exact large filesystem identities through observation and rejects rounded or malformed records', async () => {
    const actual = await vi.importActual('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'pvt-large-identity-'));
    process.env.PORTOS_TEST_TEMP_ROOT = root;
    const name = 'portos-code-animation-stages-Abc123';
    const profile = join(root, name);
    mkdirSync(profile);
    let ino = 18014398509481984n;
    let dev = 18446744073709551615n;
    lstatSync.mockImplementation((path, options) => {
      const stat = actual.lstatSync(path, options);
      if (path === profile) {
        expect(options).toEqual({ bigint: true });
        stat.ino = ino;
        stat.dev = dev;
      }
      return stat;
    });
    const dispose = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
    try {
      channel('portos.composition-browser.lifecycle').publish({ event: 'allocated', profile });
      dispose();
      const sidecar = join(root, '.leak-owners');
      const row = readFileSync(sidecar, 'utf8').trim().split('\n').at(-1).split('\t');
      const recorded = JSON.parse(row[2]);
      expect(recorded).toMatchObject({ generation: 1, dev: dev.toString(), ino: ino.toString() });
      const project = () => {
        const { observations, state } = readOwnedBrowserObservations(root);
        return describeStageFixtureRoot(profile, observations.get(name), state);
      };
      expect(project()).toContain('generation=1 rootIdentity=matches');
      ino += 1n; // These adjacent IDs collapse to the same floating-point Number.
      expect(Number(ino)).toBe(Number(recorded.ino));
      expect(project()).toContain('generation=1 rootIdentity=changed');
      const replace = identity => writeFileSync(sidecar, `${row[0]}\t${row[1]}\t${JSON.stringify({ ...recorded, ...identity })}\n`);
      ino = 1n; dev = 2n;
      replace({ ino: 1, dev: 2 });
      expect(project()).toContain('generation=1 rootIdentity=matches');
      for (const invalid of [18014398509481984, -1, '01', '-1', '1e3', '18446744073709551616', '9'.repeat(21)]) {
        for (const field of ['ino', 'dev']) {
          replace({ [field]: invalid });
          expect(project()).toContain('generation=unavailable rootIdentity=unavailable');
        }
      }
    } finally {
      dispose();
      lstatSync.mockImplementation(actual.lstatSync);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps records, event history and public projection without copying private child or error values', () => {
    const observations = channel('portos.composition-browser.lifecycle');
    const leaked = runTeardown(root => {
      const dispose = observeOwnedBrowsers(() => '/private/owner-sentinel.test.js');
      for (let i = 0; i < 66; i++) {
        const profile = join(root, `portos-composition-browser-${String(i).padStart(6, '0')}`);
        mkdirSync(profile);
        writeFileSync(join(profile, 'private-content-sentinel'), 'private output sentinel');
        observations.publish({ event: 'allocated', profile });
        if (!i) {
          const child = Object.assign(new EventEmitter(), { pid: 987654321, exitCode: 'private-exit-sentinel', signalCode: 'private-signal-sentinel' });
          observations.publish({ event: 'child', profile, child });
          for (let event = 0; event < 30; event++) observations.publish({ event: 'remove-rejected', profile, code: 'private-error-sentinel' });
        }
      }
      dispose();
      const rows = readFileSync(join(root, '.leak-owners'), 'utf8').trim().split('\n');
      expect(rows.every(row => Buffer.byteLength(row + '\n') <= 1024)).toBe(true);
      expect(new Set(rows.map(row => row.split('\t')[0])).size).toBe(65); // 64 profiles + one cap marker
    });
    expect(leaked.exitCode).toBe(1);
    const report = leaked.warnings.join('\n');
    expect(leaked.warnings.filter(line => /composition profile \d+:/.test(line))).toHaveLength(8);
    expect(report).toContain('58 additional entries');
    expect(report).toContain('provenance=capped');
    expect(report).toContain('removal=rejected:other');
    expect(report).toContain('exitCode=other signalCode=other');
    expect(report).toContain('truncated=true');
    expect(report).not.toMatch(/sentinel|987654321|000000/);
  });

  it('reports unavailable or capped evidence rather than stale success after truncated metadata or write failure', () => {
    const observations = channel('portos.composition-browser.lifecycle');
    for (const boundary of ['truncated', 'write-failure', 'byte-cap']) {
      const leaked = runTeardown(root => {
        const profile = join(root, 'portos-composition-browser-Abc123');
        mkdirSync(profile);
        writeFileSync(join(profile, 'data'), 'synthetic');
        if (boundary === 'write-failure') mkdirSync(join(root, '.leak-owners'));
        const dispose = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
        observations.publish({ event: 'allocated', profile });
        observations.publish({ event: 'remove-resolved', profile });
        dispose();
        if (boundary === 'truncated') appendFileSync(join(root, '.leak-owners'), 'portos-composition-browser-Abc123\tprivate-sentinel\t{"v":1');
        if (boundary === 'byte-cap') {
          writeFileSync(join(root, '.leak-owners'), 'x'.repeat(8 * 1024 * 1024));
          const stop = observeOwnedBrowsers(() => fileURLToPath(import.meta.url));
          observations.publish({ event: 'allocated', profile });
          stop();
          expect(statSync(join(root, '.leak-owners')).size).toBe(8 * 1024 * 1024);
        }
      });
      expect(leaked.exitCode).toBe(1);
      expect(leaked.warnings.join('\n')).toContain(`provenance=${boundary === 'byte-cap' ? 'capped' : 'unavailable'}`);
      expect(leaked.warnings.join('\n')).not.toMatch(/removal=resolved|private-sentinel/);
    }
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
