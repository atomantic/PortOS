import { describe, expect, it } from 'vitest';
import {
  REDACTED_CREDENTIAL,
  compareBackendEndpoints,
  providerConnectionProfile,
  sameConnectionIdentity,
  withConnectionOwnedFields,
  withoutConnectionOwnedFields,
} from './providerConnections.js';

// Transport identity is the one place the graph can silently do damage: merge
// two connections that are not the same backend and a later slice would write
// one machine's credentials over another's. These are focused adapter tests
// because the failures are about exact URL/credential comparison, which a
// route-level assertion can only observe indirectly.

const claudeOllama = (overrides = {}) => ({
  id: 'claude-ollama',
  name: 'Claude Ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  models: [],
  envVars: {
    ANTHROPIC_BASE_URL: 'http://localhost:11434',
    ANTHROPIC_AUTH_TOKEN: 'example-token',
    ANTHROPIC_SMALL_FAST_MODEL: 'example-small',
  },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
  ...overrides,
});

const opencodeOllama = (baseURL = 'http://localhost:11434/v1', overrides = {}) => ({
  id: 'opencode-ollama',
  name: 'OpenCode Ollama',
  type: 'cli',
  command: 'opencode',
  ollamaBacked: true,
  models: [],
  envVars: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      permission: 'allow',
      provider: { ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL } } },
    }),
  },
  secretEnvVars: [],
  ...overrides,
});

describe('providerConnectionProfile', () => {
  it('reads the Claude wrapper transport from its own env var, not the endpoint field', () => {
    const profile = providerConnectionProfile(claudeOllama());
    expect(profile.kind).toBe('ollama');
    expect(profile.transports).toEqual({ anthropic: { baseUrl: 'http://localhost:11434' } });
    expect(profile.credentials).toEqual({ ANTHROPIC_AUTH_TOKEN: 'example-token' });
    expect(profile.reasons).toEqual([]);
  });

  it('leaves harness behavior route-owned while owning the transport env var', () => {
    // ANTHROPIC_SMALL_FAST_MODEL is a Claude Code behavior knob, not a backend
    // address — materializing it out of a shared connection would let one
    // route's model choice follow another route onto the same daemon.
    const profile = providerConnectionProfile(claudeOllama());
    expect(Object.keys(profile.owned.envVars).sort())
      .toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
  });

  it('reads the OpenCode transport out of its inline config and leaves that config route-owned', () => {
    const profile = providerConnectionProfile(opencodeOllama());
    expect(profile.transports).toEqual({ openai: { baseUrl: 'http://localhost:11434/v1' } });
    // The config string also carries permissions/agents, so splitting it would
    // be lossy; only its derived endpoint informs the connection.
    expect(profile.owned.envVars).toEqual({});
  });

  it('isolates an unparsable harness config instead of guessing an endpoint', () => {
    const profile = providerConnectionProfile(
      opencodeOllama('http://localhost:11434/v1', { envVars: { OPENCODE_CONFIG_CONTENT: '{not json' } }),
    );
    expect(profile.reasons.map((r) => r.code)).toContain('unparsable-harness-config');
  });

  it('isolates a config declaring a namespace the record has no marker for', () => {
    const provider = opencodeOllama();
    provider.envVars.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        ollama: { options: { baseURL: 'http://localhost:11434/v1' } },
        openai: { options: { baseURL: 'https://api.example.com/v1' } },
      },
    });
    const profile = providerConnectionProfile(provider);
    expect(profile.reasons.map((r) => r.code)).toContain('foreign-namespace-config');
  });

  it('isolates a dynamic environment reference the adapter cannot resolve', () => {
    const profile = providerConnectionProfile(claudeOllama({
      envVars: { ANTHROPIC_BASE_URL: '${OLLAMA_URL}', ANTHROPIC_AUTH_TOKEN: 'example-token' },
    }));
    expect(profile.reasons.map((r) => r.code)).toContain('dynamic-config');
  });

  it('isolates a local-runtime record that names no endpoint at all', () => {
    const profile = providerConnectionProfile(claudeOllama({ envVars: {} }));
    expect(profile.reasons.map((r) => r.code)).toContain('unknown-endpoint');
  });

  it('isolates a cli record whose command matches no known harness', () => {
    const profile = providerConnectionProfile({ id: 'custom', type: 'cli', command: 'my-agent' });
    expect(profile.reasons.map((r) => r.code)).toContain('unknown-harness');
  });
});

describe('sameConnectionIdentity', () => {
  it('matches two records pointed at the same daemon with the same credential', () => {
    expect(sameConnectionIdentity(
      providerConnectionProfile(claudeOllama()),
      providerConnectionProfile(claudeOllama({ id: 'claude-ollama-tui', type: 'tui' })),
    )).toBe(true);
  });

  it('refuses a differing auth token even when the endpoint is identical', () => {
    const other = claudeOllama();
    other.envVars = { ...other.envVars, ANTHROPIC_AUTH_TOKEN: 'different-token' };
    expect(sameConnectionIdentity(
      providerConnectionProfile(claudeOllama()),
      providerConnectionProfile(other),
    )).toBe(false);
  });

  it('refuses REDACTED credentials outright — equal `***` is not equal auth', () => {
    // The whole risk of comparing sanitized records: two unrelated backends
    // both read `***` and would merge into one connection carrying one
    // machine's key. Identity is decided on real server-side values only.
    const redacted = claudeOllama();
    redacted.envVars = { ...redacted.envVars, ANTHROPIC_AUTH_TOKEN: REDACTED_CREDENTIAL };
    const profile = providerConnectionProfile(redacted);
    expect(profile.reasons.map((r) => r.code)).toContain('redacted-credential');
    expect(sameConnectionIdentity(profile, providerConnectionProfile(redacted))).toBe(false);
  });

  it('refuses a remote host that merely shares the local daemon port', () => {
    expect(sameConnectionIdentity(
      providerConnectionProfile(claudeOllama()),
      providerConnectionProfile(claudeOllama({
        envVars: { ANTHROPIC_BASE_URL: 'http://ollama.example.com:11434', ANTHROPIC_AUTH_TOKEN: 'example-token' },
      })),
    )).toBe(false);
  });
});

describe('compareBackendEndpoints', () => {
  it('reconciles the recognized /v1 suffix across two harnesses and reports the differences', () => {
    const result = compareBackendEndpoints(
      providerConnectionProfile(claudeOllama()),
      providerConnectionProfile(opencodeOllama()),
    );
    expect(result.sameEndpoint).toBe(true);
    // Reported, not merged: the human confirms the protocol/auth difference.
    expect(result.differences).toEqual(expect.arrayContaining(['protocol', 'credentials']));
  });

  it('never equates a remote daemon with the local one', () => {
    expect(compareBackendEndpoints(
      providerConnectionProfile(claudeOllama()),
      providerConnectionProfile(opencodeOllama('https://ollama.example.com/v1')),
    ).sameEndpoint).toBe(false);
  });
});

describe('connection-owned field split', () => {
  it('round-trips a record exactly, including keys this module has never heard of', () => {
    // The downgrade contract: an older release runs providers.json alone, so
    // every connection-owned value has to survive back into the record.
    const original = claudeOllama({ endpoint: null, apiKey: '', someFutureField: { nested: true } });
    const { owned } = providerConnectionProfile(original);
    const routeRecord = withoutConnectionOwnedFields(original, owned);
    expect(routeRecord.envVars.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(withConnectionOwnedFields(routeRecord, owned)).toEqual(original);
  });

  it('does not invent an endpoint key on a record that never had one', () => {
    const original = claudeOllama();
    const { owned } = providerConnectionProfile(original);
    const projected = withConnectionOwnedFields(withoutConnectionOwnedFields(original, owned), owned);
    expect(Object.hasOwn(projected, 'endpoint')).toBe(false);
  });
});
