/**
 * scripts/ensure-ffmpeg.js is the only ffmpeg installer (#16820): setup and both
 * update scripts call it. Every branch runs with an injected package-manager
 * runner, so no test installs anything; the CLI test only proves the "always
 * exits 0" contract against an empty PATH.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { commandExists, ensureFfmpeg } from './ensure-ffmpeg.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ensure-ffmpeg.js');

/**
 * Runs ensureFfmpeg on a simulated machine: `available` is the set of commands
 * on PATH, `run` records each install command and installs ffmpeg when it
 * succeeds (so the final 'installed' check sees it), `failing` makes it fail.
 */
function simulate({ platform, available = [], isRoot = false, nonInteractive = false, passwordlessSudo = true, failing = [] }) {
  const present = new Set(available);
  const ran = [];
  const logs = [];
  const status = ensureFfmpeg({
    platform,
    isRoot,
    nonInteractive,
    has: (name) => present.has(name),
    run: (command) => {
      ran.push(command.join(' '));
      if (failing.some((prefix) => command.join(' ').startsWith(prefix))) return false;
      if (command.includes('ffmpeg') && command.some((part) => part === 'install' || part === '-S')) present.add('ffmpeg');
      return true;
    },
    canSudoNonInteractive: () => passwordlessSudo,
    log: (line) => logs.push(line)
  });
  return { status, ran, logs: logs.join('\n') };
}

describe('ensureFfmpeg', () => {
  it('does nothing when ffmpeg is already installed', () => {
    expect(simulate({ platform: 'linux', available: ['ffmpeg'] })).toEqual({ status: 'present', ran: [], logs: '' });
  });

  it('installs through Homebrew on macOS', () => {
    const result = simulate({ platform: 'darwin', available: ['brew'] });
    expect(result.status).toBe('installed');
    expect(result.ran).toEqual(['brew install ffmpeg']);
  });

  it('gives the Homebrew hint on macOS without brew', () => {
    const result = simulate({ platform: 'darwin' });
    expect(result.status).toBe('unavailable');
    expect(result.ran).toEqual([]);
    expect(result.logs).toContain('https://brew.sh');
  });

  it('reports a failed brew install as unavailable instead of throwing', () => {
    const result = simulate({ platform: 'darwin', available: ['brew'], failing: ['brew'] });
    expect(result.status).toBe('unavailable');
    expect(result.logs).toContain('brew install ffmpeg failed');
  });

  it.each([
    ['apt-get', ['apt-get update', 'apt-get install -y ffmpeg']],
    ['dnf', ['dnf install -y ffmpeg']],
    ['pacman', ['pacman -S --noconfirm ffmpeg']]
  ])('uses %s directly as root, with no sudo binary needed', (manager, expected) => {
    const result = simulate({ platform: 'linux', isRoot: true, available: [manager] });
    expect(result.status).toBe('installed');
    expect(result.ran).toEqual(expected);
  });

  it('prefers apt-get over dnf and pacman', () => {
    expect(simulate({ platform: 'linux', isRoot: true, available: ['pacman', 'dnf', 'apt-get'] }).ran[0]).toBe('apt-get update');
  });

  it('uses plain sudo when interactive, so the user can type a password', () => {
    const result = simulate({ platform: 'linux', available: ['sudo', 'apt-get'] });
    expect(result.ran).toEqual(['sudo apt-get update', 'sudo apt-get install -y ffmpeg']);
  });

  it('uses sudo -n when non-interactive and passwordless sudo works', () => {
    const result = simulate({ platform: 'linux', nonInteractive: true, available: ['sudo', 'dnf'] });
    expect(result.ran).toEqual(['sudo -n dnf install -y ffmpeg']);
  });

  it('never runs a package manager when non-interactive and sudo needs a password', () => {
    const result = simulate({ platform: 'linux', nonInteractive: true, passwordlessSudo: false, available: ['sudo', 'apt-get'] });
    expect(result.status).toBe('unavailable');
    expect(result.ran).toEqual([]);
    expect(result.logs).toContain('passwordless sudo unavailable');
  });

  it('gives a manual hint when not root and sudo is missing', () => {
    const result = simulate({ platform: 'linux', available: ['apt-get'] });
    expect(result.status).toBe('unavailable');
    expect(result.ran).toEqual([]);
    expect(result.logs).toContain('sudo unavailable');
  });

  it('gives a manual hint when no package manager is known', () => {
    const result = simulate({ platform: 'linux', isRoot: true });
    expect(result.ran).toEqual([]);
    expect(result.logs).toContain('No known package manager');
  });

  it('stops after a failed apt-get update instead of installing', () => {
    const result = simulate({ platform: 'linux', isRoot: true, available: ['apt-get'], failing: ['apt-get update'] });
    expect(result.ran).toEqual(['apt-get update']);
    expect(result.status).toBe('unavailable');
  });

  it('never attempts an install on Windows and says how to install by hand', () => {
    const result = simulate({ platform: 'win32', available: ['winget', 'brew', 'apt-get'] });
    expect(result.status).toBe('unavailable');
    expect(result.ran).toEqual([]);
    expect(result.logs).toContain('winget install Gyan.FFmpeg');
  });
});

describe('commandExists', () => {
  it('finds an executable on PATH and rejects directories and missing names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-which-'));
    try {
      const name = process.platform === 'win32' ? 'fake-tool.cmd' : 'fake-tool';
      writeFileSync(join(dir, name), '');
      chmodSync(join(dir, name), 0o755);
      const env = { PATH: dir, PATHEXT: '.CMD' };
      expect(commandExists('fake-tool', { env })).toBe(true);
      expect(commandExists('absent-tool', { env })).toBe(false);
      expect(commandExists('fake-tool', { env: { PATH: '' } })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('ignores a non-executable file on POSIX', () => {
    const dir = mkdtempSync(join(tmpdir(), 'portos-which-'));
    try {
      writeFileSync(join(dir, 'plain-file'), '');
      chmodSync(join(dir, 'plain-file'), 0o644);
      expect(commandExists('plain-file', { env: { PATH: dir } })).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A failed or impossible install must never fail setup or an unattended update.
describe('node scripts/ensure-ffmpeg.js', () => {
  it('exits 0 and reports unavailable when ffmpeg and every package manager are missing', () => {
    const emptyPath = mkdtempSync(join(tmpdir(), 'portos-empty-path-'));
    try {
      const output = execFileSync(process.execPath, [SCRIPT, '--non-interactive'], {
        encoding: 'utf8',
        env: { PATH: emptyPath, Path: emptyPath }
      });
      expect(output).toContain('ffmpeg: unavailable');
    } finally {
      rmSync(emptyPath, { recursive: true, force: true });
    }
  });
});
