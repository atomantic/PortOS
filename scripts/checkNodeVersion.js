/**
 * Single source of truth for the supported Node.js runtime range (issue #3863).
 *
 * The floor used to be copied into five places that could drift independently
 * (setup.sh, setup.ps1, .nvmrc, the CI workflows, README prose) while the
 * primary install path — `npm run setup` && `npm start`, straight out of the
 * README — enforced none of them. On an unsupported Node the install would
 * succeed, several minutes would pass, and the run would die inside Vite with
 * an error that never names the cause.
 *
 * The supported range below is now the only place the runtime contract is
 * written down:
 *   - the four `engines` fields declare it machine-readably (npm warns on a
 *     mismatch; `engine-strict` is deliberately NOT set — see the .npmrc note,
 *     it would make one dependency's narrow range break every install),
 *   - `npm run setup` / `npm start` / `npm run dev` run this file first, so an
 *     unsupported Node fails in the first second instead of the fifth minute,
 *   - scripts/node-version-drift.test.js fails if any of the other sites is
 *     left behind when MIN_NODE moves.
 *
 * The current dependency intersection is `^22.22.2 || ^24.15.0 || >=26.0.0`:
 * react-router requires Node 22.22, while the Babel toolchain and the
 * dependency graph's supported Node 24 line require later patches. Node 23 and
 * 25 are intentionally excluded by dependencies with even-major ranges.
 * `.nvmrc`/CI at 24 remains the preferred LTS, while the minimum CI job proves
 * the lower supported Node 22 line.
 */

import { isDirectlyInvoked } from './lib/directInvocation.js';

/** The lowest supported Node 22 patch. */
export const MIN_NODE = '22.22.2';

/** The lowest supported Node 24 patch. */
export const MIN_NODE_24 = '24.15.0';

/** The supported runtime range shared by manifests, setup, and CI. */
export const SUPPORTED_NODE_RANGE = `^${MIN_NODE} || ^${MIN_NODE_24} || >=26.0.0`;

/** Parse `v22.12.0` / `22.12` / `22` into a [major, minor, patch] tuple. */
export function parseVersion(version) {
  const parts = String(version)
    .trim()
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** -1 / 0 / 1, comparing `a` against `b` semver-numerically. */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Compare a tool version against the small, portable subset of npm engine
 * ranges used by PortOS manifests. Unsupported syntax returns null so callers
 * can fail closed instead of treating an unknown requirement as compatible.
 */
export function satisfiesVersionRequirement(version, requirement) {
  if (typeof version !== 'string' || !version.trim() || typeof requirement !== 'string' || !requirement.trim()) {
    return null;
  }
  if (!/^v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(version.trim())) return null;
  const alternatives = requirement.split('||').map((part) => part.trim()).filter(Boolean);
  if (!alternatives.length) return null;

  const satisfiesComparator = (candidate, comparator) => {
    const token = comparator.trim();
    if (!token || token === '*' || /^x$/i.test(token)) return true;
    const match = token.match(/^(>=|<=|>|<|=|\^|~)?\s*(v?\d+(?:\.\d+){0,2})(?:\.[xX*])?$/);
    if (!match) return null;
    const operator = match[1] || '=';
    const target = match[2];
    const comparison = compareVersions(candidate, target);
    const numericParts = target.replace(/^v/, '').split('.').map((part) => Number(part));
    const major = numericParts[0];
    const minor = numericParts[1] || 0;
    const patch = numericParts[2] || 0;
    const isPartial = numericParts.length < 3 || /(?:^|\.)[xX*]$/.test(token);
    const partialUpper = numericParts.length < 2
      ? `${major + 1}.0.0`
      : `${major}.${minor + 1}.0`;
    if (operator === '=' && isPartial) {
      return comparison >= 0 && compareVersions(candidate, partialUpper) < 0;
    }
    if (operator === '>=') return comparison >= 0;
    if (operator === '<=') return isPartial
      ? compareVersions(candidate, partialUpper) < 0
      : comparison <= 0;
    if (operator === '>') return isPartial
      ? compareVersions(candidate, partialUpper) >= 0
      : comparison > 0;
    if (operator === '<') return comparison < 0;
    if (operator === '^') {
      const upper = major > 0
        ? `${major + 1}.0.0`
        : minor > 0
          ? `0.${minor + 1}.0`
          : numericParts.length < 3 ? '0.1.0' : `0.0.${patch + 1}`;
      return comparison >= 0 && compareVersions(candidate, upper) < 0;
    }
    if (operator === '=') return comparison === 0;
    const upper = numericParts.length < 2 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
    return comparison >= 0 && compareVersions(candidate, upper) < 0;
  };

  const results = alternatives.map((alternative) => {
    const comparators = alternative.replaceAll(',', ' ').split(/\s+/).filter(Boolean);
    const values = comparators.map((comparator) => satisfiesComparator(version, comparator));
    if (values.some((value) => value === null)) return null;
    return values.every(Boolean);
  });
  if (results.some(Boolean)) return true;
  if (results.every((value) => value === false)) return false;
  return null;
}

/** True when `version` is in the supported runtime range. */
export function satisfiesMinNode(version = process.versions.node) {
  return satisfiesVersionRequirement(version, SUPPORTED_NODE_RANGE) === true;
}

/** The one-line failure message, shared by the Node and shell gates. */
export function unsupportedNodeMessage(version = process.versions.node) {
  return `Node.js ${SUPPORTED_NODE_RANGE} required (found v${String(version).trim().replace(/^v/, '')}) — see .nvmrc`;
}

/**
 * Exit non-zero with `unsupportedNodeMessage` when the running Node is outside
 * the supported range. Injectable so the test can exercise both branches without
 * spawning a second interpreter or tearing down the runner.
 */
export function assertNodeVersion({
  version = process.versions.node,
  onFail = (message) => {
    console.error(`❌ ${message}`);
    process.exit(1);
  },
} = {}) {
  if (satisfiesMinNode(version)) return true;
  onFail(unsupportedNodeMessage(version));
  return false;
}

// Runnable directly: `node scripts/checkNodeVersion.js` — see lib/directInvocation.js
// for why this comparison is not a plain string equality.
if (isDirectlyInvoked(import.meta.url)) {
  assertNodeVersion();
}
