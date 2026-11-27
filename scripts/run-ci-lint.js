#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import { SERVER_LINT_RE } from './lib/serverLintSurface.js';

export { SERVER_LINT_RE };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// Biome ships a Node wrapper (`#!/usr/bin/env node`) as its bin, which then execs
// the platform binary from the matching @biomejs/cli-* optional dependency. So it
// is spawned through the current `process.execPath` exactly like the old eslint bin
// was — no PATH lookup, and no Windows `.cmd` shim in play.
export const BIOME_BIN = join(
  repoRoot, 'client', 'node_modules', '@biomejs', 'biome', 'bin', 'biome',
);

export const LINT_MODES = ['files', 'full'];

/** Narrow a repo-wide changed-file list to the client sources Biome lints. */
export function selectClientFiles(repoFiles) {
  return repoFiles
    .filter((path) => /^client\/src\/.*\.(?:js|jsx)$/i.test(path))
    .map((path) => path.replace(/^client\//, ''));
}

/** True when a changed-file list touches a tree the server rule set lints, or its config. */
export function touchesServer(repoFiles) {
  return repoFiles.some((path) => SERVER_LINT_RE.test(path));
}

// Both trees reject warnings, including diagnostics whose severity comes from tool defaults.
export const SERVER_LINT_ARGS = ['lint', '--error-on-warnings', '--max-diagnostics=20', '.'];
// Repo root. Pass the three trees explicitly: `biome lint .` from the repo root
// errors on the nested server/ and client/ configs, which are their own roots.
// biome.jsonc's includes still drop lib/slashdo and node_modules.
export const SHARED_LINT_ARGS = ['lint', '--error-on-warnings', '--max-diagnostics=20', 'scripts', 'lib', 'autofixer'];

/** Build the Biome argv for a lint run. Pure, so the CI matrix is testable. */
export function buildLintArgs({ mode, clientFiles = [] }) {
  // `--error-on-warnings` holds the client's documented lint policy: every rule is
  // 'error' or off, never 'warn'. Biome defaults many rules to warn, so a rule
  // added later without an explicit severity would otherwise slip through CI.
  const base = ['lint', '--error-on-warnings'];
  if (mode === 'full') return [...base, 'src'];
  // The CI plan excludes deleted paths. A remaining path can still be excluded
  // by biome.jsonc's `files.includes`, which can leave Biome with no files.
  return [...base, '--no-errors-on-unmatched', ...clientFiles];
}

function runBiome(args, cwd) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [BIOME_BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => stderr.push(Buffer.from(`${error.message}\n`)));
    child.on('close', status => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function main() {
  const mode = process.env.CI_LINT_MODE || 'full';
  if (!LINT_MODES.includes(mode)) {
    console.error(`Unsupported CI lint mode: ${mode}`);
    process.exit(2);
  }

  const repoFiles = JSON.parse(process.env.CI_LINT_FILES || '[]');
  const clientFiles = selectClientFiles(repoFiles);
  const lintClient = mode === 'full' || clientFiles.length > 0;
  const lintServer = mode === 'full' || touchesServer(repoFiles);
  if (!lintClient && !lintServer) {
    console.log('No changed client, server, scripts, lib, or autofixer JavaScript files require linting.');
    process.exit(0);
  }

  if (!existsSync(BIOME_BIN)) {
    console.error(`❌ Biome not found at ${BIOME_BIN} — run \`npm ci --prefix client\` first.`);
    process.exit(1);
  }

  const checks = [];
  if (lintClient) {
    const scope = mode === 'files' ? ` (${clientFiles.length} file(s))` : '';
    checks.push({
      heading: `Running client lint in ${mode} mode${scope}.`,
      result: runBiome(buildLintArgs({ mode, clientFiles }), join(repoRoot, 'client')),
    });
  }
  if (lintServer) {
    checks.push(
      { heading: 'Running server lint (whole tree).', result: runBiome(SERVER_LINT_ARGS, join(repoRoot, 'server')) },
      { heading: 'Running scripts, lib, and autofixer lint.', result: runBiome(SHARED_LINT_ARGS, repoRoot) },
    );
  }

  // The processes are already running. Emit complete workspace reports in order.
  let status = 0;
  for (const check of checks) {
    const result = await check.result;
    console.log(check.heading);
    process.stdout.write(Buffer.concat(result.stdout));
    process.stderr.write(Buffer.concat(result.stderr));
    status = result.status || status;
  }
  process.exitCode = status;
}

if (isDirectlyInvoked(import.meta.url)) await main();
