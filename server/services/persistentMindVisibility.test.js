import { readFile } from 'fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getActiveApps: vi.fn(),
  inspectRuntime: vi.fn(),
  readPreflights: vi.fn(),
}));

vi.mock('./apps.js', () => ({ getActiveApps: mocks.getActiveApps }));
vi.mock('./persistentMindRuntime.js', () => ({ inspectPersistentMindRuntime: mocks.inspectRuntime }));
vi.mock('./persistentMindWorkspacePreflight.js', () => ({
  PERSISTENT_MIND_WORKSPACE_PREFLIGHT_TTL_MS: 30_000,
  readPersistentMindWorkspacePreflights: (...args) => mocks.readPreflights(...args),
}));

const { buildPersistentMindVisibilityPrompt, readPersistentMindVisibility } = await import('./persistentMindVisibility.js');

const preflight = {
  schemaVersion: 1,
  capturedAt: '2026-08-27T12:00:00.000Z',
  freshness: { state: 'fresh', capturedAt: '2026-08-27T12:00:00.000Z', ageMs: 0, ttlMs: 30_000 },
  truncated: false,
  workspaceDiscovery: 'ready',
  readiness: 'degraded',
  repository: { configured: true, reachable: true },
  checkout: { state: 'clean' },
  workspaces: [{
    id: 'root',
    manifest: 'ready',
    lockfile: { status: 'present', type: 'npm', scope: 'workspace' },
    dependencies: { status: 'absent', source: null },
    engines: { node: { required: '>=22.12.0', actual: '24.0.0', status: 'compatible' }, packageManager: null },
    scripts: { test: ['test'], build: ['build'] },
  }],
  submodules: { configured: false, status: 'not-configured', initialized: null },
  forge: { provider: 'github', cli: 'gh', installed: true, authenticated: true, status: 'ready' },
  reviewers: {
    configured: 1,
    required: { configured: 1, available: 1, unavailable: 0, unknown: 0, status: 'ready' },
    optional: { configured: 0, available: 0, unavailable: 0, unknown: 0, status: 'not-configured' },
    status: 'ready',
  },
  warnings: [{ code: 'workspace-dependencies-unavailable', check: 'dependencies', severity: 'warning', message: 'Dependencies are absent.' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getActiveApps.mockResolvedValue([{ id: 'example-app', name: 'Example App', repoPath: '/private/example-app' }]);
  mocks.inspectRuntime.mockResolvedValue({
    inference: { active: false, residency: { status: 'provider-managed' } },
    context: { chars: 100, maxChars: 1_000, approximateTokens: 25, summaryState: 'current' },
    system: { memory: { usagePercent: 40 } },
  });
  mocks.readPreflights.mockResolvedValue([{ appId: 'example-app', appName: 'Example App', preflight }]);
});

describe('persistent mind visibility', () => {
  it('projects shared runtime, actions, scheduler, health, and workspace facts', async () => {
    const visibility = await readPersistentMindVisibility({
      root: { config: { persistentMindCapabilities: { createTasks: true }, domainAutonomy: { cos: 'execute' } } },
      state: { agents: {}, status: 'idle' },
      profile: { providerId: 'example-provider' },
      prompt: { identity: 'Example identity' },
      provider: { id: 'example-provider', type: 'api' },
      apps: [{ id: 'example-app', name: 'Example App', repoPath: '/private/example-app' }],
      now: 1_000,
    });

    expect(visibility).toMatchObject({
      schemaVersion: 1,
      readiness: 'degraded',
      runtime: { status: 'ready', context: { pressure: 'nominal' } },
      provider: { status: 'configured', type: 'api' },
      actions: {
        grants: { createTasks: true, manageMind: false, readPortos: false, writePortos: false },
        tools: expect.arrayContaining([
          expect.objectContaining({ id: 'cos.create-task', granted: true }),
          expect.objectContaining({ id: 'portos.read', granted: false }),
          expect.objectContaining({ id: 'portos.write', granted: false }),
          expect.objectContaining({ id: 'mind.cleanup', granted: false }),
        ]),
      },
      scheduler: { autonomy: 'execute', capacity: { status: 'unknown' } },
      health: { system: 'available', provider: 'configured', database: 'available', forge: 'ready' },
      workspaces: [{ appId: 'example-app', readiness: 'degraded', preflight: { repository: { reachable: true } } }],
      surfaces: expect.arrayContaining(['mind/visibility', 'workspace-preflight']),
    });

    const prompt = buildPersistentMindVisibilityPrompt(visibility);
    expect(prompt).toContain('workspace-dependencies-unavailable');
    expect(prompt).not.toContain('/private/example-app');
    expect(prompt).not.toContain('git@');
    expect(JSON.stringify(visibility)).not.toContain('/private/example-app');
  });

  it('bounds large workspace projections while retaining an explicit truncation signal', async () => {
    const apps = Array.from({ length: 30 }, (_, index) => ({
      id: `example-${index}`,
      name: `Example App ${index}`,
      repoPath: `/private/example-${index}`,
    }));
    mocks.readPreflights.mockResolvedValue(apps.map((app) => ({
      appId: app.id,
      appName: app.name,
      preflight: { ...preflight, warnings: [] },
    })));

    const visibility = await readPersistentMindVisibility({ apps, now: 2_000 });
    expect(visibility.truncated).toBe(true);
    expect(visibility.characterBudget).toMatchObject({ maxChars: 20_000, truncated: true });
    expect(JSON.stringify(visibility).length).toBeLessThanOrEqual(21_000);
  });

  // #5154 privacy contract. Every forbidden value below is fed in through a
  // DIFFERENT input surface (config, live records, error text, prompt, provider
  // credentials, runtime probe, app registry) so a projection that starts
  // spreading a whole source object fails here rather than in production.
  it('never projects identity, secrets, network addresses, paths, or live-record contents', async () => {
    mocks.inspectRuntime.mockResolvedValue({
      inference: { active: false, residency: { status: 'provider-managed' }, endpoint: 'http://192.0.2.10:11434' },
      context: { chars: 100, maxChars: 1_000, approximateTokens: 25, summaryState: 'current', lastMessage: 'private live record' },
      system: { memory: { usagePercent: 40 }, hostname: 'private-hostname' },
    });

    const visibility = await readPersistentMindVisibility({
      root: {
        config: {
          persistentMindCapabilities: { createTasks: true },
          domainAutonomy: { cos: 'execute' },
          secret: 'private-config-value',
          pgPassword: 'private-db-password',
        },
        queuedTasks: [{ prompt: 'private live record' }],
      },
      state: { agents: {}, status: 'idle', lastError: 'private-token' },
      profile: { providerId: 'example-provider', model: 'example-model' },
      prompt: { identity: 'Private Person', instructions: 'Read /Users/private-user/private-file' },
      provider: { id: 'example-provider', type: 'api', apiKey: 'private-api-key', endpoint: 'http://192.0.2.10:1234/v1' },
      apps: [{ id: 'example-app', name: 'Example App', repoPath: '/private/example-app', remote: 'git@example.com:acme/private.git' }],
      now: 1_000,
    });

    const serialized = JSON.stringify(visibility);
    const prompt = buildPersistentMindVisibilityPrompt(visibility);
    for (const forbidden of [
      'private-config-value', 'private-db-password', 'private live record', 'private-token',
      'Private Person', '/Users/private-user', 'private-api-key', '192.0.2.10',
      'private-hostname', '/private/example-app', 'git@',
    ]) {
      expect(serialized).not.toContain(forbidden);
      expect(prompt).not.toContain(forbidden);
    }
  });

  // #5154: "unknown" must mean "the probe did not answer", never "the probe
  // answered nothing". Collapsing the two would let the mind read a failed
  // health check as a clean empty one.
  it('keeps failed probes distinct from a legitimately empty projection', async () => {
    mocks.readPreflights.mockResolvedValue([]);
    const empty = await readPersistentMindVisibility({ apps: [], now: 1_000 });
    expect(empty.sections).toMatchObject({ runtime: { freshness: 'fresh' }, workspace: { freshness: 'fresh' } });
    expect(empty.workspaces).toEqual([]);
    expect(empty.runtime.status).toBe('ready');
    expect(empty.readiness).toBe('ready');
    expect(empty.reasonCodes).toEqual([]);

    mocks.inspectRuntime.mockRejectedValue(new Error('runtime probe failed'));
    mocks.readPreflights.mockRejectedValue(new Error('preflight probe failed'));
    const failed = await readPersistentMindVisibility({ apps: [], now: 1_000 });
    expect(failed.sections).toMatchObject({ runtime: { freshness: 'unknown' }, workspace: { freshness: 'unknown' } });
    expect(failed.runtime).toMatchObject({ status: 'unknown', context: { pressure: 'unknown' }, model: { residency: 'unknown' } });
    expect(failed.readiness).toBe('unknown');
    expect(failed.health).toMatchObject({ system: 'unknown', provider: 'unknown', database: 'unknown', forge: 'unknown' });
    expect(failed.reasonCodes).toEqual(expect.arrayContaining(['runtime-unknown', 'workspace-unknown']));
  });

  it('collects read-only, makes no provider inference call, and never enters a federation payload', async () => {
    const root = { config: { persistentMindCapabilities: { createTasks: true }, domainAutonomy: { cos: 'execute' } } };
    const state = { agents: {}, status: 'idle' };
    const rootBefore = structuredClone(root);
    const stateBefore = structuredClone(state);
    await readPersistentMindVisibility({ root, state, apps: [], now: 1_000 });
    expect(root).toEqual(rootBefore);
    expect(state).toEqual(stateBefore);
    expect(mocks.readPreflights).toHaveBeenCalledWith([], expect.objectContaining({ force: false }));

    // Deliberately an exact allowlist, not a denylist: the read-only and
    // no-inference guarantees hold only while this module depends on nothing
    // but these five readers. Adding a dependency should fail here and force a
    // re-read of the privacy contract above - especially an LLM runner, which
    // would turn a diagnostic read into a billed provider call.
    const source = await readFile(new URL('./persistentMindVisibility.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import[^;]*?from '([^']+)';/gm)].map(([, id]) => id);
    expect(imports.sort()).toEqual([
      '../lib/domainAutonomy.js',
      '../lib/persistentMindCapabilities.js',
      './apps.js',
      './persistentMindRuntime.js',
      './persistentMindWorkspacePreflight.js',
    ]);

    // Privacy records stay machine-local: the projection must not be reachable
    // from any outbound federation path.
    const federation = await Promise.all([
      './sharing/peerSyncPush.js',
      './sharing/peerCosSync.js',
      './sharing/peerSyncShared.js',
      '../routes/peerSync.js',
    ].map((rel) => readFile(new URL(rel, import.meta.url), 'utf8')));
    expect(federation.join('\n')).not.toMatch(/persistentMindVisibility|mindVisibility/i);
  });
});
