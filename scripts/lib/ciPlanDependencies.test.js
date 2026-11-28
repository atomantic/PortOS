import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FULL_SUITE_SHARDS, shardIndexes } from './ciPlanOutput.js';
import { TRUSTED_REBUILDS } from '../trusted-rebuilds.js';
import { readCiJobs } from './ciWorkflowJobs.js';
import { TRACKED } from '../fixtures/ciPlanTrackedFiles.js';
import { buildCiTestPlan } from '../ci-test-plan.js';
import { WINDOWS_CONTRACT_TESTS } from './ciPlanRules.js';
import { classifyDependencyChange, PLATFORM_PACKAGE_RES, WINDOWS_INSTALLED_WORKSPACES } from './ciPlanDependencies.js';
import { collectPlanInputs } from './ciPlanInputs.js';

describe('dependency manifest Windows escalation', () => {
  const TRACKED_WITH_CONTRACTS = [...TRACKED, ...WINDOWS_CONTRACT_TESTS];
  const LOCK = 'server/package-lock.json';
  const lockfile = (packages, root = {}) => JSON.stringify({
    name: 'portos-server',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'portos-server', version: '1.0.0', ...root }, ...packages },
  });
  const BASE_PACKAGES = {
    'node_modules/@googleapis/gmail': { version: '16.1.1', resolved: 'https://registry.example.com/g-16.1.1.tgz' },
    'node_modules/node-pty': { version: '1.2.0', hasInstallScript: true },
  };
  const BASE = lockfile(BASE_PACKAGES);
  const planFor = (files, dependencyChanges) => buildCiTestPlan(files, {
    trackedFiles: TRACKED_WITH_CONTRACTS,
    dependencyChanges,
  });
  const lockPlan = (headText, baseText = BASE) => planFor([LOCK], { [LOCK]: classifyDependencyChange(LOCK, baseText, headText) });

  it('keeps a pure-JS version bump on the primary platform and names the package', () => {
    const plan = lockPlan(lockfile({
      ...BASE_PACKAGES,
      'node_modules/@googleapis/gmail': { version: '17.0.0', resolved: 'https://registry.example.com/g-17.0.0.tgz' },
    }));

    // The Linux side stays complete; only Windows narrows.
    expect(plan.full).toBe(true);
    expect(plan.server.mode).toBe('full');
    expect(plan.windowsMode).toBe('skip');
    expect(plan.windowsFiles).toEqual([]);
    expect(plan.shards.windows).toEqual([1]);
    expect(plan.suiteReasons.windows).toContain('does not select Windows native contracts');
    expect(plan.suiteReasons.windows).toContain('@googleapis/gmail');
  });

  it('escalates Windows for a native, install-script, platform-gated or optional package', () => {
    const cases = {
      'install script': { 'node_modules/fresh-addon': { version: '1.0.0', hasInstallScript: true } },
      'os field': { 'node_modules/@scope/binding-win32-x64': { version: '1.0.0', os: ['win32'], cpu: ['x64'] } },
      optional: { 'node_modules/maybe-native': { version: '1.0.0', optional: true } },
      // Removing a trusted rebuild escalates too: either side of the diff counts.
      'trusted rebuild removed': { 'node_modules/node-pty': undefined },
      // sharp's entry carries no platform metadata; the family list catches it.
      'platform family': { 'node_modules/sharp': { version: '0.35.6' } },
    };
    for (const [label, change] of Object.entries(cases)) {
      const packages = Object.fromEntries(Object.entries({ ...BASE_PACKAGES, ...change })
        .filter(([, entry]) => entry !== undefined));
      const plan = lockPlan(lockfile(packages));
      expect(plan.full, label).toBe(true);
      expect(plan.windowsMode, label).toBe('files');
      expect(plan.shards.windows, label).toEqual(shardIndexes('full', FULL_SUITE_SHARDS.windows));
      expect(plan.suiteReasons.windows, label).toContain('selects Windows native contracts: platform-sensitive package changed');
    }
  });

  it('treats every trusted-rebuild package as platform-sensitive', () => {
    // The planner mirrors the allowlist instead of importing it (see
    // PLATFORM_PACKAGE_RES); this keeps the two from drifting.
    const trusted = Object.values(TRUSTED_REBUILDS).flatMap((groups) => groups.flatMap(({ pkgs }) => pkgs));
    expect(trusted.length).toBeGreaterThan(0);
    expect(trusted.filter((name) => !PLATFORM_PACKAGE_RES.some((re) => re.test(name)))).toEqual([]);
  });

  it('fails closed when the lockfile cannot be compared', () => {
    for (const [label, baseText, headText] of [
      ['unparsable head', BASE, '{ "packages": '],
      ['missing base', null, BASE],
      ['deleted head', BASE, null],
      ['no packages map', JSON.stringify({ lockfileVersion: 1 }), BASE],
    ]) {
      expect(classifyDependencyChange(LOCK, baseText, headText).escalate, label).toBe(true);
      expect(lockPlan(headText, baseText).windowsMode, label).toBe('files');
    }
    // No verdict at all — a caller that skipped the comparison — escalates too.
    expect(planFor([LOCK], {}).windowsMode).toBe('files');
  });

  it('escalates Windows for engines, overrides and npm configuration changes', () => {
    const manifest = { name: 'portos-server', dependencies: { express: '^5.2.1' }, engines: { node: '>=24.14' } };
    const verdict = (head) => classifyDependencyChange('server/package.json', JSON.stringify(manifest), JSON.stringify(head));

    expect(verdict({ ...manifest, dependencies: { express: '^5.3.0' } })).toMatchObject({ escalate: false, packages: ['express'] });
    expect(verdict({ ...manifest, engines: { node: '>=26' } }).escalate).toBe(true);
    expect(verdict({ ...manifest, overrides: { braces: '3.0.3' } }).escalate).toBe(true);
    expect(verdict({ ...manifest, dependencies: { ...manifest.dependencies, 'node-pty': '^1.2.0' } }).escalate).toBe(true);
    // The lockfile mirrors engines into its root entry.
    expect(classifyDependencyChange(LOCK, BASE, lockfile(BASE_PACKAGES, { engines: { node: '>=26' } })).escalate).toBe(true);

    for (const npmrc of ['server/.npmrc']) {
      const plan = planFor([npmrc], {});
      expect(plan.full, npmrc).toBe(true);
      expect(plan.reason, npmrc).toContain('npm configuration changed');
      expect(plan.windowsMode, npmrc).toBe('files');
    }
  });

  it('skips Windows for changes in workspaces outside the native dependency baseline', () => {
    const unsafe = lockfile({ ...BASE_PACKAGES, 'node_modules/@scope/binding-win32-x64': { version: '1.0.0', os: ['win32'], cpu: ['x64'] } });
    for (const path of ['package-lock.json', 'client/package-lock.json']) {
      const plan = planFor([path], { [path]: classifyDependencyChange(path, BASE, unsafe) });
      expect(plan.full, path).toBe(true);
      expect(plan.windowsMode, path).toBe('skip');
      expect(plan.suiteReasons.windows, path).toContain('dependency changes in this workspace do not schedule the Windows job');
    }
    for (const path of ['.npmrc', 'client/.npmrc']) {
      expect(planFor([path], {}).windowsMode, path).toBe('skip');
    }
    // The same diff in the server lockfile still escalates.
    expect(lockPlan(unsafe).windowsMode).toBe('files');
  });

  it('pins the native dependency baseline and the conditional client install in ci.yml', () => {
    const job = readCiJobs()['windows-server'];
    const installed = [...job.matchAll(/npm (?:ci|install)\b[^\n]*/g)].map(([cmd]) => cmd.match(/--prefix\s+(\S+)/)?.[1] ?? '.');
    expect(installed.sort()).toEqual([...WINDOWS_INSTALLED_WORKSPACES, 'client'].sort());
    expect(job).toContain('uses: ./.github/actions/setup-client\n        if: matrix.shard == 1 && fromJSON(needs.impact.outputs.plan).build');
  });

  it('runs shared schema contracts on the primary platform', () => {
    for (const path of ['server/lib/schemaVersions.js']) {
      const plan = planFor([path], {});
      expect(plan.full, path).toBe(true);
      expect(plan.server.mode, path).toBe('full');
      // Full CI Gate requires the native Windows job as well as full primary
      // coverage; this primary-only schema plan leaves that job skipped.
      expect(plan.windowsMode, path).toBe('skip');
      expect(plan.windowsFiles, path).toEqual([]);
    }
  });

  it('compares the manifest at the real diff base through git', () => {
    const root = mkdtempSync(join(tmpdir(), 'portos-ci-lockfile-'));
    const git = (...args) => execFileSync('git', ['-c', 'user.name=CI', '-c', 'user.email=ci@example.com',
      '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim();
    try {
      git('init', '-q');
      mkdirSync(join(root, 'server'));
      writeFileSync(join(root, LOCK), BASE);
      git('add', '--all');
      git('commit', '-q', '--no-verify', '-m', 'base');
      const bumped = lockfile({ ...BASE_PACKAGES, 'node_modules/@googleapis/gmail': { version: '17.0.0' } });
      writeFileSync(join(root, LOCK), bumped);

      const inputs = collectPlanInputs({ baseSha: 'HEAD', changedFiles: [LOCK], cwd: root });
      expect(inputs.dependencyChanges[LOCK]).toMatchObject({ escalate: false, packages: ['@googleapis/gmail'] });

      // A base commit that does not exist in the checkout fails closed.
      const missing = collectPlanInputs({ baseSha: '0'.repeat(40), changedFiles: [LOCK], cwd: root });
      expect(missing.dependencyChanges[LOCK]).toMatchObject({ escalate: true, reason: 'base version unavailable' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
