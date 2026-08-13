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
  isCodexProvider,
  supportsModelRefresh,
  isAntigravityProvider,
  effortLevelsForProvider,
  resolveCliEffort,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  ANTIGRAVITY_EFFORT_LEVELS,
  isConfiguredDefaultModel,
  configuredDefaultIn,
  isLocalEndpoint,
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
    ['codex accepts its whole ladder', 'ultra', CODEX, 'ultra'],
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
    ['grok (no effort control)', { id: 'grok-cli', command: 'grok' }, null],
    ['blank command is not claude', { id: 'ollama' }, null],
  ];

  it.each(CASES)('%s', (_label, provider, expected) => {
    expect(effortLevelsForProvider(provider)).toEqual(expected);
    expect(serverEffortLevelsForProvider(provider)).toEqual(expected);
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
    // Frozen from the pre-#3620 dispatch chains — the refactor must not change
    // WHICH shipped provider offers the button.
    expect(withButton).toEqual([
      'antigravity-cli', 'antigravity-tui', 'cerebras', 'claude-code',
      'claude-code-bedrock', 'claude-ollama', 'claude-ollama-tui', 'cursor-cli',
      'cursor-tui', 'grok', 'lmstudio', 'nvidia-kimi', 'ollama',
      'opencode-ollama', 'opencode-ollama-tui',
    ]);
  });
});

describe('cursor providers', () => {
  it('offers no effort ladder — cursor bakes the reasoning tier into the model id', () => {
    expect(effortLevelsForProvider({ id: 'cursor-cli', command: 'cursor-agent' })).toBeNull();
    expect(effortLevelsForProvider({ id: 'cursor-tui', command: 'cursor-agent' }, 'claude-opus-5-thinking-high')).toBeNull();
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
});
