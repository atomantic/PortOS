// Exercised THROUGH the `providers.js` facade on purpose: the helpers under test
// are declared across the nine `provider*` / `localModelHeuristics` modules it
// re-exports, so a helper that drops out of the facade fails here before any of
// the 69 `utils/providers` importers notices. The declaring modules re-export
// their shared tables from `server/lib`, so what is pinned here is the
// client-side behaviour built on top of them.
import { SHIPPED_PROVIDERS } from './providers.test.fixture.js';
import * as serverProviderTypes from '../../../server/lib/provider/providerTypes.js';
import { describe, it, expect } from 'vitest';
import {
  providerDisplayName,
  assignmentProviderOptions,
  assignmentModelOptions,
  assignmentDefaultModel,
  assignmentToolUseState,
  PROVIDER_TYPES,
  isTuiProvider,
  isLaunchableTuiProvider,
  isCliProvider,
  isApiProvider,
  isProcessProvider,
  providerRuntimeKey,
  credentialSource,
  providerCardState,
  isPrivateNetworkEndpoint,
  PROVIDER_CARD_STATE,
  isOllamaBackedProvider,
  gatewayForProvider,
  isGatewayBackedProvider,
  isGrokBuildCli,
  isKimiProvider,
  isCodexProvider,
  isCodexSubscriptionProvider,
  isAntigravityProvider,
  isFleetHostConfigured,
  effortLevelsForProvider,
  CURSOR_EFFORT_LEVELS,
  isLocalEndpoint,
  isLocalInstanceProvider,
  enabledApiProviderFilter,
  providerTypeClass,
  getProviderTimeout,
} from './providers.js';
import * as providerTypes from './providerTypes.js';
import * as serverProviderModels from '../../../server/lib/provider/providerModels.js';
import * as serverOllamaBacked from '../../../server/lib/aiToolkit/internal/ollamaBacked.js';
import * as serverToolkitConstants from '../../../server/lib/aiToolkit/constants.js';

// The vendor predicates and backend markers the browser classifies a record
// with are the server's own functions — identity, not behavioral parity, is the
// contract. A copy that answers the same today is exactly what let every vendor
// addition (kimi, cursor, the grok effort flag) land the same predicate twice.
// Every name the client module shares with a server leaf must be that leaf's
// export, so a local declaration that shadows a server name fails here too.
describe('providerTypes re-exports the server predicates', () => {
  const shared = [serverProviderModels, serverProviderTypes, serverOllamaBacked, serverToolkitConstants]
    .flatMap((leaf) => Object.keys(leaf).filter((name) => name in providerTypes).map((name) => [name, leaf]));

  it('shares exactly the re-exported names with the server leaves', () => {
    expect(shared.map(([name]) => name).sort()).toEqual([
      'PROVIDER_TYPES',
      'commandBasename',
      'isAntigravityProvider',
      'isApiProvider',
      'isClaudeHarnessProvider',
      'isCliProvider',
      'isCodexProvider',
      'isCodexSubscriptionProvider',
      'isCursorProvider',
      'isGrokBuildCli',
      'isGrokProvider',
      'isKimiProvider',
      'isOllamaBackedProvider',
      'isOpencodeLocalProvider',
      'isProcessProvider',
      'isTuiProvider',
      'localRuntimeNamespace',
    ]);
  });

  it('keeps the legacy Claude command alias on the type-gated server export', () => {
    expect(providerTypes.isClaudeCommandProvider).toBe(serverProviderTypes.isClaudeHarnessProvider);
  });

  it.each(shared)('%s is the server export itself', (name, leaf) => {
    expect(providerTypes[name]).toBe(leaf[name]);
  });
});

describe('PROVIDER_TYPES', () => {

  it('is frozen so callers cannot mutate the shared enum', () => {
    expect(Object.isFrozen(PROVIDER_TYPES)).toBe(true);
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

  // Shared by the Providers card's "Launch in Shell" button and the Shell page's
  // launch menu, so the two can't disagree about what is launchable.
  it('isLaunchableTuiProvider needs a TUI AND a server-resolved command line', () => {
    expect(isLaunchableTuiProvider({ ...tui, tuiCommandLine: 'claude --dangerously-skip-permissions' })).toBe(true);
    // A TUI the server resolved no command for, or an older server that omits
    // the field entirely, is not offered.
    expect(isLaunchableTuiProvider(tui)).toBe(false);
    expect(isLaunchableTuiProvider({ ...cli, tuiCommandLine: 'claude' })).toBe(false);
    expect(isLaunchableTuiProvider({ ...api, tuiCommandLine: 'x' })).toBe(false);
    expect(isLaunchableTuiProvider(null)).toBe(false);
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

  it('gatewayForProvider matches the generic marker and the legacy boolean', () => {
    // The legacy per-gateway boolean, which stored records still carry.
    expect(gatewayForProvider({ id: 'opencode-orcarouter', orcarouterBacked: true }).id).toBe('orcarouter');
    expect(gatewayForProvider({ id: 'opencode-orcarouter-tui', orcarouterBacked: true }).id).toBe('orcarouter');
    // The generic marker every new gateway wrapper ships with.
    expect(gatewayForProvider({ id: 'opencode-openrouter', gatewayBacked: 'openrouter' }).id).toBe('openrouter');
    expect(gatewayForProvider({ id: 'opencode-openrouter-tui', gatewayBacked: 'openrouter' }).label).toBe('OpenRouter');
    expect(gatewayForProvider({ id: 'opencode-nvidia-nim', gatewayBacked: 'nvidia-nim' }).id).toBe('nvidia-nim');
    expect(gatewayForProvider({ id: 'opencode-nvidia-nim-tui', gatewayBacked: 'nvidia-nim' }).label).toBe('NVIDIA NIM');
    // A renamed wrapper that keeps the marker still inherits the sibling key.
    expect(isGatewayBackedProvider({ id: 'my-orca', orcarouterBacked: true })).toBe(true);
    // The sibling API provider itself is NOT gateway-backed (it owns the key).
    expect(isGatewayBackedProvider({ id: 'orcarouter', type: 'api' })).toBe(false);
    expect(isGatewayBackedProvider({ id: 'openrouter', type: 'api' })).toBe(false);
    expect(isGatewayBackedProvider({ id: 'nvidia-nim', type: 'api' })).toBe(false);
    // An ollama-backed OpenCode wrapper shares the form shape but not the marker.
    expect(isGatewayBackedProvider({ id: 'opencode-ollama', ollamaBacked: true })).toBe(false);
    expect(isGatewayBackedProvider({ id: 'x', gatewayBacked: 'not-a-gateway' })).toBe(false);
    expect(isGatewayBackedProvider(null)).toBe(false);
    expect(isGatewayBackedProvider(undefined)).toBe(false);
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

  it('matches the whole loopback block, not just 127.0.0.1', () => {
    // A daemon on a loopback alias is as local as one on `.1`, and the server's
    // `isLocalInstanceHost` accepts the full block — while they disagreed, a
    // provider on 127.0.0.2 was badged NEEDS SETUP for a key it never needs.
    expect(isLocalEndpoint('http://127.0.0.2:11434/v1')).toBe(true);
    expect(isLocalEndpoint('http://127.5.5.5:8080')).toBe(true);
    expect(isLocalEndpoint('http://[::]:1234')).toBe(true);
    // …without letting a loopback prefix vouch for a public host.
    expect(isLocalEndpoint('http://127.0.0.1.evil.com/v1')).toBe(false);
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

describe('isLocalInstanceProvider', () => {
  it('accepts a loopback endpoint and a record that names none', () => {
    expect(isLocalInstanceProvider({ endpoint: 'http://localhost:1234/v1' })).toBe(true);
    expect(isLocalInstanceProvider({ endpoint: 'http://127.0.0.1:11434' })).toBe(true);
    // No endpoint = the stock local default every backend manager targets.
    expect(isLocalInstanceProvider({ id: 'lmstudio' })).toBe(true);
    expect(isLocalInstanceProvider({ endpoint: '  ' })).toBe(true);
  });

  it('rejects another machine, however local the provider is NAMED', () => {
    // This is the case that put "Install LM Studio" on a card for a server
    // running on a different box.
    expect(isLocalInstanceProvider({ name: 'LM Studio peer', endpoint: 'http://192.168.1.50:1234/v1' })).toBe(false);
    expect(isLocalInstanceProvider({ id: 'ollama', endpoint: 'http://10.0.0.4:11434/v1' })).toBe(false);
    expect(isLocalInstanceProvider({ endpoint: 'https://api.openai.com/v1' })).toBe(false);
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

describe('cursor providers', () => {
  it('offers the cursor effort ladder — the level rides --model, not an --effort flag', () => {
    expect(effortLevelsForProvider({ id: 'cursor-cli', command: 'cursor-agent' })).toBe(CURSOR_EFFORT_LEVELS);
    expect(effortLevelsForProvider({ id: 'cursor-tui', command: 'cursor-agent' }, 'claude-opus-5-thinking-high')).toBe(
      CURSOR_EFFORT_LEVELS,
    );
    // The GUI editor launcher is not the agent binary, so it keeps no ladder.
    expect(effortLevelsForProvider({ id: 'custom', command: 'cursor' })).toBeNull();
  });

  it('is not mistaken for a claude/codex/antigravity provider by its model ids', () => {
    const cursor = { id: 'cursor-cli', command: 'cursor-agent', models: ['claude-opus-5-thinking-high'] };
    expect(isCodexProvider(cursor)).toBe(false);
    expect(isAntigravityProvider(cursor)).toBe(false);
    expect(isKimiProvider(cursor)).toBe(false);
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
      defaultModel: 'granite4.1:8b',
      models: ['qwen2.5vl:latest', 'llava:latest', 'granite4.1:8b', 'llama3.2:latest', 'nomic-embed-text'],
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
        { id: 'vlm-x', name: 'VLM X (disabled)', enabled: false },
        { id: 'ollama', name: 'Ollama', enabled: true },
        { id: 'openai', name: 'OpenAI', enabled: true },
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
    expect(assignmentDefaultModel({}, providers, 'ollama')).toBe('granite4.1:8b');
    expect(assignmentDefaultModel({}, providers, '')).toBe('');
  });

  describe('assignmentToolUseState', () => {
    const ollama = providers.find((p) => p.id === 'ollama');
    const openai = providers.find((p) => p.id === 'openai');
    const agentEntry = { needsTools: true };

    it('flags a needsTools row on a local model with no recognized tool use', () => {
      expect(assignmentToolUseState(agentEntry, ollama, 'llava:latest', null, true))
        .toEqual({ annotate: true, effectiveModel: 'llava:latest', incapable: true });
    });

    it('clears once the model is recognized, by regex or by the backend', () => {
      expect(assignmentToolUseState(agentEntry, ollama, 'llama3.2:latest', null, true).incapable).toBe(false);
      // Authoritative map wins for an id the regex does not know.
      const ids = { ollama: new Set(['llava:latest']) };
      expect(assignmentToolUseState(agentEntry, ollama, 'llava:latest', ids, true).incapable).toBe(false);
    });

    it('judges the EFFECTIVE model, so a blank pin resolves the provider default', () => {
      // granite4.1 IS a recognized tool-caller, so a blank pin on ollama is clean…
      expect(assignmentToolUseState(agentEntry, ollama, '', null, true))
        .toEqual({ annotate: true, effectiveModel: 'granite4.1:8b', incapable: false });
      // …while a provider whose default is not gets flagged on the same blank pin.
      const textOnly = { id: 'ollama', name: 'Ollama', defaultModel: 'llava:latest' };
      expect(assignmentToolUseState(agentEntry, textOnly, '', null, true))
        .toEqual({ annotate: true, effectiveModel: 'llava:latest', incapable: true });
    });

    it('asserts nothing until the capability scan settles', () => {
      expect(assignmentToolUseState(agentEntry, ollama, 'llava:latest', null, false))
        .toEqual({ annotate: false, effectiveModel: 'llava:latest', incapable: false });
    });

    it('stays silent for a non-agent entry, a cloud provider, or an unpinned row', () => {
      // The server did not mark this assignment — same model, no warning.
      expect(assignmentToolUseState({ modelFilter: 'vision' }, ollama, 'llava:latest', null, true).incapable).toBe(false);
      expect(assignmentToolUseState(undefined, ollama, 'llava:latest', null, true).incapable).toBe(false);
      // Cloud ids do not encode their family, so they are never judged.
      expect(assignmentToolUseState(agentEntry, openai, 'gpt-4.1', null, true).incapable).toBe(false);
      expect(assignmentToolUseState(agentEntry, undefined, '', null, true))
        .toEqual({ annotate: true, effectiveModel: '', incapable: false });
    });

    it('flags an ollama-BACKED wrapper whose id and name say nothing about ollama', () => {
      // Only the server-resolved `ollamaBacked` flag identifies it — the exact
      // provider class the tool-use warning exists for.
      const wrapper = { id: 'local-agent', name: 'Local Agent', ollamaBacked: true, defaultModel: 'llava:latest' };
      expect(assignmentToolUseState(agentEntry, wrapper, '', null, true).incapable).toBe(true);
      // Without the flag it reads as a cloud CLI and is left alone.
      expect(assignmentToolUseState(agentEntry, { ...wrapper, ollamaBacked: false }, '', null, true).incapable).toBe(false);
    });
  });
});

describe('providerRuntimeKey', () => {
  // The key is what a provider card looks its runtime up by in the server's
  // `runtimes` map, so a path-qualified or Windows command must normalize to
  // the same bare binary name the server publishes.
  it('normalizes a process provider command to its bare binary name', () => {
    expect(providerRuntimeKey({ type: 'cli', command: 'codex' })).toBe('codex');
    expect(providerRuntimeKey({ type: 'tui', command: '/opt/homebrew/bin/opencode' })).toBe('opencode');
    expect(providerRuntimeKey({ type: 'cli', command: 'C:\\tools\\claude.exe' })).toBe('claude');
    expect(providerRuntimeKey({ type: 'cli', command: '  agy  ' })).toBe('agy');
  });

  // API providers have no CLI runtime — the two fronted by a local app resolve
  // through localBackendForProvider instead, so this must not claim a key for
  // every cloud provider id.
  it('has no runtime key for an API provider', () => {
    expect(providerRuntimeKey({ type: 'api', id: 'lmstudio', endpoint: 'http://localhost:1234/v1' })).toBeNull();
    expect(providerRuntimeKey({ type: 'api', id: 'cerebras' })).toBeNull();
  });

  it('returns null when there is nothing to look up', () => {
    expect(providerRuntimeKey(null)).toBeNull();
    expect(providerRuntimeKey({ type: 'cli', command: '   ' })).toBeNull();
  });
});

describe('credentialSource', () => {
  it('identifies a stored public-provider key', () => {
    expect(credentialSource({ id: 'cloud', type: 'api', endpoint: 'https://api.example.com/v1' }))
      .toEqual({ kind: 'stored', ref: 'cloud' });
  });

  it('does not require a credential for a local API endpoint', () => {
    expect(credentialSource({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', hasApiKey: false }))
      .toEqual({ kind: 'none', ref: null });
  });

  it('identifies an inherited gateway key, pointing at the sibling of that gateway', () => {
    expect(credentialSource({ id: 'opencode-orcarouter', type: 'cli', orcarouterBacked: true }))
      .toEqual({ kind: 'inherited', ref: 'orcarouter' });
    expect(credentialSource({ id: 'opencode-openrouter', type: 'cli', gatewayBacked: 'openrouter' }))
      .toEqual({ kind: 'inherited', ref: 'openrouter' });
    expect(credentialSource({ id: 'opencode-nvidia-nim', type: 'cli', gatewayBacked: 'nvidia-nim' }))
      .toEqual({ kind: 'inherited', ref: 'nvidia-nim' });
  });

  it('identifies env credentials from explicit metadata and conventional names', () => {
    expect(credentialSource({
      id: 'bedrock', type: 'cli', secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'], envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
    })).toEqual({ kind: 'env', ref: 'AWS_BEARER_TOKEN_BEDROCK' });
    expect(credentialSource({
      id: 'claude-ollama', type: 'cli', envVars: { ANTHROPIC_AUTH_TOKEN: 'ollama' },
    })).toEqual({ kind: 'env', ref: 'ANTHROPIC_AUTH_TOKEN' });
    expect(credentialSource({
      id: 'custom-cli', type: 'cli', envVars: { MY_LLM_KEY: '' }, secretEnvVars: ['MY_LLM_KEY'],
    })).toEqual({ kind: 'env', ref: 'MY_LLM_KEY' });
  });

  it('does not treat API env settings or legacy process keys as credentials', () => {
    expect(credentialSource({
      id: 'cloud', type: 'api', endpoint: 'https://api.example.com/v1',
      envVars: { OPENAI_API_KEY: 'token-example' },
    })).toEqual({ kind: 'stored', ref: 'cloud' });
    expect(credentialSource({
      id: 'custom-cli', type: 'cli', apiKey: 'legacy-key', envVars: {},
    })).toEqual({ kind: 'none', ref: null });
  });

  it('keeps a Codex ChatGPT subscription separate from API-key credentials', () => {
    expect(credentialSource({ id: 'codex', type: 'cli', command: 'codex', apiKey: 'legacy-key' }))
      .toEqual({ kind: 'subscription', ref: 'codex' });
  });

  it('keys Codex subscription credentials on the command, not an editable id', () => {
    const renamed = { id: 'codex', type: 'cli', command: 'opencode', envVars: { CUSTOM_API_KEY: '' } };
    expect(isCodexSubscriptionProvider(renamed)).toBe(false);
    expect(credentialSource(renamed)).toEqual({ kind: 'env', ref: 'CUSTOM_API_KEY' });
  });

  it('exempts a local-backed Codex record from the ChatGPT subscription contract', () => {
    // `codex --oss --local-provider ollama` generates its tokens on this machine
    // and authenticates against nothing, so the account is not one of its
    // prerequisites — without this the card claims "No ChatGPT account is signed
    // in" and, worse, parks in UNKNOWN awaiting a read that never matters.
    // The server's own isCodexSubscriptionProvider (server/lib/provider/providerModels.js),
    // re-exported — one rule for the card and the prerequisite router.
    const local = SHIPPED_PROVIDERS.providers['codex-ollama'];
    expect(local.ollamaBacked).toBe(true);
    expect(isCodexSubscriptionProvider(local)).toBe(false);
    expect(isCodexSubscriptionProvider(SHIPPED_PROVIDERS.providers.codex)).toBe(true);
    // An enabled copy: a codex-command card whose account read came back with
    // no verdict parks in UNKNOWN, which this record must never reach.
    const enabled = { ...local, enabled: true, missingPrerequisites: [] };
    expect(providerCardState(enabled, { codexAccount: null }).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('lets a wrapper carrying its own key stand down from inheritance', () => {
    expect(credentialSource({ id: 'wrapper', type: 'cli', apiKey: 'sk-example', orcarouterBacked: true }))
      .toEqual({ kind: 'stored', ref: 'wrapper' });
  });

  it('covers the shipped Bedrock and Claude-Ollama provider shapes', () => {
    expect(credentialSource(SHIPPED_PROVIDERS.providers['claude-code-bedrock']))
      .toEqual({ kind: 'env', ref: 'AWS_BEARER_TOKEN_BEDROCK' });
    expect(credentialSource(SHIPPED_PROVIDERS.providers['claude-ollama']))
      .toEqual({ kind: 'env', ref: 'ANTHROPIC_AUTH_TOKEN' });
  });
});

describe('providerCardState', () => {
  const cli = (over = {}) => ({ id: 'p1', type: 'cli', command: 'opencode', enabled: true, ...over });
  const cloudApi = (over = {}) => ({ id: 'p2', type: 'api', endpoint: 'https://api.example.com/v1', enabled: true, ...over });

  it('reports an enabled provider with every prerequisite met as ready', () => {
    expect(providerCardState(cli(), { runtime: { label: 'OpenCode CLI', installed: true } }))
      .toEqual({ state: PROVIDER_CARD_STATE.READY, missing: [] });
    expect(providerCardState(cloudApi({ hasApiKey: true })))
      .toEqual({ state: PROVIDER_CARD_STATE.READY, missing: [] });
  });

  it('uses bounded Codex account states without calling a subscription an API-key provider', () => {
    const codex = { id: 'codex', type: 'cli', command: 'codex', enabled: true };
    expect(providerCardState(codex, { codexAccount: { status: 'signed-out' } })).toEqual({
      state: PROVIDER_CARD_STATE.BLOCKED,
      missing: [{ code: 'codexAccount', label: 'No ChatGPT account is signed in' }],
    });
    expect(providerCardState(codex, { codexAccount: { status: 'reauth-required' } })).toEqual({
      state: PROVIDER_CARD_STATE.BLOCKED,
      missing: [{ code: 'codexAccount', label: 'ChatGPT sign-in has expired' }],
    });
    expect(providerCardState(codex, { codexAccount: { status: 'quota-exhausted' } })).toEqual({
      state: PROVIDER_CARD_STATE.BENCHED,
      missing: [],
    });
    // A legacy server payload carrying codexQuota finding is filtered out and benched
    expect(providerCardState({
      ...codex,
      missingPrerequisites: [{ code: 'codexQuota', label: 'ChatGPT usage limit reached' }],
    }, { codexAccount: { status: 'quota-exhausted' } })).toEqual({
      state: PROVIDER_CARD_STATE.BENCHED,
      missing: [],
    });
    // A missing runtime still blocks even if quota is also exhausted
    expect(providerCardState(codex, {
      runtime: { label: 'Codex CLI', installed: false },
      codexAccount: { status: 'quota-exhausted' },
    })).toEqual({
      state: PROVIDER_CARD_STATE.BLOCKED,
      missing: [{ code: 'runtime', label: 'Codex CLI is not installed' }],
    });
    expect(providerCardState(codex, { codexAccount: { status: 'unknown' } }))
      .toEqual({ state: PROVIDER_CARD_STATE.UNKNOWN, missing: [] });
    expect(providerCardState(codex, { codexAccount: null }))
      .toEqual({ state: PROVIDER_CARD_STATE.UNKNOWN, missing: [] });
    expect(providerCardState(codex, { codexAccount: { status: 'ready' } }))
      .toEqual({ state: PROVIDER_CARD_STATE.READY, missing: [] });
  });

  // An unprobed runtime (older server, or the card drawn before the probe
  // lands) must read as "can't tell", never as a missing binary.
  it('never blocks on an unprobed runtime', () => {
    expect(providerCardState(cli(), { runtime: null }).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('blocks a provider whose CLI is not installed, and names it', () => {
    const readiness = providerCardState(cli(), { runtime: { label: 'OpenCode CLI', installed: false } });
    expect(readiness.state).toBe(PROVIDER_CARD_STATE.BLOCKED);
    expect(readiness.missing).toEqual([{ code: 'runtime', label: 'OpenCode CLI is not installed' }]);
  });

  it('blocks a cloud API provider with no key', () => {
    const readiness = providerCardState(cloudApi({ hasApiKey: false }));
    expect(readiness.state).toBe(PROVIDER_CARD_STATE.BLOCKED);
    expect(readiness.missing).toEqual([{ code: 'apiKey', label: 'API key is not set' }]);
  });

  // Ollama / LM Studio need no key at all — absence there is not a prerequisite.
  it('does not demand a key from a local endpoint', () => {
    expect(providerCardState({ id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1', enabled: true }).state)
      .toBe(PROVIDER_CARD_STATE.READY);
  });

  // A LAN box or a tailnet peer running LM Studio / Ollama serves keylessly, and
  // PortOS is a tailnet-first product — flagging those as unconfigured would be
  // a false alarm on a supported deployment.
  it.each([
    ['http://192.168.1.50:1234/v1'],
    ['http://10.0.0.4:11434/v1'],
    ['http://100.64.0.5:11434/v1'],
    ['http://desk-machine.ts.net:1234/v1'],
    ['http://nas:11434/v1'],
  ])('does not demand a key from the private-network endpoint %s', (endpoint) => {
    expect(providerCardState({ id: 'lan', type: 'api', endpoint, enabled: true }).state)
      .toBe(PROVIDER_CARD_STATE.READY);
  });

  // The RFC1918 test matches a prefix; without an IPv4-literal gate it also
  // claims DNS names that merely start like one, waving a real public endpoint
  // through as needing no key.
  it.each([
    'https://10.evil.example/v1',
    'https://172.16.evil.example/v1',
    'https://100.64.evil.example/v1',
  ])('still demands a key from %s, which only LOOKS like a private range', (endpoint) => {
    expect(providerCardState({ id: 'spoof', type: 'api', endpoint, enabled: true }).state)
      .toBe(PROVIDER_CARD_STATE.BLOCKED);
  });

  it('still demands a key from a public endpoint', () => {
    expect(providerCardState({ id: 'cloud', type: 'api', endpoint: 'https://api.example.com/v1', enabled: true }).state)
      .toBe(PROVIDER_CARD_STATE.BLOCKED);
  });

  it('blocks an OrcaRouter wrapper when the sibling API provider holds no key', () => {
    const wrapper = cli({ id: 'opencode-orcarouter', orcarouterBacked: true });
    expect(providerCardState(wrapper, { keySetFor: id => id === 'orcarouter' ? false : null }).missing)
      .toEqual([{ code: 'inheritedApiKey', label: 'OrcaRouter API provider has no API key' }]);
    // Sibling absent from the list = unknown, which must not accuse the wrapper.
    expect(providerCardState(wrapper, { keySetFor: () => null }).state).toBe(PROVIDER_CARD_STATE.READY);
    expect(providerCardState(wrapper, { keySetFor: () => true }).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('blocks an OpenRouter wrapper against its OWN sibling, naming that gateway', () => {
    const wrapper = cli({ id: 'opencode-openrouter', gatewayBacked: 'openrouter' });
    expect(providerCardState(wrapper, { keySetFor: id => id === 'openrouter' ? false : null }).missing)
      .toEqual([{ code: 'inheritedApiKey', label: 'OpenRouter API provider has no API key' }]);
    // An OrcaRouter key must never satisfy an OpenRouter wrapper.
    expect(providerCardState(wrapper, { keySetFor: id => id === 'orcarouter' }).missing)
      .toEqual([{ code: 'inheritedApiKey', label: 'OpenRouter API provider has no API key' }]);
    expect(providerCardState(wrapper, { keySetFor: () => true }).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('does not require the inherited key when a wrapper carries its own key', () => {
    const wrapper = cli({ id: 'opencode-orcarouter', apiKey: 'sk-example', orcarouterBacked: true });
    expect(providerCardState(wrapper, { keySetFor: id => id === wrapper.id })).toEqual({
      state: PROVIDER_CARD_STATE.READY,
      missing: [],
    });
  });

  it('keeps the inherited-key check when an Orca wrapper also has an env credential', () => {
    const wrapper = cli({
      id: 'opencode-orcarouter',
      orcarouterBacked: true,
      envVars: { OPENROUTER_API_KEY: 'token-example' },
    });
    expect(providerCardState(wrapper, { keySetFor: () => false }).missing).toEqual([{
      code: 'inheritedApiKey',
      label: 'OrcaRouter API provider has no API key',
    }]);
  });

  it('blocks an env-credential provider whose configured value is empty, naming the variable', () => {
    const readiness = providerCardState(cli({
      id: 'claude-code-bedrock',
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    }));
    expect(readiness.state).toBe(PROVIDER_CARD_STATE.BLOCKED);
    expect(readiness.missing).toEqual([{
      code: 'envVar',
      label: 'AWS_BEARER_TOKEN_BEDROCK environment variable is not set',
    }]);
  });

  it('derives an empty env credential even when the server published no findings', () => {
    const readiness = providerCardState(cli({
      id: 'claude-code-bedrock',
      missingPrerequisites: [],
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    }));
    expect(readiness).toEqual({
      state: PROVIDER_CARD_STATE.BLOCKED,
      missing: [{
        code: 'envVar',
        label: 'AWS_BEARER_TOKEN_BEDROCK environment variable is not set',
      }],
    });
  });

  it('accepts a configured env credential', () => {
    expect(providerCardState(cli({
      id: 'claude-ollama',
      envVars: { ANTHROPIC_AUTH_TOKEN: 'ollama' },
    })).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('blocks a shipped Claude-Ollama provider whose auth token is blank', () => {
    const provider = SHIPPED_PROVIDERS.providers['claude-ollama'];
    const readiness = providerCardState({
      ...provider,
      envVars: { ...provider.envVars, ANTHROPIC_AUTH_TOKEN: '' },
    });
    expect(readiness.missing).toEqual([{
      code: 'envVar',
      label: 'ANTHROPIC_AUTH_TOKEN environment variable is not set',
    }]);
  });

  it('does not let a legacy CLI key satisfy an empty process credential', () => {
    const readiness = providerCardState(cli({
      apiKey: 'legacy-key',
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '' },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    }));
    expect(readiness.missing).toEqual([{
      code: 'envVar',
      label: 'AWS_BEARER_TOKEN_BEDROCK environment variable is not set',
    }]);
  });

  it('ignores optional secret env settings and checks every credential variable', () => {
    const readiness = providerCardState(cli({
      envVars: {
        AWS_PROFILE: '',
        AWS_ACCESS_KEY_ID: '',
        AWS_SECRET_ACCESS_KEY: '',
      },
      secretEnvVars: ['AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    }));
    expect(readiness.missing).toEqual([
      { code: 'envVar', label: 'AWS_ACCESS_KEY_ID environment variable is not set' },
      { code: 'envVar', label: 'AWS_SECRET_ACCESS_KEY environment variable is not set' },
    ]);
  });

  it('reports only the missing half of a known AWS access-key pair', () => {
    const readiness = providerCardState(cli({
      envVars: {
        AWS_ACCESS_KEY_ID: 'key-example',
        AWS_SECRET_ACCESS_KEY: '',
      },
      secretEnvVars: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    }));
    expect(readiness.missing).toEqual([{
      code: 'envVar',
      label: 'AWS_SECRET_ACCESS_KEY environment variable is not set',
    }]);
  });

  it('accepts a configured alternative credential when another env value is blank', () => {
    expect(providerCardState(cli({
      envVars: {
        AWS_BEARER_TOKEN_BEDROCK: '',
        AWS_ACCESS_KEY_ID: 'key-example',
        AWS_SECRET_ACCESS_KEY: 'secret-example',
      },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    })).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('does not use API env settings in place of the stored API key', () => {
    const readiness = providerCardState(cloudApi({
      hasApiKey: false,
      envVars: { OPENAI_API_KEY: 'token-example' },
    }));
    expect(readiness.missing).toEqual([{ code: 'apiKey', label: 'API key is not set' }]);
  });

  it('does not block an unmarked empty env value that clears an ambient credential', () => {
    expect(providerCardState(cli({ envVars: { ANTHROPIC_API_KEY: '' } })).state)
      .toBe(PROVIDER_CARD_STATE.READY);
  });

  it('keeps a redacted secret unknown while an explicit blank is missing', () => {
    const provider = (value) => cli({
      envVars: { AWS_BEARER_TOKEN_BEDROCK: value },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    });
    expect(providerCardState(provider('***')).state).toBe(PROVIDER_CARD_STATE.READY);
    expect(providerCardState(provider('')).state).toBe(PROVIDER_CARD_STATE.BLOCKED);
  });

  it('does not treat an unknown env lookup as a missing credential', () => {
    expect(providerCardState(cli({
      id: 'claude-code-bedrock',
      envVars: { AWS_BEARER_TOKEN_BEDROCK: '***' },
      secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
    }), { envVarSet: () => null }).state).toBe(PROVIDER_CARD_STATE.READY);
  });

  it('benches an enabled provider the server marked unavailable', () => {
    const readiness = providerCardState(cli(), { status: { available: false, reason: 'usage-limit' } });
    expect(readiness.state).toBe(PROVIDER_CARD_STATE.BENCHED);
    // A benched provider is fully configured — nothing to install or paste.
    expect(readiness.missing).toEqual([]);
  });

  it('reads a switched-off but fully configured provider as disabled, not blocked', () => {
    expect(providerCardState(cli({ enabled: false }), { runtime: { label: 'OpenCode CLI', installed: true } }).state)
      .toBe(PROVIDER_CARD_STATE.DISABLED);
  });

  // Switched off outranks every finding, and the findings ride along so the
  // card can still say what enabling it would take.
  it('reads a switched-off provider with a missing prerequisite as disabled, keeping the findings', () => {
    const readiness = providerCardState(cli({ enabled: false }), { runtime: { label: 'OpenCode CLI', installed: false } });
    expect(readiness.state).toBe(PROVIDER_CARD_STATE.DISABLED);
    expect(readiness.missing).toEqual([{ code: 'runtime', label: 'OpenCode CLI is not installed' }]);
  });

  it('collects every missing prerequisite at once', () => {
    const readiness = providerCardState(
      { id: 'lmstudio-remote', type: 'api', endpoint: 'https://api.example.com/v1', hasApiKey: false, enabled: true },
      { runtime: { label: 'LM Studio', installed: false } },
    );
    expect(readiness.missing.map(m => m.code)).toEqual(['runtime', 'apiKey']);
  });

  // The server publishes its own verdict on GET /api/providers and routes the
  // fallback chain on the same computation (#4611) — the card must read that
  // rather than re-deriving it, or the badge and the router can disagree.
  describe('server-published prerequisites', () => {
    it('paints a blocked card from the published findings', () => {
      const readiness = providerCardState(cli({
        missingPrerequisites: [{ code: 'runtime', label: 'OpenCode CLI is not installed' }],
      }));
      expect(readiness.state).toBe(PROVIDER_CARD_STATE.BLOCKED);
      expect(readiness.missing).toEqual([{ code: 'runtime', label: 'OpenCode CLI is not installed' }]);
    });

    // An EMPTY array is a real answer ("nothing missing"), not an absent one —
    // so it must SUPPRESS the local derivation, not fall back to it.
    it('trusts an empty published list over its own credential derivation', () => {
      expect(providerCardState(cloudApi({ hasApiKey: false, missingPrerequisites: [] })).state)
        .toBe(PROVIDER_CARD_STATE.READY);
    });

    it('falls back to deriving locally when the server published nothing', () => {
      expect(providerCardState(cloudApi({ hasApiKey: false })).state).toBe(PROVIDER_CARD_STATE.BLOCKED);
      expect(providerCardState(cloudApi({ hasApiKey: false, missingPrerequisites: null })).state)
        .toBe(PROVIDER_CARD_STATE.BLOCKED);
    });

    // The local-app runtime shape (an LM Studio / Ollama app installed with no
    // CLI shim on PATH) is derived from the local-LLM status, which the server's
    // runtime table does not cover — so it must still be added on top.
    it('adds a client-only local-app runtime finding to the published list', () => {
      const readiness = providerCardState(
        { id: 'lmstudio', type: 'api', endpoint: 'http://localhost:1234/v1', enabled: true, missingPrerequisites: [] },
        { runtime: { id: 'lmstudio', label: 'LM Studio', installed: false } },
      );
      expect(readiness.missing).toEqual([{ code: 'runtime', label: 'LM Studio is not installed' }]);
    });

    // The runtime row answers "is the BARE binary on PortOS's PATH?" — which is
    // not this provider's question. The server declines to route on it, so the
    // badge must not accuse it either.
    it.each([
      ['an explicit command path', { command: '/opt/example/bin/opencode' }],
      ['a PATH of its own in envVars', { envVars: { PATH: '/opt/example/bin' } }],
    ])('does not badge a provider that resolves outside PortOS PATH — %s', (_label, over) => {
      const readiness = providerCardState(cli(over), { runtime: { label: 'OpenCode CLI', installed: false } });
      expect(readiness.state).toBe(PROVIDER_CARD_STATE.READY);
      expect(readiness.missing).toEqual([]);
    });

    it('does not double-report a runtime both sides found missing', () => {
      const readiness = providerCardState(
        cli({ missingPrerequisites: [{ code: 'runtime', label: 'OpenCode CLI is not installed' }] }),
        { runtime: { label: 'OpenCode CLI', installed: false } },
      );
      expect(readiness.missing).toHaveLength(1);
    });
  });
});

describe('isPrivateNetworkEndpoint', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:1234',
    '192.168.1.5:1234/v1',
    'http://172.16.4.4:11434',
    'http://172.31.255.1:11434',
    'http://100.64.0.1:11434',
    'http://host.local:1234',
    'http://box.internal/v1',
    'http://ollama',
    // IPv6 unique-local — Tailscale hands out a ULA address alongside the CGNAT
    // v4 one, so a tailnet peer reached over IPv6 must not read as public.
    'http://[fd7a:115c:a1e0::1]:11434/v1',
    'http://[fc00::5]:1234',
    // IPv6 link-local (fe80::/10).
    'http://[fe80::1]:1234',
    'http://[febf::1]:1234',
  ])('treats %s as inside the private network', (endpoint) => {
    expect(isPrivateNetworkEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://api.example.com/v1',
    'https://example.com:8443/v1',
    // 172.32 is outside RFC1918 (which stops at 172.31), and 100.128 is above
    // the Tailscale CGNAT range — both are public space.
    'http://172.32.0.1:11434',
    'http://100.128.0.1:11434',
    'http://9.9.9.9/v1',
    // A HOSTNAME starting with fc/fd is not an IPv6 ULA — a bare prefix test on
    // the host would hand these the no-key-needed pass.
    'https://fdrive.example.com:1234/v1',
    'https://fc-api.example.com/v1',
    // 2001:… is public IPv6, and `fd::1` expands to a leading hextet of 0x00fd,
    // which is outside fc00::/7 despite the `fd` spelling.
    'http://[2001:db8::1]:1234',
    'http://[fd::1]:1234',
    '',
    null,
  ])('treats %s as public', (endpoint) => {
    expect(isPrivateNetworkEndpoint(endpoint)).toBe(false);
  });
});

describe('isFleetHostConfigured', () => {
  const host = {
    peerId: 'peer-1',
    peerName: 'Workstation GPU',
    peerHost: 'workstation.tailnet.ts.net',
    peerAddress: '192.168.1.50',
    endpoint: 'http://workstation.tailnet.ts.net:18022/v1',
    model: 'qwen3.8-27b',
    serving: true,
  };

  it('returns false for empty host or empty providers', () => {
    expect(isFleetHostConfigured(null, [])).toBe(false);
    expect(isFleetHostConfigured(host, [])).toBe(false);
    expect(isFleetHostConfigured(host, null)).toBe(false);
  });

  it('matches provider by exact endpoint', () => {
    const providers = [
      { id: 'p1', endpoint: 'http://workstation.tailnet.ts.net:18022/v1' },
    ];
    expect(isFleetHostConfigured(host, providers)).toBe(true);

    const providersWithSlash = [
      { id: 'p1', endpoint: 'http://workstation.tailnet.ts.net:18022/v1/' },
    ];
    expect(isFleetHostConfigured(host, providersWithSlash)).toBe(true);
  });

  it('matches provider by peerHost hostname or peerAddress', () => {
    const providers = [
      { id: 'p1', endpoint: 'http://workstation.tailnet.ts.net:18022/v1' },
    ];
    expect(isFleetHostConfigured({ peerHost: 'workstation.tailnet.ts.net' }, providers)).toBe(true);
    expect(isFleetHostConfigured({ peerAddress: '192.168.1.50' }, [
      { id: 'p2', endpoint: 'http://192.168.1.50:18022/v1' },
    ])).toBe(true);
  });

  it('matches OpenCode TUI provider by OPENCODE_CONFIG_CONTENT baseURL', () => {
    const providers = [
      {
        id: 'p-tui',
        type: 'tui',
        envVars: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: {
              vllm: {
                options: { baseURL: 'http://workstation.tailnet.ts.net:18022/v1' },
              },
            },
          }),
        },
      },
    ];
    expect(isFleetHostConfigured(host, providers)).toBe(true);
  });

  it('returns false when no provider points to the host', () => {
    const providers = [
      { id: 'other', endpoint: 'http://other.tailnet.ts.net:18022/v1' },
      { id: 'local', endpoint: 'http://127.0.0.1:11434' },
    ];
    expect(isFleetHostConfigured(host, providers)).toBe(false);
  });
});
