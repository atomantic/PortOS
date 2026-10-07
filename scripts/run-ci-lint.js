#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isDirectlyInvoked } from './lib/directInvocation.js';

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

/** True when a changed-file list touches server code or its Biome config. */
export function touchesServer(repoFiles) {
  return repoFiles.some((path) => /^server\/(?!node_modules\/).*\.(?:m?js)$|^server\/biome\.jsonc$/i.test(path));
}

/**
 * Biome argv for the server tree. Only `noUndeclaredVariables` is an error; the
 * unused-variable rule is a warning (server/biome.jsonc), so no `--error-on-warnings`.
 * Diagnostics are capped so the known unused-variable backlog does not drown real errors.
 */
export const SERVER_LINT_ARGS = ['lint', '--max-diagnostics=20', '.'];

/** Build the Biome argv for a lint run. Pure, so the CI matrix is testable. */
export function buildLintArgs({ mode, clientFiles = [] }) {
  // `--error-on-warnings` holds the client's documented lint policy: every rule is
  // 'error' or off, never 'warn'. Biome defaults many rules to warn, so a rule
  // added later without an explicit severity would otherwise slip through CI.
  const base = ['lint', '--error-on-warnings'];
  if (mode === 'full') return [...base, 'src'];
  // A changed-files run can name a path that biome.jsonc's `files.includes`
  // excludes, or one the PR deleted. Biome treats "no files processed" as an
  // error by default, which would fail CI for a PR that only removes files.
  return [...base, '--no-errors-on-unmatched', ...clientFiles];
}

function runBiome(args, cwd) {
  const result = spawnSync(process.execPath, [BIOME_BIN, ...args], { cwd, stdio: 'inherit', env: process.env });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function main() {
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
    console.log('No changed client or server JavaScript files require linting.');
    process.exit(0);
  }

  if (!existsSync(BIOME_BIN)) {
    console.error(`❌ Biome not found at ${BIOME_BIN} — run \`npm ci --prefix client\` first.`);
    process.exit(1);
  }

  let status = 0;
  if (lintClient) {
    console.log(`Running client lint in ${mode} mode${mode === 'files' ? ` (${clientFiles.length} file(s))` : ''}.`);
    status = runBiome(buildLintArgs({ mode, clientFiles }), join(repoRoot, 'client')) || status;
  }
  if (lintServer) {
    console.log('Running server lint (whole tree).');
    status = runBiome(SERVER_LINT_ARGS, join(repoRoot, 'server')) || status;
  }
  process.exit(status);
}

if (isDirectlyInvoked(import.meta.url)) main();
