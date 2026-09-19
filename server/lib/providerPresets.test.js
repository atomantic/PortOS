/**
 * The preset contract (#7565): what a DERIVED preset keeps as its own, what it
 * takes from its service on every save, which direct edits are refused, and
 * the boot-time backfill's one rule — a legacy record is stamped only when
 * re-deriving it is a fixpoint.
 *
 * The 55 shipped samples are the fixture for the backfill because they are
 * the file every install starts from; everything else is synthetic. Nothing
 * here is read out of a running install.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessById } from './providerHarnesses.js';
import { importGraphFromProviders, isDerivedPreset } from './providerGraphRecords.js';
import { instanceForConnection, planServiceColumnBackfill, takenServiceSlugs } from './providerServiceInstances.js';
import { resolveServiceInstance } from './serviceDefinitions.js';
import {
  PRESET_STRUCTURAL_KEYS,
  bootstrapInputFor,
  derivedPresetDrift,
  derivedPresetPatch,
  materializeDerivedPreset,
  matchBootstrapApp,
  planPresetBackfill,
  presetDerivable,
  refusedDerivedEdits,
} from './providerPresets.js';

const SAMPLES = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'aiToolkit/defaults/providers.sample.json'), 'utf8',
)).providers;

const OLLAMA = resolveServiceInstance({
  definitionId: 'ollama', slug: 'ollama', plan: 'local',
  transports: { anthropic: { baseUrl: 'http://127.0.0.1:11434' }, openai: { baseUrl: 'http://127.0.0.1:11434/v1' } },
  credentials: { apiKey: 'ollama' },
});
const KNOWN = { state: 'known', models: ['example-llama', 'example-qwen'] };

/** A Claude-on-Ollama derived preset with per-preset choices and a route-owned env var beside the service's. */
const claudePreset = (extra = {}) => ({
  id: 'claude-local', name: 'Claude · local', type: 'cli', method: 'cli', harnessId: 'claude', serviceId: 'ollama',
  command: 'claude', args: ['--print'], timeout: 42000, effort: 'high', defaultModel: 'example-qwen', someFutureField: { keep: true },
  envVars: { ANTHROPIC_SMALL_FAST_MODEL: 'example-llama', ANTHROPIC_BASE_URL: 'http://old.example.test', ANTHROPIC_AUTH_TOKEN: 'stale' },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'], models: ['stale-model'], ...extra,
});

describe('materializeDerivedPreset', () => {
  it('rewrites what the service owns and keeps every per-preset field, unknown ones included', () => {
    const { record, error, ownedEnvNames } = materializeDerivedPreset({ record: claudePreset(), harness: harnessById('claude'), instance: OLLAMA, catalog: KNOWN });
    expect(error).toBeNull();
    expect(record).toMatchObject({
      id: 'claude-local', name: 'Claude · local', type: 'cli', command: 'claude', ollamaBacked: true,
      timeout: 42000, effort: 'high', defaultModel: 'example-qwen', someFutureField: { keep: true },
      envVars: { ANTHROPIC_SMALL_FAST_MODEL: 'example-llama', ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434', ANTHROPIC_AUTH_TOKEN: 'ollama' },
      secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'], models: ['example-llama', 'example-qwen'],
    });
    expect(record).not.toHaveProperty('servicePlan');
    expect([...ownedEnvNames].sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  });

  it('narrows the catalog in the narrowing\'s own order, and falls back to the record\'s models while the service has listed none', () => {
    const narrowed = materializeDerivedPreset({ record: claudePreset({ catalogNarrowing: ['example-qwen', 'retired'] }), harness: harnessById('claude'), instance: OLLAMA, catalog: KNOWN });
    expect(narrowed.record.models).toEqual(['example-qwen']);
    const unlisted = materializeDerivedPreset({ record: claudePreset(), harness: harnessById('claude'), instance: OLLAMA, catalog: { state: 'unknown', models: [] } });
    expect(unlisted.record.models).toEqual(['stale-model']);
  });

  it('keeps the binding\'s argv suffix present whatever the user typed before it', () => {
    const nim = resolveServiceInstance({ definitionId: 'nvidia-nim', slug: 'nim', plan: 'free', credentials: { apiKey: 'k' } });
    const record = { id: 'pi-nim', name: 'Pi', type: 'tui', method: 'tui', harnessId: 'pi', serviceId: 'nim', args: ['--approve', '--verbose'] };
    expect(materializeDerivedPreset({ record, harness: harnessById('pi'), instance: nim }).record.args).toEqual(['--approve', '--verbose', '--provider', 'nvidia']);
  });

  it('keeps the record\'s own OpenCode inline config when it already reaches the service', () => {
    const shipped = SAMPLES['opencode-ollama'];
    const record = { ...shipped, harnessId: 'opencode', method: 'cli', serviceId: 'ollama' };
    const local = resolveServiceInstance({ definitionId: 'ollama', slug: 'ollama', transports: { openai: { baseUrl: JSON.parse(shipped.envVars.OPENCODE_CONFIG_CONTENT).provider.ollama.options.baseURL } } });
    const { record: derived } = materializeDerivedPreset({ record, harness: harnessById('opencode'), instance: local });
    expect(derived.envVars.OPENCODE_CONFIG_CONTENT).toBe(shipped.envVars.OPENCODE_CONFIG_CONTENT);
    const moved = resolveServiceInstance({ definitionId: 'ollama', slug: 'ollama', transports: { openai: { baseUrl: 'http://127.0.0.1:9999/v1' } } });
    const rewritten = materializeDerivedPreset({ record, harness: harnessById('opencode'), instance: moved }).record;
    expect(JSON.parse(rewritten.envVars.OPENCODE_CONFIG_CONTENT).provider.ollama.options.baseURL).toBe('http://127.0.0.1:9999/v1');
  });

  it('writes the bootstrap app as the inline object the spawner reads, and drops a stale inline one', () => {
    const app = { label: 'Corp', command: 'corp-auth', args: ['run'], argsSeparator: '--', envCommand: ['corp-auth', 'env'], harnessNames: { claude: 'claude-code' } };
    const anthropic = resolveServiceInstance({ definitionId: 'anthropic', slug: 'anthropic', credentialVia: 'bootstrap' });
    const record = claudePreset({ serviceId: 'anthropic', credentialBootstrapId: 'corp-auth', credentialBootstrap: { setupCommand: 'brew install corp', command: 'old' } });
    const { record: derived } = materializeDerivedPreset({ record, harness: harnessById('claude'), instance: anthropic, bootstrap: bootstrapInputFor('corp-auth', app) });
    expect(derived.credentialBootstrap).toEqual({ setupCommand: 'brew install corp', command: 'corp-auth', args: ['run'], harnessId: 'claude-code', argsSeparator: '--', envCommand: ['corp-auth', 'env'] });
    const without = materializeDerivedPreset({ record: { ...record, credentialBootstrapId: undefined }, harness: harnessById('claude'), instance: { ...anthropic, credentialVia: 'stored', credentials: { apiKey: 'k' } } }).record;
    expect(without).not.toHaveProperty('credentialBootstrap');
    expect(without).not.toHaveProperty('credentialBootstrapId');
  });

  it('carries the service\'s refusal as a typed error rather than a half record', () => {
    const { record, error } = materializeDerivedPreset({ record: claudePreset(), harness: harnessById('claude'), instance: resolveServiceInstance({ definitionId: 'nvidia-nim', slug: 'nim' }) });
    expect(record).toBeNull();
    expect(error).toMatchObject({ code: 'HARNESS_SERVICE_INCOMPATIBLE', status: 400 });
  });
});

describe('refusedDerivedEdits', () => {
  const { record: derived, ownedEnvNames } = materializeDerivedPreset({ record: claudePreset(), harness: harnessById('claude'), instance: OLLAMA, catalog: KNOWN });

  it('names a connection-owned value the client moved, and nothing it merely echoed back', () => {
    expect(refusedDerivedEdits({ ...derived }, derived, ownedEnvNames)).toEqual([]);
    expect(refusedDerivedEdits({ command: '/opt/bin/claude', apiKey: 'typed', envVars: { ...derived.envVars, ANTHROPIC_BASE_URL: 'http://elsewhere.test' } }, derived, ownedEnvNames))
      .toEqual(['command', 'apiKey', 'envVars.ANTHROPIC_BASE_URL']);
  });

  it('lets the preset\'s own env vars, argv, pins and effort through', () => {
    expect(refusedDerivedEdits({ args: ['--print', '--verbose'], effort: 'low', envVars: { ...derived.envVars, ANTHROPIC_SMALL_FAST_MODEL: 'other' } }, derived, ownedEnvNames)).toEqual([]);
  });
});

describe('derivedPresetPatch', () => {
  it('is only what changed, with a dropped key written as undefined', () => {
    const before = claudePreset({ credentialBootstrap: { command: 'gone' } });
    const { record: derived } = materializeDerivedPreset({ record: before, harness: harnessById('claude'), instance: OLLAMA, catalog: KNOWN });
    const patch = derivedPresetPatch(before, derived);
    expect(patch).toMatchObject({ envVars: derived.envVars, models: derived.models, ollamaBacked: true });
    for (const kept of ['name', 'effort', 'timeout', 'someFutureField', 'harnessId']) expect(patch).not.toHaveProperty(kept);
    expect(patch.credentialBootstrap).toBeUndefined();
    expect(Object.hasOwn(patch, 'credentialBootstrap')).toBe(true);
  });
});

describe('matchBootstrapApp', () => {
  const apps = { 'corp-auth': { label: 'Corp', command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessNames: { claude: 'claude-code' } } };
  it('matches on what the spawn runs, harness name included, and never on the advisory setup command', () => {
    expect(matchBootstrapApp({ command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessId: 'claude-code', setupCommand: 'anything' }, harnessById('claude'), apps)?.slug).toBe('corp-auth');
    expect(matchBootstrapApp({ command: 'corp-auth', args: ['run'], argsSeparator: '--' }, harnessById('claude'), apps)).toBeNull();
    // No name configured for Codex means the wrapper calls it by its binary — so a bare inline matches, a renamed one does not.
    expect(matchBootstrapApp({ command: 'corp-auth', args: ['run'], argsSeparator: '--' }, harnessById('codex'), apps)?.slug).toBe('corp-auth');
    expect(matchBootstrapApp({ command: 'corp-auth', args: ['run'], argsSeparator: '--', harnessId: 'codex-cli' }, harnessById('codex'), apps)).toBeNull();
  });
});

describe('presetDerivable', () => {
  it('offers conversion only for a legacy record on a known harness, its own binary, with a clean profile', () => {
    expect(presetDerivable(SAMPLES['claude-ollama'])).toBe(true);
    expect(presetDerivable({ ...SAMPLES['claude-ollama'], harnessId: 'claude', method: 'cli', serviceId: 'ollama' })).toBe(false);
    expect(presetDerivable({ ...SAMPLES['claude-ollama'], command: '/opt/bin/claude' })).toBe(false);
    expect(presetDerivable({ ...SAMPLES['claude-ollama'], envVars: { ...SAMPLES['claude-ollama'].envVars, ANTHROPIC_BASE_URL: '$DAEMON' } })).toBe(false);
    expect(presetDerivable(SAMPLES['kilo-cli'])).toBe(false);
  });
});

describe('planPresetBackfill over the shipped samples', () => {
  const providers = Object.values(SAMPLES).map((record) => structuredClone(record));
  let n = 0;
  const graph = importGraphFromProviders({ providers }, () => `id-${(n += 1)}`);
  for (const row of planServiceColumnBackfill(graph, takenServiceSlugs(graph.connections))) {
    Object.assign(graph.connections.find((connection) => connection.id === row.id), row);
  }
  const { patches, skipped } = planPresetBackfill({ graph, providers, bootstraps: {}, env: {} });

  it('stamps every routed record whose re-derivation is a fixpoint, with the structural keys only', () => {
    expect(Object.keys(patches).length).toBeGreaterThanOrEqual(30);
    for (const patch of Object.values(patches)) {
      expect(Object.keys(patch).every((key) => PRESET_STRUCTURAL_KEYS.includes(key))).toBe(true);
      expect(patch).toMatchObject({ harnessId: expect.any(String), method: expect.any(String), serviceId: expect.any(String) });
    }
    // The motivating example: a CLI/TUI pair on one daemon, and a direct API record.
    expect(patches['claude-ollama']).toEqual({ harnessId: 'claude', method: 'cli', serviceId: 'ollama' });
    expect(patches['claude-ollama-tui']).toEqual({ harnessId: 'claude', method: 'tui', serviceId: 'ollama' });
    expect(patches.slotstream).toMatchObject({ harnessId: 'direct', method: 'api' });
  });

  it('turns two records sharing one endpoint into two narrowings of one instance', () => {
    expect(patches['nvidia-nim'].serviceId).toBe(patches['nvidia-kimi'].serviceId);
    expect(patches['nvidia-nim'].catalogNarrowing).toEqual(SAMPLES['nvidia-nim'].models);
    expect(patches['nvidia-kimi'].catalogNarrowing).toEqual(SAMPLES['nvidia-kimi'].models);
  });

  it('leaves each unmappable or drifting record legacy with a reason, never a guess', () => {
    const reasons = Object.fromEntries(skipped.map(({ id, reason }) => [id, reason]));
    expect(reasons['pi-cli']).toBe('service-undefined');
    expect(reasons['kilo-cli']).toBe('service-undefined');
    expect(reasons['opencode-zen-cli']).toBe('SERVICE_CREDENTIAL_REQUIRED');
    // The legacy per-gateway marker is not what a service writes.
    expect(reasons['opencode-orcarouter']).toMatch(/^drift:.*orcarouterBacked/);
    for (const id of Object.keys(reasons)) expect(patches).not.toHaveProperty(id);
  });

  it('is additive — a stamped file differs from the shipped one by added keys alone — and a second pass stamps nothing', () => {
    const stamped = providers.map((record) => ({ ...record, ...(patches[record.id] || {}) }));
    for (const record of stamped) {
      const original = SAMPLES[record.id];
      for (const key of Object.keys(original)) expect(record[key]).toEqual(original[key]);
      if (patches[record.id]) expect(isDerivedPreset(record)).toBe(true);
    }
    expect(planPresetBackfill({ graph, providers: stamped, bootstraps: {}, env: {} }).patches).toEqual({});
  });

  it('proves the fixpoint it stamped on: re-deriving a stamped record changes no connection-owned value', () => {
    for (const record of providers) {
      const patch = patches[record.id];
      if (!patch) continue;
      const connection = graph.connections.find((row) => row.slug === patch.serviceId);
      const instance = instanceForConnection(connection, {});
      const harness = harnessById(patch.harnessId);
      const { record: derived } = materializeDerivedPreset({ record: { ...record, ...patch }, harness, instance, catalog: connection.catalog });
      expect(derivedPresetDrift(record, derived, harness), record.id).toEqual([]);
    }
  });
});
