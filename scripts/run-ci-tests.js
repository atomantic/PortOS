#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { prepareCliSpawn } from '../server/lib/bufferedSpawn.js';
import { ALWAYS_RUN_TESTS } from './ci-test-plan.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseVitestListOutput(stdout) {
  const files = [];
  const seen = new Set();
  for (const line of String(stdout || '').split('\n')) {
    const trimmed = line.trim();
    const sep = trimmed.indexOf(' > ');
    if (sep <= 0) continue;
    const file = trimmed.slice(0, sep);
    // vitest list prints `path > suite > test`. Skip log lines that happen
    // to contain the same separator but are not a file path.
    if (file.includes(' ')) continue;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

export function canonicalizeRunnerPath(path) {
  if (path.startsWith('../')) return path;
  return `./${String(path).replace(/^\.\//, '')}`;
}

export function unionSelectors(selectedFiles, relatedFiles) {
  const seen = new Set();
  const out = [];
  for (const file of [...relatedFiles, ...selectedFiles]) {
    const canonical = canonicalizeRunnerPath(file);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

export function shouldSkipRelatedList(mode, repoFiles) {
  // Docs-only / always-run plans already name the exact files. Walking
  // Vitest's import graph against a markdown diff just burns 15–30s.
  return mode === 'files'
    && repoFiles.length > 0
    && repoFiles.every((path) => ALWAYS_RUN_TESTS.includes(path));
}

export function toRunnerPath(scope, path) {
  // Prefix in-root selectors so a contributor-controlled filename beginning
  // with "-" cannot be interpreted as another Vitest CLI option.
  if (scope === 'client') return `./${path.replace(/^client\//, '')}`;
  if (path.startsWith('server/')) return `./${path.replace(/^server\//, '')}`;
  return `../${path}`;
}

function spawnNpm(scope, extraArgs, label) {
  const args = ['run', 'test:ci', '--prefix', scope];
  if (extraArgs.length > 0) args.push('--', ...extraArgs);
  console.log(`Running ${scope} ${label}${extraArgs.length ? ` (${extraArgs.length} selector argument(s))` : ''}.`);
  // Wrapped, not a bare `npm.cmd`: Node refuses to spawn a `.cmd` under
  // `shell:false` and throws EINVAL, so this script could never run on a
  // Windows checkout. See server/lib/bufferedSpawn.js.
  const { command, args: spawnArgs } = prepareCliSpawn('npm', args);
  const result = spawnSync(command, spawnArgs, {
    stdio: 'inherit',
    env: process.env,
    cwd: repoRoot,
  });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

export function listRelatedCwd(scope) {
  // `npm exec --prefix server` still inherits this process cwd, and Vitest
  // resolves its config + --changed graph from cwd — so listing from the
  // repo root would miss server/vitest.config.js and silently drop related
  // tests. Run the list from the workspace that owns the runner.
  return join(repoRoot, scope);
}

function listRelatedFiles(scope, baseSha) {
  const { command, args } = prepareCliSpawn('npm', [
    'exec', '--',
    'vitest', 'list', '--changed', baseSha, '--silent',
  ]);
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    cwd: listRelatedCwd(scope),
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr || `exit ${result.status}`;
    console.warn(`⚠️  Could not list related ${scope} tests (${detail}). Falling back.`);
    return null;
  }
  return parseVitestListOutput(result.stdout);
}

function main() {
  const scope = process.argv[2];
  if (!['server', 'client'].includes(scope)) {
    console.error('Usage: node scripts/run-ci-tests.js <server|client>');
    process.exit(2);
  }

  const mode = process.env.CI_TEST_MODE || 'full';
  const baseSha = process.env.CI_BASE_SHA;
  const repoFiles = JSON.parse(process.env.CI_TEST_FILES || '[]');
  const selectedFiles = repoFiles.map((path) => toRunnerPath(scope, path));

  if (!['full', 'files', 'related'].includes(mode)) {
    console.error(`Unsupported CI test mode: ${mode}`);
    process.exit(2);
  }

  if (mode === 'related' && !baseSha) {
    console.error('CI_BASE_SHA is required for related-test mode.');
    process.exit(2);
  }

  if (mode === 'full') {
    process.exit(spawnNpm(scope, [], 'full suite'));
  }

  if (mode === 'files' && selectedFiles.length === 0) {
    console.log(`No ${scope} tests selected.`);
    process.exit(0);
  }

  // One Vitest process for the union of planner files + import-graph related
  // tests. `--changed` ANDs with path selectors, so they cannot share argv —
  // list the related set, then run the union once.
  let relatedFiles = [];
  if (baseSha && !shouldSkipRelatedList(mode, repoFiles)) {
    const listed = listRelatedFiles(scope, baseSha);
    if (listed) {
      relatedFiles = listed;
    } else if (mode === 'related') {
      const relatedStatus = spawnNpm(scope, ['--changed', baseSha], 'related tests');
      if (relatedStatus !== 0) process.exit(relatedStatus);
      process.exit(selectedFiles.length ? spawnNpm(scope, selectedFiles, 'explicit structural tests') : 0);
    }
  } else if (mode === 'related') {
    process.exit(spawnNpm(scope, ['--changed', baseSha], 'related tests'));
  }

  const union = unionSelectors(selectedFiles, relatedFiles);
  if (union.length === 0) {
    console.log(`No ${scope} tests selected.`);
    process.exit(0);
  }
  process.exit(spawnNpm(scope, union, 'selected tests'));
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) main();
