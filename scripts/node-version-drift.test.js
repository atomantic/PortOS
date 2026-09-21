/**
 * Drift guard for the supported Node.js runtime range (issue #3863).
 *
 * The supported range is owned by scripts/checkNodeVersion.js. This test keeps
 * manifests, setup entrypoints, README, CI, and the committed dependency graph
 * aligned with that owner. CI still runs the preferred Node 24 line, while a
 * dedicated minimum job exercises the lower supported Node 22 line.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

import {
  MIN_NODE,
  MIN_NODE_24,
  SUPPORTED_NODE_RANGE,
  parseVersion,
  satisfiesMinNode,
  satisfiesVersionRequirement,
} from './checkNodeVersion.js';

const REPO_ROOT = join(fileURLToPath(new URL('..', import.meta.url)));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

/**
 * True when a version pin — which may be partial (`24`, `24.x`) — names a
 * supported release line or a supported concrete version. A partial release
 * line resolves to its current patch, so it is checked by major rather than by
 * the current patch number.
 */
function pinSatisfiesSupportedRange(pin) {
  const raw = String(pin).trim().replace(/^v/, '');
  const [major] = parseVersion(raw);
  if (/^\d+(?:\.x)?$/i.test(raw)) return major === 22 || major === 24 || major >= 26;
  if (!/^\d+\.\d/.test(raw)) return false;
  return satisfiesMinNode(raw);
}

const MANIFESTS = ['package.json', 'client/package.json', 'server/package.json', 'autofixer/package.json'];
const LOCKFILES = ['package-lock.json', 'client/package-lock.json', 'server/package-lock.json', 'autofixer/package-lock.json'];
const NPMRCS = ['.npmrc', 'client/.npmrc', 'server/.npmrc', 'autofixer/.npmrc'];
const SUPPORTED_NODE_POINTS = [MIN_NODE, MIN_NODE_24, '26.0.0'];
const REQUIRED_DEPENDENCIES = [
  ['server/package-lock.json', 'node_modules/undici'],
  ['server/package-lock.json', 'node_modules/@babel/parser'],
  ['client/package-lock.json', 'node_modules/react-router'],
];

describe('Node version contract has exactly one owner (issue #3863)', () => {
  it('exports a concrete lower bound and a supported range', () => {
    expect(MIN_NODE).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MIN_NODE_24).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SUPPORTED_NODE_RANGE).toBe('^22.22.2 || ^24.15.0 || >=26.0.0');
  });

  // The pin comparison decides whether the .nvmrc / CI assertions below pass,
  // so it is verified against literals rather than trusted.
  it('pinSatisfiesSupportedRange reads release-line and point pins correctly', () => {
    expect(pinSatisfiesSupportedRange('24')).toBe(true);
    expect(pinSatisfiesSupportedRange('24.x')).toBe(true);
    expect(pinSatisfiesSupportedRange('22')).toBe(true);
    expect(pinSatisfiesSupportedRange('22.22.2')).toBe(true);
    expect(pinSatisfiesSupportedRange('22.22.1')).toBe(false);
    expect(pinSatisfiesSupportedRange('23')).toBe(false);
    expect(pinSatisfiesSupportedRange('24.14.0')).toBe(false);
    expect(pinSatisfiesSupportedRange('25.x')).toBe(false);
    expect(pinSatisfiesSupportedRange('20.19.0')).toBe(false);
    expect(pinSatisfiesSupportedRange('18')).toBe(false);
  });

  describe('floor sites equal SUPPORTED_NODE_RANGE', () => {
    it.each(MANIFESTS)('%s declares engines.node = the supported range', (rel) => {
      expect(readJson(rel).engines?.node).toBe(SUPPORTED_NODE_RANGE);
    });

    it.each(LOCKFILES)('%s records the supported range in its root package', (rel) => {
      expect(readJson(rel).packages?.['']?.engines?.node).toBe(SUPPORTED_NODE_RANGE);
    });

    it('setup.sh delegates the pre-install gate to the owner', () => {
      expect(read('setup.sh')).toMatch(/node scripts\/checkNodeVersion\.js/);
      expect(read('setup.sh')).not.toMatch(/22\.12/);
    });

    it('setup.ps1 delegates the pre-install gate to the owner', () => {
      expect(read('setup.ps1')).toMatch(/node scripts\/checkNodeVersion\.js/);
      expect(read('setup.ps1')).not.toMatch(/22\.12/);
    });

    it('README states the supported range', () => {
      expect(read('README.md')).toContain(SUPPORTED_NODE_RANGE);
    });
  });

  describe('preference sites stay on supported release lines', () => {
    it('.nvmrc is a supported release line', () => {
      const nvmrc = read('.nvmrc').trim();
      expect(nvmrc).toMatch(/^\d+(?:\.\d+)*$/);
      expect(pinSatisfiesSupportedRange(nvmrc), `.nvmrc (${nvmrc}) is outside the supported range`).toBe(true);
    });

    it('every CI setup-node pin is supported', () => {
      const workflows = execFileSync('git', ['ls-files', '-z', '.github/workflows'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      const pinsIn = (body) =>
        [...body.matchAll(/node-version:\s*['"]?v?(\d+(?:\.[\dx]+)*)/g)].map((m) => m[1]);
      const pins = workflows.flatMap((rel) => pinsIn(read(rel)).map((pin) => ({ rel, pin })));

      expect(pins.length).toBeGreaterThan(0);
      for (const rel of workflows) {
        const body = read(rel);
        if (!/actions\/setup-node/.test(body)) continue;
        expect(pinsIn(body).length, `${rel} uses setup-node but no node-version was parsed`)
          .toBeGreaterThan(0);
      }
      for (const { rel, pin } of pins) {
        expect(pinSatisfiesSupportedRange(pin), `${rel} pins node-version ${pin}, outside the supported range`)
          .toBe(true);
      }
    });

    it('CI explicitly exercises the lowest supported Node 22 point', () => {
      const workflow = read('.github/workflows/ci.yml');
      expect(workflow).toContain(`node-version: ${MIN_NODE}`);
      expect(workflow).toContain('name: Node minimum compatibility');
    });
  });

  describe('the advertised range covers required dependency engines', () => {
    it.each(REQUIRED_DEPENDENCIES)('%s %s accepts every supported runtime point', (rel, packagePath) => {
      const dependency = readJson(rel).packages?.[packagePath];
      expect(dependency?.engines?.node, `${rel} ${packagePath} has no node engine`).toBeTruthy();
      for (const version of SUPPORTED_NODE_POINTS) {
        expect(
          satisfiesVersionRequirement(version, dependency.engines.node),
          `${packagePath} rejects supported Node ${version} with ${dependency.engines.node}`,
        ).toBe(true);
      }
    });
  });

  describe('the range is actually enforced', () => {
    it.each(NPMRCS)('%s does not set engine-strict', (rel) => {
      expect(read(rel)).not.toMatch(/^\s*engine-strict\s*=\s*true/m);
    });

    it.each(['setup', 'start', 'dev'])(
      'the root `%s` script runs the version check first',
      (name) => {
        expect(readJson('package.json').scripts[name]).toMatch(
          /^node scripts\/checkNodeVersion\.js &&/
        );
      }
    );
  });
});
