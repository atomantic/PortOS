import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inspectNpmGlobalCommand } from '../lib/npmGlobalBin.js';
import { getRuntimeUninstallTarget, spawnRuntimeInstaller } from './providerRuntimeInstaller.js';

const windows = process.platform === 'win32';

function packageFixture(prefix, { isWindows = windows } = {}) {
  const packageDir = join(prefix, ...(isWindows ? [] : ['lib']), 'node_modules', '@kilocode', 'cli');
  const binDir = isWindows ? prefix : join(prefix, 'bin');
  const target = join(packageDir, 'bin', 'kilo');
  mkdirSync(join(packageDir, 'bin'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: '@kilocode/cli', version: '1.0.0', bin: { kilo: 'bin/kilo', kilocode: 'bin/kilo' },
  }));
  writeFileSync(target, '#!/usr/bin/env node\nprocess.exit(0);\n');
  chmodSync(target, 0o755);
  for (const command of ['kilo', 'kilocode']) {
    if (isWindows) {
      const relativeTarget = relative(prefix, target).split(sep).join('\\');
      writeFileSync(join(binDir, `${command}.cmd`), `@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (echo ok)\r\n"%_prog%" "%dp0%\\${relativeTarget}" %*\r\n`);
      const shellTarget = relativeTarget.replaceAll('\\', '/');
      writeFileSync(join(binDir, command), `#!/bin/sh\nexec node "$basedir/${shellTarget}" "$@"\n`);
      writeFileSync(join(binDir, `${command}.ps1`), `#!/usr/bin/env pwsh\n& "node$exe" "$basedir/${shellTarget}" $args\n`);
    } else {
      symlinkSync(relative(binDir, target), join(binDir, command));
    }
  }
  return { packageDir, binDir, target, executable: join(binDir, isWindows ? 'kilo.cmd' : 'kilo') };
}

describe('npm harness removal across prefixes', () => {
  let root;
  let originalPath;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'harness-npm-uninstall-'));
    originalPath = process.env.PATH || '';
    vi.stubEnv('npm_config_cache', join(root, 'cache'));
    vi.stubEnv('npm_config_logs_max', '0');
    vi.stubEnv('npm_config_offline', 'true');
    vi.stubEnv('npm_config_update_notifier', 'false');
    vi.stubEnv('NODE_DISABLE_COMPILE_CACHE', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('removes the selected prefix and leaves another npm copy and unrelated package untouched', async () => {
    const active = packageFixture(join(root, 'active prefix'));
    const other = packageFixture(join(root, 'default prefix'));
    const unrelated = join(root, 'default prefix', ...(windows ? [] : ['lib']), 'node_modules', 'unrelated');
    const samePrefixUnrelated = join(root, 'active prefix', ...(windows ? [] : ['lib']), 'node_modules', 'unrelated');
    mkdirSync(unrelated, { recursive: true });
    mkdirSync(samePrefixUnrelated, { recursive: true });
    writeFileSync(join(unrelated, 'package.json'), JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
    writeFileSync(join(samePrefixUnrelated, 'package.json'), JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
    vi.stubEnv('PATH', [active.binDir, other.binDir, originalPath].join(delimiter));
    vi.stubEnv('npm_config_prefix', join(root, 'default prefix'));
    if (windows) vi.stubEnv('PATHEXT', '.CMD;.EXE;.BAT;.COM');

    const target = getRuntimeUninstallTarget('kilo');
    expect(target?.prefix).toBe(realpathSync(join(root, 'active prefix')));
    const child = spawnRuntimeInstaller('kilo', { action: 'uninstall', uninstallTarget: target });
    child.stdout.resume(); child.stderr.resume();
    const [code] = await once(child, 'close');

    expect(code).toBe(0);
    expect(existsSync(active.packageDir)).toBe(false);
    expect(existsSync(active.executable)).toBe(false);
    expect(existsSync(other.packageDir)).toBe(true);
    expect(existsSync(other.executable)).toBe(true);
    expect(existsSync(join(unrelated, 'package.json'))).toBe(true);
    expect(existsSync(join(samePrefixUnrelated, 'package.json'))).toBe(true);
    expect(getRuntimeUninstallTarget('kilo')?.prefix).toBe(realpathSync(join(root, 'default prefix')));
  });

  it('does not spawn npm when the selected executable changes after preflight', () => {
    const active = packageFixture(join(root, 'active'));
    const other = packageFixture(join(root, 'other'));
    vi.stubEnv('PATH', [active.binDir, other.binDir, originalPath].join(delimiter));
    if (windows) vi.stubEnv('PATHEXT', '.CMD;.EXE;.BAT;.COM');
    const target = getRuntimeUninstallTarget('kilo');
    expect(target).not.toBeNull();
    rmSync(active.executable);
    const spawnImpl = vi.fn();

    expect(() => spawnRuntimeInstaller('kilo', { action: 'uninstall', uninstallTarget: target, spawnImpl })).toThrow('could not be verified');
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.skipIf(windows)('refuses a package directory linked to an external installation', () => {
    const active = packageFixture(join(root, 'active'));
    const external = join(root, 'external-package');
    renameSync(active.packageDir, external);
    symlinkSync(external, active.packageDir, 'dir');
    vi.stubEnv('PATH', [active.binDir, originalPath].join(delimiter));

    expect(getRuntimeUninstallTarget('kilo')).toBeNull();
    const spawnImpl = vi.fn();
    expect(() => spawnRuntimeInstaller('kilo', { action: 'uninstall', spawnImpl })).toThrow('could not be verified');
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(existsSync(external)).toBe(true);
  });

  it('refuses when another declared alias was replaced by an unrelated file', () => {
    const active = packageFixture(join(root, 'active'));
    vi.stubEnv('PATH', [active.binDir, originalPath].join(delimiter));
    if (windows) vi.stubEnv('PATHEXT', '.CMD;.EXE;.BAT;.COM');
    const alias = join(active.binDir, windows ? 'kilocode.cmd' : 'kilocode');
    rmSync(alias);
    writeFileSync(alias, 'unrelated executable');

    expect(getRuntimeUninstallTarget('kilo')).toBeNull();
    expect(readFileSync(alias, 'utf8')).toBe('unrelated executable');
  });

  it.skipIf(windows)('checks a string man entry and refuses a conflicting manual page', () => {
    const active = packageFixture(join(root, 'active'));
    const manifestPath = join(active.packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.man = 'docs/kilo.1';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    mkdirSync(join(active.packageDir, 'docs'));
    const target = join(active.packageDir, 'docs', 'kilo.1');
    writeFileSync(target, 'package manual');
    const manDir = join(root, 'active', 'share', 'man', 'man1');
    mkdirSync(manDir, { recursive: true });
    const manLink = join(manDir, 'kilo.1');
    symlinkSync(relative(manDir, target), manLink);
    vi.stubEnv('PATH', [active.binDir, originalPath].join(delimiter));
    expect(getRuntimeUninstallTarget('kilo')).not.toBeNull();

    rmSync(manLink);
    writeFileSync(manLink, 'unrelated manual');
    expect(getRuntimeUninstallTarget('kilo')).toBeNull();
    expect(readFileSync(manLink, 'utf8')).toBe('unrelated manual');
  });

  it('refuses unusual bin keys that npm would normalize to another alias', () => {
    const active = packageFixture(join(root, 'active'));
    const manifestPath = join(active.packageDir, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.bin['path/other'] = 'bin/kilo';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    vi.stubEnv('PATH', [active.binDir, originalPath].join(delimiter));
    if (windows) vi.stubEnv('PATHEXT', '.CMD;.EXE;.BAT;.COM');

    expect(getRuntimeUninstallTarget('kilo')).toBeNull();
  });

  it('recognizes an npm-style Windows shim only when it points to the declared package bin', () => {
    const fixture = packageFixture(join(root, 'windows'), { isWindows: true });
    const inspect = () => inspectNpmGlobalCommand('kilo', '@kilocode/cli', {
      isWindows: true, env: {}, findCommand: () => fixture.executable,
    });
    expect(inspect()?.prefix).toBe(realpathSync(join(root, 'windows')));
    const source = readFileSync(fixture.executable, 'utf8');
    writeFileSync(fixture.executable, source.replace('bin\\kilo', 'bin\\other'));
    expect(inspect()).toBeNull();
  });
});
