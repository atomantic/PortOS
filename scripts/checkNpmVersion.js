/**
 * npm floor advisory — the reason the lockfiles keep showing up modified.
 *
 * Symptom: `client/package-lock.json` (and `server/`'s) appears in `git status`
 * after every local `npm install`, deleting entries nobody edited — most
 * visibly the `libc` arrays on the Linux-only Rollup/esbuild optional deps
 * (`+0 / -66`, one file changed, over and over).
 *
 * Cause: npm's lockfile writer copies a fixed list of manifest fields into each
 * entry — `pkgMetaKeys` in `@npmcli/arborist`'s `lib/shrinkwrap.js`. `libc` was
 * added in arborist 9.4.0, shipped by npm 11.11.0. Earlier npm 11 releases
 * omit it, so their installs can churn lockfiles authored by newer npm.
 * npm 11.11.0 also preserves `peer: true`; neither field requires npm 12.
 * Source: https://github.com/npm/cli/blob/v11.11.0/workspaces/arborist/lib/shrinkwrap.js
 * Compare v11.10.1, whose pkgMetaKeys still omits `libc`.
 *
 * PortOS-managed setup, update, and dependency-repair installs pass `--no-save`
 * so they honor the committed lockfile without rewriting it. A direct
 * dependency-authoring `npm install` on an older npm still churns the lockfile.
 * This is an authoring advisory, not a runtime gate. Recommend the verified
 * floor explicitly: npm@latest may require a newer Node than PortOS does.
 *
 * This advisory is the explainer, not the whole floor. The four `engines.npm`
 * fields are the declarative half, and they are what covers the install paths
 * this script never sees — `cd client && npm install` and `npm i <pkg>` —
 * because npm checks them itself and prints EBADENGINE. `engine-strict` stays
 * off (see the .npmrc note: it would make one dependency's narrow range break
 * every install), so those stay warnings too.
 *
 * The advisory also names the case that makes this confusing to diagnose: a
 * stale global npm earlier on PATH than the one Node bundles, so `npm -v`
 * reports a version far older than the Node in use would suggest.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';

import { compareVersions } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

/**
 * The first npm whose lockfile writer records `libc`. Changing this means
 * changing exactly this string — scripts/checkNpmVersion.test.js pins the
 * arborist/npm reasoning above to it.
 */
export const MIN_NPM = '11.11.0';

/**
 * Read the npm version out of the `npm_config_user_agent` npm exports to its
 * run-scripts (`npm/9.6.0 node/v24.10.0 win32 x64 workspaces/false`). This is
 * the npm actually running the install in the same script chain, which a
 * `which npm` lookup is not guaranteed to be.
 * @returns {string|null} - The version, or null when not running under npm
 */
export function parseNpmUserAgent(userAgent = process.env.npm_config_user_agent) {
  const match = /(?:^|\s)npm\/(\d+(?:\.\d+)*)/.exec(String(userAgent));
  return match ? match[1] : null;
}

/**
 * The version of the npm that ships inside the running Node, so the advisory
 * can tell "your npm is old" apart from "your npm is old *and* it isn't even
 * the one Node gave you". Handles both install layouts: `<dir>/node_modules`
 * next to the binary (Windows, and npm's own installer) and the POSIX
 * `<prefix>/lib/node_modules` one.
 * @returns {string|null} - The version, or null when it can't be read
 */
export function readBundledNpmVersion(execPath = process.execPath) {
  const base = dirname(execPath);
  const candidates = [
    join(base, 'node_modules', 'npm', 'package.json'),
    join(base, '..', 'lib', 'node_modules', 'npm', 'package.json')
  ];
  for (const candidate of candidates) {
    try {
      const { version } = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof version === 'string' && version) return version;
    } catch {
      // Not this layout (or an unreadable/corrupt manifest) — try the next.
    }
  }
  return null;
}

/**
 * The advisory lines for a given toolchain, or `[]` when nothing is wrong.
 * Pure and injectable so the test can exercise every branch without an npm.
 * @param {object} options
 * @param {string|null} options.npmVersion - npm running the install
 * @param {string|null} options.bundledNpmVersion - npm shipped with `nodeVersion`
 * @param {string} options.nodeVersion - the running Node
 * @returns {string[]} - Single-line messages, ready to print in order
 */
export function npmAdvisory({
  npmVersion,
  bundledNpmVersion = null,
  nodeVersion = process.versions.node
} = {}) {
  // Not running under npm (a bare `node scripts/checkNpmVersion.js`, or a
  // wrapper that stripped the env) — there is no install to warn about.
  if (!npmVersion) return [];
  if (compareVersions(npmVersion, MIN_NPM) >= 0) return [];

  const lines = [
    `⚠️  npm ${npmVersion} is below ${MIN_NPM} — direct npm installs can rewrite package-lock.json`,
    `ℹ️  npm before ${MIN_NPM} drops the libc metadata newer npm records, so direct installs can churn the lockfiles`
  ];

  // The confusing case: PATH is resolving an older global npm ahead of the one
  // Node bundles, so `npm -v` looks stuck in the past no matter which Node runs.
  if (bundledNpmVersion && compareVersions(npmVersion, bundledNpmVersion) < 0) {
    lines.push(
      `ℹ️  Node v${String(nodeVersion).replace(/^v/, '')} bundles npm ${bundledNpmVersion}, but PATH resolves npm ${npmVersion} — an older global install is shadowing it`
    );
  }

  lines.push(`🔧 Fix: npm install -g npm@${MIN_NPM}`);
  return lines;
}

/**
 * Print the advisory. Always resolves to whether anything was reported — this
 * never exits non-zero, so it is safe to chain ahead of a real install.
 * @returns {boolean} - True when an advisory was printed
 */
export function warnOnOutdatedNpm({
  npmVersion = parseNpmUserAgent(),
  bundledNpmVersion = readBundledNpmVersion(),
  warn = console.warn
} = {}) {
  const lines = npmAdvisory({ npmVersion, bundledNpmVersion });
  for (const line of lines) warn(line);
  return lines.length > 0;
}

// Runnable directly: `node scripts/checkNpmVersion.js`.
if (isDirectlyInvoked(import.meta.url)) {
  warnOnOutdatedNpm();
}
