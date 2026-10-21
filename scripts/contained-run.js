#!/usr/bin/env node
/**
 * contained-run — run an install or validation step from a worktree inside
 * PortOS's Docker containment profile (#12844, docs/CONTAINMENT.md).
 *
 *   node scripts/contained-run.js --phase install -- npm ci
 *   node scripts/contained-run.js --phase validate -- "npm run lint && npm test"
 *   node scripts/contained-run.js --phase install --apply-patch -- npm install --package-lock-only
 *
 * The step runs in a throwaway Linux container: the worktree is read-only,
 * node_modules live in a Docker volume, there is no host environment or
 * credential, `validate` has no network and `install` reaches only allowlisted
 * registries. Tracked files the step changed come back as a patch;
 * `--apply-patch` applies only its lockfile sections to the worktree with
 * `git apply` (edits to scripts, tests or hooks made by untrusted code are
 * withheld and listed), `--patch-out <file>` saves the whole patch for review.
 *
 * It asks this machine's PortOS server (`POST /api/docker-containment/run`)
 * with the same credentials as `scripts/portos-api.js`. When the feature is
 * off or Docker is not ready the server refuses and this exits 2 — it never
 * runs the command on the host instead.
 *
 * Exit status: the command's own, 2 refused, 124 timed out or cancelled,
 * 1 for anything else. Builtins only.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectApplicablePatch } from '../server/lib/dockerContainment.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { requestApi, resolveCredentials } from './portos-api.js';

export const USAGE = `Usage:
  contained-run --phase install|validate [--cwd <dir>] [--timeout-minutes <n>] [--apply-patch] [--patch-out <file>] -- <command...>

A single argument after -- is a shell command line; several are quoted and joined.`;

const REQUEST_SLACK_MS = 5 * 60_000;
const MAX_RUN_MINUTES = 240;

/** POSIX single-quote one argv entry. */
const shellQuote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`);

export function parseArgs(argv) {
  const split = argv.indexOf('--');
  const flags = split === -1 ? argv : argv.slice(0, split);
  const rest = split === -1 ? [] : argv.slice(split + 1);
  const options = { phase: null, cwd: process.cwd(), timeoutMinutes: null, applyPatch: false, patchOut: null, help: false };
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    const value = () => {
      if (i + 1 >= flags.length) throw new Error(`${flag} needs a value`);
      i += 1;
      return flags[i];
    };
    if (flag === '--help' || flag === '-h') options.help = true;
    else if (flag === '--phase') options.phase = value();
    else if (flag === '--cwd') options.cwd = value();
    else if (flag === '--timeout-minutes') options.timeoutMinutes = Number(value());
    else if (flag === '--apply-patch') options.applyPatch = true;
    else if (flag === '--patch-out') options.patchOut = value();
    else throw new Error(`Unknown option ${flag}`);
  }
  if (options.help) return options;
  if (!['install', 'validate'].includes(options.phase)) throw new Error('--phase must be install or validate');
  if (options.timeoutMinutes !== null && !(Number.isInteger(options.timeoutMinutes) && options.timeoutMinutes >= 1 && options.timeoutMinutes <= MAX_RUN_MINUTES)) {
    throw new Error(`--timeout-minutes must be an integer from 1 to ${MAX_RUN_MINUTES}`);
  }
  if (rest.length === 0) throw new Error('a command after -- is required');
  options.command = rest.length === 1 ? rest[0] : rest.map(shellQuote).join(' ');
  return options;
}

/** The repository root holding `cwd` (the mounted worktree), else `cwd` itself. */
export function resolveWorktree(cwd) {
  try {
    return realpathSync(execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return realpathSync(cwd);
  }
}

/** `git apply` the returned patch in the worktree, checking it first so a bad patch never half-lands. */
export function applyPatch(worktree, patch) {
  const dir = mkdtempSync(join(tmpdir(), 'portos-contained-patch-'));
  const file = join(dir, 'changes.patch');
  try {
    writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`);
    execFileSync('git', ['-C', worktree, 'apply', '--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('git', ['-C', worktree, 'apply', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const worktree = (deps.resolveWorktree ?? resolveWorktree)(options.cwd);
  const { url, token } = await (deps.resolveCredentials ?? resolveCredentials)(env);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const body = JSON.stringify({
    worktree, phase: options.phase, command: options.command,
    ...(options.timeoutMinutes ? { timeoutMinutes: options.timeoutMinutes } : {}),
  });
  const timeoutMs = (options.timeoutMinutes ?? MAX_RUN_MINUTES) * 60_000 + REQUEST_SLACK_MS;
  const { status, text } = await (deps.request ?? requestApi)(`${url}/api/docker-containment/run`, { method: 'POST', headers, body, timeoutMs });
  let result = null;
  try { result = JSON.parse(text); } catch { result = null; }

  if (status === 409 && result?.status === 'refused') {
    console.error(`❌ contained-run refused (${result.state}): ${result.reason}`);
    console.error('Nothing ran. The command was NOT executed on the host.');
    return 2;
  }
  if (status < 200 || status >= 300 || !result) {
    console.error(`❌ contained-run: POST /api/docker-containment/run → ${status}`);
    if (text) console.error(text);
    if (status === 401 && !token) console.error('No credential found. Turn on Settings > Security > Agent API key in PortOS, or set PORTOS_API_TOKEN.');
    return 1;
  }

  if (result.log) process.stdout.write(result.log.endsWith('\n') ? result.log : `${result.log}\n`);
  if (result.logTruncated) console.error('⚠️ contained-run: the log was truncated to its most recent part');
  const where = `${result.phase} phase, Node ${result.nodeMajor}, ${result.engine?.kind ?? 'docker'} engine`;
  if (result.status === 'terminated') {
    console.error(`❌ contained-run ${result.reason === 'timeout' ? 'timed out' : 'was cancelled'} (${where}); the container and its work volume were removed`);
    return 124;
  }
  if (result.status !== 'completed') {
    console.error(`❌ contained-run failed (${where}): ${result.error ?? `exit ${result.exitCode}`}`);
    return 1;
  }

  if (result.patchTruncated) console.error('⚠️ contained-run: the change patch exceeded its size limit and was dropped');
  if (result.patch) {
    if (options.patchOut) {
      writeFileSync(options.patchOut, result.patch);
      console.error(`📝 contained-run: wrote the tracked-file patch to ${options.patchOut}`);
    }
    if (options.applyPatch) {
      const selected = selectApplicablePatch(result.patch);
      if (selected.patch) {
        (deps.applyPatch ?? applyPatch)(worktree, selected.patch);
        console.error(`📝 contained-run: applied lockfile changes to the worktree: ${selected.applied.join(', ')}`);
      }
      if (selected.malformed) console.error('⚠️ contained-run: the change patch is malformed; nothing was applied');
      if (selected.withheld.length) {
        console.error(`⚠️ contained-run: withheld changes to ${selected.withheld.join(', ')} — code run in the container edited them; review with --patch-out before applying anything by hand`);
      }
    } else if (!options.patchOut) {
      console.error('📝 contained-run: the step changed tracked files; rerun with --apply-patch or --patch-out <file> to keep them');
    }
  }
  // Status lines go to stderr so stdout carries only the command's own log.
  console.error(`${result.exitCode === 0 ? '✅' : '❌'} contained-run: exit ${result.exitCode} (${where}, contained)`);
  return result.exitCode;
}

if (isDirectlyInvoked(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`❌ ${err.message}`);
      if (/needs|Unknown option|must be|required/.test(err.message)) console.error(USAGE);
      process.exitCode = 1;
    });
}
