/**
 * npm floor advisory: why the lockfiles keep showing up modified.
 *
 * Symptom: `client/package-lock.json` (and `server/`'s) appears in `git status`
 * after every local `npm install`, deleting entries nobody edited (the `libc`
 * arrays on the Linux-only Rollup/esbuild optional deps).
 *
 * Cause: npm's lockfile writer copies a fixed list of manifest fields
 * (`pkgMetaKeys` in `@npmcli/arborist`'s `lib/shrinkwrap.js`). `libc` was added in
 * arborist 9.4.0 (npm 11.11.0, which also preserves `peer: true`); earlier npm 11
 * omits it and churns lockfiles authored by newer npm. Source:
 * https://github.com/npm/cli/blob/v11.11.0/workspaces/arborist/lib/shrinkwrap.js
 *
 * PortOS-managed installs pass `--no-save` so they honor the committed lockfile;
 * this is an authoring advisory, not a runtime gate. It recommends the verified
 * floor because npm@latest may require a newer Node than PortOS.
 *
 * The four `engines.npm` fields are the declarative half, covering paths this
 * script never sees (`cd client && npm install`): npm prints EBADENGINE itself.
 * `engine-strict` stays off (one dependency's narrow range would break every
 * install). The advisory also names a stale global npm earlier on PATH than the
 * one Node bundles.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';

import { compareVersions } from './checkNodeVersion.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';

/**
 * The first npm whose lockfile writer records `libc`; scripts/checkNpmVersion.test.js
 * pins the arborist/npm reasoning above to this string.
 */
export const MIN_NPM = '11.11.0';

/**
 * The npm version from `npm_config_user_agent` (`npm/9.6.0 node/v24.10.0 ...`):
 * the npm actually running the install, which `which npm` may not be.
 * @returns {string|null} - null when not running under npm
 */
export function parseNpmUserAgent(userAgent = process.env.npm_config_user_agent) {
  const match = /(?:^|\s)npm\/(\d+(?:\.\d+)*)/.exec(String(userAgent));
  return match ? match[1] : null;
}

/**
 * The version of the npm that ships inside the running Node, so the advisory can
 * tell "your npm is old" from "and it isn't the one Node gave you". Handles
 * `<dir>/node_modules` next to the binary (Windows, npm's installer) and the POSIX
 * `<prefix>/lib/node_modules`.
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
 * The advisory lines for a given toolchain, or `[]` when nothing is wrong. Pure and
 * injectable so tests exercise every branch without an npm.
 * `npmVersion` is the npm running the install, `bundledNpmVersion` the npm shipped
 * with `nodeVersion`. Returns single-line messages in print order.
 */
export function npmAdvisory({
  npmVersion,
  bundledNpmVersion = null,
  nodeVersion = process.versions.node
} = {}) {
  // Not running under npm (a bare `node` run, or a wrapper that stripped the env).
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
 * Print the advisory. Never exits non-zero, so it is safe to chain ahead of an install.
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
