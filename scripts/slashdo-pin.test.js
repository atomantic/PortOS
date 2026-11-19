import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { installSlashdo, readSlashdoVersion } from './install-slashdo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// scripts/install-slashdo.js is the only place that runs `npx slash-do@<version>`
// and the only reader of scripts/SLASHDO_VERSION (#16820); setup.js, update.sh
// and update.ps1 just call it.
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

  it('the helper installs the pinned version, never latest', () => {
    const calls = [];
    expect(installSlashdo({ run: (version) => { calls.push(version); return true; }, log: () => {} })).toBe('installed');
    expect(calls).toEqual([read('scripts/SLASHDO_VERSION').trim()]);
    expect(read('scripts/install-slashdo.js')).not.toMatch(/slash-do@latest/);
    expect(read('scripts/install-slashdo.js')).toContain('`slash-do@${version}`');
  });

  it.each(['scripts/setup.js', 'update.sh', 'update.ps1'])('%s installs through the helper', (file) => {
    expect(read(file)).toMatch(/install-slashdo\.js/);
  });

  it.each(['setup.sh', 'setup.ps1', 'update.sh', 'update.ps1', 'scripts/setup.js'])('%s carries no slash-do install of its own', (file) => {
    const src = read(file);
    expect(src).not.toMatch(/slash-do@/);
    expect(src).not.toMatch(/(Get-Content|<)[^\n]*SLASHDO_VERSION/);
  });
});

describe('installSlashdo', () => {
  it('skips, without running npx, when the pin is missing or not an exact version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-slashdo-'));
    try {
      const run = () => { throw new Error('npx must not run without a pin'); };
      writeFileSync(join(dir, 'SLASHDO_VERSION'), 'latest\n');
      expect(readSlashdoVersion(join(dir, 'SLASHDO_VERSION'))).toBeNull();
      expect(readSlashdoVersion(join(dir, 'absent'))).toBeNull();
      const logs = [];
      expect(installSlashdo({ version: null, run, log: (line) => logs.push(line) })).toBe('skipped');
      expect(logs.join('\n')).toContain('skipping slash-do install');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([['exits non-zero', () => false], ['throws', () => { throw new Error('spawn failed'); }]])(
    'reports a failure and does not throw when npx %s',
    (_label, run) => {
      const logs = [];
      expect(installSlashdo({ version: '1.2.3', run, log: (line) => logs.push(line) })).toBe('failed');
      expect(logs.join('\n')).toContain('npx slash-do@1.2.3');
    }
  );
});
