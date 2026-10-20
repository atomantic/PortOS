#!/usr/bin/env node

/**
 * SuperCollider Runtime Setup
 *
 * Builds the PortOS-owned SuperCollider image (sclang + scsynth + the stock
 * class library and plugins, from the pinned recipe in docker/supercollider/)
 * and proves it with a synthetic offline render under the same containment the
 * Music Designer uses. Docker must already be installed and running — this
 * never installs or reconfigures Docker, and never calls an AI provider.
 *
 * Usage:
 *   npm run setup:supercollider                    # status + offer to build
 *   npm run setup:supercollider -- --yes           # build/verify without asking
 *   npm run setup:supercollider -- --yes --rebuild # repair: rebuild every layer, re-probe
 *   npm run setup:supercollider -- --verbose       # stream the full docker build log
 *   npm run setup:supercollider -- --status [--json]
 *
 * Idempotent: a built, current image is not rebuilt, and current passing probe
 * evidence is not re-run. Exit codes: see SETUP_EXIT_CODES.
 */

import { createInterface } from 'node:readline';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { getSuperColliderStatus, setupSuperColliderRuntime } from '../server/services/superColliderRuntime.js';

export const SETUP_EXIT_CODES = Object.freeze({
  ready: 0,
  failed: 1,
  'docker-unavailable': 2,
  declined: 3,
  'build-failed': 4,
  'smoke-failed': 5,
});

export function parseSuperColliderSetupArgs(argv) {
  const options = { yes: false, status: false, json: false, rebuild: false, verbose: false };
  const flags = { '--yes': 'yes', '-y': 'yes', '--status': 'status', '--json': 'json', '--rebuild': 'rebuild', '--verbose': 'verbose' };
  for (const arg of argv) {
    if (!flags[arg]) throw new Error(`Unknown option: ${arg} (known: ${Object.keys(flags).join(', ')})`);
    options[flags[arg]] = true;
  }
  if (options.json && !options.status) throw new Error('--json is only valid with --status');
  return options;
}

/** The exit code for a setup outcome; anything unrecognized is a generic failure. */
export const exitCodeForOutcome = (outcome) => SETUP_EXIT_CODES[outcome] ?? SETUP_EXIT_CODES.failed;

// Build output is thousands of compiler lines; by default show only the step
// headers (BuildKit `#N [stage x/y] …`, classic builder `Step x/y : …`).
export const isBuildStepLine = (line) => /^#\d+ \[[^\]]+\]/.test(line) || /^Step \d+\/\d+ :/.test(line);

/** Bounded ring buffer size for lines not shown in non-verbose build mode. */
export const BUILD_LINE_BUFFER_LIMIT = 40;

const mark = (ok) => (ok ? '✅' : '❌');

function printStatus(status, { log = console.log, warn = console.warn } = {}) {
  if (!status) return;
  const { docker, image, smoke, runtime } = status;
  const dockerLine = !docker?.installed ? 'not installed'
    : !docker.running ? `installed, engine not reachable${docker.error ? ` (${docker.error})` : ''}`
      : `${docker.serverVersion} (${docker.os}/${docker.arch})`;
  log(`${mark(docker?.running)} Docker: ${dockerLine}`);
  const imageLine = !image ? `${runtime?.image ?? 'supercollider'} not built`
    : `${runtime?.image ?? 'supercollider'}${image.sizeBytes ? ` (${Math.round(image.sizeBytes / 1e6)} MB)` : ''}${image.current ? '' : ` — stale (built for ${image.runtimeVersion || 'an unknown version'})`}`;
  log(`${mark(image?.current)} Image: ${imageLine}`);
  const smokeLine = !smoke ? 'not run'
    : !smoke.current ? `stale (last run ${smoke.checkedAt} against a different image/runtime/policy)`
      : smoke.ok ? `passed ${smoke.checkedAt} — ${smoke.measurement?.durationMs} ms, ${smoke.measurement?.channels} ch, ${smoke.measurement?.sampleRate} Hz, peak ${smoke.measurement?.peak}`
        : `failed ${smoke.checkedAt}: ${smoke.error}`;
  log(`${mark(smoke?.current && smoke.ok)} Render probe: ${smokeLine}`);
  const msgLog = status.ready ? log : warn;
  msgLog(`${status.ready ? '🎛️' : '⚠️'} ${status.message}`);
  if (status.action) msgLog(`👉 ${status.action}`);
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(/^y(es)?$/i.test(answer.trim())); }));
}

async function confirmBuild({ yes }) {
  if (yes) return true;
  const question = '📦 Build the SuperCollider image now? It compiles SuperCollider from source inside Docker — expect 10–30 minutes, a few hundred MB of image and more for build cache. [y/N] ';
  if (process.stdin.isTTY && await ask(question)) return true;
  console.warn('⚠️ Skipped the image build. Re-run with --yes to build it.');
  return false;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;
  const warn = io.warn ?? console.warn;
  const setupRuntime = io.setupSuperColliderRuntime ?? setupSuperColliderRuntime;
  const getStatus = io.getSuperColliderStatus ?? getSuperColliderStatus;
  const options = parseSuperColliderSetupArgs(argv);
  if (options.status) {
    const status = await getStatus();
    if (options.json) log(JSON.stringify(status, null, 2));
    else printStatus(status, { log, warn });
    return { outcome: status.ready ? 'ready' : status.state, status };
  }
  log('🎛️ SuperCollider runtime setup');
  const retainedLines = [];
  const result = await setupRuntime({
    rebuild: options.rebuild,
    confirmBuild: io.confirmBuild ?? (() => confirmBuild(options)),
    onLine: (line) => {
      if (options.verbose || isBuildStepLine(line)) {
        log(`   ${line}`);
      } else {
        retainedLines.push(line);
        if (retainedLines.length > BUILD_LINE_BUFFER_LIMIT) {
          retainedLines.shift();
        }
      }
    },
  });
  if (result.built) log('✅ Image built');
  else if (result.outcome === 'ready' || result.outcome === 'smoke-failed') log('✅ Image already current — skipped the build');
  if (result.probed) log(`${result.status?.ready ? '✅' : '❌'} Synthetic render probe ${result.status?.ready ? 'passed' : 'failed'}`);
  if (result.outcome === 'build-failed') {
    error(`❌ Image build failed: ${result.error}`);
    if (!options.verbose) {
      for (const line of retainedLines) {
        error(`   ${line}`);
      }
      error('👉 Re-run with --verbose for the full build log');
    }
  }
  printStatus(result.status, { log, warn });
  const exitCode = exitCodeForOutcome(result.outcome);
  if (io.setExitCode !== false) {
    process.exitCode = exitCode;
  }
  return { ...result, exitCode };
}

if (isDirectlyInvoked(import.meta.url)) {
  main().catch(error => {
    console.error(`❌ SuperCollider setup failed: ${error.message}`);
    process.exitCode = SETUP_EXIT_CODES.failed;
  });
}
