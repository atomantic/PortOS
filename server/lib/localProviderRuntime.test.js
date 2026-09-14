import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  LOCAL_RUNTIMES,
  isLocalInstanceEndpoint,
  localRuntimeForProvider,
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
    expect(LOCAL_RUNTIMES.lmstudio.defaultBaseUrl).toBe(opencodeLocalBaseUrl('lmstudio'));
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

  // #6466 — before the id-based fallback, `localRuntimeKind` had no answer for
  // the bare API record, so this returned null and the shipped provider got no
  // readiness checklist at all.
  it('resolves the shipped mtplx API record — no command, no marker', () => {
    const runtime = localRuntimeForProvider({ id: 'mtplx', type: 'api', endpoint: 'http://127.0.0.1:8000/v1' });
    expect(runtime.kind).toBe('mtplx');
    expect(runtime.label).toBe('MTPLX');
    expect(runtime.endpoint).toBe('http://127.0.0.1:8000/v1');
  });
});
