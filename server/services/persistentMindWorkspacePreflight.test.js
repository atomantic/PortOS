import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  assessPersistentMindWorkspaceReadiness,
  PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS,
  PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS,
  readPersistentMindWorkspacePreflight,
  readPersistentMindWorkspacePreflights,
  resetPersistentMindWorkspacePreflightCache,
  satisfiesVersionRequirement,
} from './persistentMindWorkspacePreflight.js';

const appFor = (repoPath, overrides = {}) => ({
  id: 'fixture-app',
  name: 'Fixture App',
  repoPath,
  workTracker: 'github',
  ...overrides,
});

const createDependencies = ({ git, origin = 'git@github.com:example/fixture.git', installed = true, auth = true, forgeHost = null } = {}) => ({
  execGit: vi.fn(git || (async (args) => ({
    stdout: args[0] === 'rev-parse' ? 'true\n' : '',
    stderr: '',
    exitCode: 0,
  }))),
  readOriginRemoteUrl: vi.fn(async () => origin),
  resolveAppForgeTarget: vi.fn(async (app) => {
    const tracker = app?.workTracker === 'auto'
      ? origin?.includes('gitlab') ? 'gitlab' : origin ? 'github' : 'plan'
      : app?.workTracker || 'plan';
    const forge = origin?.includes('gitlab') ? 'gitlab'
      : origin ? 'github'
        : ['github', 'gitlab'].includes(tracker) ? tracker : null;
    return { tracker, target: forge ? { forge, apiHost: forgeHost || (forge === 'github' ? 'github.com' : null) } : null };
  }),
  commandExists: vi.fn(async () => installed),
  execFile: vi.fn(async (command, args) => {
    if (args[0] === 'auth') {
      if (auth === true) return { stdout: 'authenticated as example-user\n' };
      if (auth === null) throw Object.assign(new Error('probe timed out'), { code: 'ETIMEDOUT', killed: true });
      throw Object.assign(new Error('not authenticated'), { code: 'AUTH_REQUIRED' });
    }
    return { stdout: command === 'npm' ? '12.0.0\n' : '1.0.0\n' };
  }),
  getCodeReviewDefaults: vi.fn(async () => ({
    reviewers: ['codex'],
    usernames: ['example-reviewer'],
    optionalReviewers: [],
  })),
  getReviewerCliInstalled: vi.fn(async () => ({ codex: installed })),
});

const writeManifest = (repoPath, relativePath, manifest) => writeFile(
  join(repoPath, relativePath),
  JSON.stringify(manifest),
);

describe('persistent mind workspace preflight', () => {
  let repoPath;

  beforeEach(async () => {
    resetPersistentMindWorkspacePreflightCache();
    repoPath = await mkdtemp(join(tmpdir(), 'portos-preflight-fixture-'));
  });

  afterEach(async () => {
    resetPersistentMindWorkspacePreflightCache();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('supports portable engine ranges without copying the Node floor', () => {
    expect(satisfiesVersionRequirement('24.1.0', '>=22.12.0')).toBe(true);
    expect(satisfiesVersionRequirement('22.11.9', '>=22.12.0')).toBe(false);
    expect(satisfiesVersionRequirement('20.19.0', '>=22.12.0 || ^18.20.0')).toBe(false);
    expect(satisfiesVersionRequirement('22.12.3', '^22.12.0')).toBe(true);
    expect(satisfiesVersionRequirement('23.0.0', '^22.12.0')).toBe(false);
    expect(satisfiesVersionRequirement('22.12.3', '22.12.x')).toBe(true);
    expect(satisfiesVersionRequirement('22.13.0', '22.12.x')).toBe(false);
    expect(satisfiesVersionRequirement('22.12.3', '~22.12')).toBe(true);
    expect(satisfiesVersionRequirement('22.12.1', '>22.12')).toBe(false);
    expect(satisfiesVersionRequirement('22.13.0', '>22.12')).toBe(true);
    expect(satisfiesVersionRequirement('0.0.5', '^0.0')).toBe(true);
    expect(satisfiesVersionRequirement('0.1.0', '^0.0')).toBe(false);
    expect(satisfiesVersionRequirement('not-a-version', '>=22.12.0')).toBe(null);
  });

  it('reports npm workspaces, absent dependencies, submodules, engines, forge auth, and reviewers as semantic facts', async () => {
    await mkdir(join(repoPath, 'packages', 'client'), { recursive: true });
    await writeManifest(repoPath, 'package.json', {
      name: 'fixture-root',
      workspaces: ['packages/*'],
      packageManager: 'npm@12.0.0',
      engines: { node: '>=22.12.0', npm: '>=12.0.0' },
      scripts: { test: 'node test.js', build: 'node build.js', lint: 'node lint.js' },
    });
    await writeFile(join(repoPath, 'package-lock.json'), '{}');
    await writeManifest(repoPath, 'packages/client/package.json', {
      name: 'fixture-client',
      engines: { node: '>=25.0.0' },
      scripts: { 'test:unit': 'node test.js', 'build:client': 'node build.js' },
    });
    await writeFile(join(repoPath, '.gitmodules'), '[submodule "fixture"]\n\tpath = vendor/fixture\n');

    const dependencies = createDependencies({
      git: async (args) => ({
        stdout: args[0] === 'rev-parse' ? 'true\n' : args[0] === 'submodule' ? '-abc123 vendor/fixture\n' : '',
        stderr: '',
        exitCode: 0,
      }),
      installed: true,
      auth: false,
    });
    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath), {
      now: 1_000,
      runtime: { nodeVersion: '24.1.0' },
      dependencies,
    });

    expect(preflight).toMatchObject({
      schemaVersion: 1,
      capturedAt: '1970-01-01T00:00:01.000Z',
      readiness: 'blocked',
      repository: { configured: true, reachable: true },
      checkout: { state: 'clean' },
      submodules: { configured: true, initialized: false, status: 'uninitialized' },
      forge: { provider: 'github', cli: 'gh', installed: true, authenticated: false, status: 'unavailable' },
      reviewers: {
        required: { configured: 2, available: 1, unavailable: 1, unknown: 0, status: 'unavailable' },
        optional: { configured: 0, status: 'not-configured' },
      },
    });
    expect(preflight.workspaces.map((workspace) => workspace.id)).toEqual(['root', 'packages/client']);
    expect(preflight.workspaces[0]).toMatchObject({
      manifest: 'ready',
      lockfile: { status: 'present', type: 'npm', scope: 'workspace' },
      dependencies: { status: 'absent' },
      engines: {
        node: { required: '>=22.12.0', actual: '24.1.0', status: 'compatible' },
        packageManager: { name: 'npm', required: '>=12.0.0', actual: '12.0.0', status: 'compatible' },
      },
      scripts: { test: ['test'], build: ['build'] },
    });
    expect(preflight.workspaces[1]).toMatchObject({
      lockfile: { status: 'present', type: 'npm', scope: 'root' },
      dependencies: { status: 'absent' },
      engines: { node: { status: 'incompatible' }, packageManager: null },
      scripts: { test: ['test:unit'], build: ['build:client'] },
    });
    const serialized = JSON.stringify(preflight);
    expect(serialized).not.toContain(repoPath);
    expect(serialized).not.toContain('fixture.git');
    expect(serialized).not.toContain('example-reviewer');
    expect(dependencies.execFile.mock.calls.every(([, args]) => !args.includes('install'))).toBe(true);
    expect(dependencies.execGit.mock.calls.every(([args]) => !args.includes('init'))).toBe(true);
  });

  it('keeps missing dependencies advisory for docs-only work but blocks declared validation', async () => {
    await writeManifest(repoPath, 'package.json', {
      name: 'fixture-root',
      engines: { node: '>=22.12.0', npm: '>=12.0.0' },
      scripts: { test: 'node test.js' },
    });
    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath, { workTracker: 'plan' }), {
      now: 2_000,
      runtime: { nodeVersion: '24.1.0', packageManagerVersions: { npm: '12.0.0' } },
      dependencies: createDependencies({ origin: null, installed: true, auth: true }),
    });

    expect(preflight.readiness).toBe('degraded');
    expect(assessPersistentMindWorkspaceReadiness(preflight, [])).toMatchObject({ readiness: 'degraded', blockers: [] });
    expect(assessPersistentMindWorkspaceReadiness(preflight, ['dependencies'])).toMatchObject({
      readiness: 'blocked',
      blockers: [{ check: 'dependencies', status: 'unavailable' }],
    });
  });

  it('reports an unconfigured app and does not claim truncated workspace discovery is ready', async () => {
    const entries = await readPersistentMindWorkspacePreflights([
      { id: 'unconfigured-app', name: 'Unconfigured App' },
    ], {
      now: 2_500,
      dependencies: createDependencies(),
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      appId: 'unconfigured-app',
      appName: 'Unconfigured App',
      preflight: {
        readiness: 'blocked',
        repository: { configured: false, reachable: false },
      },
    });
    expect(assessPersistentMindWorkspaceReadiness({
      workspaceDiscovery: 'truncated',
      workspaces: [{ manifest: 'ready', dependencies: { status: 'installed' } }],
    }, ['dependencies'])).toMatchObject({
      readiness: 'blocked',
      blockers: [{ check: 'dependencies', status: 'unknown' }],
    });
  });

  it('resolves forge readiness from the app forge target for auto-tracked workspaces', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies();
    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath, { workTracker: 'auto' }), {
      now: 2_600,
      dependencies,
    });

    expect(preflight.forge).toMatchObject({
      provider: 'github',
      cli: 'gh',
      installed: true,
      authenticated: true,
      status: 'ready',
    });
    expect(dependencies.resolveAppForgeTarget).toHaveBeenCalledWith(expect.objectContaining({ workTracker: 'auto' }));
  });

  it('authenticates GitHub Enterprise against the resolved forge host', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies({
      origin: 'git@github.enterprise.example:example/fixture.git',
      forgeHost: 'github.enterprise.example',
    });
    await readPersistentMindWorkspacePreflight(appFor(repoPath, { workTracker: 'auto' }), {
      now: 2_650,
      dependencies,
    });

    expect(dependencies.execFile).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--hostname', 'github.enterprise.example'],
      expect.any(Object),
    );
  });

  it('flattens nested workspace globs without collapsing to unknown', async () => {
    await mkdir(join(repoPath, 'packages', 'one', 'plugins', 'first'), { recursive: true });
    await mkdir(join(repoPath, 'packages', 'two', 'plugins', 'second'), { recursive: true });
    await writeManifest(repoPath, 'package.json', {
      name: 'fixture-root',
      workspaces: ['packages/*/plugins/*'],
    });
    await writeManifest(repoPath, 'packages/one/plugins/first/package.json', { name: 'first-plugin' });
    await writeManifest(repoPath, 'packages/two/plugins/second/package.json', { name: 'second-plugin' });

    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath), {
      now: 2_675,
      dependencies: createDependencies(),
    });

    expect(preflight.workspaceDiscovery).toBe('ready');
    expect(preflight.workspaces.map((workspace) => workspace.id)).toEqual([
      'root',
      'packages/one/plugins/first',
      'packages/two/plugins/second',
    ]);
  });

  it('does not report Copilot as available for a GitLab workspace', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies({ origin: 'git@gitlab.com:example/fixture.git' });
    dependencies.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['copilot'],
      usernames: [],
      optionalReviewers: [],
    });
    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath, { workTracker: 'auto' }), {
      now: 2_700,
      dependencies,
    });

    expect(preflight.reviewers.required).toMatchObject({ configured: 1, available: 0, unavailable: 1, status: 'unavailable' });
  });

  it('shares the reviewer defaults and CLI probe across a bounded app batch', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies();
    await readPersistentMindWorkspacePreflights([
      appFor(repoPath, { id: 'fixture-one' }),
      appFor(repoPath, { id: 'fixture-two' }),
    ], {
      force: true,
      now: 2_700,
      dependencies,
    });

    expect(dependencies.getCodeReviewDefaults).toHaveBeenCalledTimes(1);
    expect(dependencies.getReviewerCliInstalled).toHaveBeenCalledTimes(1);
  });

  it('keeps unavailable optional reviewers advisory', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies({ installed: false });
    dependencies.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: ['codex'],
    });
    const preflight = await readPersistentMindWorkspacePreflight(appFor(repoPath), {
      now: 2_750,
      dependencies,
    });

    expect(preflight.reviewers).toMatchObject({
      required: { configured: 0, status: 'not-configured' },
      optional: { configured: 1, unavailable: 1, status: 'unavailable' },
      status: 'degraded',
    });
    expect(preflight.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'workspace-reviewers-optional-unavailable', severity: 'advisory' }),
    ]));
    expect(assessPersistentMindWorkspaceReadiness(preflight, ['reviewers']).blockers).toEqual([]);
  });

  it('preserves unknown probe state, cache freshness, and explicit truncation', async () => {
    await writeManifest(repoPath, 'package.json', { name: 'fixture-root' });
    const dependencies = createDependencies({
      git: vi.fn(async () => { throw Object.assign(new Error('unavailable'), { code: 'EIO' }); }),
      auth: null,
    });
    const first = await readPersistentMindWorkspacePreflight(appFor(repoPath), { now: 3_000, dependencies });
    const cached = await readPersistentMindWorkspacePreflight(appFor(repoPath), { now: 3_000 + PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS - 1, dependencies });
    const refreshed = await readPersistentMindWorkspacePreflight(appFor(repoPath), { now: 3_000 + PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS + 1, dependencies });

    expect(first.repository.reachable).toBe(null);
    expect(first.readiness).toBe('unknown');
    expect(cached.freshness.state).toBe('fresh');
    expect(refreshed.freshness.state).toBe('fresh');
    expect(dependencies.execGit).toHaveBeenCalledTimes(2);

    resetPersistentMindWorkspacePreflightCache();
    await writeFile(join(repoPath, 'package.json'), 'x'.repeat(PERSISTENT_MIND_WORKSPACE_PREFLIGHT_LIMITS.maxPackageManifestBytes + 1));
    const truncated = await readPersistentMindWorkspacePreflight(appFor(repoPath), {
      now: 4_000,
      dependencies: createDependencies(),
    });
    expect(truncated.truncated).toBe(true);
    expect(truncated.workspaces[0].manifest).toBe('truncated');
  });
});
