#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { appendFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function requiresSourceFiles(mode, repoSources) {
  return mode === 'related' && repoSources.length === 0;
}

export function toRunnerPath(scope, path) {
  // Prefix in-root selectors so a contributor-controlled filename beginning
  // with "-" cannot be interpreted as another Vitest CLI option.
  if (scope === 'client') return `./${path.replace(/^client\//, '')}`;
  if (path.startsWith('server/')) return `./${path.replace(/^server\//, '')}`;
  return `../${path}`;
}

export function recordVitestDuration(scope, label, startedAt) {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const line = `⏱ ${scope} ${label}: ${seconds}s`;
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
}

function spawnNpm(scope, script, extraArgs, label) {
  const args = ['run', script, '--prefix', scope];
  if (extraArgs.length > 0) args.push('--', ...extraArgs);
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  // Wrapped, not a bare `npm.cmd`: Node refuses to spawn a `.cmd` under
  // `shell:false` and throws EINVAL, so this script could never run on a
  // Windows checkout. See server/lib/bufferedSpawn.js.
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args);
  const startedAt = Date.now();
  const result = spawnSync(command, spawnArgs, {
    stdio: 'inherit',
    env: process.env,
    cwd: repoRoot,
  });
  recordVitestDuration(scope, label, startedAt);
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
  const scope = process.argv[2];
  if (!['server', 'client'].includes(scope)) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client>');
    process.exit(2);
  }

  const mode = process.env.CI_TEST_MODE || 'full';
  const repoFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');
  const repoSources = JSON.parse(process.env.CI_TEST_SOURCES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(scope, path));
  const sourceFiles = repoSources.map((path) => toRunnerPath(scope, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (requiresSourceFiles(mode, repoSources)) {
    console.error('CI_TEST_SOURCES must name at least one changed source file in related-test mode.');
    process.exit(2);
  }

  if (mode === 'full') {
    process.exit(spawnNpm(scope, 'test:ci', [], 'full suite'));
  }

  if (mode === 'files') {
    if (selectedFiles.length === 0) {
      console.log(`No ${scope} tests selected.`);
      process.exit(0);
    }
    process.exit(spawnNpm(scope, 'test:ci', selectedFiles, 'selected tests'));
  }

  // Feed Vitest the actual changed source files instead of asking `list
  // --changed` to print every individual test name into a buffered subprocess.
  // The old discovery pass took 282 seconds on PR #5296, overflowed Node's
  // spawnSync buffer, discarded its work, then reran the same graph. `related`
  // builds that graph once and immediately executes it.
  const relatedStatus = spawnNpm(scope, 'test:ci:related', sourceFiles, 'source-related tests');
  if (relatedStatus !== 0) process.exit(relatedStatus);

  // Structural and repository-wide guards do not import the source they scan,
  // so the import graph cannot discover them. They are deliberately cheap and
  // run once after the related set.
  process.exit(selectedFiles.length
    ? spawnNpm(scope, 'test:ci', selectedFiles, 'explicit contract guards')
    : 0);
}

if (isDirectlyInvoked(import.meta.url)) main();
