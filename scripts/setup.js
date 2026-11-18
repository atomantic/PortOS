#!/usr/bin/env node
/**
 * The one first-run install pipeline: `npm run setup`, setup.sh and setup.ps1
 * all execute these steps, in this order, so a fix lands once and a platform
 * can no longer drift from the others (the Windows path used to hand-copy the
 * chain, and `--prefix` installs needed Developer Mode there).
 *
 * Runs on a fresh clone before any dependency exists, so it imports only Node
 * builtins and repo files whose own imports are builtins (scripts/pre-install-entrypoints.test.js
 * enforces that closure). Dependencies install through scripts/ensure-deps.js's
 * installWorkspace — cwd-based `npm install --no-save` with the clean retry,
 * followed by the trusted native rebuilds — never `--prefix`.
 *
 * ffmpeg and slash-do are fail-soft: PortOS runs without them, so neither can
 * fail setup. `PORTOS_DEFER_SETUP_GUIDE=1` (set by setup.sh) is honored by
 * scripts/setup-guide.js so the guide can print after the start prompt.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { installWorkspace } from './ensure-deps.js';
import { dependencyWorkspaces, hasLinkedDependencies } from './lib/workspaceDependencies.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Runs a command in the repo root with inherited stdio; returns its exit status (1 when it could not start). */
function execInherit(command, args, { cwd }) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  return result.status ?? 1;
}

/**
 * The ordered pipeline. Each step's `run(ctx)` returns an exit status (0 = ok).
 * `failSoft` steps warn and continue instead of failing setup.
 */
export function buildSetupSteps({ root, interactive }) {
  const workspaces = dependencyWorkspaces(root);
  const script = (file, ...args) => ({ exec }) => exec(process.execPath, [join(root, 'scripts', file), ...args]);
  const all = (...runs) => (ctx) => {
    for (const run of runs) {
      const status = run(ctx);
      if (status !== 0) return status;
    }
    return 0;
  };
  return [
    {
      id: 'versions',
      title: 'Checking Node, npm and git versions',
      run: all(script('checkNodeVersion.js', '--security'), script('checkNpmVersion.js'), script('checkGitVersion.js'))
    },
    {
      id: 'submodules',
      title: 'Updating git submodules',
      run: ({ exec }) => exec('git', ['submodule', 'update', '--init', '--recursive'])
    },
    {
      id: 'dependencies',
      title: 'Installing dependencies (root, client, server, autofixer) and rebuilding trusted native packages',
      run: ({ install, log }) => {
        // A CoS worktree's node_modules are symlinks into the primary checkout;
        // installing through them would empty the primary's dependencies.
        const linked = workspaces.find(({ dir }) => hasLinkedDependencies(dir));
        if (linked) {
          log(`⛔ Refusing to install: ${linked.label}/node_modules is linked to another checkout. Run setup in the source checkout.`);
          return 1;
        }
        for (const { dir, label } of workspaces) {
          if (!install(dir, label)) return 1;
        }
        return 0;
      }
    },
    { id: 'data', title: 'Setting up the data directory', run: script('setup-data.js') },
    { id: 'database', title: 'Setting up PostgreSQL', run: script('setup-db.js') },
    { id: 'llm', title: 'Setting up local LLM', run: script('setup-llm.js') },
    { id: 'browser', title: 'Setting up the managed browser', run: script('setup-browser.js') },
    { id: 'cert', title: 'Provisioning the Tailscale certificate when possible', run: script('setup-cert.js') },
    {
      id: 'ffmpeg',
      title: 'Checking ffmpeg',
      failSoft: true,
      run: script('ensure-ffmpeg.js', ...(interactive ? [] : ['--non-interactive']))
    },
    { id: 'slash-do', title: 'Installing slash-do commands', failSoft: true, run: script('install-slashdo.js') },
    { id: 'guide', title: 'Printing the setup walkthrough', run: script('setup-guide.js') }
  ];
}

/** Runs the pipeline; returns the process exit code. Collaborators are injectable for tests. */
export function runSetup({
  root = ROOT,
  interactive = Boolean(process.stdin.isTTY),
  exec = (command, args) => execInherit(command, args, { cwd: root }),
  install = installWorkspace,
  log = console.log
} = {}) {
  const steps = buildSetupSteps({ root, interactive });
  const ctx = { exec, install, log };
  for (const [index, step] of steps.entries()) {
    log(`\n▶️  [${index + 1}/${steps.length}] ${step.title}...`);
    const status = step.run(ctx);
    if (status === 0) continue;
    if (step.failSoft) {
      log(`⚠️  ${step.id} step exited ${status} — continuing (it is optional)`);
      continue;
    }
    log(`\n❌ Setup step "${step.id}" failed (exit ${status}). Fix the issue above, then re-run setup.`);
    return status;
  }
  return 0;
}

if (isDirectlyInvoked(import.meta.url)) process.exitCode = runSetup();
