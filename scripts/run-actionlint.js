#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { dirname, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { probeActionlint, selectWorkflowFiles, WORKFLOW_FILE_RE } from './lib/actionlint.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every committed workflow, for a full run. */
export function allWorkflowFiles() {
  const dir = join(repoRoot, '.github', 'workflows');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => `.github/workflows/${name}`)
    .filter((path) => WORKFLOW_FILE_RE.test(path))
    .sort();
}

/**
 * Which files to lint. Positional paths (the CI proof that the linter rejects a
 * known-bad fixture) win; otherwise the CI lint env decides, as run-ci-lint.js does.
 */
export function resolveTargets({ argv = [], env = process.env, cwd = process.cwd() } = {}) {
  if (argv.length > 0) return argv.map((path) => relative(repoRoot, resolve(cwd, path)));
  const mode = env.CI_LINT_MODE || 'full';
  if (mode === 'full') return allWorkflowFiles();
  return selectWorkflowFiles(JSON.parse(env.CI_LINT_FILES || '[]'));
}

function main() {
  const files = resolveTargets({ argv: process.argv.slice(2) });
  if (files.length === 0) {
    console.log('No changed workflow files require actionlint.');
    process.exit(0);
  }
  // Unavailable is a failure here: the pregate stage is only offered when the
  // probe passes, and CI installs the pinned binary before this step runs.
  const probe = probeActionlint();
  if (!probe.ok) {
    console.error(`❌ actionlint unavailable: ${probe.reason}`);
    process.exit(1);
  }
  console.log(`Running actionlint ${probe.version} on ${files.length} workflow file(s).`);
  const result = spawnSync(probe.bin, files, { cwd: repoRoot, stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (isDirectlyInvoked(import.meta.url)) main();
