#!/usr/bin/env node
/**
 * Installs ffmpeg through the platform package manager when it is missing.
 *
 * ffmpeg is a runtime dependency of the media/video features (camera-device
 * enumeration, video generation, thumbnailing, audio mux): server/lib/ffmpeg.js
 * shells out to the `ffmpeg` binary, and without it those paths fail at runtime
 * with `spawn ffmpeg ENOENT`. It is not an npm package, so setup and update both
 * call this one helper (scripts/setup.js, update.sh, update.ps1).
 *
 * Always exits 0: PortOS boots without ffmpeg and only the media paths degrade,
 * so a failed install must never fail a setup or an unattended update.
 *
 * `--non-interactive` is for callers with no TTY (the update scripts): a Linux
 * install then uses `sudo -n` and gives up with a manual hint when passwordless
 * sudo is unavailable, instead of blocking on a password prompt nobody can answer.
 * Windows has no automated install; it prints a manual hint.
 *
 * Node builtins only: scripts/setup.js runs this on a clone with no node_modules.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { isDirectlyInvoked } from './lib/directInvocation.js';

/** True when `name` resolves to an executable file on PATH (PATHEXT-aware on win32). */
export function commandExists(name, { platform = process.platform, env = process.env } = {}) {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const extensions = platform === 'win32'
    ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (platform !== 'win32') accessSync(candidate, constants.X_OK);
        return true;
      } catch { /* not here; keep looking */ }
    }
  }
  return false;
}

/** Runs `[command, ...args]` with the parent's stdio; true on exit 0. */
function runCommand([command, ...args]) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  return result.status === 0;
}

const MANUAL_HINTS = {
  win32: 'Install ffmpeg manually so media/video features work: winget install Gyan.FFmpeg (or https://ffmpeg.org/download.html), then restart PortOS.',
  darwin: 'Install Homebrew (https://brew.sh) then run: brew install ffmpeg',
  other: 'Unrecognized platform — install ffmpeg manually so media/video features work.'
};

/** Linux package managers in preference order; each is the full command list to run. */
const LINUX_MANAGERS = [
  { bin: 'apt-get', commands: (sudo) => [[...sudo, 'apt-get', 'update'], [...sudo, 'apt-get', 'install', '-y', 'ffmpeg']] },
  { bin: 'dnf', commands: (sudo) => [[...sudo, 'dnf', 'install', '-y', 'ffmpeg']] },
  { bin: 'pacman', commands: (sudo) => [[...sudo, 'pacman', '-S', '--noconfirm', 'ffmpeg']] }
];

/**
 * Returns 'present', 'installed' or 'unavailable'. Every collaborator is
 * injectable so each platform branch is testable without a package manager.
 */
export function ensureFfmpeg({
  nonInteractive = false,
  platform = process.platform,
  isRoot = typeof process.getuid === 'function' && process.getuid() === 0,
  has = (name) => commandExists(name, { platform }),
  run = runCommand,
  canSudoNonInteractive = () => runCommand(['sudo', '-n', 'true']),
  log = console.log
} = {}) {
  if (has('ffmpeg')) return 'present';
  log('🎞️  ffmpeg not found — required for camera devices, video generation, and thumbnails.');

  if (platform === 'darwin') {
    if (has('brew')) {
      log('📦 Installing ffmpeg via Homebrew...');
      if (!run(['brew', 'install', 'ffmpeg'])) log('⚠️  brew install ffmpeg failed — install manually: brew install ffmpeg');
    } else {
      log(`⚠️  Homebrew not found. ${MANUAL_HINTS.darwin}`);
    }
  } else if (platform === 'linux') {
    // A root container (e.g. the Docker image) has no sudo binary, so prefixing
    // unconditionally would fail to install even with apt-get present.
    let sudo = [];
    let blocked = null;
    if (!isRoot) {
      if (!has('sudo')) {
        blocked = 'Not root and sudo unavailable — install ffmpeg manually (e.g. sudo apt-get install ffmpeg).';
      } else if (nonInteractive) {
        if (canSudoNonInteractive()) sudo = ['sudo', '-n'];
        else blocked = 'ffmpeg missing and passwordless sudo unavailable — install manually: sudo apt-get install ffmpeg (or your distro\'s equivalent).';
      } else {
        sudo = ['sudo'];
      }
    }
    const manager = LINUX_MANAGERS.find(({ bin }) => has(bin));
    if (blocked) {
      log(`⚠️  ${blocked}`);
    } else if (!manager) {
      log('⚠️  No known package manager (apt-get/dnf/pacman). Install ffmpeg manually so media/video features work.');
    } else {
      log(`📦 Installing ffmpeg via ${manager.bin}${sudo.length && !nonInteractive ? ' (may prompt for sudo)' : ''}...`);
      const installed = manager.commands(sudo).every((command) => run(command));
      if (!installed) log(`⚠️  ${manager.bin} install ffmpeg failed — install manually: ${isRoot ? '' : 'sudo '}${manager.bin} install ffmpeg`);
    }
  } else {
    log(`⚠️  ${MANUAL_HINTS[platform] ?? MANUAL_HINTS.other}`);
  }

  return has('ffmpeg') ? 'installed' : 'unavailable';
}

if (isDirectlyInvoked(import.meta.url)) {
  try {
    const status = ensureFfmpeg({ nonInteractive: process.argv.includes('--non-interactive') });
    console.log(`🎞️  ffmpeg: ${status}`);
  } catch (err) {
    console.log(`⚠️  ffmpeg check failed: ${err.message ?? err} — continuing without it`);
  }
  process.exitCode = 0;
}
