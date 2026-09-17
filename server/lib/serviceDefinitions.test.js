/**
 * The service table absorbs three registries (#7562). What is pinned here is
 * the absorption itself: that every id the epic (#7561, D2) names exists, that
 * the local rows ARE the `LOCAL_RUNTIMES` ids, that `PROVIDER_GATEWAYS` derived
 * from it is byte-identical to the table it replaced, and that Pi's built-in
 * provider names stay the ones the installed CLI documents.
 */
import { describe, expect, it } from 'vitest';
import {
  CATALOG_STRATEGIES,
  SERVICE_DEFINITIONS,
  SERVICE_DEFINITION_IDS,
  SERVICE_FAMILIES,
  SERVICE_PLANS,
  resolveServiceInstance,
  serviceDefinitionById,
  serviceDefinitionForLocalRuntime,
} from './serviceDefinitions.js';
import { LOCAL_RUNTIMES } from './localProviderRuntime.js';
import { PROVIDER_GATEWAYS } from './providerGateways.js';
import { CREDENTIALS } from './credentialRegistry.js';

/** Epic D2, verbatim: the ids the rest of the epic composes from. */
const D2_IDS = [
  'claude-subscription', 'codex-subscription', 'antigravity', 'grok-build', 'cursor', 'kimi',
  'anthropic', 'openai', 'google', 'xai', 'bedrock', 'nvidia-nim', 'openrouter', 'orcarouter', 'opencode-zen', 'cerebras', 'openai-compatible',
  'ollama', 'lmstudio', 'mtplx', 'llama', 'vllm', 'sglang', 'slotstream', 'fleet-host',
];

/** `pi --help` / `docs/providers.md` of the installed Pi CLI (0.85.x): provider name → env key. */
const PI_PROVIDERS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  google: 'GEMINI_API_KEY',
  'amazon-bedrock': 'AWS_BEARER_TOKEN_BEDROCK',
  cerebras: 'CEREBRAS_API_KEY',
  xai: 'XAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'kimi-coding': 'KIMI_API_KEY',
};

describe('SERVICE_DEFINITIONS', () => {
  it('covers every id the epic names, each exactly once', () => {
    for (const id of D2_IDS) expect(serviceDefinitionById(id), id).not.toBeNull();
    expect(new Set(SERVICE_DEFINITION_IDS).size).toBe(SERVICE_DEFINITION_IDS.length);
  });

  it('keeps every row inside the declared vocabularies', () => {
    for (const row of SERVICE_DEFINITIONS) {
      expect(SERVICE_FAMILIES, row.id).toContain(row.family);
      expect(row.plans.length, row.id).toBeGreaterThan(0);
      for (const plan of row.plans) expect(SERVICE_PLANS, row.id).toContain(plan);
      expect(CATALOG_STRATEGIES, row.id).toContain(row.catalog.strategy);
      for (const protocol of Object.keys(row.transports)) expect(['anthropic', 'openai'], row.id).toContain(protocol);
      if (row.family === 'subscription') expect(typeof row.harnessOnly, row.id).toBe('string');
      if (row.family === 'local') expect(row.plans, row.id).toEqual(['local']);
    }
  });

  // One row per daemon PortOS can check for — a runtime added to either table
  // alone is one a harness could not be composed onto (or one nothing probes).
  it('has exactly the LOCAL_RUNTIMES ids as its local rows', () => {
    const local = SERVICE_DEFINITIONS.filter((row) => row.family === 'local').map((row) => row.localRuntime).sort();
    expect(local).toEqual(Object.keys(LOCAL_RUNTIMES).sort());
    for (const id of Object.keys(LOCAL_RUNTIMES)) expect(serviceDefinitionForLocalRuntime(id)?.id).toBe(id);
  });

  // The projection must reproduce the table it replaced: every consumer keys on
  // these exact fields, and the toolkit mirror is compared with toEqual.
  it('derives PROVIDER_GATEWAYS unchanged', () => {
    expect(PROVIDER_GATEWAYS).toEqual([
      { id: 'orcarouter', label: 'OrcaRouter', baseURL: 'https://api.orcarouter.ai/v1', apiKeyEnv: 'ORCAROUTER_API_KEY', legacyMarker: 'orcarouterBacked', legacyApiKeyField: 'orcarouterApiKey' },
      { id: 'openrouter', label: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
      { id: 'nvidia-nim', label: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', apiKeyEnv: 'NVIDIA_API_KEY', keyUrl: 'https://build.nvidia.com' },
    ]);
  });

  // The AI rows of the credential registry are the same keys, so a user who
  // pasted one under Settings > Credentials is the one a service reads.
  it('names the credential registry\'s env vars for the vendors it absorbs', () => {
    for (const [credentialId, serviceId] of [['anthropic', 'anthropic'], ['openai', 'openai'], ['google', 'google'], ['xai', 'xai'], ['cursor', 'cursor'], ['kimi', 'kimi']]) {
      const credential = CREDENTIALS.find((row) => row.id === credentialId);
      expect(serviceDefinitionById(serviceId).credential.envVars, serviceId).toEqual(credential.envVars);
    }
  });

  it('only names Pi providers the installed CLI ships, keyed by Pi\'s own env var', () => {
    for (const row of SERVICE_DEFINITIONS.filter((entry) => entry.piProvider)) {
      expect(PI_PROVIDERS, row.id).toHaveProperty(row.piProvider);
      expect(row.credential.envVars[0], row.id).toBe(PI_PROVIDERS[row.piProvider]);
    }
  });

  it('filters a plan only where the vendor marks the tier in the model id', () => {
    const models = ['vendor/big', 'vendor/small:free', 'big-pickle-free'];
    expect(serviceDefinitionById('openrouter').catalog.planFilter('free', models)).toEqual(['vendor/small:free']);
    expect(serviceDefinitionById('openrouter').catalog.planFilter('paid', models)).toEqual(models);
    expect(serviceDefinitionById('opencode-zen').catalog.planFilter('free', models)).toEqual(['big-pickle-free']);
    expect(serviceDefinitionById('nvidia-nim').catalog.planFilter).toBeUndefined();
  });
});

describe('resolveServiceInstance', () => {
  it('defaults slug, plan and transports from the definition, and keeps overrides', () => {
    const instance = resolveServiceInstance('nvidia-nim');
    expect(instance).toMatchObject({ slug: 'nvidia-nim', plan: 'free', credentialVia: 'stored' });
    expect(instance.transports).toEqual({ openai: { baseUrl: 'https://integrate.api.nvidia.com/v1' } });

    const paid = resolveServiceInstance({ definitionId: 'nvidia-nim', slug: 'nvidia-paid', plan: 'paid', credentials: { apiKey: 'k' } });
    expect(paid).toMatchObject({ slug: 'nvidia-paid', plan: 'paid', credentials: { apiKey: 'k' } });
    expect(resolveServiceInstance(paid)).toEqual(paid);
  });

  // A local daemon's port is an install fact: the row declares the wire, and
  // an instance that names no endpoint has NONE — never a guessed default.
  it('leaves a local transport endpoint-less until the instance names it', () => {
    expect(resolveServiceInstance('ollama').transports).toEqual({ openai: { baseUrl: null }, anthropic: { baseUrl: null } });
    expect(resolveServiceInstance({ definitionId: 'ollama', transports: { openai: { baseUrl: 'http://127.0.0.1:11434/v1' } } }).transports.openai.baseUrl)
      .toBe('http://127.0.0.1:11434/v1');
  });

  it.each([
    [{ definitionId: 'nope' }, 'SERVICE_DEFINITION_UNKNOWN'],
    [{ definitionId: 'ollama', slug: 'Bad Slug' }, 'SERVICE_SLUG_INVALID'],
    [{ definitionId: 'ollama', plan: 'paid' }, 'SERVICE_PLAN_UNSUPPORTED'],
  ])('refuses %j with %s', (input, code) => {
    expect(() => resolveServiceInstance(input)).toThrow(expect.objectContaining({ code }));
  });
});
