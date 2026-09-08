import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_GRAPH_SCHEMA_VERSION,
  buildProviderGraphPreview,
  projectPreviewToProviders,
  providerGraphUniquenessViolations,
  routeModeEligibility,
  toManagementPreviewDto,
} from './providerGraphPreview.js';

const SAMPLE_PROVIDERS = join(
  dirname(fileURLToPath(import.meta.url)),
  'aiToolkit/defaults/providers.sample.json',
);

// Synthetic fixtures only — never a record read out of a running install.
const OLLAMA_CONFIG = (baseURL) => JSON.stringify({
  permission: 'allow',
  provider: { ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL } } },
});

const claudeOllamaCli = {
  id: 'claude-ollama',
  name: 'Claude Ollama (local model)',
  type: 'cli',
  command: 'claude',
  args: ['--print'],
  ollamaBacked: true,
  models: ['example-model:8b'],
  defaultModel: 'example-model:8b',
  enabled: true,
  timeout: 600000,
  envVars: {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'example-token',
    ANTHROPIC_SMALL_FAST_MODEL: 'example-small:3b',
  },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};
const claudeOllamaTui = {
  ...claudeOllamaCli,
  id: 'claude-ollama-tui',
  name: 'Claude Ollama TUI (local model)',
  type: 'tui',
  enabled: false,
  tuiPromptDelayMs: 2500,
};
const opencodeOllamaCli = {
  id: 'opencode-ollama',
  name: 'OpenCode Ollama (local model)',
  type: 'cli',
  command: 'opencode',
  args: ['run'],
  ollamaBacked: true,
  models: ['ollama/example-model:8b'],
  defaultModel: 'ollama/example-model:8b',
  enabled: false,
  envVars: { OPENCODE_CONFIG_CONTENT: OLLAMA_CONFIG('http://localhost:11434/v1') },
  secretEnvVars: [],
};
const opencodeOllamaTui = { ...opencodeOllamaCli, id: 'opencode-ollama-tui', type: 'tui', enabled: false };
const remoteOllamaApi = {
  id: 'remote-ollama',
  name: 'Remote Ollama',
  type: 'api',
  endpoint: 'https://ollama.example.com/v1',
  apiKey: 'example-remote-key',
  models: ['example-model:8b'],
  enabled: true,
};

const FIXTURES = [claudeOllamaCli, claudeOllamaTui, opencodeOllamaCli, opencodeOllamaTui, remoteOllamaApi];

const previewOf = (providers, activeProvider = null) =>
  buildProviderGraphPreview({ providers, activeProvider });
const byProviderId = (preview, id) => preview.routes.find((route) => route.providerId === id);
const bindingOf = (preview, id) => preview.bindings.find((b) => b.id === byProviderId(preview, id).bindingId);

describe('provider graph import preview', () => {
  it('groups proven CLI/TUI siblings into one binding and keeps both executable route IDs', () => {
    const preview = previewOf(FIXTURES, 'claude-ollama');

    const binding = bindingOf(preview, 'claude-ollama');
    expect(binding.harnessId).toBe('claude');
    expect(binding.variantKey).toBe('default');
    // OR across proven siblings, exactly as `unifyProviderModes` already does.
    expect(binding.enabled).toBe(true);
    expect(byProviderId(preview, 'claude-ollama-tui').bindingId).toBe(binding.id);
    expect(byProviderId(preview, 'claude-ollama').mode).toBe('cli');
    expect(byProviderId(preview, 'claude-ollama-tui').mode).toBe('tui');
    expect(preview.activeProvider).toBe('claude-ollama');
  });

  it('never merges two harnesses on one daemon — it suggests an explicit link instead', () => {
    // The whole point of the slice: Claude and OpenCode both reach the same
    // local Ollama, and importing them into ONE connection would silently make
    // a Claude auth token the OpenCode route's credential.
    const preview = previewOf(FIXTURES);
    const claude = bindingOf(preview, 'claude-ollama');
    const opencode = bindingOf(preview, 'opencode-ollama');
    expect(opencode.harnessId).toBe('opencode');
    expect(opencode.connectionId).not.toBe(claude.connectionId);

    expect(preview.suggestedLinks).toEqual([expect.objectContaining({
      connectionIds: [claude.connectionId, opencode.connectionId],
      harnessIds: ['claude', 'opencode'],
      reason: 'same-backend-endpoint',
      requiresExplicitLink: true,
    })]);
  });

  it('keeps a separate remote API its own connection even when the model names match', () => {
    const preview = previewOf(FIXTURES);
    const api = bindingOf(preview, 'remote-ollama');
    expect(api.harnessId).toBeNull();
    expect(byProviderId(preview, 'remote-ollama').mode).toBe('api');
    // A remote host is never suggested against the local daemon.
    expect(preview.suggestedLinks.flatMap((link) => link.connectionIds)).not.toContain(api.connectionId);
  });

  it('imports a second custom configuration of one harness as a distinct labeled variant', () => {
    // Same connection, same harness, different argv: merging would have to
    // discard one of the two executable route IDs.
    const custom = { ...claudeOllamaCli, id: 'claude-ollama-fast', name: 'Claude Ollama Fast', args: ['--print', '--fast'] };
    const preview = previewOf([...FIXTURES, custom]);
    const first = bindingOf(preview, 'claude-ollama');
    const second = bindingOf(preview, 'claude-ollama-fast');

    expect(second.connectionId).toBe(first.connectionId);
    expect(second.variantKey).not.toBe(first.variantKey);
    expect(providerGraphUniquenessViolations(preview)).toEqual([]);
  });

  it('isolates a record whose configuration the adapter cannot fully understand', () => {
    const dynamic = { ...claudeOllamaCli, id: 'claude-ollama-dyn', envVars: { ...claudeOllamaCli.envVars, ANTHROPIC_BASE_URL: '${OLLAMA_URL}' } };
    const unknownHarness = { id: 'house-agent', name: 'House Agent', type: 'cli', command: 'house-agent', models: [] };
    const preview = previewOf([...FIXTURES, dynamic, unknownHarness]);

    expect(byProviderId(preview, 'claude-ollama-dyn').bindingId).toBeNull();
    expect(byProviderId(preview, 'house-agent').bindingId).toBeNull();
    const reasons = Object.fromEntries(preview.unresolved.map((u) => [u.providerId, u.reasons.map((r) => r.code)]));
    expect(reasons['claude-ollama-dyn']).toContain('dynamic-config');
    expect(reasons['house-agent']).toContain('unknown-harness');
  });

  it('isolates a conventional sibling pair whose backend markers disagree', () => {
    // `providerModeGroups` pairs on command/endpoint/apiKey/envVars alone, so a
    // pair that differs only by its `*Backed` marker still arrives here as one
    // group while describing two different backends. Adopting the lead's
    // connection for both would attach a route to a daemon it does not use.
    const cli = { ...claudeOllamaCli, id: 'claude-split' };
    const tui = { ...claudeOllamaTui, id: 'claude-split-tui', ollamaBacked: false, lmstudioBacked: true };
    const preview = previewOf([cli, tui]);

    expect(preview.routes.every((route) => route.bindingId === null)).toBe(true);
    expect(preview.unresolved.flatMap((u) => u.reasons.map((r) => r.code)))
      .toContain('sibling-configuration-mismatch');
  });
});

describe('model aliases and pins', () => {
  it('maps an OpenCode namespaced alias back to its canonical backend name', () => {
    const preview = previewOf(FIXTURES);
    expect(byProviderId(preview, 'opencode-ollama').modelMap)
      .toEqual({ 'example-model:8b': 'ollama/example-model:8b' });
  });

  it('reports a bare alias an OpenCode route could not execute, without prefixing it', () => {
    // A bare id on a namespaced harness is ambiguous — it may be an un-prefixed
    // Ollama model or a qualified id for another backend — so it stays visible
    // and unselectable rather than being rewritten into something executable.
    const mixed = { ...opencodeOllamaCli, id: 'opencode-mixed', models: ['ollama/example-model:8b', 'example-model:8b'] };
    const route = byProviderId(previewOf([mixed]), 'opencode-mixed');
    expect(route.modelMap).toEqual({ 'example-model:8b': 'ollama/example-model:8b' });
    expect(route.unresolvedModels).toEqual([{ model: 'example-model:8b', reason: 'unmappable-model-alias' }]);
  });

  it('reports a stored pin the catalog no longer offers, without repairing it', () => {
    const stale = { ...claudeOllamaCli, id: 'claude-stale', defaultModel: 'removed-model:8b' };
    const route = byProviderId(previewOf([stale]), 'claude-stale');
    expect(route.unresolvedPins).toEqual([{ pin: 'defaultModel', model: 'removed-model:8b', reason: 'pin-not-in-catalog' }]);
    // Reported, never rewritten — the record still carries the user's value.
    expect(projectPreviewToProviders(previewOf([stale]))['claude-stale'].defaultModel).toBe('removed-model:8b');
  });
});

describe('mode eligibility', () => {
  it('is route-scoped: a CLI-only caller can never reach the TUI sibling', () => {
    expect(routeModeEligibility(claudeOllamaCli, { allowedModes: ['cli'] }).eligible).toBe(true);
    const tui = routeModeEligibility({ ...claudeOllamaTui, enabled: true }, { allowedModes: ['cli'] });
    expect(tui.eligible).toBe(false);
    expect(tui.reasons).toContain('mode-not-allowed');
  });

  it('requires text-transport consent explicitly and never infers it from enablement', () => {
    const advertised = { ...claudeOllamaCli, textTransport: 'subscription' };
    expect(routeModeEligibility(advertised).reasons).toContain('consent-required');
    expect(routeModeEligibility({ ...advertised, textTransportEnabled: true }).eligible).toBe(true);
  });
});

describe('import fidelity and the wire DTO', () => {
  it('round-trips every shipped provider record byte-for-byte', () => {
    // The shipped catalog is the widest real input matrix available: every
    // harness, both modes, gateways, secret env vars and custom markers. If a
    // preview cannot re-materialize these, an import built on it loses data.
    const { providers } = JSON.parse(readFileSync(SAMPLE_PROVIDERS, 'utf8'));
    const records = Object.values(providers);
    const preview = previewOf(records);

    expect(preview.routes).toHaveLength(records.length);
    expect(projectPreviewToProviders(preview)).toEqual(Object.fromEntries(records.map((p) => [p.id, p])));
    expect(providerGraphUniquenessViolations(preview)).toEqual([]);
  });

  it('preserves a field this module has never heard of', () => {
    const future = { ...claudeOllamaCli, id: 'claude-future', unknownFutureField: { nested: ['keep', 'me'] } };
    expect(projectPreviewToProviders(previewOf([future]))['claude-future']).toEqual(future);
  });

  it('publishes no credential material and no raw provider record', () => {
    const dto = toManagementPreviewDto(previewOf(FIXTURES, 'claude-ollama'));
    expect(dto.schemaVersion).toBe(PROVIDER_GRAPH_SCHEMA_VERSION);
    expect(dto.activeProvider).toBe('claude-ollama');
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('example-token');
    expect(serialized).not.toContain('example-remote-key');
    expect(dto.connections.find((c) => c.kind === 'ollama').hasCredentials).toBe(true);
  });

  it('keeps secrets out of the internal preview serialization too', () => {
    // Belt and braces: the raw records and credential map hang off the preview
    // as non-enumerable properties, so an accidental log of the whole object
    // cannot leak them even before the DTO's `.strict()` guard runs.
    expect(JSON.stringify(previewOf(FIXTURES))).not.toContain('example-token');
  });
});
