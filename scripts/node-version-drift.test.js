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

/**
 * True when a version *pin* — which may be partial (`24`, `24.x`, `22.12.0`) —
 * is at or above the floor. A pin without an explicit numeric minor names a
 * release line, not a point release, so `22`/`22.x` resolves to the latest 22
 * and clears a 22.12 floor; `22.10.0` names a real version and does not.
 */
function pinSatisfiesFloor(pin) {
  const raw = String(pin).trim();
  const [major] = parseVersion(raw);
  if (major !== MIN_MAJOR) return major > MIN_MAJOR;
  if (!/^\d+\.\d/.test(raw)) return true;
  return compareVersions(raw, MIN_NODE) >= 0;
}

const MANIFESTS = ['package.json', 'client/package.json', 'server/package.json', 'autofixer/package.json'];
const NPMRCS = ['.npmrc', 'client/.npmrc', 'server/.npmrc', 'autofixer/.npmrc'];

describe('Node version floor has exactly one owner (issue #3863)', () => {
  it('MIN_NODE is a concrete three-part version', () => {
    expect(MIN_NODE).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // The pin comparison decides whether the .nvmrc / CI assertions below pass,
  // so it is verified against literals rather than trusted.
  it('pinSatisfiesFloor reads partial and point pins correctly', () => {
    expect(MIN_NODE).toBe('22.12.0'); // the literals below assume this floor
    expect(pinSatisfiesFloor('24')).toBe(true);
    expect(pinSatisfiesFloor('24.x')).toBe(true);
    expect(pinSatisfiesFloor('22')).toBe(true); // the 22 line resolves above 22.12
    expect(pinSatisfiesFloor('22.12.0')).toBe(true);
    expect(pinSatisfiesFloor('22.10.0')).toBe(false);
    expect(pinSatisfiesFloor('20.19.0')).toBe(false);
    expect(pinSatisfiesFloor('18')).toBe(false);
  });

  describe('floor sites equal MIN_NODE', () => {
    // Both shell gates check major AND minor: a bare `-lt 22` would wave through
    // 22.0–22.11, which is below the real floor. They run before any Node script
    // in the `./setup.sh` path, so their literals must track MIN_NODE exactly.
    it('setup.sh gates on the full MIN_NODE floor', () => {
      const sh = read('setup.sh');
      const major = sh.match(/"\$NODE_MAJOR"\s+-lt\s+(\d+)/);
      const minor = sh.match(/"\$NODE_MINOR"\s+-lt\s+(\d+)/);
      expect(major, 'setup.sh no longer contains a `$NODE_MAJOR -lt <n>` gate').toBeTruthy();
      expect(minor, 'setup.sh no longer contains a `$NODE_MINOR -lt <n>` gate').toBeTruthy();
      expect([Number(major[1]), Number(minor[1])]).toEqual([MIN_MAJOR, MIN_MINOR]);
    });

    it('setup.ps1 gates on the full MIN_NODE floor', () => {
      const ps1 = read('setup.ps1');
      const major = ps1.match(/\$majorVersion\s+-lt\s+(\d+)/);
      const minor = ps1.match(/\$minorVersion\s+-lt\s+(\d+)/);
      expect(major, 'setup.ps1 no longer contains a `$majorVersion -lt <n>` gate').toBeTruthy();
      expect(minor, 'setup.ps1 no longer contains a `$minorVersion -lt <n>` gate').toBeTruthy();
      expect([Number(major[1]), Number(minor[1])]).toEqual([MIN_MAJOR, MIN_MINOR]);
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
      expect(pinSatisfiesFloor(nvmrc), `.nvmrc (${nvmrc}) is below the floor`).toBe(true);
    });

    it('every CI job pins a node-version >= MIN_NODE', () => {
      const workflows = execFileSync('git', ['ls-files', '-z', '.github/workflows'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean);
      const pins = workflows.flatMap((rel) =>
        [...read(rel).matchAll(/node-version:\s*['"]?(\d+(?:\.[\dx]+)*)/g)].map((m) => ({
          rel,
          pin: m[1],
        }))
      );
      // Sanity: without this the loop below would pass vacuously.
      expect(pins.length).toBeGreaterThan(0);
      for (const { rel, pin } of pins) {
        // Compare the whole pin, not just its major: `22.10.0` shares MIN_NODE's
        // major and is still below the floor.
        expect(pinSatisfiesFloor(pin), `${rel} pins node-version ${pin}, below the floor`).toBe(true);
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
