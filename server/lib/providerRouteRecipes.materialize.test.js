/**
 * `materializeRoute` (#7562): a (harness, method, service) composition is an
 * executable record with no further lookup, and one that reads back as the
 * service it was built for.
 *
 * Three contracts are pinned, each one a way the registries could drift apart
 * without any single row looking wrong:
 *   1. every (harness, definition) pair `isCompatible` accepts round-trips
 *      through `providerConnectionProfile` onto the same service;
 *   2. the 55 shipped samples that profile cleanly are reproduced — every
 *      connection-owned value the sample declares is what the composition
 *      writes, byte for byte;
 *   3. a bootstrap app becomes the `credentialBootstrap` object the spawn
 *      composer already understands, and only when one is supplied.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeBootstrapSpawn } from './aiToolkit/internal/credentialBootstrap.js';
import { ensurePiHeadlessArgs } from './pi.js';
import { providerConnectionProfile } from './providerConnections.js';
import { PROVIDER_HARNESSES, harnessForProvider, isCompatible } from './providerHarnesses.js';
import { materializeRoute, routeDescribesService } from './providerRouteRecipes.js';
import { SERVICE_DEFINITIONS, resolveServiceInstance, serviceDefinitionById, serviceDefinitionForLocalRuntime } from './serviceDefinitions.js';

const SAMPLES = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'aiToolkit/defaults/providers.sample.json'),
  'utf8',
)).providers;

/** A local daemon's endpoints, as an install would declare them. */
const LOCAL_TRANSPORTS = { openai: { baseUrl: 'http://127.0.0.1:11434/v1' }, anthropic: { baseUrl: 'http://127.0.0.1:11434' } };

/** A remote endpoint for the definitions that default to none (a proxy, a peer). */
const REMOTE_TRANSPORTS = { openai: { baseUrl: 'https://gateway.example.com/v1' } };

/** An instance of `definition` with every endpoint and a key filled in. */
const instanceFor = (definition, credentials = { apiKey: 'example-key' }) => resolveServiceInstance({
  definitionId: definition.id,
  transports: Object.fromEntries(Object.keys(definition.transports).map((protocol) => [protocol, {
    baseUrl: definition.transports[protocol].defaultBaseUrl
      ?? (definition.family === 'local' ? LOCAL_TRANSPORTS : REMOTE_TRANSPORTS)[protocol].baseUrl,
  }])),
  credentials,
});

const compatiblePairs = PROVIDER_HARNESSES.flatMap((harness) => SERVICE_DEFINITIONS
  .map((definition) => instanceFor(definition))
  .filter((instance) => isCompatible(harness, instance))
  .map((instance) => ({ harness, instance, name: `${harness.id} × ${instance.definition.id}` })));

describe('materializeRoute round-trips onto its service', () => {
  it('accepts a meaningful number of pairs', () => {
    expect(compatiblePairs.length).toBeGreaterThan(25);
  });

  it.each(compatiblePairs)('$name', ({ harness, instance }) => {
    const method = harness.modes[0];
    const record = materializeRoute({ harness, method, serviceInstance: instance });
    expect(record).toMatchObject({
      id: `${harness.id}.${method}@${instance.slug}`,
      type: method,
      harnessId: harness.id,
      method,
      serviceId: instance.slug,
      servicePlan: instance.plan,
      enabled: true,
      models: [],
    });
    expect(record).not.toHaveProperty('credentialBootstrap');
    if (harness.recipe) expect(record.command).toBe(harness.recipe.command);
    else expect(record).not.toHaveProperty('command');

    const profile = providerConnectionProfile(record);
    expect(profile.reasons, `${harness.id} on ${instance.definition.id} isolates: ${JSON.stringify(profile.reasons)}`).toEqual([]);
    expect(harnessForProvider(record)?.id).toBe(harness.id);
    expect(routeDescribesService(profile, instance)).toBe(true);
    // A key never rides an unlisted env var: the profile reads every credential
    // the record carries, or the record describes a backend it is not on.
    for (const name of record.secretEnvVars) expect(record.envVars).toHaveProperty(name);
  });

  it('refuses the pairs the registries rule out, with a typed reason', () => {
    const refuse = (input) => { try { materializeRoute(input); return null; } catch (err) { return err.code; } };
    expect(refuse({ harness: 'claude', method: 'cli', serviceInstance: 'nvidia-nim' })).toBe('HARNESS_SERVICE_INCOMPATIBLE');
    expect(refuse({ harness: 'antigravity', method: 'api', serviceInstance: 'antigravity' })).toBe('HARNESS_METHOD_UNSUPPORTED');
    expect(refuse({ harness: 'nope', method: 'cli', serviceInstance: 'antigravity' })).toBe('HARNESS_UNKNOWN');
    // A local daemon whose instance names no endpoint: never a guessed port.
    expect(refuse({ harness: 'codex', method: 'cli', serviceInstance: 'ollama' })).toBe('SERVICE_ENDPOINT_REQUIRED');
    // Claude Code will not start without a token, even to a daemon that ignores it.
    expect(refuse({ harness: 'claude', method: 'cli', serviceInstance: { definitionId: 'ollama', transports: LOCAL_TRANSPORTS } })).toBe('SERVICE_CREDENTIAL_REQUIRED');
    // ...while OpenCode on the same daemon needs none.
    expect(refuse({ harness: 'opencode', method: 'cli', serviceInstance: { definitionId: 'ollama', transports: LOCAL_TRANSPORTS } })).toBeNull();
  });
});

describe('materializeRoute writes what each binding shape says', () => {
  it('materializes Bedrock through Claude Code\'s static env switch', () => {
    const record = materializeRoute({ harness: 'claude', method: 'cli', serviceInstance: { definitionId: 'bedrock', credentials: { apiKey: 'token' } } });
    expect(record.envVars).toEqual({ AWS_BEARER_TOKEN_BEDROCK: 'token', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(record.secretEnvVars).toEqual(['AWS_BEARER_TOKEN_BEDROCK']);
    expect(record).not.toHaveProperty('endpoint');
  });

  it('declares OpenCode Zen as the provider OpenCode ships, permissions only', () => {
    const record = materializeRoute({ harness: 'opencode', method: 'cli', serviceInstance: { definitionId: 'opencode-zen', credentials: { apiKey: 'zen' } } });
    expect(record.envVars.OPENCODE_CONFIG_CONTENT).toBe(SAMPLES['opencode-zen-cli'].envVars.OPENCODE_CONFIG_CONTENT);
    expect(record.envVars.OPENCODE_API_KEY).toBe('zen');
    expect(record.secretEnvVars).toEqual(SAMPLES['opencode-zen-cli'].secretEnvVars);
  });

  // Two instances of one definition under different plans are how "NVIDIA
  // free vs paid" is represented; each is its own route.
  it('keys a second plan of the same service by its slug', () => {
    const free = materializeRoute({ harness: 'direct', method: 'api', serviceInstance: { definitionId: 'nvidia-nim', slug: 'nvidia-free', plan: 'free' } });
    const paid = materializeRoute({ harness: 'direct', method: 'api', serviceInstance: { definitionId: 'nvidia-nim', slug: 'nvidia-paid', plan: 'paid', credentials: { apiKey: 'k' } } });
    expect([free.id, paid.id]).toEqual(['direct.api@nvidia-free', 'direct.api@nvidia-paid']);
    expect([free.servicePlan, paid.servicePlan]).toEqual(['free', 'paid']);
    expect(free).toMatchObject({ endpoint: 'https://integrate.api.nvidia.com/v1', apiKey: '', timeout: 300000 });
    // A direct record IS the gateway; the marker is for a wrapper in front of one.
    expect(free).not.toHaveProperty('gatewayBacked');
    expect(materializeRoute({ harness: 'opencode', method: 'cli', serviceInstance: 'nvidia-nim' }).gatewayBacked).toBe('nvidia-nim');
    expect(paid.apiKey).toBe('k');
  });

  it('carries the selection onto the record', () => {
    const record = materializeRoute({
      harness: 'codex', method: 'cli', serviceInstance: { definitionId: 'nvidia-nim', credentials: { apiKey: 'k' } },
      selection: { model: 'vendor/model-a', effort: 'high', tiers: { lightModel: 'vendor/model-b' } },
      overrides: { timeout: 42 },
    });
    expect(record).toMatchObject({ defaultModel: 'vendor/model-a', effort: 'high', lightModel: 'vendor/model-b', timeout: 42 });
  });
});

describe('Pi is pointed at a service by the provider name it ships (verified against pi 0.85)', () => {
  it('selects the provider with --provider and keys it from the service\'s own env var', () => {
    const record = materializeRoute({ harness: 'pi', method: 'cli', serviceInstance: { definitionId: 'nvidia-nim', credentials: { apiKey: 'nv' } } });
    expect(record.command).toBe('pi');
    expect(record.args).toEqual(['--print', '--approve', '--provider', 'nvidia']);
    expect(record.envVars).toEqual({ NVIDIA_API_KEY: 'nv' });
    expect(record.secretEnvVars).toEqual(['NVIDIA_API_KEY']);
    // The spawn-time argv builder keeps the selection and adds the model in the
    // `provider/id` form Pi documents for `--model`.
    expect(ensurePiHeadlessArgs(record.args, 'nvidia/example-model', null))
      .toEqual(['--print', '--approve', '--provider', 'nvidia', '--model', 'nvidia/example-model']);
  });

  it('cannot be pointed at a custom endpoint, which is Pi\'s own models.json', () => {
    expect(() => materializeRoute({ harness: 'pi', method: 'cli', serviceInstance: { definitionId: 'ollama', transports: LOCAL_TRANSPORTS } }))
      .toThrow(expect.objectContaining({ code: 'HARNESS_SERVICE_INCOMPATIBLE' }));
    expect(() => materializeRoute({ harness: 'pi', method: 'cli', serviceInstance: { definitionId: 'openai-compatible', transports: LOCAL_TRANSPORTS } }))
      .toThrow(expect.objectContaining({ code: 'HARNESS_SERVICE_INCOMPATIBLE' }));
  });
});

describe('a bootstrap app becomes the credentialBootstrap the spawn composer reads', () => {
  const BOOTSTRAP = { id: 'corp-auth', command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessNames: { claude: 'claude-code' } };
  const PROXY = { definitionId: 'openai-compatible', transports: { openai: { baseUrl: 'https://proxy.example.com/v1' } }, credential: { via: 'bootstrap' } };

  it('emits <bootstrap> run <harness name> -- <args>', () => {
    const record = materializeRoute({ harness: 'codex', method: 'cli', serviceInstance: PROXY, bootstrap: BOOTSTRAP });
    expect(record.id).toBe('codex.cli@openai-compatible+corp-auth');
    expect(record.credentialBootstrap).toEqual({ command: 'corp-auth', args: ['run'], harnessId: 'codex', argsSeparator: '--' });
    expect(composeBootstrapSpawn(record, record.command, [...record.args, '--flag']))
      .toEqual({ command: 'corp-auth', args: ['run', 'codex', '--', '--flag'], wrapped: true });
    // The bootstrap-minted credential is not a stored key: none is required,
    // and the key env var is left for the bootstrap CLI to provide.
    expect(record.envVars).toEqual({ OPENAI_BASE_URL: 'https://proxy.example.com/v1' });
    expect(record.secretEnvVars).toEqual([]);
  });

  it('uses the bootstrap CLI\'s own name for a harness when it has one', () => {
    const record = materializeRoute({
      harness: 'claude', method: 'tui', bootstrap: BOOTSTRAP,
      serviceInstance: { definitionId: 'ollama', transports: LOCAL_TRANSPORTS, credential: { via: 'bootstrap' } },
    });
    expect(record.credentialBootstrap.harnessId).toBe('claude-code');
    expect(composeBootstrapSpawn(record, record.command, record.args).args).toEqual(['run', 'claude-code', '--', '--dangerously-skip-permissions']);
  });

  it('refuses a bootstrap-credentialed service with no bootstrap, and never wraps an api route', () => {
    expect(() => materializeRoute({ harness: 'codex', method: 'cli', serviceInstance: PROXY }))
      .toThrow(expect.objectContaining({ code: 'SERVICE_CREDENTIAL_BOOTSTRAP_REQUIRED' }));
    const api = materializeRoute({ harness: 'direct', method: 'api', serviceInstance: PROXY, bootstrap: BOOTSTRAP });
    expect(api).not.toHaveProperty('credentialBootstrap');
    expect(composeBootstrapSpawn(api, 'x', []).wrapped).toBe(false);
  });
});

/**
 * The service a shipped sample is on, read the same way a later migration
 * will read it: from the record's own profile (kind + endpoint), then — for a
 * record that names no backend — from the harness's subscription binding or
 * the static switch it carries.
 */
function serviceForSample(sample, profile, harness) {
  const local = serviceDefinitionForLocalRuntime(profile.kind);
  if (local) return local;
  if (profile.kind.startsWith('gateway:')) return serviceDefinitionById(profile.kind.slice('gateway:'.length));
  if (sample.envVars?.CLAUDE_CODE_USE_BEDROCK === '1') return serviceDefinitionById('bedrock');
  if (sample.secretEnvVars?.includes('OPENCODE_API_KEY')) return serviceDefinitionById('opencode-zen');
  const endpoint = profile.transports.openai?.baseUrl;
  if (endpoint) return SERVICE_DEFINITIONS.find((row) => row.transports.openai?.defaultBaseUrl === endpoint) || null;
  const subscription = harness.bindings.find((binding) => binding.service && !binding.env);
  return subscription ? serviceDefinitionById(subscription.service) : null;
}

describe('the shipped samples are reproduced by their (harness, service) composition', () => {
  const mapped = [];
  const unmapped = [];
  for (const [id, sample] of Object.entries(SAMPLES)) {
    const profile = providerConnectionProfile(sample);
    const harness = harnessForProvider(sample);
    const definition = harness && profile.reasons.length === 0 ? serviceForSample(sample, profile, harness) : null;
    if (!definition) { unmapped.push(id); continue; }
    const [credentialValue] = Object.values(profile.credentials);
    const serviceInstance = resolveServiceInstance({
      definitionId: definition.id,
      // The profile reports ONE transport (the env var wins over `endpoint`);
      // a sample that also stores the daemon's OpenAI URL declares both.
      transports: {
        ...(definition.transports.openai && sample.endpoint ? { openai: { baseUrl: sample.endpoint } } : {}),
        ...profile.transports,
      },
      // A sample stores a blank key; the composition needs a real one where
      // the program refuses to start without it. The VALUE is compared only
      // where the sample itself carries one.
      credentials: { apiKey: credentialValue ?? 'example-key' },
    });
    if (!isCompatible(harness, serviceInstance)) { unmapped.push(id); continue; }
    mapped.push({ id, sample, profile, harness, serviceInstance });
  }

  // Kilo and OpenChamber bind to nothing; the two Pi samples name no service
  // at all (Pi's default provider is whatever the user last logged into), so
  // they are pinned by `providerRouteRecipes.sampleParity.test.js` instead.
  it('maps every sample except the ones that name no service', () => {
    expect(unmapped.sort()).toEqual(['kilo-cli', 'kilo-tui', 'openchamber-cli', 'pi-cli', 'pi-tui']);
    expect(mapped.length + unmapped.length).toBe(Object.keys(SAMPLES).length);
  });

  it.each(mapped)('$id', ({ sample, profile, harness, serviceInstance }) => {
    const minted = materializeRoute({ harness, method: sample.type, serviceInstance });
    // Every connection-owned value the sample declares is what the composition
    // writes: endpoint / apiKey fields and the transport + credential env vars.
    for (const [field, value] of Object.entries(profile.owned.fields)) {
      if (field === 'apiKey' && value === '') continue;
      expect(minted[field], field).toBe(value);
    }
    for (const [name, value] of Object.entries(profile.owned.envVars)) {
      if (value === '') continue;
      expect(minted.envVars[name], name).toBe(value);
    }
    // ...and the composition reads back onto the same service and kind.
    const reread = providerConnectionProfile(minted);
    expect(reread.kind).toBe(profile.kind);
    expect(routeDescribesService(reread, serviceInstance)).toBe(true);
  });
});
