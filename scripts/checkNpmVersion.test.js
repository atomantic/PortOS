/**
 * Unit tests for the npm floor advisory.
 *
 * The gate exists because a lockfile written by npm 12 and re-written by npm 11
 * or older differ by the `libc` fields, so `client/package-lock.json` shows up
 * modified after every install. These tests pin the three things that make the
 * advisory useful: it fires only below the floor, it never turns into a hard
 * failure, and it names the shadowed-global-npm case that makes the version
 * skew hard to spot.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  MIN_NPM,
  npmAdvisory,
  parseNpmUserAgent,
  readBundledNpmVersion,
  warnOnOutdatedNpm,
} from './checkNpmVersion.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('MIN_NPM', () => {
  it('is the npm major whose lockfile writer records `libc`', () => {
    // arborist 10 added 'libc' to pkgMetaKeys and ships in npm 12; arborist 9
    // (npm 11.6.1, bundled with Node 24.10) strips it. Anything below 12 churns
    // the lockfile, so the floor is a whole major and has no patch nuance.
    expect(MIN_NPM).toBe('12.0.0');
  });
});

describe('parseNpmUserAgent', () => {
  it('reads the version out of the user agent npm exports to run-scripts', () => {
    expect(parseNpmUserAgent('npm/9.6.0 node/v24.10.0 win32 x64 workspaces/false')).toBe('9.6.0');
    expect(parseNpmUserAgent('npm/12.0.2 node/v24.10.0 darwin arm64 workspaces/false')).toBe('12.0.2');
  });

  it('is not fooled by a lookalike earlier in the string', () => {
    // `pnpm/9.0.0` ends in "npm/9.0.0"; only a token boundary counts.
    expect(parseNpmUserAgent('pnpm/9.0.0 node/v24.10.0 linux x64')).toBeNull();
    expect(parseNpmUserAgent('yarn/4.1.0 npm/? node/v24.10.0 linux x64')).toBeNull();
  });

  it('returns null when there is no npm user agent to read', () => {
    // NOT `parseNpmUserAgent(undefined)`: the parameter defaults to
    // `process.env.npm_config_user_agent`, and passing an explicit `undefined`
    // is indistinguishable from omitting the argument — so under `npm test`
    // that call reads the ambient agent and returns a version, not null.
    expect(parseNpmUserAgent('')).toBeNull();
    expect(parseNpmUserAgent(null)).toBeNull();
  });

  it('falls back to the ambient npm_config_user_agent, and to null without one', () => {
    vi.stubEnv('npm_config_user_agent', 'npm/10.9.0 node/v22.12.0 linux x64');
    expect(parseNpmUserAgent()).toBe('10.9.0');
    // The "not running under npm" case the default parameter exists for. Stubbed
    // rather than assumed, because the suite itself usually runs under npm.
    vi.stubEnv('npm_config_user_agent', '');
    expect(parseNpmUserAgent()).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe('readBundledNpmVersion', () => {
  it('returns null instead of throwing when no npm sits beside the binary', () => {
    expect(readBundledNpmVersion(join(REPO_ROOT, 'no', 'such', 'node'))).toBeNull();
  });

  it('reads bundled npm from both supported Node install layouts', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-npm-version-'));
    tempRoots.push(root);

    const adjacentBin = join(root, 'adjacent', 'bin');
    const adjacentManifest = join(adjacentBin, 'node_modules', 'npm', 'package.json');
    mkdirSync(dirname(adjacentManifest), { recursive: true });
    writeFileSync(adjacentManifest, JSON.stringify({ version: '11.17.0' }));
    expect(readBundledNpmVersion(join(adjacentBin, 'node'))).toBe('11.17.0');

    const prefixBin = join(root, 'prefix', 'bin');
    const prefixManifest = join(root, 'prefix', 'lib', 'node_modules', 'npm', 'package.json');
    mkdirSync(dirname(prefixManifest), { recursive: true });
    writeFileSync(prefixManifest, JSON.stringify({ version: '12.0.1' }));
    expect(readBundledNpmVersion(join(prefixBin, 'node'))).toBe('12.0.1');
  });
});

describe('npmAdvisory', () => {
  it('says nothing on npm at or above the floor', () => {
    expect(npmAdvisory({ npmVersion: MIN_NPM, bundledNpmVersion: '11.6.1' })).toEqual([]);
    expect(npmAdvisory({ npmVersion: '12.4.0', bundledNpmVersion: '11.6.1' })).toEqual([]);
  });

  it('says nothing when there is no npm to warn about', () => {
    // A bare `node scripts/checkNpmVersion.js` isn't running an install.
    expect(npmAdvisory({ npmVersion: null })).toEqual([]);
    expect(npmAdvisory({})).toEqual([]);
  });

  it('names the version, the floor, the symptom, and the fix below the floor', () => {
    const lines = npmAdvisory({ npmVersion: '11.6.1', bundledNpmVersion: '11.6.1' });
    const text = lines.join('\n');
    expect(text).toContain('11.6.1');
    expect(text).toContain(MIN_NPM);
    expect(text).toContain('package-lock.json');
    expect(text).toContain('libc');
    expect(text).toContain('npm install -g npm@latest');
  });

  it('flags a stale global npm shadowing the one Node bundles', () => {
    const lines = npmAdvisory({
      npmVersion: '9.6.0',
      bundledNpmVersion: '11.6.1',
      nodeVersion: 'v24.10.0',
    });
    const shadow = lines.find((line) => line.includes('shadowing'));
    expect(shadow).toBeTruthy();
    expect(shadow).toContain('24.10.0');
    expect(shadow).toContain('11.6.1');
    expect(shadow).toContain('9.6.0');
    // The `v` is supplied by the message, not doubled up from the input.
    expect(shadow).not.toContain('vv');
  });

  it('omits the shadowing line when npm is the bundled one, or newer', () => {
    const bundled = npmAdvisory({ npmVersion: '11.6.1', bundledNpmVersion: '11.6.1' });
    expect(bundled.some((line) => line.includes('shadowing'))).toBe(false);
    const newer = npmAdvisory({ npmVersion: '11.9.0', bundledNpmVersion: '11.6.1' });
    expect(newer.some((line) => line.includes('shadowing'))).toBe(false);
  });

  it('omits the shadowing line when the bundled npm cannot be read', () => {
    const lines = npmAdvisory({ npmVersion: '9.6.0', bundledNpmVersion: null });
    expect(lines.some((line) => line.includes('shadowing'))).toBe(false);
    expect(lines.join('\n')).toContain('npm install -g npm@latest');
  });
});

describe('warnOnOutdatedNpm', () => {
  it('prints each advisory line and reports that it warned', () => {
    const warn = vi.fn();
    const warned = warnOnOutdatedNpm({ npmVersion: '9.6.0', bundledNpmVersion: '11.6.1', warn });
    expect(warned).toBe(true);
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    // Single-line logging: no multi-line blobs, no JSON dumps.
    for (const [line] of warn.mock.calls) expect(line).not.toContain('\n');
  });

  it('stays silent — and non-fatal — on a current npm', () => {
    const warn = vi.fn();
    expect(warnOnOutdatedNpm({ npmVersion: '12.0.2', bundledNpmVersion: '11.6.1', warn })).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the advisory is actually reachable', () => {
  it.each(['setup', 'start', 'dev'])('the root `%s` script runs it before installing', (name) => {
    const script = readJson('package.json').scripts[name];
    expect(script).toContain('node scripts/checkNpmVersion.js &&');
    // After the Node gate (which is fatal) and before anything that installs.
    expect(script.indexOf('checkNodeVersion.js')).toBeLessThan(script.indexOf('checkNpmVersion.js'));
  });
});

describe('PortOS-managed installs preserve committed lockfiles', () => {
  it('passes --no-save through every setup, update, and dependency-repair install', () => {
    const managedEntrypoints = [
      ['package.json', /npm install(?: --prefix \w+)?/g],
      ['setup.ps1', /^npm install/gm],
      ['update.ps1', /Invoke-Logged npm install/g],
      ['update.sh', /run npm install/g],
      ['scripts/ensure-deps.js', /npmSpawn\(\['install'/g],
    ];

    for (const [rel, installPattern] of managedEntrypoints) {
      const body = readFileSync(join(REPO_ROOT, rel), 'utf8');
      const installs = [...body.matchAll(installPattern)];
      expect(installs.length, `${rel} has no managed npm installs to verify`).toBeGreaterThan(0);
      for (const install of installs) {
        const command = body.slice(install.index, install.index + 80);
        expect(command, `${rel}: ${install[0]} must preserve package-lock.json`).toContain('--no-save');
      }
    }
  });
});

describe('the floor is declared where npm itself reads it', () => {
  // The three scripts above cover `npm run setup|start|dev` and nothing else.
  // Direct `cd client && npm install` and `npm i <pkg>` are how lockfile churn
  // still gets introduced; only `engines.npm` reaches those authoring paths.
  const MANIFESTS = ['package.json', 'client/package.json', 'server/package.json', 'autofixer/package.json'];

  it.each(MANIFESTS)('%s declares engines.npm = the floor', (rel) => {
    expect(readJson(rel).engines?.npm).toBe(`>=${MIN_NPM}`);
  });

  it.each(MANIFESTS)('%s ships a lockfile that the floor protects', (rel) => {
    // If a workspace stops carrying a lockfile, its engines.npm entry is just
    // noise — this is what would say so.
    const lockfile = join(REPO_ROOT, rel.replace(/package\.json$/, 'package-lock.json'));
    expect(existsSync(lockfile), `${rel} declares engines.npm but ships no lockfile`).toBe(true);
  });

  it.each(['.npmrc', 'client/.npmrc', 'server/.npmrc', 'autofixer/.npmrc'])(
    '%s leaves engine-strict off so the npm floor stays a warning',
    (rel) => {
      // engine-strict would turn EBADENGINE fatal for dependencies too, which is
      // the trap the node floor already documents. A churned lockfile is not
      // worth a broken install.
      expect(readFileSync(join(REPO_ROOT, rel), 'utf8')).not.toMatch(/^\s*engine-strict\s*=\s*true/m);
    }
  );
});
