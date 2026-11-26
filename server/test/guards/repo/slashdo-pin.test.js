import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { installSlashdo } from '../../../../scripts/install-slashdo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// scripts/install-slashdo.js runs the submodule CLI directly (#17916); setup.js and
// update.mjs just call it.
describe('slash-do install pin', () => {
  it('SLASHDO_VERSION is an exact semver', () => {
    expect(read('scripts/SLASHDO_VERSION').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('SLASHDO_VERSION matches lib/slashdo submodule package.json when present', () => {
    const slashdoPkgPath = join(root, 'lib/slashdo/package.json');
    if (!existsSync(slashdoPkgPath)) {
      return;
    }
    const pkg = JSON.parse(readFileSync(slashdoPkgPath, 'utf8'));
    expect(read('scripts/SLASHDO_VERSION').trim()).toBe(pkg.version);
  });

  it('the installer never shells out to npx or the registry', () => {
    const src = read('scripts/install-slashdo.js');
    expect(src).not.toMatch(/npx|slash-do@|bufferedSpawn|SLASHDO_VERSION/);
    expect(src).toContain('process.execPath');
    expect(src).toContain('lib/slashdo/bin/cli.js');
  });

  it.each(['scripts/setup.js', 'scripts/update.mjs'])('%s installs through the helper', (file) => {
    expect(read(file)).toMatch(/install-slashdo\.js/);
  });

  it.each(['setup.sh', 'setup.ps1', 'update.sh', 'update.ps1', 'scripts/update.mjs', 'scripts/setup.js'])('%s carries no slash-do install of its own', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/slash-do@/);
    expect(src).not.toMatch(/(Get-Content|<)[^\n]*SLASHDO_VERSION/);
  });
});

describe('installSlashdo', () => {
  it('runs the local submodule CLI when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-slashdo-'));
    try {
      const cli = join(dir, 'cli.js');
      writeFileSync(cli, '');
      const calls = [];
      expect(installSlashdo({ cli, run: (c) => { calls.push(c); return true; }, log: () => {} })).toBe('installed');
      expect(calls).toEqual([cli]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips with a submodule hint, without running anything, when the CLI is missing', () => {
    const run = () => { throw new Error('must not run without the submodule CLI'); };
    const logs = [];
    expect(installSlashdo({ cli: join(tmpdir(), 'portos-absent-slashdo', 'cli.js'), run, log: (line) => logs.push(line) })).toBe('skipped');
    expect(logs.join('\n')).toContain('git submodule update --init --recursive');
  });

  it.each([['exits non-zero', () => false], ['throws', () => { throw new Error('spawn failed'); }]])(
    'reports a failure and does not throw when the CLI %s',
    (_label, run) => {
      const dir = mkdtempSync(join(tmpdir(), 'portos-slashdo-'));
      try {
        const cli = join(dir, 'cli.js');
        writeFileSync(cli, '');
        expect(installSlashdo({ cli, run, log: () => {} })).toBe('failed');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
