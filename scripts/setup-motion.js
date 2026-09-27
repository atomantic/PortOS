#!/usr/bin/env node

/**
 * Motion Studio Setup
 *
 * Installs what code-rendered launch videos and HTML compositions need:
 *   - ffmpeg (required to encode MP4s and contact-sheet proofs), via the
 *     platform package manager.
 *   - Optional motion-design agent skills (HyperFrames, Remotion, Claude
 *     Animation) installed user-wide with the `skills` CLI, so a launch-video
 *     run can ask its agent to consult them (the "Consult motion skills" option).
 *
 * The seek(t) renderer, motion kit and critique-loop proofs ship with PortOS and
 * need nothing else; the managed browser comes from `npm run setup:browser`.
 *
 * Usage:
 *   npm run setup:motion                     # status + offer to install ffmpeg
 *   npm run setup:motion -- --yes            # install ffmpeg without asking
 *   npm run setup:motion -- --skills         # also install every skill pack
 *   npm run setup:motion -- --skills=hyperframes,remotion
 *   npm run setup:motion -- --status [--json]
 *
 * Idempotent: installed components are reported and skipped.
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { platform as osPlatform } from 'node:os';
import { MOTION_SKILL_PACKS, detectMotionSkills } from '../server/lib/motionSkills.js';
import { whichFirstSync } from '../server/lib/processEnv.js';
import { findFfmpeg } from '../server/lib/ffmpeg.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

// Agents the skills CLI links each installed skill into (Claude Code + Codex
// cover the CoS providers that read skill folders).
const SKILL_AGENTS = ['claude-code', 'codex'];

export function parseMotionSetupArgs(argv) {
  const options = { yes: false, status: false, json: false, skills: [] };
  for (const arg of argv) {
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--status') options.status = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--skills') options.skills = MOTION_SKILL_PACKS.map(pack => pack.id);
    else if (arg.startsWith('--skills=')) {
      const ids = arg.slice('--skills='.length).split(',').map(id => id.trim()).filter(Boolean);
      const unknown = ids.filter(id => !MOTION_SKILL_PACKS.some(pack => pack.id === id));
      if (unknown.length) throw new Error(`Unknown skill pack: ${unknown.join(', ')} (known: ${MOTION_SKILL_PACKS.map(pack => pack.id).join(', ')})`);
      options.skills = ids;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** The package-manager command that installs ffmpeg, or null when none applies. */
export function ffmpegInstallCommand(platform, has) {
  if (platform === 'darwin' && has('brew')) return ['brew', ['install', 'ffmpeg']];
  if (platform === 'win32' && has('winget')) return ['winget', ['install', '--id', 'Gyan.FFmpeg', '-e', '--accept-source-agreements', '--accept-package-agreements']];
  if (platform === 'linux' && has('apt-get')) return ['sudo', ['apt-get', 'install', '-y', 'ffmpeg']];
  if (platform === 'linux' && has('dnf')) return ['sudo', ['dnf', 'install', '-y', 'ffmpeg']];
  return null;
}

/** The `skills` CLI invocation that installs one pack user-wide, non-interactively. */
export function skillInstallCommand(pack) {
  return ['npx', ['-y', 'skills@latest', 'add', pack.source, '--global', '--yes', '--agent', ...SKILL_AGENTS, '--skill', ...pack.skills]];
}

const hasCommand = (command) => Boolean(whichFirstSync(command));
// The server's own lookup (PATH plus Homebrew/system locations), so this CLI
// and the launch-video form agree on whether ffmpeg is present.
const hasFfmpeg = async () => Boolean(await findFfmpeg());

const run = ([command, args]) => spawnSync(command, args, { stdio: 'inherit', shell: osPlatform() === 'win32' }).status === 0;

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); }));
}

async function status() {
  return { ffmpeg: await hasFfmpeg(), skillPacks: detectMotionSkills() };
}

function printStatus({ ffmpeg, skillPacks }) {
  console.log(`${ffmpeg ? '✅' : '❌'} ffmpeg${ffmpeg ? '' : ' — required for launch videos and proofs'}`);
  for (const pack of skillPacks) {
    const mark = pack.installed ? '✅' : pack.found.length ? '🟡' : '⚪';
    console.log(`${mark} ${pack.label} skills (${pack.id}): ${pack.found.length}/${pack.skills.length} — ${pack.description}`);
  }
}

async function ensureFfmpeg({ yes }) {
  if (await hasFfmpeg()) return true;
  const command = ffmpegInstallCommand(osPlatform(), hasCommand);
  if (!command) {
    console.warn('⚠️ ffmpeg is missing and no supported package manager was found — install ffmpeg yourself (https://ffmpeg.org/download.html).');
    return false;
  }
  const printable = `${command[0]} ${command[1].join(' ')}`;
  const approved = yes || (process.stdin.isTTY && await ask(`📦 ffmpeg is missing. Run "${printable}"? [y/N] `));
  if (!approved) {
    console.warn(`⚠️ Skipped ffmpeg install. Run "${printable}" or re-run with --yes.`);
    return false;
  }
  console.log(`📦 ${printable}`);
  if (!run(command) || !await hasFfmpeg()) {
    console.error('❌ ffmpeg install failed');
    return false;
  }
  return true;
}

function installSkills(ids) {
  let ok = true;
  const detected = detectMotionSkills();
  for (const id of ids) {
    const pack = MOTION_SKILL_PACKS.find(entry => entry.id === id);
    if (detected.find(entry => entry.id === id)?.installed) {
      console.log(`✅ ${pack.label} skills already installed`);
      continue;
    }
    console.log(`🎬 Installing ${pack.label} skills from ${pack.source}...`);
    if (!run(skillInstallCommand(pack))) {
      console.error(`❌ ${pack.label} skill install failed`);
      ok = false;
    }
  }
  return ok;
}

async function main() {
  const options = parseMotionSetupArgs(process.argv.slice(2));
  if (options.status) {
    const current = await status();
    if (options.json) console.log(JSON.stringify(current, null, 2));
    else printStatus(current);
    return;
  }
  console.log('🎬 Motion studio setup');
  const ffmpegReady = await ensureFfmpeg(options);
  const skillsReady = options.skills.length ? installSkills(options.skills) : true;
  printStatus(await status());
  if (!options.skills.length) console.log('💡 Optional: npm run setup:motion -- --skills installs HyperFrames, Remotion and Claude Animation technique skills for launch-video agents.');
  if (!ffmpegReady || !skillsReady) process.exitCode = 1;
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch(error => {
    console.error(`❌ Motion setup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
