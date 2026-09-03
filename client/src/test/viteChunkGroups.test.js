import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHUNK_GROUPS } from '../../vite.chunkGroups.js';

const CLIENT_DIR = resolve(import.meta.dirname, '../..');

// Resolve against the checked-in lockfiles, not an installed `node_modules`
// tree: the lockfile is deterministic, covers nested (unflattened) transitive
// dependencies the group regexes still match at any depth, and cannot be
// satisfied by a stale directory left behind by an uninstalled package.
const lockedPackageNames = () => {
  const names = new Set();
  for (const lockfile of ['package-lock.json', '../package-lock.json']) {
    const file = resolve(CLIENT_DIR, lockfile);
    if (!existsSync(file)) continue;
    for (const key of Object.keys(JSON.parse(readFileSync(file, 'utf-8')).packages ?? {})) {
      const marker = key.lastIndexOf('node_modules/');
      if (marker !== -1) names.add(key.slice(marker + 'node_modules/'.length));
    }
  }
  return [...names];
};

const LOCKED_PACKAGES = lockedPackageNames();

const isInstalled = (name) => {
  if (name.endsWith('*')) return LOCKED_PACKAGES.some((pkg) => pkg.startsWith(name.slice(0, -1)));
  // A bare `@scope` entry stands for every package published under it.
  if (name.startsWith('@') && !name.includes('/')) {
    return LOCKED_PACKAGES.some((pkg) => pkg.startsWith(`${name}/`));
  }
  return LOCKED_PACKAGES.includes(name);
};

const groupNamed = (name) => CHUNK_GROUPS.find((group) => group.name === name);

describe('vite chunk groups', () => {
  // The regression: a group regex naming a package that is not installed matches
  // nothing, so the named chunk quietly stops capturing what its comment claims.
  // `vendor-three` shipped that way against the removed `three-fenestra` (#5725).
  it('only names packages that are actually installed', () => {
    const missing = CHUNK_GROUPS.flatMap(({ name, packages }) =>
      packages.filter((pkg) => !isInstalled(pkg)).map((pkg) => `${name} -> ${pkg}`));
    expect(LOCKED_PACKAGES.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });

  it('captures the whole three stack on both path separators', () => {
    const { test } = groupNamed('vendor-three');
    expect(test.test('/app/node_modules/three/build/three.module.js')).toBe(true);
    expect(test.test('/app/node_modules/three-stdlib/index.js')).toBe(true);
    expect(test.test('/app/node_modules/three-mesh-bvh/src/index.js')).toBe(true);
    expect(test.test('C:\\app\\node_modules\\@react-three\\fiber\\index.js')).toBe(true);
    // A `three`-prefixed package we do not depend on must not be swept in.
    expect(test.test('/app/node_modules/three-globe/index.js')).toBe(false);
  });

  it('keeps package names from bleeding across the separator', () => {
    // A declared name must match a whole path segment: `react` must not swallow
    // `react-redux`. The trailing separator is what enforces that.
    const { test } = groupNamed('vendor-react');
    expect(test.test('/app/node_modules/react/index.js')).toBe(true);
    expect(test.test('/app/node_modules/react-redux/index.js')).toBe(false);
    // Family prefixes still match every member.
    const charts = groupNamed('vendor-charts').test;
    expect(charts.test('/app/node_modules/d3-scale/src/band.js')).toBe(true);
    expect(charts.test('/app/node_modules/victory-vendor/d3-scale.js')).toBe(true);
  });
});
