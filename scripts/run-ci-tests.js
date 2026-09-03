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

export function relatedInputs(sourceFiles, selectedFiles) {
  return [...new Set([...sourceFiles, ...selectedFiles])];
}

/**
 * Vitest selector flags for this runner's slice of a full suite. `CI_SHARD` is
 * `<index>/<count>` from the job matrix (ci.yml). A single shard passes nothing,
 * so the one-runner invocation stays identical to a local `npm run test:ci`.
 */
export function shardArgs(shard) {
  if (!shard) return [];
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error(`CI_SHARD must look like <index>/<count>, got "${shard}"`);
  return match[2] === '1' ? [] : [`--shard=${shard}`];
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
    const shard = shardArgs(process.env.CI_SHARD);
    const label = shard.length ? `full suite shard ${process.env.CI_SHARD}` : 'full suite';
    process.exit(spawnNpm(scope, 'test:ci', shard, label));
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
  // A test file passed to `vitest related` is itself selected, so changed tests
  // and structural guards can share the source graph's one Vitest invocation.
  // Running them in a second exact-file process repeated any changed test that
  // already imported the source; on PR #5299 that rebuilt the atlas twice and
  // added 27.5 seconds after the related run had already passed it.
  process.exit(spawnNpm(
    scope,
    'test:ci:related',
    relatedInputs(sourceFiles, selectedFiles),
    'related and contract tests',
  ));
}

if (isDirectlyInvoked(import.meta.url)) main();
