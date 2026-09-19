/**
 * Composite provider resolution (#7564): a `harness.method@service[+bootstrap]`
 * id becomes an executable record with no `providers.json` entry, through the
 * REAL argv/env builders every run path uses — or is refused with the reason
 * a picker shows beside a saved selection.
 *
 * The policy half (`materializeComposite`) is pure over its inputs; the
 * store-backed half (`describeCompositeProvider`, the cache, fallback
 * admission) runs over doubled graph/settings/probe modules. Fixtures are
 * synthetic; nothing is read out of a running install and nothing is spawned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const graphState = vi.hoisted(() => ({ current: { connections: [], bindings: [], routes: [] }, enabled: true }));
const settingsState = vi.hoisted(() => ({ current: {} }));
const runtimeState = vi.hoisted(() => ({ current: {} }));
const settingsMock = vi.hoisted(() => {
  const listeners = new Map();
  const settingsEvents = {
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]),
    emit: (event, ...args) => (listeners.get(event) || []).forEach((fn) => fn(...args)),
  };
  return {
    settingsEvents,
    getSettings: vi.fn(async () => structuredClone(settingsState.current)),
    updateSettingsWith: vi.fn(async (mutate) => {
      settingsState.current = await mutate(structuredClone(settingsState.current));
      settingsEvents.emit('settings:updated', settingsState.current);
      return settingsState.current;
    }),
  };
});
vi.mock('./settings.js', () => settingsMock);
const store = vi.hoisted(() => ({ readGraph: vi.fn(async () => structuredClone(graphState.current)) }));
vi.mock('./providerGraphStore.js', () => store);
vi.mock('./providerGraph.js', async (importOriginal) => ({
  ...(await importOriginal()),
  providerGraphEnabled: () => graphState.enabled,
}));
vi.mock('./providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peekProviderRuntimeStatuses: () => runtimeState.current,
}));
vi.mock('./providerServices.js', () => ({ listServices: vi.fn(async () => ({ services: [{ slug: 'nvidia-nim' }] })) }));

const composite = await import('./compositeProviders.js');
const { instanceForConnection } = await import('../lib/providerServiceInstances.js');
const { buildCliArgs } = await import('../lib/cliProviderArgs.js');
const { buildTuiInvocation } = await import('../lib/tuiHandshake.js');
const { buildTuiShellLaunch } = await import('../lib/tuiShellLaunch.js');
const { buildCliChildEnv } = await import('../lib/cliChildEnv.js');
const { applyCredentialBootstrap, needsProcessGroup, resolveCliSpawn } = await import('../lib/credentialBootstrap.js');
const { PUBLIC_REVIEW_GATE_EXECUTION_PROFILE, PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE } = await import('../lib/agentExecutionProfiles.js');
const { createRunnerService } = await import('../lib/aiToolkit/runner.js');
const { createProviderStatusService } = await import('../lib/aiToolkit/providerStatus.js');
const { allowedModesFor } = await import('../lib/callerModePolicy.js');

// A shell launch line is quoted for the SESSION shell, and this suite runs on
// the Windows CI shard too, where PowerShell renders every token quoted and the
// command with the call operator (`& 'pi' '--provider' 'nvidia' …`). Strip the
// dialect so the assertion below is about the flags, not the quoting — the
// quoting itself is covered by shellCd.test.js.
const unquoteShellLine = (line) => line.replace(/^& /, '').replace(/'/g, '');

const uuid = (n) => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}${n}`;
const connection = (n, row) => ({ id: uuid(n), revision: 1, enabled: true, credentialVia: 'stored', bindings: [], catalog: { state: 'known', models: [] }, ...row });

const GRAPH = {
  bindings: [],
  routes: [],
  connections: [
    connection(1, { kind: 'gateway:nvidia-nim', label: 'NVIDIA NIM (free)', slug: 'nvidia-nim', definitionId: 'nvidia-nim', plan: 'free',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'nim-key' },
      catalog: { state: 'known', models: ['nvidia/example-nemotron', 'meta/example-llama'] } }),
    connection(2, { kind: 'gateway:openrouter', label: 'OpenRouter', slug: 'openrouter', definitionId: 'openrouter', plan: 'free',
      transports: { openai: { baseUrl: 'https://openrouter.ai/api/v1' } }, credentials: { apiKey: 'or-key' },
      catalog: { state: 'known', models: ['example/free-model:free', 'example/paid-model'] } }),
    connection(3, { kind: 'ollama', label: 'Ollama', slug: 'ollama', definitionId: 'ollama', plan: 'local',
      transports: { openai: { baseUrl: 'http://127.0.0.1:11434/v1' }, anthropic: { baseUrl: 'http://127.0.0.1:11434' } },
      credentials: { ANTHROPIC_AUTH_TOKEN: 'ollama' }, catalog: { state: 'known', models: ['example-llama'] } }),
    connection(4, { kind: 'lmstudio', label: 'LM Studio', slug: 'lmstudio', definitionId: 'lmstudio', plan: 'local',
      transports: { openai: { baseUrl: 'http://127.0.0.1:1234/v1' } }, credentials: {}, catalog: { state: 'known', models: ['example-qwen'] } }),
    connection(5, { kind: 'api', label: 'Anthropic (corp)', slug: 'anthropic', definitionId: 'anthropic', plan: 'paid',
      transports: { anthropic: { baseUrl: 'https://api.anthropic.com' } }, credentials: {}, credentialVia: 'bootstrap' }),
    connection(6, { kind: 'gateway:nvidia-nim', label: 'NIM (off)', slug: 'nvidia-nim-off', definitionId: 'nvidia-nim', plan: 'paid',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } }, credentials: { apiKey: 'other' }, enabled: false }),
    // Antigravity publishes one catalog entry PER RUNG (`<base>-low|medium|high`),
    // which is what the per-model effort ladders are derived from.
    connection(7, { kind: 'subscription', label: 'Antigravity', slug: 'antigravity', definitionId: 'antigravity', plan: 'subscription',
      credentials: {}, catalog: { state: 'known', models: ['gemini-3.8-flash-low', 'gemini-3.8-flash-high', 'gemini-3.1-pro-high'] } }),
  ],
};
const BOOTSTRAPS = { 'corp-auth': { label: 'Corp auth', command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessNames: { claude: 'claude-code' } } };
const RUNTIMES = { pi: { installed: true, version: '1.0.0' }, claude: { installed: true, version: '2.0.0' }, codex: { installed: true, version: '0.5.0' }, opencode: { installed: true, version: '1.1.0' } };
const inputs = (overrides = {}) => ({ graph: GRAPH, settings: {}, bootstraps: BOOTSTRAPS, runtimes: RUNTIMES, env: {}, ...overrides });
const resolve = (id, overrides) => composite.materializeComposite(id, inputs(overrides));
const record = (id, overrides) => {
  const outcome = resolve(id, overrides);
  expect(outcome.reason, `${id}: ${outcome.reason}`).toBeNull();
  return outcome.record;
};

describe('materializeComposite — the run paths', () => {
  it('pi.tui@nvidia-nim: Pi in TUI mode with --provider/--model and the NIM key in env, with no pi-nvidia record anywhere', () => {
    const provider = record('pi.tui@nvidia-nim');
    expect(provider).toMatchObject({
      id: 'pi.tui@nvidia-nim', type: 'tui', command: 'pi', harnessId: 'pi', method: 'tui', serviceId: 'nvidia-nim', servicePlan: 'free',
      enabled: true, models: ['nvidia/example-nemotron', 'meta/example-llama'], defaultModel: 'nvidia/example-nemotron',
      envVars: { NVIDIA_API_KEY: 'nim-key' }, secretEnvVars: ['NVIDIA_API_KEY'], gatewayBacked: 'nvidia-nim',
    });
    const invocation = buildTuiInvocation(provider, provider.defaultModel);
    expect(invocation.command).toBe('pi');
    expect(invocation.args).toEqual(expect.arrayContaining(['--approve', '--provider', 'nvidia', '--model', 'nvidia/example-nemotron']));
    // The Shell page's launch line and PTY env — what `shell:start { providerId }` runs.
    const launch = buildTuiShellLaunch(provider);
    expect(unquoteShellLine(launch.commandLine)).toMatch(/^pi\b.*--provider nvidia.*--model nvidia\/example-nemotron/);
    expect(launch.env.NVIDIA_API_KEY).toBe('nim-key');
  });

  it('pi.cli@nvidia-nim: the headless argv the CLI runner spawns, unwrapped', () => {
    const provider = record('pi.cli@nvidia-nim');
    expect(provider).toMatchObject({ type: 'cli', command: 'pi', headlessArgs: [] });
    const args = buildCliArgs(provider);
    expect(args).toEqual(expect.arrayContaining(['--print', '--approve', '--provider', 'nvidia', '--model', 'nvidia/example-nemotron']));
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider, cwd: process.cwd() });
    expect(env.NVIDIA_API_KEY).toBe('nim-key');
    expect(resolveCliSpawn(provider, provider.command, args, env)).toMatchObject({ command: 'pi', wrapped: false });
  });

  it('direct.api@nvidia-nim: executeApiRun posts to the service endpoint with the key as a Bearer header', async () => {
    const provider = record('direct.api@nvidia-nim');
    expect(provider).toMatchObject({ type: 'api', harnessId: 'direct', endpoint: 'https://integrate.api.nvidia.com/v1', timeout: 300000 });
    expect(provider).not.toHaveProperty('command');
    // The credential rides NON-enumerably: readable at execution, gone on serialization.
    expect(provider.apiKey).toBe('nim-key');
    expect(Object.keys(provider)).not.toContain('apiKey');
    expect(JSON.stringify(provider)).not.toContain('nim-key');
    expect({ ...provider }).not.toHaveProperty('apiKey');

    const dataDir = await mkdtemp(join(tmpdir(), 'portos-composite-api-'));
    const encoder = new TextEncoder();
    const chunks = [encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`), encoder.encode('data: [DONE]\n')];
    let i = 0;
    const body = { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }) }) };
    const fetch = vi.fn(async () => ({ ok: true, body }));
    vi.stubGlobal('fetch', fetch);
    const runner = createRunnerService({ dataDir, hooks: { ensureProviderReady: async () => ({ success: true }) } });
    let done;
    const completed = new Promise((r) => { done = r; });
    await runner.executeApiRun({ runId: 'composite-api', provider, model: null, prompt: 'hello', workspacePath: process.cwd(), screenshots: [], onComplete: done });
    await expect(completed).resolves.toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer nim-key');
    expect(JSON.parse(init.body).model).toBe('nvidia/example-nemotron');
    vi.unstubAllGlobals();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('opencode.cli@openrouter: the inline OpenCode config names the openrouter namespace, and the gateway key rides its own env var', () => {
    const provider = record('opencode.cli@openrouter');
    expect(provider).toMatchObject({ command: 'opencode', args: ['run'], gatewayBacked: 'openrouter', servicePlan: 'free', models: ['example/free-model:free'] });
    const config = JSON.parse(provider.envVars.OPENCODE_CONFIG_CONTENT);
    expect(config.provider.openrouter.options.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(provider.envVars.OPENROUTER_API_KEY).toBe('or-key');
    expect(provider.secretEnvVars).toContain('OPENROUTER_API_KEY');
    const env = buildCliChildEnv({ baseEnv: { PATH: '/usr/bin' }, provider, model: 'example/free-model:free', cwd: process.cwd() });
    expect(env.OPENROUTER_API_KEY).toBe('or-key');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider.openrouter).toBeTruthy();
    // OpenCode takes `-m <namespace>/<model>`: the executable model name is namespaced onto the gateway.
    expect(buildCliArgs(provider)).toEqual(expect.arrayContaining(['run', '-m', 'openrouter/example/free-model:free']));
  });

  it('claude.cli@ollama: Claude Code pointed at the local daemon with the stored placeholder token', () => {
    const provider = record('claude.cli@ollama');
    expect(provider).toMatchObject({ command: 'claude', ollamaBacked: true, harnessId: 'claude', servicePlan: 'local' });
    expect(provider.envVars).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' });
    expect(provider.secretEnvVars).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(buildCliArgs(provider)).toEqual(expect.arrayContaining(['--print', '--model', 'example-llama']));
  });

  it('codex.cli@lmstudio: Codex reaches the daemon through its native --oss --local-provider flag', () => {
    const provider = record('codex.cli@lmstudio');
    expect(provider).toMatchObject({ command: 'codex', lmstudioBacked: true, endpoint: 'http://127.0.0.1:1234/v1' });
    expect(buildCliArgs(provider)).toEqual(expect.arrayContaining(['--oss', '--local-provider', 'lmstudio']));
  });

  it('claude.cli@anthropic+corp-auth: the bootstrap app wraps the spawn, including a tool-free review but never the actions stage', () => {
    const provider = record('claude.cli@anthropic+corp-auth');
    expect(provider.credentialBootstrap).toEqual({ command: 'corp-auth', args: ['run'], harnessId: 'claude-code', argsSeparator: '--' });
    const args = buildCliArgs(provider);
    const spawn = resolveCliSpawn(provider, provider.command, args, { PATH: '/usr/bin' });
    expect(spawn.command).toBe('corp-auth');
    expect(spawn.args.slice(0, 3)).toEqual(['run', 'claude-code', '--']);
    expect(spawn.args.slice(3)).toEqual(args);
    expect(spawn.wrapped).toBe(true);
    // The wrapper is the direct child, so stop/timeout must reach the harness behind it.
    expect(needsProcessGroup(spawn.wrapped, false)).toBe(true);
    expect(needsProcessGroup(spawn.wrapped, true)).toBe(false);

    // A tool-free reviewer still gets the wrap — spawned bare it would have no
    // credential at all and the review gate would wait out a round that can
    // never answer (#7720). The enforced recipe rides through unchanged.
    const reviewer = applyCredentialBootstrap(provider, provider.command, args, { safetyProfile: PUBLIC_REVIEW_GATE_EXECUTION_PROFILE });
    expect(reviewer).toEqual({ command: 'corp-auth', args: ['run', 'claude-code', '--', ...args], wrapped: true });
    // The actions stage is the one posture that fails closed: it EXECUTES the
    // screened patch inside a sandbox spelled entirely in that argv, so nothing
    // may sit in front of the harness and rewrite it.
    const actions = applyCredentialBootstrap(provider, provider.command, args, { safetyProfile: PUBLIC_REVIEW_ACTIONS_EXECUTION_PROFILE });
    expect(actions).toEqual({ command: 'claude', args, wrapped: false });
  });

  it('carries the harness by name into the effort ladder, so a bootstrap-wrapped spawn still offers its rungs', async () => {
    const { effortLevelsForProvider } = await import('../lib/providerModels.js');
    expect(effortLevelsForProvider(record('claude.cli@anthropic+corp-auth'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsForProvider(record('pi.tui@nvidia-nim'))).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortLevelsForProvider(record('direct.api@nvidia-nim'))).toBeNull();
  });
});

describe('materializeComposite — refusals carry a reason and never substitute', () => {
  it.each([
    ['claude.cli@nvidia-nim', 'incompatible'],
    ['codex.cli@lmstudio', 'harness-disabled', { settings: { harnesses: { codex: { enabled: false } } } }],
    ['pi.tui@nvidia-nim', 'harness-disabled', { runtimes: { pi: { installed: false } } }],
    ['pi.tui@nvidia-nim-off', 'service-disabled'],
    ['pi.tui@no-such-service', 'service-unknown'],
    ['pi.api@nvidia-nim', 'method-unsupported'],
    ['gui.cli@nvidia-nim', 'harness-unknown'],
    ['claude.cli@anthropic', 'SERVICE_CREDENTIAL_BOOTSTRAP_REQUIRED'],
    ['claude.cli@anthropic+no-such-app', 'bootstrap-unknown'],
    ['direct.api@ollama+corp-auth', 'not-composite'],
    ['claude-code', 'not-composite'],
  ])('%s → %s', (id, code, overrides = {}) => {
    const outcome = resolve(id, overrides);
    expect(outcome.record).toBeNull();
    expect(outcome.code).toBe(code);
    expect(outcome.reason).toEqual(expect.any(String));
  });

  it('refuses — rather than throwing — a row whose stored plan the definition no longer sells', () => {
    // Installs upgrade independently, so a row can outlive the plan it was
    // written with. That must drop the one service, not throw out of the whole
    // composition surface (the catalog resolves EVERY row in one pass).
    const stale = { ...GRAPH, connections: GRAPH.connections.map((row) => (row.slug === 'nvidia-nim' ? { ...row, plan: 'retired-tier' } : row)) };
    expect(instanceForConnection(stale.connections.find((row) => row.slug === 'nvidia-nim'))).toBeNull();
    expect(resolve('pi.tui@nvidia-nim', { graph: stale })).toMatchObject({ record: null, code: 'service-undefined' });
    // A sibling row on a plan that still exists is unaffected.
    expect(resolve('pi.tui@openrouter', { graph: stale }).record).not.toBeNull();
  });

  it('refuses a slug that only matches a connection UUID, so an id is never resolved by row identity', () => {
    const byUuid = { ...GRAPH, connections: [{ ...GRAPH.connections[0], slug: 'nvidia-nim-renamed' }] };
    expect(resolve('pi.tui@nvidia-nim', { graph: byUuid }).code).toBe('service-unknown');
  });

  it('re-enabling the harness restores a composite a disabled harness refused, with the same record', () => {
    const off = resolve('pi.tui@nvidia-nim', { settings: { harnesses: { pi: { enabled: false } } } });
    expect(off.code).toBe('harness-disabled');
    const on = resolve('pi.tui@nvidia-nim', { settings: { harnesses: { pi: { enabled: true } } }, runtimes: {} });
    expect(on.record).toMatchObject({ id: 'pi.tui@nvidia-nim' });
  });
});

describe('describeCompositeProvider / resolveCompositeProvider over the live stores', () => {
  beforeEach(() => {
    graphState.current = structuredClone(GRAPH);
    graphState.enabled = true;
    settingsState.current = { credentialBootstraps: BOOTSTRAPS };
    runtimeState.current = RUNTIMES;
    store.readGraph.mockClear();
    composite.invalidateCompositeCache();
  });
  afterEach(() => composite.invalidateCompositeCache());

  it('resolves through the store, reuses the graph snapshot within its TTL, and re-derives when settings move', async () => {
    const first = await composite.resolveCompositeProvider('pi.tui@nvidia-nim');
    expect(first).toMatchObject({ id: 'pi.tui@nvidia-nim', harnessId: 'pi' });
    const second = await composite.describeCompositeProvider('pi.tui@nvidia-nim');
    expect(second).toMatchObject({ eligible: true, code: null, parts: { harnessId: 'pi', method: 'tui', serviceSlug: 'nvidia-nim', bootstrapSlug: null } });
    expect(store.readGraph).toHaveBeenCalledTimes(1);
    expect(second.record).toBe(first);

    settingsState.current = { ...settingsState.current, harnesses: { pi: { enabled: false } } };
    settingsMock.settingsEvents.emit('settings:updated', settingsState.current);
    await expect(composite.describeCompositeProvider('pi.tui@nvidia-nim')).resolves.toMatchObject({ eligible: false, code: 'harness-disabled', record: null });
  });

  it('answers null (not a throw) for a composite that is not runnable, and for a preset id', async () => {
    await expect(composite.resolveCompositeProvider('claude.cli@nvidia-nim')).resolves.toBeNull();
    await expect(composite.resolveCompositeProvider('claude-code')).resolves.toBeNull();
    await expect(composite.describeCompositeProvider('claude-code')).resolves.toMatchObject({ eligible: false, code: 'not-composite' });
    const readsSoFar = store.readGraph.mock.calls.length;
    graphState.enabled = false;
    await expect(composite.describeCompositeProvider('pi.tui@nvidia-nim')).resolves.toMatchObject({ eligible: false, code: 'graph-unavailable' });
    expect(store.readGraph).toHaveBeenCalledTimes(readsSoFar);
  });

  it('admits a composite into the fallback chain only under a caller policy that allows its method', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'portos-composite-status-'));
    const status = createProviderStatusService({ dataDir, defaultFallbackPriority: [] });
    const stored = { id: 'codex', name: 'Codex', type: 'cli', command: 'codex', enabled: true, models: [] };
    const pick = async (policy) => {
      const map = await composite.withCompositeCandidates({ codex: stored }, ['pi.tui@nvidia-nim', 'codex', null]);
      expect(Object.keys(map)).toEqual(['codex', 'pi.tui@nvidia-nim']);
      return status.getFallbackProvider('codex', map, 'pi.tui@nvidia-nim', null, { allowedModes: allowedModesFor(policy) });
    };
    await expect(pick('cli-harness')).resolves.toBeNull();
    await expect(pick('agent-harness')).resolves.toMatchObject({ source: 'task', provider: { id: 'pi.tui@nvidia-nim', type: 'tui' } });
    await rm(dataDir, { recursive: true, force: true });
  });

  it('builds the catalog from cache and settings only: harness verdicts, compatibility by slug, ladders, and the presets handed in', async () => {
    const catalog = await composite.buildProviderCatalog({ presets: [{ id: 'claude-code' }] });
    expect(catalog.presets).toEqual([{ id: 'claude-code' }]);
    expect(catalog.services).toEqual([{ slug: 'nvidia-nim' }]);
    expect(catalog.harnesses.find((row) => row.id === 'pi')).toMatchObject({ enabled: true, detected: true, version: '1.0.0', modes: ['cli', 'tui'] });
    expect(catalog.harnesses.find((row) => row.id === 'direct')).toMatchObject({ enabled: true, source: 'always' });
    expect(catalog.compatibility.pi).toEqual(expect.arrayContaining(['nvidia-nim', 'openrouter', 'anthropic']));
    expect(catalog.compatibility.pi).not.toContain('ollama');
    expect(catalog.compatibility.claude).toEqual(expect.arrayContaining(['ollama', 'anthropic']));
    expect(catalog.compatibility.claude).not.toContain('nvidia-nim');
    expect(catalog.compatibility.direct).toEqual(expect.arrayContaining(['nvidia-nim', 'openrouter', 'ollama', 'lmstudio']));
    expect(catalog.bootstraps).toEqual([{ slug: 'corp-auth', label: 'Corp auth', harnessNames: { claude: 'claude-code' } }]);
    expect(catalog.effortLevels).toMatchObject({ pi: ['low', 'medium', 'high', 'xhigh', 'max'], direct: null, claude: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(catalog.effortLevelsByModel).toMatchObject({ pi: {}, direct: {} });
    // A per-model ladder is NARROWED by the surrounding catalog: Antigravity
    // offers a rung only where `<base>-<rung>` is itself a catalog entry. Without
    // the catalog every model collapsed onto the harness default and this map
    // came back empty, silently dropping the whole per-model axis.
    expect(catalog.effortLevelsByModel.antigravity).toEqual({
      'gemini-3.8-flash-low': ['low', 'high'],
      'gemini-3.8-flash-high': ['low', 'high'],
      'gemini-3.1-pro-high': ['high'],
    });
    // Nothing in the catalog carries a credential.
    expect(JSON.stringify(catalog)).not.toMatch(/nim-key|or-key|corp-auth run/);
    expect(store.readGraph).toHaveBeenCalledTimes(1);
  });
});
