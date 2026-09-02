import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LOCAL_RUNTIMES,
  isLocalInstanceEndpoint,
  localBackendForProvider,
  localRuntimeForProvider,
  localRuntimeKind,
  normalizeOpenAiBaseUrl,
} from './localProviderRuntime.js';
import { opencodeLocalBaseUrl } from './opencodeConfig.js';
import { PORTS } from './ports.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

const opencodeConfig = (namespace, baseURL) => JSON.stringify({
  permission: 'allow',
  provider: { [namespace]: { npm: '@ai-sdk/openai-compatible', options: { baseURL } } },
});

describe('normalizeOpenAiBaseUrl', () => {
  it('appends /v1 only when the URL does not already end in a version segment', () => {
    expect(normalizeOpenAiBaseUrl('http://localhost:11434')).toBe('http://localhost:11434/v1');
    expect(normalizeOpenAiBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(normalizeOpenAiBaseUrl('http://localhost:11434/v1/')).toBe('http://localhost:11434/v1');
  });

  it('returns null for anything unusable', () => {
    expect(normalizeOpenAiBaseUrl('')).toBeNull();
    expect(normalizeOpenAiBaseUrl('   ')).toBeNull();
    expect(normalizeOpenAiBaseUrl(null)).toBeNull();
    expect(normalizeOpenAiBaseUrl(42)).toBeNull();
  });
});

describe('isLocalInstanceEndpoint', () => {
  it('accepts every loopback / bind-all spelling, with or without a version segment', () => {
    expect(isLocalInstanceEndpoint('http://localhost:1234/v1')).toBe(true);
    expect(isLocalInstanceEndpoint('http://127.0.0.1:11434')).toBe(true);
    expect(isLocalInstanceEndpoint('http://127.5.5.5:8080/v1/')).toBe(true);
    expect(isLocalInstanceEndpoint('http://0.0.0.0:1234/v1')).toBe(true);
    expect(isLocalInstanceEndpoint('http://[::1]:1234/v1')).toBe(true);
  });

  it('rejects another machine, a public API, and anything unparseable', () => {
    expect(isLocalInstanceEndpoint('http://192.0.2.10:1234/v1')).toBe(false);
    expect(isLocalInstanceEndpoint('http://nas.example.com:11434/v1')).toBe(false);
    expect(isLocalInstanceEndpoint('https://api.openai.com/v1')).toBe(false);
    expect(isLocalInstanceEndpoint('localhost:1234')).toBe(false); // no scheme — not a URL
    expect(isLocalInstanceEndpoint('')).toBe(false);
    expect(isLocalInstanceEndpoint(null)).toBe(false);
  });
});

describe('localRuntimeKind', () => {
  it('reads the explicit backing markers first', () => {
    expect(localRuntimeKind({ command: 'opencode', llamaBacked: true })).toBe('llama');
    expect(localRuntimeKind({ command: 'opencode', mtplxBacked: true })).toBe('mtplx');
    expect(localRuntimeKind({ command: 'opencode', vllmBacked: true })).toBe('vllm');
    expect(localRuntimeKind({ command: 'opencode', sglangBacked: true })).toBe('sglang');
    expect(localRuntimeKind({ command: 'opencode', ollamaBacked: true })).toBe('ollama');
    // claude-ollama is not an OpenCode provider but is still Ollama-backed.
    expect(localRuntimeKind({ command: 'claude', ollamaBacked: true })).toBe('ollama');
  });

  it('treats OrcaRouter as remote, not a local daemon', () => {
    expect(localRuntimeKind({ command: 'opencode', orcarouterBacked: true })).toBeNull();
  });

  it('falls back to the endpoint/name heuristic for plain API providers', () => {
    expect(localRuntimeKind({ type: 'api', id: 'ollama', endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://localhost:1234/v1' })).toBe('lmstudio');
    expect(localRuntimeKind({ type: 'api', id: 'x', name: 'LM Studio local' })).toBe('lmstudio');
  });

  it('does NOT claim a peer machine daemon as a local runtime', () => {
    // A provider pointed at another box on the LAN/tailnet used to match on the
    // bare port, so the card offered to install Ollama HERE for a daemon that
    // lives — and may simply be switched off — over there.
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://192.0.2.10:11434/v1' })).toBeNull();
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://192.0.2.10:1234/v1' })).toBeNull();
    // Every loopback / bind-all spelling still resolves.
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://0.0.0.0:1234' })).toBe('lmstudio');
    expect(localRuntimeKind({ type: 'api', id: 'x', endpoint: 'http://[::1]:1234/v1' })).toBe('lmstudio');
  });

  it('returns null for a remote provider and for junk input', () => {
    expect(localRuntimeKind({ type: 'api', id: 'openai', endpoint: 'https://api.openai.com/v1' })).toBeNull();
    expect(localRuntimeKind(null)).toBeNull();
    expect(localRuntimeKind('nope')).toBeNull();
  });

  it('recognizes Slotstream by id, name, and dedicated port — never 11434', () => {
    expect(localRuntimeKind({ id: 'slotstream' })).toBe('slotstream');
    expect(localRuntimeKind({ name: 'Slotstream (local)' })).toBe('slotstream');
    expect(localRuntimeKind({ endpoint: `http://127.0.0.1:${PORTS.SLOTSTREAM}/v1` })).toBe('slotstream');
    expect(localRuntimeKind({ endpoint: 'http://127.0.0.1:11434/v1' })).toBe('ollama');
  });
});

describe('localRuntimeForProvider', () => {
  it('prefers the baseURL the provider itself declares over the canonical default', () => {
    const runtime = localRuntimeForProvider({
      id: 'opencode-llama-tui',
      command: 'opencode',
      llamaBacked: true,
      endpoint: 'http://127.0.0.1:8080/v1',
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfig('llama', 'http://127.0.0.1:8090/v1') },
    });
    expect(runtime.kind).toBe('llama');
    expect(runtime.label).toBe('llama.cpp');
    expect(runtime.command).toBe('llama-server');
    expect(runtime.endpoint).toBe('http://127.0.0.1:8090/v1');
    expect(runtime.manageUrl).toBe('/models/llms');
  });

  it('falls back to the provider endpoint when the stored OpenCode config is unparseable', () => {
    const runtime = localRuntimeForProvider({
      command: 'opencode',
      llamaBacked: true,
      endpoint: 'http://127.0.0.1:8081/v1',
      envVars: { OPENCODE_CONFIG_CONTENT: '{not json' },
    });
    expect(runtime.endpoint).toBe('http://127.0.0.1:8081/v1');
  });

  it('falls back to the canonical default when the provider declares no endpoint at all', () => {
    const runtime = localRuntimeForProvider({ command: 'opencode', ollamaBacked: true, envVars: {} });
    expect(runtime.endpoint).toBe(LOCAL_RUNTIMES.ollama.defaultBaseUrl);
  });

  it('reads the Claude Ollama wrapper base URL out of ANTHROPIC_BASE_URL', () => {
    const runtime = localRuntimeForProvider({
      command: 'claude',
      ollamaBacked: true,
      envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11500' },
    });
    expect(runtime.endpoint).toBe('http://localhost:11500/v1');
  });

  it('ignores a foreign namespace in the stored OpenCode config', () => {
    // A config that only declares `ollama` says nothing about where this
    // llama-backed provider points — using its baseURL would probe Ollama and
    // report the wrong daemon as the missing requirement.
    const runtime = localRuntimeForProvider({
      command: 'opencode',
      llamaBacked: true,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfig('ollama', 'http://localhost:11434/v1') },
    });
    expect(runtime.endpoint).toBe(LOCAL_RUNTIMES.llama.defaultBaseUrl);
  });

  it('returns null for providers with no local dependency', () => {
    expect(localRuntimeForProvider({ command: 'claude', type: 'cli' })).toBeNull();
  });

  it('returns null for an API provider whose endpoint lives on ANOTHER machine', () => {
    // The name matches `lmstudio`, so the card used to report THIS host's
    // install state — "`lms` is on PortOS's PATH", "start LM Studio from
    // Models → LLMs" — for a server PortOS neither runs nor can start.
    expect(localRuntimeForProvider({
      type: 'api',
      id: 'lmstudio-peer',
      name: 'LM Studio peer',
      endpoint: 'http://192.0.2.10:1234/v1',
    })).toBeNull();
    // Same for the authoritative `*Backed` markers and for an OpenCode config
    // that points its namespace at a peer.
    expect(localRuntimeForProvider({
      command: 'claude',
      ollamaBacked: true,
      envVars: { ANTHROPIC_BASE_URL: 'http://192.0.2.10:11434' },
    })).toBeNull();
    expect(localRuntimeForProvider({
      command: 'opencode',
      llamaBacked: true,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfig('llama', 'http://192.0.2.10:8080/v1') },
    })).toBeNull();
  });

  it('returns null when the env override the managers read points off-box', () => {
    // OLLAMA_HOST on another machine means no local daemon to install here.
    vi.stubEnv('OLLAMA_HOST', '192.0.2.10:11434');
    expect(localRuntimeForProvider({ command: 'opencode', ollamaBacked: true, envVars: {} })).toBeNull();
  });

  it('takes the canonical default from the OpenCode provider table, not a second copy', () => {
    // These are the base URLs a spawned OpenCode actually talks to; probing a
    // hand-typed duplicate would eventually check a port nothing is on.
    expect(LOCAL_RUNTIMES.llama.defaultBaseUrl).toBe(opencodeLocalBaseUrl('llama'));
    expect(LOCAL_RUNTIMES.ollama.defaultBaseUrl).toBe(opencodeLocalBaseUrl('ollama'));
    expect(LOCAL_RUNTIMES.mtplx.defaultBaseUrl).toBe(opencodeLocalBaseUrl('mtplx'));
    expect(LOCAL_RUNTIMES.vllm.defaultBaseUrl).toBe(opencodeLocalBaseUrl('vllm'));
    expect(LOCAL_RUNTIMES.slotstream.defaultBaseUrl).toBe(`http://127.0.0.1:${PORTS.SLOTSTREAM}/v1`);
    expect(LOCAL_RUNTIMES.slotstream.defaultBaseUrl).not.toMatch(/11434/);
  });

  it('honors the env override the backend managers themselves read', () => {
    // A user who relocated Ollama via OLLAMA_HOST reaches it fine everywhere
    // else in PortOS; the card must not answer "not responding — install it".
    vi.stubEnv('OLLAMA_HOST', 'localhost:11500');
    const runtime = localRuntimeForProvider({ command: 'opencode', ollamaBacked: true, envVars: {} });
    // Bare `host:port` is Ollama's own convention — the scheme is added here.
    expect(runtime.endpoint).toBe('http://localhost:11500/v1');
  });

  it('lets the provider config win over the env override', () => {
    vi.stubEnv('OLLAMA_HOST', 'localhost:11500');
    const runtime = localRuntimeForProvider({
      command: 'opencode',
      ollamaBacked: true,
      envVars: { OPENCODE_CONFIG_CONTENT: opencodeConfig('ollama', 'http://localhost:11600/v1') },
    });
    expect(runtime.endpoint).toBe('http://localhost:11600/v1');
  });
});

describe('localBackendForProvider', () => {
  // Moved here from services/localModelHealing.js, which now re-exports it —
  // these cases pin the behavior its healing path depends on.
  it('matches by id, name, and local endpoint port', () => {
    expect(localBackendForProvider({ id: 'ollama' })).toBe('ollama');
    expect(localBackendForProvider({ name: 'My Ollama' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(localBackendForProvider({ id: 'lmstudio' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'lm-studio' })).toBe('lmstudio');
    expect(localBackendForProvider({ endpoint: 'http://127.0.0.1:1234/v1' })).toBe('lmstudio');
  });

  it('declines a remote host, an unknown port, and junk', () => {
    expect(localBackendForProvider({ endpoint: 'http://192.0.2.10:11434/v1' })).toBeNull();
    expect(localBackendForProvider({ endpoint: 'http://localhost:9999' })).toBeNull();
    expect(localBackendForProvider({ id: 'anthropic', endpoint: 'https://api.anthropic.com/v1' })).toBeNull();
    expect(localBackendForProvider(null)).toBeNull();
  });
});
