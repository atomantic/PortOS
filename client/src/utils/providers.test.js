import { describe, it, expect } from 'vitest';
import {
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  CODEX_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  providerDisplayName,
  assignmentProviderOptions,
  assignmentModelOptions,
  assignmentDefaultModel,
  PROVIDER_TYPES,
  filterSelectableModels,
  filterGenerationModels,
  isEmbeddingModel,
  isVisionModel,
  visionLocalModelFilter,
  isToolUseModel,
  toolUseLocalModelFilter,
  localToolUseHint,
  withToolUseOptionLabel,
  localBackendForProvider,
  knownProviderContextWindow,
  CODEX_CONTEXT_WINDOW,
  GEMINI_CONTEXT_WINDOW,
  GROK_CONTEXT_WINDOW,
  KIMI_CONTEXT_WINDOW,
  KIMI_CONFIGURED_DEFAULT,
  effectiveModelContextWindow,
  mergeModelLists,
  modelOptionLabel,
  isTuiProvider,
  isCliProvider,
  isApiProvider,
  isProcessProvider,
  isOllamaBackedProvider,
  isGrokBuildCli,
  isKimiProvider,
  isConfiguredDefaultModel,
  isLocalEndpoint,
  enabledApiProviderFilter,
  providerTypeClass,
  getProviderTimeout,
} from './providers.js';
import { PROVIDER_TYPES as SERVER_PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';

describe('PROVIDER_TYPES', () => {
  it('exposes the three provider-type values', () => {
    expect(PROVIDER_TYPES).toEqual({ CLI: 'cli', TUI: 'tui', API: 'api' });
  });

  // The client mirror exists because aiToolkit is server-only (the directory is
  // kept self-contained for upstream sync hygiene). A drift here would let one
  // side read a provider type the other doesn't recognize.
  it('matches the server-side enum (mirror must stay in lockstep)', () => {
    expect({ ...PROVIDER_TYPES }).toEqual({ ...SERVER_PROVIDER_TYPES });
  });

  it('is frozen so callers cannot mutate the shared enum', () => {
    expect(Object.isFrozen(PROVIDER_TYPES)).toBe(true);
    expect(Object.isFrozen(SERVER_PROVIDER_TYPES)).toBe(true);
  });
});

describe('filterSelectableModels', () => {
  it('drops configured-default sentinels', () => {
    expect(filterSelectableModels([
      'gpt-4',
      CODEX_CONFIGURED_DEFAULT,
      ANTIGRAVITY_CONFIGURED_DEFAULT,
      GROK_CONFIGURED_DEFAULT,
      'gpt-5',
    ])).toEqual(['gpt-4', 'gpt-5']);
  });

  it('returns an empty array for null/undefined input', () => {
    expect(filterSelectableModels(null)).toEqual([]);
    expect(filterSelectableModels(undefined)).toEqual([]);
  });

  it('passes lists through unchanged when no sentinel present', () => {
    expect(filterSelectableModels(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('provider type predicates', () => {
  const tui = { type: 'tui' };
  const cli = { type: 'cli' };
  const api = { type: 'api' };

  it('isTuiProvider matches only tui providers', () => {
    expect(isTuiProvider(tui)).toBe(true);
    expect(isTuiProvider(cli)).toBe(false);
    expect(isTuiProvider(api)).toBe(false);
  });

  it('isCliProvider matches only cli providers', () => {
    expect(isCliProvider(cli)).toBe(true);
    expect(isCliProvider(tui)).toBe(false);
    expect(isCliProvider(api)).toBe(false);
  });

  it('isApiProvider matches only api providers', () => {
    expect(isApiProvider(api)).toBe(true);
    expect(isApiProvider(cli)).toBe(false);
    expect(isApiProvider(tui)).toBe(false);
  });

  it('isProcessProvider matches cli and tui but not api', () => {
    expect(isProcessProvider(cli)).toBe(true);
    expect(isProcessProvider(tui)).toBe(true);
    expect(isProcessProvider(api)).toBe(false);
  });

  it('isOllamaBackedProvider matches the marker or an Ollama base URL', () => {
    // explicit marker (Claude Ollama CLI + TUI samples carry this)
    expect(isOllamaBackedProvider({ type: 'tui', ollamaBacked: true })).toBe(true);
    expect(isOllamaBackedProvider({ type: 'cli', ollamaBacked: true })).toBe(true);
    // inferred from ANTHROPIC_BASE_URL (port 11434 or "ollama" host)
    expect(isOllamaBackedProvider({ envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' } })).toBe(true);
    expect(isOllamaBackedProvider({ envVars: { ANTHROPIC_BASE_URL: 'http://my-ollama:1234' } })).toBe(true);
    // the built-in `ollama` API provider itself (endpoint carries the daemon
    // URL, not envVars) — id match regardless of endpoint/envVars shape
    expect(isOllamaBackedProvider({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' })).toBe(true);
    // any other api-type provider whose endpoint points at Ollama
    expect(isOllamaBackedProvider({ id: 'local-llm', type: 'api', endpoint: 'http://192.168.1.5:11434/v1' })).toBe(true);
    expect(isOllamaBackedProvider({ id: 'renamed', type: 'api', endpoint: 'https://my-ollama-box.example.com/v1' })).toBe(true);
    // plain claude TUI / cloud providers are NOT ollama-backed
    expect(isOllamaBackedProvider({ type: 'tui', command: 'claude' })).toBe(false);
    expect(isOllamaBackedProvider({ type: 'cli', command: 'claude', envVars: {} })).toBe(false);
    expect(isOllamaBackedProvider({ id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com' })).toBe(false);
    expect(isOllamaBackedProvider(null)).toBe(false);
  });

  it('all predicates safely return false for nullish input', () => {
    expect(isTuiProvider(null)).toBe(false);
    expect(isTuiProvider(undefined)).toBe(false);
    expect(isCliProvider(null)).toBe(false);
    expect(isApiProvider(null)).toBe(false);
    expect(isApiProvider(undefined)).toBe(false);
    expect(isProcessProvider(null)).toBe(false);
    expect(isOllamaBackedProvider(undefined)).toBe(false);
  });
});

describe('isLocalEndpoint', () => {
  it('matches loopback endpoints regardless of scheme/port/path', () => {
    expect(isLocalEndpoint('http://localhost:11434')).toBe(true);
    expect(isLocalEndpoint('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalEndpoint('https://[::1]:8080')).toBe(true);
    expect(isLocalEndpoint('localhost:11434')).toBe(true);
  });

  it('rejects hosted endpoints and non-strings', () => {
    expect(isLocalEndpoint('https://api.cerebras.ai/v1')).toBe(false);
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
    // "localhost" as a subdomain of a remote host must not count as local.
    expect(isLocalEndpoint('https://localhost.evil.com/v1')).toBe(false);
    expect(isLocalEndpoint('')).toBe(false);
    expect(isLocalEndpoint(undefined)).toBe(false);
  });
});

describe('isGrokBuildCli', () => {
  it('matches the shipped grok-cli / grok-tui samples', () => {
    expect(isGrokBuildCli({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(true);
    expect(isGrokBuildCli({ id: 'grok-tui', type: 'tui', command: 'grok' })).toBe(true);
  });

  it('matches any process provider whose command basename is grok', () => {
    expect(isGrokBuildCli({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/grok' })).toBe(true);
  });

  it('does not match the plain grok API provider (no harness upload)', () => {
    expect(isGrokBuildCli({ id: 'grok', type: 'api', command: '' })).toBe(false);
  });

  it('does not match non-grok process providers', () => {
    expect(isGrokBuildCli({ id: 'codex', type: 'cli', command: 'codex' })).toBe(false);
  });

  it('safely returns false for nullish input', () => {
    expect(isGrokBuildCli(null)).toBe(false);
    expect(isGrokBuildCli(undefined)).toBe(false);
  });
});

describe('enabledApiProviderFilter', () => {
  it('keeps only enabled api providers', () => {
    const list = [
      { type: 'api', enabled: true, id: 'a' },
      { type: 'api', enabled: false, id: 'b' },
      { type: 'cli', enabled: true, id: 'c' },
      { type: 'tui', enabled: true, id: 'd' },
    ];
    expect(list.filter(enabledApiProviderFilter).map(p => p.id)).toEqual(['a']);
  });

  it('safely rejects nullish entries', () => {
    expect(enabledApiProviderFilter(null)).toBe(false);
    expect(enabledApiProviderFilter(undefined)).toBe(false);
  });
});

describe('providerTypeClass', () => {
  it('returns blue chip for cli', () => {
    expect(providerTypeClass('cli')).toBe('bg-blue-500/20 text-blue-400');
  });

  it('returns emerald chip for tui', () => {
    expect(providerTypeClass('tui')).toBe('bg-emerald-500/20 text-emerald-400');
  });

  it('falls back to purple chip for api/unknown', () => {
    expect(providerTypeClass('api')).toBe('bg-purple-500/20 text-purple-400');
    expect(providerTypeClass('mystery')).toBe('bg-purple-500/20 text-purple-400');
  });
});

describe('getProviderTimeout', () => {
  const providers = [
    { id: 'p1', timeout: 300000 },
    { id: 'p2', timeout: 900000 },
    { id: 'p3' /* no timeout */ },
  ];

  it('returns the stage-pinned provider timeout when it wins over active', () => {
    expect(getProviderTimeout(providers, 'p2', 'p1')).toBe(900000);
  });

  it('falls back to the active provider timeout when no stage pin', () => {
    expect(getProviderTimeout(providers, null, 'p1')).toBe(300000);
    expect(getProviderTimeout(providers, undefined, 'p1')).toBe(300000);
    expect(getProviderTimeout(providers, '', 'p1')).toBe(300000);
  });

  it('returns undefined when neither pinned nor active id is given', () => {
    expect(getProviderTimeout(providers, null, null)).toBeUndefined();
  });

  it('returns undefined when the matched provider has no timeout', () => {
    expect(getProviderTimeout(providers, 'p3', null)).toBeUndefined();
  });

  it('returns undefined when the id matches no provider in the list', () => {
    expect(getProviderTimeout(providers, 'ghost', 'also-ghost')).toBeUndefined();
  });
});

describe('isEmbeddingModel / filterGenerationModels', () => {
  it('flags embedding models and not chat models', () => {
    expect(isEmbeddingModel('nomic-embed-text:latest')).toBe(true);
    expect(isEmbeddingModel('mxbai-embed-large')).toBe(true);
    expect(isEmbeddingModel('qwen3.6:35b')).toBe(false);
    expect(isEmbeddingModel('')).toBe(false);
  });

  it('drops sentinels and embedding models from generation lists', () => {
    expect(filterGenerationModels([
      CODEX_CONFIGURED_DEFAULT,
      'nomic-embed-text:latest',
      'qwen3.6:35b',
      'llama3.2:latest',
    ])).toEqual(['qwen3.6:35b', 'llama3.2:latest']);
  });
});

describe('isVisionModel (mirror of server localModelHeuristics)', () => {
  it('flags known vision model ids', () => {
    for (const id of [
      'qwen2.5-vl:7b', 'qwen2.5vl', 'qwen2.5vl:32b', 'llava:latest', 'moondream:latest', 'minicpm-v:8b',
      'llama3.2-vision:11b', 'pixtral-12b', 'gemma3:4b', 'internvl2:8b', 'glm-4v:9b',
    ]) {
      expect(isVisionModel(id), id).toBe(true);
    }
  });

  it('does not flag text-only models or non-strings', () => {
    for (const id of ['llama3.1:8b', 'qwen2.5:7b', 'gpt-oss:20b', '']) {
      expect(isVisionModel(id), id).toBe(false);
    }
    expect(isVisionModel(null)).toBe(false);
  });
});

describe('isToolUseModel (mirror of server localModelHeuristics)', () => {
  it('flags known tool-use-capable model ids', () => {
    for (const id of [
      'qwen2.5:7b', 'qwen3:32b', 'llama3.1:8b', 'llama3.3:70b',
      'mistral-small:24b', 'mixtral:8x7b', 'command-r:35b', 'hermes3:8b', 'glm-4:9b', 'gpt-oss:20b',
    ]) {
      expect(isToolUseModel(id), id).toBe(true);
    }
  });

  it('does not flag non-tool families or non-strings', () => {
    for (const id of ['llama3:8b', 'gemma2:9b', 'phi3:mini', 'nomic-embed-text', '']) {
      expect(isToolUseModel(id), id).toBe(false);
    }
    expect(isToolUseModel(null)).toBe(false);
  });
});

describe('toolUseLocalModelFilter', () => {
  it('restricts local backends to tool-use models', () => {
    const ollama = { name: 'Ollama', endpoint: 'http://localhost:11434/v1' };
    expect(toolUseLocalModelFilter('qwen2.5:7b', ollama)).toBe(true);
    expect(toolUseLocalModelFilter('gemma2:9b', ollama)).toBe(false);
  });

  it('leaves cloud/CLI providers untouched', () => {
    const cloud = { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };
    expect(toolUseLocalModelFilter('gpt-4o', cloud)).toBe(true);
    expect(toolUseLocalModelFilter('anything', undefined)).toBe(true);
  });
});

describe('localToolUseHint', () => {
  const ollama = { name: 'Ollama', endpoint: 'http://localhost:11434/v1' };

  it('flags a local tool-capable model', () => {
    expect(localToolUseHint('qwen3.6:35b', ollama)).toEqual({ toolCapable: true });
  });

  it('flags a local non-tool model (Gemma narrates instead of acting)', () => {
    expect(localToolUseHint('gemma4:e4b', ollama)).toEqual({ toolCapable: false });
    expect(localToolUseHint('gemma2:9b', ollama)).toEqual({ toolCapable: false });
  });

  it('returns null for cloud providers (their ids do not encode family)', () => {
    const cloud = { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };
    expect(localToolUseHint('gpt-4o', cloud)).toBeNull();
    expect(localToolUseHint('gemma4:e4b', undefined)).toBeNull();
  });

  it('flags a renamed Ollama-backed CLI/TUI wrapper (no "ollama" name/endpoint)', () => {
    // The incident's provider class: a claude-ollama-tui wrapper the user renamed,
    // so localBackendForProvider misses it — but it still carries ollamaBacked.
    const wrapper = { id: 'my-local-agent', name: 'My Local Agent', ollamaBacked: true };
    expect(localToolUseHint('gemma4:e4b', wrapper)).toEqual({ toolCapable: false });
    expect(localToolUseHint('qwen3.6:35b', wrapper)).toEqual({ toolCapable: true });
    // Also via ANTHROPIC_BASE_URL pointing at the Ollama daemon.
    const viaBase = { name: 'Renamed', envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434/v1' } };
    expect(localToolUseHint('gemma4:e4b', viaBase)).toEqual({ toolCapable: false });
  });

  it('returns null for a blank id', () => {
    expect(localToolUseHint('', ollama)).toBeNull();
  });
});

describe('withToolUseOptionLabel', () => {
  const ollama = { name: 'Ollama', endpoint: 'http://localhost:11434/v1' };

  it('marks recognized-tool vs unrecognized local models', () => {
    expect(withToolUseOptionLabel('qwen3.6:35b', 'qwen3.6:35b', ollama)).toBe('qwen3.6:35b · 🔧 tool use');
    // Non-match is worded as unverified, not a false-certain negative — the id
    // regex is a positive allowlist, so a miss only means "not recognized".
    expect(withToolUseOptionLabel('gemma4:e4b', 'gemma4:e4b', ollama)).toBe('gemma4:e4b · ⚠ no known tool use');
  });

  it('leaves cloud provider labels unchanged', () => {
    const cloud = { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };
    expect(withToolUseOptionLabel('gpt-4o', 'GPT-4o', cloud)).toBe('GPT-4o');
  });
});

describe('localBackendForProvider', () => {
  it('detects Ollama by id, endpoint, or name', () => {
    expect(localBackendForProvider({ id: 'ollama' })).toBe('ollama');
    expect(localBackendForProvider({ endpoint: 'http://localhost:11434/v1' })).toBe('ollama');
    expect(localBackendForProvider({ name: 'Ollama' })).toBe('ollama');
  });

  it('detects LM Studio by id, endpoint, or name', () => {
    expect(localBackendForProvider({ id: 'lmstudio' })).toBe('lmstudio');
    expect(localBackendForProvider({ endpoint: 'http://localhost:1234/v1' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'LM Studio' })).toBe('lmstudio');
    expect(localBackendForProvider({ name: 'lm-studio' })).toBe('lmstudio');
  });

  it('returns null for cloud providers', () => {
    expect(localBackendForProvider({ endpoint: 'https://api.openai.com/v1', name: 'OpenAI' })).toBeNull();
    expect(localBackendForProvider({})).toBeNull();
    expect(localBackendForProvider(null)).toBeNull();
  });
});

describe('knownProviderContextWindow (mirror of server stageRunner)', () => {
  it('resolves vendor windows for bare commands', () => {
    expect(knownProviderContextWindow({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'antigravity-cli', type: 'cli', command: 'agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'grok-cli', type: 'cli', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'grok-tui', type: 'tui', command: 'grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'kimi-cli', type: 'cli', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'kimi-tui', type: 'tui', command: 'kimi' })).toBe(KIMI_CONTEXT_WINDOW);
  });

  it('normalizes command paths to the basename for vendor windows (#2337)', () => {
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/grok' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/kimi' })).toBe(KIMI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'tui', command: '/usr/local/bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/agy' })).toBe(GEMINI_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: './bin/codex' })).toBe(CODEX_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: 'C:\\tools\\grok.exe' })).toBe(GROK_CONTEXT_WINDOW);
    expect(knownProviderContextWindow({ id: 'custom', type: 'cli', command: '/opt/homebrew/bin/mycli' })).toBeNull();
  });

  it('returns null for non-process providers', () => {
    expect(knownProviderContextWindow({ id: 'codex', type: 'api', command: 'codex' })).toBeNull();
  });
});

describe('isKimiProvider (mirror of server providerModels)', () => {
  it('matches the shipped ids and a path/exe command, rejects others', () => {
    expect(isKimiProvider({ id: 'kimi-cli' })).toBe(true);
    expect(isKimiProvider({ id: 'kimi-tui' })).toBe(true);
    expect(isKimiProvider({ id: 'custom', command: '/opt/homebrew/bin/kimi' })).toBe(true);
    expect(isKimiProvider({ id: 'custom', command: 'C:\\tools\\Kimi.exe' })).toBe(true);
    expect(isKimiProvider({ id: 'grok-cli', command: 'grok' })).toBe(false);
    expect(isKimiProvider(null)).toBe(false);
  });

  it('treats the kimi configured-default sentinel as a configured default', () => {
    expect(isConfiguredDefaultModel(KIMI_CONFIGURED_DEFAULT)).toBe(true);
    expect(filterSelectableModels([KIMI_CONFIGURED_DEFAULT, 'kimi-k2'])).toEqual(['kimi-k2']);
  });
});

describe('effectiveModelContextWindow', () => {
  it('matches known model windows before provider defaults', () => {
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.5')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4-mini')).toBe(400_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4-nano')).toBe(128_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'claude-opus-4-8')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://api.example.test/v1' }, 'claude-sonnet-5')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://api.example.test/v1' }, 'claude-sonnet-4-6')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://api.example.test/v1' }, 'us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://api.example.test/v1' }, 'claude-haiku-4-5')).toBe(200_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://generativelanguage.googleapis.com/v1beta' }, 'gemini-2.5-pro')).toBe(1_048_576);
  });

  it('uses canonical provider windows for configured-default process providers', () => {
    expect(effectiveModelContextWindow({ id: 'codex-tui', type: 'tui', command: 'codex' }, CODEX_CONFIGURED_DEFAULT)).toBe(1_000_000);
    expect(effectiveModelContextWindow({ id: 'antigravity-cli', type: 'cli', command: 'agy' }, ANTIGRAVITY_CONFIGURED_DEFAULT)).toBe(1_048_576);
    expect(effectiveModelContextWindow({ id: 'grok-cli', type: 'cli', command: 'grok' }, GROK_CONFIGURED_DEFAULT)).toBe(256_000);
    expect(effectiveModelContextWindow({ id: 'grok-tui', type: 'tui', command: 'grok' }, GROK_CONFIGURED_DEFAULT)).toBe(256_000);
  });

  it('matches the server planner for local and cloud api defaults', () => {
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'http://localhost:8000/v1' }, 'unknown')).toBeNull();
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'http://127.0.0.1:8000/v1' }, 'unknown')).toBeNull();
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'https://api.example.test/v1' }, 'unknown')).toBe(128_000);
  });

  it('uses explicit contextWindow and numCtx with server precedence', () => {
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'http://localhost:11434/v1', contextWindow: 64_000, numCtx: 32_768 }, 'unknown')).toBe(64_000);
    expect(effectiveModelContextWindow({ type: 'api', endpoint: 'http://localhost:11434/v1', numCtx: 32_768 }, 'unknown')).toBe(32_768);
  });
});

describe('modelOptionLabel', () => {
  it('appends a context parenthetical when known', () => {
    expect(modelOptionLabel('qwen3.6:35b', { 'qwen3.6:35b': 32768 })).toBe('qwen3.6:35b (32K ctx)');
  });

  it('returns the bare id when context is unknown', () => {
    expect(modelOptionLabel('gpt-4o', {})).toBe('gpt-4o');
    expect(modelOptionLabel('gpt-4o')).toBe('gpt-4o');
    expect(modelOptionLabel('gpt-4o', { 'gpt-4o': 0 })).toBe('gpt-4o');
  });
});

describe('mergeModelLists', () => {
  it('unions lists, de-dupes, preserves order, drops falsy', () => {
    expect(mergeModelLists(['a', 'b'], ['b', 'c'], undefined, [null, 'd', '']))
      .toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns [] for no input', () => {
    expect(mergeModelLists()).toEqual([]);
    expect(mergeModelLists(undefined, null)).toEqual([]);
  });
});

describe('visionLocalModelFilter', () => {
  // `id` matters: the authoritative map is keyed by the provider id the SERVER
  // enumerated, so only these canonical ids can be vouched for.
  const ollama = { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434' };
  const lmstudio = { id: 'lmstudio', name: 'LM Studio', endpoint: 'http://localhost:1234' };
  const cloud = { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };

  it('keeps only vision models for local backends (ollama/lm studio)', () => {
    expect(visionLocalModelFilter('qwen2.5vl:32b', ollama)).toBe(true);
    expect(visionLocalModelFilter('llava:latest', lmstudio)).toBe(true);
    // Text-only / embedding local models are filtered out.
    expect(visionLocalModelFilter('qwen2.5-coder:32b', ollama)).toBe(false);
    expect(visionLocalModelFilter('nomic-embed-text', ollama)).toBe(false);
  });

  it('accepts a server-reported vision id the stale id regex does not know', () => {
    // The id regex knows `gemma-3` but not `gemma4` — without the authoritative
    // map, a user whose only VLMs are gemma4/qwen3.6 gets an empty picker.
    expect(visionLocalModelFilter('gemma4:e4b', ollama)).toBe(false);
    expect(visionLocalModelFilter('gemma4:e4b', ollama, { ollama: new Set(['gemma4:e4b']) })).toBe(true);
    expect(visionLocalModelFilter('qwen3.6:35b', ollama, { ollama: new Set(['qwen3.6:35b']) })).toBe(true);
  });

  it('unions rather than replaces — the map never vetoes a regex match', () => {
    // Fetched-but-empty (no local VLM reported) still keeps regex matches, and a
    // map that omits a model the regex knows must not hide it.
    expect(visionLocalModelFilter('llava:latest', ollama, { ollama: new Set() })).toBe(true);
    expect(visionLocalModelFilter('llava:latest', ollama, { ollama: new Set(['gemma4:e4b']) })).toBe(true);
    // ...and it still can't smuggle a text-only model past the filter.
    expect(visionLocalModelFilter('qwen2.5-coder:32b', ollama, { ollama: new Set(['gemma4:e4b']) })).toBe(false);
  });

  it('scopes capabilities to the enumerated provider — an id is not a capability', () => {
    // The same id can be a VLM on one backend and text-only on another; a flat
    // set would mark it eligible for either. LM Studio says it's vision; Ollama
    // never reported it, so on Ollama only the regex may speak (and it says no).
    const lmOnly = { ollama: new Set(), lmstudio: new Set(['shared-id:latest']) };
    expect(visionLocalModelFilter('shared-id:latest', lmstudio, lmOnly)).toBe(true);
    expect(visionLocalModelFilter('shared-id:latest', ollama, lmOnly)).toBe(false);
  });

  it('does not vouch for a custom provider pointed at a host the server never enumerated', () => {
    // A custom provider at a REMOTE ollama resolves to the ollama backend, but
    // the local /vision-models result says nothing about that host — so a local
    // VLM's id must not make a same-named remote model "vision".
    const remote = { id: 'ollama-udev', name: 'Ollama (udev)', endpoint: 'http://udev:11434' };
    const localOnly = { ollama: new Set(['gemma4:e4b']) };
    expect(visionLocalModelFilter('gemma4:e4b', ollama, localOnly)).toBe(true);
    expect(visionLocalModelFilter('gemma4:e4b', remote, localOnly)).toBe(false);
  });

  it('leaves cloud providers untouched regardless of the authoritative map', () => {
    expect(visionLocalModelFilter('gpt-4o', cloud, { ollama: new Set() })).toBe(true);
  });

  it('leaves cloud/API providers untouched (multimodal ids that miss the local regex pass)', () => {
    // gpt-4o / claude are multimodal but their ids do not encode "vision";
    // a local-name heuristic must NOT hide them on a cloud provider.
    expect(visionLocalModelFilter('gpt-4o', cloud)).toBe(true);
    expect(visionLocalModelFilter('claude-opus-4-8', cloud)).toBe(true);
  });

  it('treats an unknown/undefined provider as non-local (no filtering)', () => {
    expect(visionLocalModelFilter('some-text-model', undefined)).toBe(true);
  });
});

describe('AI Assignments option helpers', () => {
  const providers = [
    { id: 'agent-a', name: 'Agent A', type: 'cli', enabled: true, models: ['a-1', 'a-2'] },
    { id: 'vlm-x', name: 'VLM X', type: 'api', enabled: false, models: ['llava'] },
    {
      id: 'ollama',
      name: 'Ollama',
      type: 'api',
      enabled: true,
      defaultModel: 'gemma4:26b',
      models: ['qwen2.5vl:latest', 'llava:latest', 'gemma4:26b', 'llama3.2:latest', 'nomic-embed-text'],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'api',
      enabled: true,
      defaultModel: 'gpt-4o',
      models: ['gpt-4o', 'gpt-4.1', 'o3-mini'],
    },
  ];

  it('providerDisplayName resolves name, then id, then fallback', () => {
    expect(providerDisplayName(providers, 'agent-a')).toBe('Agent A');
    expect(providerDisplayName(providers, 'ghost')).toBe('ghost');
    expect(providerDisplayName(providers, '', 'Default')).toBe('Default');
    expect(providerDisplayName(providers, '')).toBe('');
  });

  it('assignmentProviderOptions filters by providerTypes and flags disabled', () => {
    expect(assignmentProviderOptions({ providerTypes: ['api'] }, providers))
      .toEqual([
        { id: 'vlm-x', name: 'VLM X (disabled)' },
        { id: 'ollama', name: 'Ollama' },
        { id: 'openai', name: 'OpenAI' },
      ]);
    // No providerTypes → all providers.
    expect(assignmentProviderOptions({}, providers).map((p) => p.id))
      .toEqual(['agent-a', 'vlm-x', 'ollama', 'openai']);
  });

  it('assignmentProviderOptions honors a pre-baked providerOptions override', () => {
    const baked = [{ id: 'x', name: 'X' }];
    expect(assignmentProviderOptions({ providerOptions: baked }, providers)).toBe(baked);
  });

  it('assignmentModelOptions returns the selected provider models, else empty', () => {
    expect(assignmentModelOptions({}, providers, 'agent-a')).toEqual(['a-1', 'a-2']);
    expect(assignmentModelOptions({}, providers, 'ghost')).toEqual([]);
    const baked = ['m'];
    expect(assignmentModelOptions({ modelOptions: baked }, providers, 'agent-a')).toEqual(baked);
  });

  it('assignmentModelOptions with modelFilter=vision keeps only VLMs on local backends', () => {
    expect(assignmentModelOptions({ modelFilter: 'vision' }, providers, 'ollama'))
      .toEqual(['qwen2.5vl:latest', 'llava:latest']);
  });

  it('assignmentModelOptions with modelFilter=vision leaves cloud model lists intact', () => {
    // gpt-4o is multimodal but its id does not encode "vision" — the local
    // heuristic must not hide cloud multimodal models.
    expect(assignmentModelOptions({ modelFilter: 'vision' }, providers, 'openai'))
      .toEqual(['gpt-4o', 'gpt-4.1', 'o3-mini']);
  });

  it('assignmentDefaultModel seeds the first VLM when the local default is text-only', () => {
    expect(assignmentDefaultModel({ modelFilter: 'vision' }, providers, 'ollama'))
      .toBe('qwen2.5vl:latest');
    // Cloud: default stays (and is in the unfiltered list).
    expect(assignmentDefaultModel({ modelFilter: 'vision' }, providers, 'openai'))
      .toBe('gpt-4o');
    // Non-vision rows still seed the provider default.
    expect(assignmentDefaultModel({}, providers, 'ollama')).toBe('gemma4:26b');
    expect(assignmentDefaultModel({}, providers, '')).toBe('');
  });
});
