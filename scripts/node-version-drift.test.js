/**
 * Drift guard for the Node.js version floor (issue #3863).
 *
 * The floor used to be written out longhand in five independent places —
 * setup.sh, setup.ps1, .nvmrc, the CI workflows, and README prose — with
 * nothing keeping them in agreement, and none of them on the primary
 * `npm run setup` / `npm start` path. scripts/checkNodeVersion.js now owns the
 * number; this test is what makes the other sites follow it.
 *
 * Two different assertions, deliberately:
 *   - the *floor* sites (shell gates, `engines`, README prose) must EQUAL
 *     MIN_NODE — they promise what the project supports;
 *   - the *preference* sites (.nvmrc, CI `node-version`) must be >= MIN_NODE —
 *     running CI on 24 while supporting 22.12 is correct, not drift.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { MIN_NODE, compareVersions, parseVersion } from './checkNodeVersion.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [MIN_MAJOR, MIN_MINOR] = parseVersion(MIN_NODE);
/** The README states the floor without its patch component ("22.12"). */
const MIN_NODE_SHORT = `${MIN_MAJOR}.${MIN_MINOR}`;
const ENGINES_RANGE = `>=${MIN_NODE}`;

const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const MANIFESTS = ['package.json', 'client/package.json', 'server/package.json', 'autofixer/package.json'];
const NPMRCS = ['.npmrc', 'client/.npmrc', 'server/.npmrc', 'autofixer/.npmrc'];

describe('Node version floor has exactly one owner (issue #3863)', () => {
  it('MIN_NODE is a concrete three-part version', () => {
    expect(MIN_NODE).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe('floor sites equal MIN_NODE', () => {
    it('setup.sh gates on the MIN_NODE major', () => {
      const match = read('setup.sh').match(/"\$NODE_VERSION"\s+-lt\s+(\d+)/);
      expect(match, 'setup.sh no longer contains a `-lt <major>` Node gate').toBeTruthy();
      expect(Number(match[1])).toBe(MIN_MAJOR);
    });

    it('setup.ps1 gates on the MIN_NODE major', () => {
      const match = read('setup.ps1').match(/\$majorVersion\s+-lt\s+(\d+)/);
      expect(match, 'setup.ps1 no longer contains a `-lt <major>` Node gate').toBeTruthy();
      expect(Number(match[1])).toBe(MIN_MAJOR);
    });

    it.each(MANIFESTS)('%s declares engines.node = the floor', (rel) => {
      expect(readJson(rel).engines?.node).toBe(ENGINES_RANGE);
    });

    it('README states the floor', () => {
      expect(read('README.md')).toContain(`Node.js ${MIN_NODE_SHORT} or later`);
    });
  });

  describe('preference sites stay at or above the floor', () => {
    it('.nvmrc is >= MIN_NODE', () => {
      const nvmrc = read('.nvmrc').trim();
      expect(nvmrc).toMatch(/^\d+(\.\d+)*$/);
      expect(compareVersions(nvmrc, `${MIN_MAJOR}`)).toBeGreaterThanOrEqual(0);
      // A bare major in .nvmrc ("24") resolves to that line's latest release, so
      // compare majors when it omits a minor rather than reading "24" as 24.0.0.
      if (parseVersion(nvmrc)[0] === MIN_MAJOR) {
        expect(compareVersions(nvmrc, MIN_NODE)).toBeGreaterThanOrEqual(0);
      }
    });

    it('every CI job pins a node-version >= MIN_NODE', () => {
      const workflows = execFileSync('git', ['ls-files', '-z', '.github/workflows'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      const pins = workflows.flatMap((rel) =>
        [...read(rel).matchAll(/node-version:\s*['"]?(\d+)(?:\.[\dx]+)*/g)].map((m) => ({
          rel,
          major: Number(m[1]),
        }))
      );
      // Sanity: without this the .each below would pass vacuously.
      expect(pins.length).toBeGreaterThan(0);
      for (const { rel, major } of pins) {
        expect(major, `${rel} pins node-version below the floor`).toBeGreaterThanOrEqual(MIN_MAJOR);
      }
    });
  });

  describe('the floor is actually enforced', () => {
    // Regression guard for the fix that #3863 originally proposed and this
    // change deliberately reversed: `engine-strict=true` makes npm treat
    // EBADENGINE as fatal for *dependencies* as well as for this project, so a
    // single transitive package with a narrow range breaks `npm install` on a
    // Node PortOS fully supports (jsdom@30 wants `^22.22.2 || ^24.15.0 || >=26`
    // — a supported Node 24.14 fails it). Enforcement lives in the script chain
    // below instead. Re-adding this line breaks every install, so it is guarded.
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
