/**
 * The pure service-instance rules (#7563): how an existing connection row is
 * named as an instance (the boot backfill), how a definition round-trips to
 * the `kind` reconciliation judges by, how a refresh outcome becomes a stored
 * catalog, and what the sanitized DTO may carry.
 *
 * The route-level contract (create / list / refresh through the API) lives in
 * `routes/providers.services.test.js`; what is pinned here is the input
 * matrix a route test would have to enumerate one request at a time.
 *
 * Fixtures are synthetic. Nothing here is read out of a running install.
 */
import { describe, expect, it } from 'vitest';
import {
  allocateServiceSlug,
  applyServicePlanFilter,
  credentialSourceFor,
  definitionIdForKind,
  kindForDefinition,
  nextServiceCatalog,
  planServiceColumnBackfill,
  toServiceDto,
} from './providerServiceInstances.js';
import { SERVICE_DEFINITIONS, serviceDefinitionById } from './serviceDefinitions.js';

const row = (overrides = {}) => ({
  id: overrides.id ?? '11111111-1111-4111-8111-111111111111',
  revision: 1,
  kind: 'ollama',
  label: 'Example daemon',
  transports: { openai: { baseUrl: 'http://127.0.0.1:11434/v1' } },
  credentials: {},
  catalog: { state: 'unknown', models: [] },
  slug: null,
  definitionId: null,
  plan: 'paid',
  enabled: true,
  credentialVia: 'stored',
  ...overrides,
});

describe('definitionIdForKind — the backfill rule', () => {
  it('maps every stored kind shape to the definition it stands for', () => {
    expect(definitionIdForKind('ollama')).toBe('ollama');
    expect(definitionIdForKind('gateway:openrouter')).toBe('openrouter');
    expect(definitionIdForKind('api')).toBe('openai-compatible');
    // A vendor row's cloud is a fact about its harness.
    expect(definitionIdForKind('vendor', { harnessId: 'claude' })).toBe('claude-subscription');
    expect(definitionIdForKind('vendor', { harnessId: 'codex' })).toBe('codex-subscription');
    expect(definitionIdForKind('vendor', { harnessId: 'opencode' })).toBe('opencode-zen');
    expect(definitionIdForKind('vendor', { harnessId: 'kimi' })).toBe('kimi');
  });

  it('answers null, never a guess, for a kind no definition describes', () => {
    expect(definitionIdForKind('vendor', { harnessId: null })).toBeNull();
    expect(definitionIdForKind('vendor', { harnessId: 'kilo' })).toBeNull();
    expect(definitionIdForKind('gateway:nope')).toBeNull();
    expect(definitionIdForKind('mystery')).toBeNull();
    expect(definitionIdForKind('')).toBeNull();
  });

  it('inverts kindForDefinition for every definition with a kind of its own', () => {
    // Keyed vendors with a plain endpoint (anthropic, openai, …) all become
    // `api` rows and read back as `openai-compatible` — their identity lives in
    // `definition_id`, which a created row always stores. Everything else must
    // round-trip, or a clone/backfill would rename the service it stands for.
    const own = SERVICE_DEFINITIONS.filter((definition) => definition.localRuntime || definition.gateway
      || definition.family === 'subscription' || definition.harnessOnly);
    expect(own.length).toBeGreaterThan(10);
    for (const definition of own) {
      expect(definitionIdForKind(kindForDefinition(definition), { harnessId: definition.harnessOnly ?? null })).toBe(definition.id);
    }
    expect(kindForDefinition(serviceDefinitionById('anthropic'))).toBe('api');
  });
});

describe('planServiceColumnBackfill', () => {
  it('names only the rows without a slug, with the definition\'s first plan and suffixed collisions', () => {
    const graph = {
      connections: [
        row({ id: 'a', kind: 'ollama', slug: 'ollama', definitionId: 'ollama', plan: 'local' }),
        row({ id: 'b', kind: 'ollama' }),
        row({ id: 'c', kind: 'ollama' }),
        row({ id: 'd', kind: 'gateway:nvidia-nim' }),
        row({ id: 'e', kind: 'vendor' }),
        row({ id: 'f', kind: 'mystery' }),
      ],
      bindings: [{ id: 'bind-e', connectionId: 'e', harnessId: 'claude' }],
    };
    expect(planServiceColumnBackfill(graph)).toEqual([
      { id: 'b', slug: 'ollama-2', definitionId: 'ollama', plan: 'local' },
      { id: 'c', slug: 'ollama-3', definitionId: 'ollama', plan: 'local' },
      // The first plan, exactly as `resolveServiceInstance` defaults it.
      { id: 'd', slug: 'nvidia-nim', definitionId: 'nvidia-nim', plan: 'free' },
      { id: 'e', slug: 'claude-subscription', definitionId: 'claude-subscription', plan: 'subscription' },
      // Addressable even when nothing composes onto it.
      { id: 'f', slug: 'mystery', definitionId: null, plan: 'paid' },
    ]);
  });

  it('plans nothing on a second pass — the re-run is a no-op', () => {
    const graph = { connections: [row({ id: 'a', kind: 'ollama' }), row({ id: 'b', kind: 'api' })], bindings: [] };
    const first = planServiceColumnBackfill(graph);
    const named = { connections: graph.connections.map((connection) => ({ ...connection, ...first.find((entry) => entry.id === connection.id) })), bindings: [] };
    expect(planServiceColumnBackfill(named)).toEqual([]);
    expect(planServiceColumnBackfill({ connections: [], bindings: [] })).toEqual([]);
  });

  it('allocates against slugs a caller already handed out in the same pass', () => {
    const taken = new Set(['ollama', 'ollama-2']);
    expect(allocateServiceSlug('ollama', taken)).toBe('ollama-3');
    expect(allocateServiceSlug('Not a slug!', taken)).toBe('service');
    expect(taken.has('ollama-3') && taken.has('service')).toBe(true);
  });
});

describe('plan filter and refresh outcome', () => {
  const zen = serviceDefinitionById('opencode-zen');
  const nim = serviceDefinitionById('nvidia-nim');
  const listing = ['big-pickle', 'mimo-v2.5-free', 'deepseek-v4-flash-free'];

  it('narrows a free plan only where the definition marks its free tier', () => {
    expect(applyServicePlanFilter(zen, 'free', listing)).toEqual(['mimo-v2.5-free', 'deepseek-v4-flash-free']);
    expect(applyServicePlanFilter(zen, 'paid', listing)).toEqual(listing);
    // NIM's listing carries no tier: both plans see everything.
    expect(applyServicePlanFilter(nim, 'free', listing)).toEqual(listing);
    expect(applyServicePlanFilter(nim, 'paid', listing)).toEqual(listing);
  });

  it('keeps the known models AND their capabilities through a failed refresh, and stamps the attempt', () => {
    const current = { state: 'known', models: ['a'], capabilities: { a: { contextWindow: 8192 } } };
    expect(nextServiceCatalog(current, { refreshed: false, error: 'timed out' }, { now: () => 'T1' })).toEqual({
      state: 'failed', models: ['a'], error: 'timed out', capabilities: { a: { contextWindow: 8192 } }, refreshedAt: 'T1',
    });
  });

  it('writes what a success saw — including an empty answer — with the windows the listing declared', () => {
    const current = { state: 'known', models: ['a'], capabilities: { a: { contextWindow: 8192 } } };
    expect(nextServiceCatalog(current, { refreshed: true, models: ['b', 'c'], contextWindows: { b: 32768, zzz: 1 } }, { now: () => 'T2' }))
      .toEqual({ state: 'known', models: ['b', 'c'], error: null, capabilities: { b: { contextWindow: 32768 } }, refreshedAt: 'T2' });
    expect(nextServiceCatalog(current, { refreshed: true, models: [] }, { now: () => 'T3' }))
      .toEqual({ state: 'known', models: [], error: null, capabilities: {}, refreshedAt: 'T3' });
  });
});

describe('credentialSourceFor', () => {
  const nim = serviceDefinitionById('nvidia-nim');
  it('reports where the key comes from, never the key', () => {
    expect(credentialSourceFor({ credentialVia: 'stored', credentials: { apiKey: 'example-key' }, definition: nim })).toBe('settings');
    expect(credentialSourceFor({ credentialVia: 'cli-login', credentials: {}, definition: serviceDefinitionById('claude-subscription') })).toBe('cli');
    expect(credentialSourceFor({ credentialVia: 'bootstrap', credentials: {}, definition: nim })).toBe('config');
    expect(credentialSourceFor({ credentialVia: 'env', credentials: {}, definition: nim }, { env: { NVIDIA_API_KEY: 'example' } })).toBe('env');
    expect(credentialSourceFor({ credentialVia: 'env', credentials: {}, definition: nim },
      { env: {}, envFile: new Map([['NVIDIA_API_KEY', 'example']]) })).toBe('env-file');
    expect(credentialSourceFor({ credentialVia: 'env', credentials: {}, definition: nim }, { env: { NVIDIA_API_KEY: '' } })).toBe('none');
    // A stored instance with nothing stored is still checked against the
    // environment: the key may simply live there.
    expect(credentialSourceFor({ credentialVia: 'stored', credentials: {}, definition: nim }, { env: { NVIDIA_API_KEY: 'x' } })).toBe('env');
  });
});

describe('toServiceDto', () => {
  it('publishes presence, plan and readiness — and never a credential value', () => {
    const dto = toServiceDto(row({
      kind: 'gateway:nvidia-nim', slug: 'nvidia-nim', definitionId: 'nvidia-nim', plan: 'free',
      transports: { openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } },
      credentials: { apiKey: 'example-secret-key' },
    }), { bindingCount: 2, credentialSource: 'settings' });
    expect(JSON.stringify(dto)).not.toContain('example-secret-key');
    expect(dto).toMatchObject({
      slug: 'nvidia-nim', plan: 'free', enabled: true, hasCredentials: true, credentialVia: 'stored',
      credentialSource: 'settings', bindingCount: 2, readiness: 'ready',
      definition: { id: 'nvidia-nim', family: 'api-key', plans: ['free', 'paid'], catalogStrategy: 'probe', harnessOnly: null },
    });
    expect(Object.keys(dto)).not.toContain('credentials');
  });

  it('reports a bootstrap instance as holding no credential, and the readiness a card can act on', () => {
    const bootstrap = toServiceDto(row({
      kind: 'api', slug: 'openai', definitionId: 'openai', plan: 'paid', credentialVia: 'bootstrap',
      transports: { openai: { baseUrl: 'https://api.openai.com/v1' } }, credentials: {},
    }), { credentialSource: 'config' });
    expect(bootstrap).toMatchObject({ hasCredentials: false, credentialVia: 'bootstrap', enabled: true, readiness: 'ready' });

    expect(toServiceDto(row({ kind: 'api', definitionId: 'openai', plan: 'paid', credentials: {} }), { credentialSource: 'none' }).readiness)
      .toBe('needs-credential');
    expect(toServiceDto(row({ kind: 'ollama', definitionId: 'ollama', plan: 'local', transports: {} })).readiness).toBe('needs-endpoint');
    expect(toServiceDto(row({ kind: 'ollama', definitionId: 'ollama', plan: 'local', enabled: false })).readiness).toBe('disabled');
    expect(toServiceDto(row({ kind: 'mystery', slug: 'mystery' })).readiness).toBe('unknown-definition');
    // A subscription declares no transport and no key: signed in is ready.
    expect(toServiceDto(row({ kind: 'vendor', definitionId: 'claude-subscription', plan: 'subscription', transports: {}, credentialVia: 'cli-login' }),
      { credentialSource: 'cli' }).readiness).toBe('ready');
  });
});
