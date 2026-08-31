import { existsSync, mkdirSync } from 'fs';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'path';
import { homedir } from 'os';

if (process.platform !== 'darwin') {
  console.error('FaceTime Audio setup requires macOS.');
  process.exit(1);
}

const source = join(import.meta.dirname, '..', 'server', 'native', 'facetime-ax', 'main.swift');
const identitySource = join(import.meta.dirname, '..', 'server', 'native', 'facetime-ax', 'identityMatcher.swift');
const output = join(homedir(), '.portos', 'voice', 'facetime-ax');
if (!existsSync(source) || !existsSync(identitySource)) throw new Error('FaceTime helper source is missing');
mkdirSync(dirname(output), { recursive: true });
execFileSync('swiftc', ['-O', identitySource, source, '-o', output], { stdio: 'inherit' });
console.log('✅ FaceTime Audio helper installed. Grant it Accessibility access before use.');

// BlackHole is GPLv3 and is deliberately NOT bundled: PortOS asks, the user
// installs it themselves through their own Homebrew. Declining is a supported
// outcome — the control plane (dial / hang up) works without it; only the
// two-way audio bridge needs the virtual devices.
const BREW_ARGS = ['install', 'blackhole-2ch', 'blackhole-16ch'];
const alreadyInstalled = () => {
  const probe = execFileSync('system_profiler', ['SPAudioDataType', '-json'], { encoding: 'utf8' });
  return /blackhole 2ch/i.test(probe) && /blackhole 16ch/i.test(probe);
};

if (alreadyInstalled()) {
  console.log('✅ BlackHole 2ch and 16ch are already installed.');
} else if (!process.stdin.isTTY) {
  console.log(`ℹ️ Two-way call audio needs BlackHole. Install it yourself with: brew ${BREW_ARGS.join(' ')}`);
} else {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`Install BlackHole virtual audio devices (GPLv3, via Homebrew)?\n  brew ${BREW_ARGS.join(' ')}\nRun it now? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer === 'y' || answer === 'yes') {
    execFileSync('brew', BREW_ARGS, { stdio: 'inherit' });
    console.log('✅ BlackHole installed. In FaceTime, set output to BlackHole 16ch and microphone to BlackHole 2ch.');
  } else {
    console.log(`ℹ️ Skipped. Two-way call audio stays unavailable until you run: brew ${BREW_ARGS.join(' ')}`);
  }
}
