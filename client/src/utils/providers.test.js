import { describe, it, expect } from 'vitest';
import {
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  CODEX_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  providerDisplayName,
  assignmentProviderOptions,
  assignmentModelOptions,
  assignmentDefaultModel,
  assignmentToolUseState,
  PROVIDER_TYPES,
  filterSelectableModels,
  filterGenerationModels,
  isEmbeddingModel,
  isVisionModel,
  isVisionCapableCliProvider,
  visionLocalModelFilter,
  isToolUseModel,
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
  providerRuntimeKey,
  credentialSource,
  providerCardState,
  isPrivateNetworkEndpoint,
  PROVIDER_CARD_STATE,
  isOllamaBackedProvider,
  isOrcaRouterBackedProvider,
  isGrokBuildCli,
  isKimiProvider,
  isCodexProvider,
  supportsModelRefresh,
  isAntigravityProvider,
  effortLevelsForProvider,
  generationControlsFor,
  resolveCliEffort,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  CURSOR_EFFORT_LEVELS,
  ANTIGRAVITY_EFFORT_LEVELS,
  isConfiguredDefaultModel,
  configuredDefaultIn,
  isLocalEndpoint,
  isLocalInstanceProvider,
  enabledApiProviderFilter,
  providerTypeClass,
  getProviderTimeout,
  splitAntigravityModel,
  antigravityBaseModels,
  antigravityModelEffortLevels,
  selectableModelsForProvider,
  withStaleAntigravityPin,
  effortAwareModelOptions,
  effectiveModelFor,
  effortSurvivingModel,
  seedModelEffort,
} from './providers.js';
import { PROVIDER_TYPES as SERVER_PROVIDER_TYPES } from '../../../server/lib/aiToolkit/constants.js';
import SHIPPED_PROVIDERS from '../../../data.reference/providers.json';
// The server's own payload decorator, so the shipped-catalog walk below tests
// the REAL derivation instead of a hand transcription of it (#3620). Pure and
// dependency-free — it imports nothing outside the vendored aiToolkit.
import { withRefreshCapabilityList } from '../../../server/lib/aiToolkit/internal/modelFetchers.js';
import {
  effortLevelsForProvider as serverEffortLevelsForProvider,
  isAntigravityProvider as serverIsAntigravityProvider,
  resolveCliEffort as serverResolveCliEffort,
  splitAntigravityModel as serverSplitAntigravityModel,
  antigravityBaseModels as serverAntigravityBaseModels,
  antigravityModelEffortLevels as serverAntigravityModelEffortLevels,
} from '../../../server/lib/providerModels.js';

// The client copy drives what EffortSelect DISPLAYS; the server copy decides
// what the CLI actually receives. Any drift means the UI names a level the run
// won't use, so every case is asserted against both implementations.
describe('resolveCliEffort (server mirror)', () => {
  const AGY = { id: 'antigravity-cli', command: 'agy' };
  const CLAUDE = { id: 'claude-code', command: 'claude' };
  const CODEX = { id: 'codex', command: 'codex' };
  const GROK = { id: 'grok-cli', command: 'grok' };

  it.each([
    ['supported value passes through', 'medium', AGY, 'medium'],
    ['above agy ladder clamps down', 'xhigh', AGY, 'high'],
    ['max clamps to agy high', 'max', AGY, 'high'],
    ['ultra clamps to agy high', 'ultra', AGY, 'high'],
    ['below agy ladder takes the weakest', 'minimal', AGY, 'low'],
    ['codex-only ultra clamps on claude', 'ultra', CLAUDE, 'max'],
    ['codex-only minimal clamps on claude', 'minimal', CLAUDE, 'low'],
    ['codex accepts its whole ladder', 'minimal', CODEX, 'minimal'],
    ['codex accepts max', 'max', CODEX, 'max'],
    ['legacy ultra resolves to codex max', 'ultra', CODEX, 'max'],
    ['unknown value yields no flag', 'bogus', AGY, null],
    ['effort-less provider yields no flag', 'high', GROK, null],
    ['unset yields no flag', '', AGY, null],
    ['null yields no flag', null, CLAUDE, null],
  ])('%s', (_label, effort, provider, expected) => {
    expect(resolveCliEffort(effort, provider)).toBe(expected);
    expect(serverResolveCliEffort(effort, provider)).toBe(expected);
  });
});

// These drive the Effort/model pickers in the CoS task + schedule forms. The
// client copy is a hand-mirror of server/lib/providerModels.js (the client can't
// import server modules at runtime), so pin both sides together here.
describe('effortLevelsForProvider (server mirror)', () => {
  const CASES = [
    ['antigravity CLI', { id: 'antigravity-cli', command: 'agy' }, ANTIGRAVITY_EFFORT_LEVELS],
    ['antigravity TUI', { id: 'antigravity-tui' }, ANTIGRAVITY_EFFORT_LEVELS],
    ['path-configured agy', { id: 'custom', command: '/Users/x/.local/bin/agy' }, ANTIGRAVITY_EFFORT_LEVELS],
    ['claude code', { id: 'claude-code', command: 'claude' }, CLAUDE_EFFORT_LEVELS],
    ['codex', { id: 'codex', command: 'codex' }, CODEX_EFFORT_LEVELS],
    ['OpenCode Ollama', { id: 'opencode-ollama', command: 'opencode', ollamaBacked: true }, ['low', 'medium', 'high']],
    // OpenCode forwards `reasoningEffort` to whichever local backend it is wired
    // to, so the ladder belongs to every local namespace, not just Ollama.
    ['OpenCode llama TUI', { id: 'opencode-llama-tui', command: 'opencode', llamaBacked: true }, ['low', 'medium', 'high']],
    ['OpenCode MTPLX', { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true }, ['low', 'medium', 'high']],
    ['OpenCode vLLM TUI', { id: 'opencode-vllm-tui', command: 'opencode', vllmBacked: true }, ['low', 'medium', 'high']],
    ['OpenCode SGLang TUI', { id: 'opencode-sglang-tui', command: 'opencode', sglangBacked: true }, ['low', 'medium', 'high']],
    ['OpenCode with no local backend', { id: 'opencode', command: 'opencode' }, null],
    ['grok (no effort control)', { id: 'grok-cli', command: 'grok' }, null],
    ['blank command is not claude', { id: 'ollama' }, null],
  ];

  it.each(CASES)('%s', (_label, provider, expected) => {
    expect(effortLevelsForProvider(provider)).toEqual(expected);
    expect(serverEffortLevelsForProvider(provider)).toEqual(expected);
  });
});

// Which providers the Generation Defaults block is offered for. The rule has to
// match what the server actually forwards, or the editor advertises a control
// that does nothing: `buildAgentGeneration` (server/lib/opencodeConfig.js) for
// the OpenCode wrappers, `apiGenerationOptions`
// (server/lib/aiToolkit/internal/generationOptions.js) for HTTP runs.
describe('generationControlsFor', () => {
  it.each([
    ['OpenCode llama TUI', { id: 'opencode-llama-tui', command: 'opencode', llamaBacked: true }, { temperature: true, topP: true, thinking: true }],
    ['OpenCode MTPLX', { id: 'opencode-mtplx', command: 'opencode', mtplxBacked: true }, { temperature: true, topP: true, thinking: true }],
    // vLLM routes the thinking toggle through the chat template like the other
    // two. Both sides were written before `vllmBacked` existed, so the editor
    // hid the whole block while the server discarded every control anyway
    // (#4765).
    ['OpenCode vLLM TUI', { id: 'opencode-vllm-tui', command: 'opencode', vllmBacked: true }, { temperature: true, topP: true, thinking: true }],
    // SGLang takes the same chat-template thinking toggle, and shipped with the
    // controls wired from day one so it never repeated vLLM's hole.
    ['OpenCode SGLang TUI', { id: 'opencode-sglang-tui', command: 'opencode', sglangBacked: true }, { temperature: true, topP: true, thinking: true }],
    // A Claude harness on Ollama is forwarded only MAX_THINKING_TOKENS
    // (server/lib/cliChildEnv.js) — it owns its own sampling.
    ['Claude Ollama TUI', { id: 'claude-ollama-tui', command: 'claude', ollamaBacked: true }, { temperature: false, topP: false, thinking: true }],
    // ...but a Claude harness on ANY OTHER local backend gets no control at all.
    // MAX_THINKING_TOKENS is the harness's only thinking lever, and it means
    // "off" solely on Ollama; SGLang takes `chat_template_kwargs.enable_thinking`,
    // which the Anthropic wire cannot carry, so the toggle would pin a value
    // nothing reads. Sampling was never forwardable on a Claude harness either,
    // which would have left the block rendering one inert select.
    ['Claude SGLang TUI', { id: 'claude-sglang-tui', command: 'claude', sglangBacked: true }, null],
    ['native Ollama API', { id: 'ollama', type: 'api', endpoint: 'http://localhost:11434/v1' }, { temperature: true, topP: true, thinking: true }],
    // OrcaRouter proxies cloud models that own their own reasoning switch.
    ['OpenCode OrcaRouter', { id: 'opencode-orcarouter', command: 'opencode', orcarouterBacked: true }, { temperature: true, topP: true, thinking: false }],
    ['cloud API provider', { id: 'anthropic', type: 'api', endpoint: 'https://api.anthropic.com/v1' }, null],
    ['vendor CLI', { id: 'claude-code', command: 'claude' }, null],
  ])('%s', (_label, provider, expected) => {
    expect(generationControlsFor(provider)).toEqual(expected);
  });
});

// Antigravity lists one model id per effort tier (`gemini-3.6-flash-high`), but
// agy also takes the BASE id with a separate `--effort` flag — so the pickers
// show base models and carry effort as its own control. Both sides must agree on
// the split, or a client-side base id won't match what the server rebuilds.
describe('Antigravity base-model split (server mirror)', () => {
  // The catalog `agy models` prints — the shipped provider list mirrors it.
  const CATALOG = [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
    'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium',
  ];
  const BASES = [
    ANTIGRAVITY_CONFIGURED_DEFAULT,
    'gemini-3.6-flash', 'gemini-3.1-pro',
    'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b',
  ];

  it.each([
    ['gemini-3.6-flash-high', { base: 'gemini-3.6-flash', effort: 'high' }],
    ['gpt-oss-120b-medium', { base: 'gpt-oss-120b', effort: 'medium' }],
    ['claude-opus-4-6-thinking', { base: 'claude-opus-4-6-thinking', effort: null }],
    [ANTIGRAVITY_CONFIGURED_DEFAULT, { base: ANTIGRAVITY_CONFIGURED_DEFAULT, effort: null }],
    ['', { base: '', effort: null }],
  ])('splitAntigravityModel(%s)', (id, expected) => {
    expect(splitAntigravityModel(id)).toEqual(expected);
    expect(serverSplitAntigravityModel(id)).toEqual(expected);
  });

  it('strips + dedupes the catalog into base models on both sides', () => {
    expect(antigravityBaseModels(CATALOG)).toEqual(BASES);
    expect(serverAntigravityBaseModels(CATALOG)).toEqual(BASES);
  });

  it.each([
    ['gemini-3.6-flash', ['low', 'medium', 'high']],
    // agy: `gemini-3.1-pro has no "medium" effort (available: low, high)`.
    ['gemini-3.1-pro', ['low', 'high']],
    ['gpt-oss-120b', ['medium']],
    ['claude-sonnet-4-6', []],
    // The sentinel is the shipped agy defaultModel, so a picker opens on it —
    // it means "model unknown" (full ladder), not "this model has no tiers".
    [ANTIGRAVITY_CONFIGURED_DEFAULT, null],
  ])('antigravityModelEffortLevels(%s)', (model, expected) => {
    expect(antigravityModelEffortLevels(model, CATALOG)).toEqual(expected);
    expect(serverAntigravityModelEffortLevels(model, CATALOG)).toEqual(expected);
  });

  it('narrows the picker ladder per selected model, and hides it for a tier-less model', () => {
    const agy = { id: 'antigravity-cli', command: 'agy', models: CATALOG };
    for (const [model, expected] of [
      ['gemini-3.6-flash', ['low', 'medium', 'high']],
      ['gemini-3.1-pro', ['low', 'high']],
      ['claude-sonnet-4-6', null],
    ]) {
      expect(effortLevelsForProvider(agy, model)).toEqual(expected);
      expect(serverEffortLevelsForProvider(agy, model)).toEqual(expected);
    }
    // Clamping follows the narrowed ladder, so agy never sees an invalid pair.
    expect(resolveCliEffort('medium', agy, 'gemini-3.1-pro')).toBe('low');
    expect(serverResolveCliEffort('medium', agy, 'gemini-3.1-pro')).toBe('low');
  });

  it('rewrites only Antigravity model lists', () => {
    expect(selectableModelsForProvider({ id: 'antigravity-cli', command: 'agy' }, CATALOG)).toEqual(BASES);
    expect(selectableModelsForProvider({ id: 'codex', command: 'codex' }, CATALOG)).toEqual(CATALOG);
    expect(selectableModelsForProvider(null, CATALOG)).toEqual(CATALOG);
  });

  // The pickers that carry their own effort control (CoS tasks/schedules/jobs,
  // the Three.js generator, the /do:* drawer) collapse the list to base models,
  // so a record saved before the split holds an id the list no longer contains.
  describe('withStaleAntigravityPin', () => {
    const agy = { id: 'antigravity-cli', command: 'agy' };

    it('re-adds a stored suffixed id that the base list dropped', () => {
      expect(withStaleAntigravityPin(agy, BASES, 'gemini-3.6-flash-high'))
        .toEqual([...BASES, 'gemini-3.6-flash-high']);
    });

    it('leaves an id the list already offers alone', () => {
      expect(withStaleAntigravityPin(agy, BASES, 'gemini-3.6-flash')).toEqual(BASES);
    });

    it('never re-surfaces the configured-default sentinel or an unsuffixed stale pin', () => {
      // filterSelectableModels exists to hide the sentinel; a typo'd pin is not
      // a legacy tier, so neither qualifies for the escape hatch.
      expect(withStaleAntigravityPin(agy, ['gemini-3.6-flash'], ANTIGRAVITY_CONFIGURED_DEFAULT))
        .toEqual(['gemini-3.6-flash']);
      expect(withStaleAntigravityPin(agy, ['gemini-3.6-flash'], 'gemini-9-typo'))
        .toEqual(['gemini-3.6-flash']);
    });

    it('is a no-op for a non-Antigravity provider whose model merely ends in -high', () => {
      const codex = { id: 'codex', command: 'codex' };
      expect(withStaleAntigravityPin(codex, ['gpt-5'], 'some-model-high')).toEqual(['gpt-5']);
    });
  });

  describe('effortAwareModelOptions', () => {
    it('collapses to base models, strips the sentinel, and pins a legacy id', () => {
      const agy = { id: 'antigravity-cli', command: 'agy', models: CATALOG };
      expect(effortAwareModelOptions(agy, 'gemini-3.6-flash-high')).toEqual([
        'gemini-3.6-flash', 'gemini-3.1-pro',
        'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b',
        'gemini-3.6-flash-high',
      ]);
    });

    it('passes a non-Antigravity catalog through untouched', () => {
      const codex = { id: 'codex', command: 'codex', models: ['gpt-5', 'gpt-5-mini'] };
      expect(effortAwareModelOptions(codex, 'gpt-5')).toEqual(['gpt-5', 'gpt-5-mini']);
      expect(effortAwareModelOptions(null, '')).toEqual([]);
    });
  });

  describe('effectiveModelFor', () => {
    it('falls back to the provider default when no model is pinned', () => {
      expect(effectiveModelFor({ defaultModel: 'gemini-3.6-flash' }, '')).toBe('gemini-3.6-flash');
      expect(effectiveModelFor({ defaultModel: 'gemini-3.6-flash' }, 'gemini-3.1-pro')).toBe('gemini-3.1-pro');
      expect(effectiveModelFor(null, null)).toBe('');
    });
  });

  describe('seedModelEffort', () => {
    const agy = { id: 'antigravity-cli', command: 'agy' };

    it('reads a legacy suffixed id back as base + its baked tier', () => {
      expect(seedModelEffort(agy, 'gemini-3.6-flash-high', '')).toEqual({
        model: 'gemini-3.6-flash', effort: 'high',
      });
    });

    it('lets an explicitly stored effort win over the baked suffix', () => {
      expect(seedModelEffort(agy, 'gemini-3.6-flash-high', 'low')).toEqual({
        model: 'gemini-3.6-flash', effort: 'low',
      });
    });

    it('leaves another provider alone even when its model ends in -high', () => {
      const codex = { id: 'codex', command: 'codex' };
      expect(seedModelEffort(codex, 'some-model-high', '')).toEqual({
        model: 'some-model-high', effort: '',
      });
    });

    it('normalizes nullish input to empty strings', () => {
      expect(seedModelEffort(agy, null, null)).toEqual({ model: '', effort: '' });
    });
  });

  // A model with no tiers HIDES the effort select. Without this the previous
  // effort sat in state with no UI left to clear it, and every submit still sent
  // it — an invocation agy rejects, plus a persisted level the run never used.
  describe('effortSurvivingModel', () => {
    const agy = { id: 'antigravity-cli', command: 'agy', models: CATALOG, defaultModel: ANTIGRAVITY_CONFIGURED_DEFAULT };

    it('drops the effort when the newly-picked model has no tiers at all', () => {
      // `claude-sonnet-4-6` ships in the agy catalog with no -low/-medium/-high
      // siblings, so effortLevelsForProvider returns null and the select vanishes.
      expect(effortSurvivingModel(agy, 'claude-sonnet-4-6', 'high')).toBe('');
    });

    it('keeps an effort the new model still offers', () => {
      expect(effortSurvivingModel(agy, 'gemini-3.6-flash', 'high')).toBe('high');
    });

    it('keeps an out-of-ladder effort when the ladder merely NARROWS', () => {
      // gemini-3.1-pro has no `medium`, but EffortSelect renders an explicit
      // "medium (runs as low)" option — the clamp stays visible, so don't
      // silently discard what the user picked.
      expect(effortSurvivingModel(agy, 'gemini-3.1-pro', 'medium')).toBe('medium');
    });

    it('falls back to the provider default when the model is cleared', () => {
      // Blank model = "use the provider default", which for agy is the sentinel —
      // an UNKNOWN model, so the full ladder applies and the effort survives.
      expect(effortSurvivingModel(agy, '', 'high')).toBe('high');
    });

    it('drops the effort for a provider with no effort control at all', () => {
      expect(effortSurvivingModel({ id: 'grok-cli', command: 'grok' }, 'grok-4', 'high')).toBe('');
    });

    it('normalizes a nullish effort to the empty sentinel', () => {
      expect(effortSurvivingModel(agy, 'gemini-3.6-flash', null)).toBe('');
    });
  });
});

// Regression guard for the provider-edit form: an Antigravity provider publishes
// a real `agy models` catalog while its defaultModel/tiers stay on the sentinel.
// filterGenerationModels strips the sentinel, so the edit form needs this to
// render an explicit option for it — otherwise those four selects hold a value
// matching no option and render blank, reading as "no model configured".
describe('configuredDefaultIn', () => {
  it('finds the sentinel in a mixed catalog', () => {
    expect(configuredDefaultIn([ANTIGRAVITY_CONFIGURED_DEFAULT, 'gemini-3.1-pro-high']))
      .toBe(ANTIGRAVITY_CONFIGURED_DEFAULT);
    expect(configuredDefaultIn(['gpt-5.6-terra', CODEX_CONFIGURED_DEFAULT]))
      .toBe(CODEX_CONFIGURED_DEFAULT);
  });

  it('returns null when the list carries no sentinel', () => {
    expect(configuredDefaultIn(['gpt-5.6-terra', 'gpt-5.6-sol'])).toBeNull();
    expect(configuredDefaultIn([])).toBeNull();
    expect(configuredDefaultIn(null)).toBeNull();
    expect(configuredDefaultIn(undefined)).toBeNull();
  });

  // The sentinel it finds must be exactly what filterGenerationModels removed,
  // or the option's value still won't match the select's value.
  it('finds precisely the value the generation filter drops', () => {
    const models = [ANTIGRAVITY_CONFIGURED_DEFAULT, 'gemini-3.1-pro-high', 'claude-sonnet-4-6'];
    const sentinel = configuredDefaultIn(models);
    expect(filterGenerationModels(models)).not.toContain(sentinel);
    expect([...filterGenerationModels(models), sentinel].sort()).toEqual([...models].sort());
  });
});

describe('isAntigravityProvider (server mirror)', () => {
  it.each([
    [{ id: 'antigravity-cli' }, true],
    [{ id: 'antigravity-tui' }, true],
    [{ id: 'custom', command: 'agy.exe' }, true],
    [{ id: 'claude-code', command: 'claude' }, false],
    [null, false],
  ])('%o → %s', (provider, expected) => {
    expect(isAntigravityProvider(provider)).toBe(expected);
    expect(serverIsAntigravityProvider(provider)).toBe(expected);
  });
});

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

  it('isOrcaRouterBackedProvider matches only the orcarouterBacked marker', () => {
    expect(isOrcaRouterBackedProvider({ id: 'opencode-orcarouter', orcarouterBacked: true })).toBe(true);
    expect(isOrcaRouterBackedProvider({ id: 'opencode-orcarouter-tui', orcarouterBacked: true })).toBe(true);
    // A renamed wrapper that keeps the marker still inherits the sibling key.
    expect(isOrcaRouterBackedProvider({ id: 'my-orca', orcarouterBacked: true })).toBe(true);
    // The sibling API provider itself is NOT orcarouter-backed (it owns the key).
    expect(isOrcaRouterBackedProvider({ id: 'orcarouter', type: 'api' })).toBe(false);
    // An ollama-backed OpenCode wrapper shares the form shape but not the marker.
    expect(isOrcaRouterBackedProvider({ id: 'opencode-ollama', ollamaBacked: true })).toBe(false);
    expect(isOrcaRouterBackedProvider(null)).toBe(false);
    expect(isOrcaRouterBackedProvider(undefined)).toBe(false);
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

describe('isVisionCapableCliProvider', () => {
  it('accepts Claude and Codex CLIs, including a path-configured command', () => {
    expect(isVisionCapableCliProvider({ type: 'cli', command: 'codex' })).toBe(true);
    expect(isVisionCapableCliProvider({ type: 'cli', command: 'claude' })).toBe(true);
    expect(isVisionCapableCliProvider({ type: 'cli', command: '/opt/homebrew/bin/claude' })).toBe(true);
  });

  it('rejects API providers and non-vision CLIs', () => {
    expect(isVisionCapableCliProvider({ type: 'api', command: 'codex' })).toBe(false);
    expect(isVisionCapableCliProvider({ type: 'cli', command: 'agy' })).toBe(false);
    expect(isVisionCapableCliProvider({ type: 'tui', command: 'claude' })).toBe(false);
    expect(isVisionCapableCliProvider(null)).toBe(false);
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

describe('localToolUseHint', () => {
  const ollama = { name: 'Ollama', endpoint: 'http://localhost:11434/v1' };

  it('flags a local tool-capable model', () => {
    expect(localToolUseHint('qwen3.6:35b', ollama)).toEqual({ toolCapable: true });
  });

  it('flags a local non-tool model (Gemma narrates instead of acting)', () => {
    // Gemma 3, not 4 — tool support landed in Gemma 4, so `gemma4:*` is a
    // tool-capable id and can't stand in for "narrates instead of acting".
    expect(localToolUseHint('gemma3:4b', ollama)).toEqual({ toolCapable: false });
    expect(localToolUseHint('gemma2:9b', ollama)).toEqual({ toolCapable: false });
  });

  it('returns null for cloud providers (their ids do not encode family)', () => {
    const cloud = { name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };
    expect(localToolUseHint('gpt-4o', cloud)).toBeNull();
    expect(localToolUseHint('gemma3:4b', undefined)).toBeNull();
  });

  it('flags a renamed Ollama-backed CLI/TUI wrapper (no "ollama" name/endpoint)', () => {
    // The incident's provider class: a claude-ollama-tui wrapper the user renamed,
    // so localBackendForProvider misses it — but it still carries ollamaBacked.
    const wrapper = { id: 'my-local-agent', name: 'My Local Agent', ollamaBacked: true };
    expect(localToolUseHint('gemma3:4b', wrapper)).toEqual({ toolCapable: false });
    expect(localToolUseHint('qwen3.6:35b', wrapper)).toEqual({ toolCapable: true });
    // Also via ANTHROPIC_BASE_URL pointing at the Ollama daemon.
    const viaBase = { name: 'Renamed', envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434/v1' } };
    expect(localToolUseHint('gemma3:4b', viaBase)).toEqual({ toolCapable: false });
  });

  it('returns null for a blank id', () => {
    expect(localToolUseHint('', ollama)).toBeNull();
  });

  describe('authoritative capability union (useToolUseModelIds)', () => {
    // The map is keyed by the PROVIDER ID the server enumerated, so the fixture
    // provider needs one.
    const ollamaProvider = { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434/v1' };

    it('flags a tool-capable model the id regex does not recognize', () => {
      // The bug: `phi4-mini` reports the `tools` capability from Ollama's
      // /api/show, but no TOOL_USE_RE alternative matches it — so the picker
      // said "⚠ no known tool use" while the Local LLMs tab's Agents badge,
      // reading the same capabilities, disagreed.
      expect(localToolUseHint('phi4-mini:latest', ollamaProvider)).toEqual({ toolCapable: false });
      const ids = { ollama: new Set(['phi4-mini:latest']) };
      expect(localToolUseHint('phi4-mini:latest', ollamaProvider, ids)).toEqual({ toolCapable: true });
      expect(withToolUseOptionLabel('phi4-mini:latest', 'phi4-mini:latest', ollamaProvider, ids))
        .toBe('phi4-mini:latest · 🔧 tool use');
    });

    it('keeps the regex verdict for a model the server did not list (union, not substitution)', () => {
      // A fetched-and-legitimately-EMPTY set is not a veto: the server can only
      // ADD to the regex, never subtract from it, so a regex hit still wins.
      const ids = { ollama: new Set(), lmstudio: new Set() };
      expect(localToolUseHint('qwen3.6:35b', ollamaProvider, ids)).toEqual({ toolCapable: true });
      expect(localToolUseHint('gemma3:4b', ollamaProvider, ids)).toEqual({ toolCapable: false });
    });

    it('falls back to regex-only when the fetch never landed or failed (null map)', () => {
      // `null` = not fetched / failed — distinct from a fetched empty map above.
      // Both degrade to the regex, but only the empty map is a real answer.
      expect(localToolUseHint('qwen3.6:35b', ollamaProvider, null)).toEqual({ toolCapable: true });
      expect(localToolUseHint('phi4-mini:latest', ollamaProvider, null)).toEqual({ toolCapable: false });
      expect(localToolUseHint('phi4-mini:latest', ollamaProvider, undefined)).toEqual({ toolCapable: false });
    });

    it('never lets one provider vouch for another (keyed by enumerated provider)', () => {
      // A CUSTOM provider pointed at a DIFFERENT Ollama host resolves to the same
      // backend but was never enumerated — a matching id there is a coincidence,
      // and a false "tool-capable" wedges the agent. It stays regex-only.
      const ids = { ollama: new Set(['phi4-mini:latest']) };
      const remote = { id: 'ollama-remote', name: 'Remote Ollama', endpoint: 'http://192.0.2.10:11434/v1' };
      expect(localToolUseHint('phi4-mini:latest', remote, ids)).toEqual({ toolCapable: false });
      // Same for a renamed Ollama-backed wrapper with its own provider id.
      const wrapper = { id: 'my-local-agent', name: 'My Local Agent', ollamaBacked: true };
      expect(localToolUseHint('phi4-mini:latest', wrapper, ids)).toEqual({ toolCapable: false });
    });

    it('still returns null for cloud providers even with a map present', () => {
      const cloud = { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1' };
      expect(localToolUseHint('gpt-4o', cloud, { openai: new Set(['gpt-4o']) })).toBeNull();
    });
  });
});

describe('withToolUseOptionLabel', () => {
  const ollama = { name: 'Ollama', endpoint: 'http://localhost:11434/v1' };

  it('marks recognized-tool vs unrecognized local models', () => {
    expect(withToolUseOptionLabel('qwen3.6:35b', 'qwen3.6:35b', ollama)).toBe('qwen3.6:35b · 🔧 tool use');
    // Non-match is worded as unverified, not a false-certain negative — the id
    // regex is a positive allowlist, so a miss only means "not recognized".
    expect(withToolUseOptionLabel('gemma3:4b', 'gemma3:4b', ollama)).toBe('gemma3:4b · ⚠ no known tool use');
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

describe('supportsModelRefresh', () => {
  // Guards the AI Providers page's "Refresh Models" button. It is now a READ of
  // the server-derived `canRefreshModels` field — the server owns the one
  // per-vendor fetcher table (server/lib/aiToolkit/internal/modelFetchers.js)
  // and the providers route decorates every payload with the answer.
  //
  // What used to be here was a ~40-line hand-written mirror of both server
  // dispatch arms, "kept in lockstep" by a comment, plus a parity test that
  // re-implemented the server dispatch a SECOND time — so it only proved the
  // mirror matched the test's own copy. Both are gone with #3620/#3616.
  it('reads the flag the server put on the payload', () => {
    expect(supportsModelRefresh({ id: 'claude-code', canRefreshModels: true })).toBe(true);
    expect(supportsModelRefresh({ id: 'codex', canRefreshModels: false })).toBe(false);
  });

  it('ignores the command/name/type shapes it used to sniff', () => {
    // The whole point: the client no longer has an opinion. A codex provider
    // the server says it CAN refresh gets a button; a claude provider the
    // server says it cannot, does not.
    expect(supportsModelRefresh({ type: 'cli', command: 'codex', name: 'Codex CLI', canRefreshModels: true })).toBe(true);
    expect(supportsModelRefresh({ type: 'cli', command: 'claude', name: 'Claude Code CLI', canRefreshModels: false })).toBe(false);
    expect(supportsModelRefresh({ type: 'api', endpoint: 'http://localhost:1234/v1', canRefreshModels: false })).toBe(false);
  });

  it('hides the button when the field is absent — an older server, not a hint to guess', () => {
    // Strict `=== true`: guessing from the shape is what produced a button that
    // 404'd on every click. Absent means "this server does not say", so stay quiet.
    expect(supportsModelRefresh({ id: 'claude-code', type: 'cli', command: 'claude', name: 'Claude Code CLI' })).toBe(false);
    expect(supportsModelRefresh({ id: 'x', canRefreshModels: 'yes' })).toBe(false);
    expect(supportsModelRefresh({ id: 'x', canRefreshModels: 1 })).toBe(false);
  });

  it('does not throw on a nullish provider', () => {
    expect(supportsModelRefresh(null)).toBe(false);
    expect(supportsModelRefresh(undefined)).toBe(false);
  });

  // The shipped-catalog walk, retargeted at the payload field. It used to
  // compare this predicate against a hand transcription of the server dispatch;
  // now it runs the SERVER's own decorator over the shipped seed and asserts the
  // button visibility that produces. That is the real lockstep gate: a provider
  // added to the seed without a fetcher-table row (how codex and kimi-cli ended
  // up with a 404ing button) shows up here.
  it('agrees with the server decorator for every shipped provider', () => {
    const decorated = withRefreshCapabilityList(Object.values(SHIPPED_PROVIDERS.providers));
    expect(decorated.length).toBeGreaterThan(20);

    const withButton = decorated.filter(supportsModelRefresh).map((p) => p.id).sort();
    // Intentional shipped-catalog contract: a newly seeded provider must either
    // have a usable fetcher or stay out of this list.
    expect(withButton).toEqual([
      'antigravity-cli', 'antigravity-tui', 'cerebras', 'claude-code',
      'claude-code-bedrock', 'claude-ollama', 'claude-ollama-tui',
      'claude-sglang', 'claude-sglang-tui', 'cursor-cli',
      'cursor-tui', 'grok', 'lmstudio', 'mtplx', 'nvidia-kimi', 'ollama',
      'opencode-llama-tui',
      'opencode-mtplx', 'opencode-mtplx-tui', 'opencode-ollama',
      'opencode-ollama-tui', 'opencode-orcarouter', 'opencode-orcarouter-tui',
      'opencode-sglang', 'opencode-sglang-tui',
      'opencode-vllm', 'opencode-vllm-tui',
      'orcarouter',
    ]);
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

  it('keeps the cursor ladder in lockstep with the server', () => {
    expect(CURSOR_EFFORT_LEVELS).toEqual(serverEffortLevelsForProvider({ id: 'cursor-cli', command: 'cursor-agent' }));
  });

  it('is not mistaken for a claude/codex/antigravity provider by its model ids', () => {
    const cursor = { id: 'cursor-cli', command: 'cursor-agent', models: ['claude-opus-5-thinking-high'] };
    expect(isCodexProvider(cursor)).toBe(false);
    expect(isAntigravityProvider(cursor)).toBe(false);
    expect(isKimiProvider(cursor)).toBe(false);
  });
});

describe('effectiveModelContextWindow', () => {
  it('matches known model windows before provider defaults', () => {
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.5')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4-mini')).toBe(400_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'gpt-5.4-nano')).toBe(128_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'claude-opus-5')).toBe(1_000_000);
    expect(effectiveModelContextWindow({ type: 'tui' }, 'global.anthropic.claude-opus-5')).toBe(1_000_000);
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
    // Multimodal models whose id carries no `vl`/`vision` marker (Muse Glimmer,
    // Ministral 3) are invisible to the regex — without the authoritative map a
    // user whose only VLMs are those gets an empty picker.
    expect(visionLocalModelFilter('muse-glimmer:30b', ollama)).toBe(false);
    expect(visionLocalModelFilter('muse-glimmer:30b', ollama, { ollama: new Set(['muse-glimmer:30b']) })).toBe(true);
    expect(visionLocalModelFilter('qwen3.6:35b', ollama, { ollama: new Set(['qwen3.6:35b']) })).toBe(true);
  });

  it('unions rather than replaces — the map never vetoes a regex match', () => {
    // Fetched-but-empty (no local VLM reported) still keeps regex matches, and a
    // map that omits a model the regex knows must not hide it.
    expect(visionLocalModelFilter('llava:latest', ollama, { ollama: new Set() })).toBe(true);
    expect(visionLocalModelFilter('llava:latest', ollama, { ollama: new Set(['muse-glimmer:30b']) })).toBe(true);
    // ...and it still can't smuggle a text-only model past the filter.
    expect(visionLocalModelFilter('qwen2.5-coder:32b', ollama, { ollama: new Set(['muse-glimmer:30b']) })).toBe(false);
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
    const localOnly = { ollama: new Set(['muse-glimmer:30b']) };
    expect(visionLocalModelFilter('muse-glimmer:30b', ollama, localOnly)).toBe(true);
    expect(visionLocalModelFilter('muse-glimmer:30b', remote, localOnly)).toBe(false);
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

  it('identifies an inherited OrcaRouter key', () => {
    expect(credentialSource({ id: 'opencode-orcarouter', type: 'cli', orcarouterBacked: true }))
      .toEqual({ kind: 'inherited', ref: 'orcarouter' });
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

  // The toggle is not what's stopping a provider whose CLI is missing, so the
  // missing prerequisite outranks it — that's the bucket the user must act in.
  it('keeps a switched-off provider with a missing prerequisite in the blocked bucket', () => {
    expect(providerCardState(cli({ enabled: false }), { runtime: { label: 'OpenCode CLI', installed: false } }).state)
      .toBe(PROVIDER_CARD_STATE.BLOCKED);
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

// @vitest-environment node
