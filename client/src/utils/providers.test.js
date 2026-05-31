import { describe, it, expect } from 'vitest';
import {
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  CODEX_CONFIGURED_DEFAULT,
  PROVIDER_TYPES,
  filterSelectableModels,
  isTuiProvider,
  isCliProvider,
  isApiProvider,
  isProcessProvider,
  isClaudeCodePlanCli,
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
    expect(filterSelectableModels(['gpt-4', CODEX_CONFIGURED_DEFAULT, ANTIGRAVITY_CONFIGURED_DEFAULT, 'gpt-5'])).toEqual(['gpt-4', 'gpt-5']);
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

  it('all predicates safely return false for nullish input', () => {
    expect(isTuiProvider(null)).toBe(false);
    expect(isTuiProvider(undefined)).toBe(false);
    expect(isCliProvider(null)).toBe(false);
    expect(isApiProvider(null)).toBe(false);
    expect(isApiProvider(undefined)).toBe(false);
    expect(isProcessProvider(null)).toBe(false);
  });
});

describe('isClaudeCodePlanCli', () => {
  it('matches a headless claude CLI provider on the plan', () => {
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'claude', envVars: {} })).toBe(true);
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'claude' })).toBe(true);
  });

  it('does not match the interactive Claude Code TUI provider', () => {
    expect(isClaudeCodePlanCli({ type: 'tui', command: 'claude' })).toBe(false);
  });

  it('does not match non-claude CLI providers', () => {
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'gemini' })).toBe(false);
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'codex' })).toBe(false);
  });

  it('excludes Bedrock/Vertex-routed claude CLIs (billed via cloud, not the plan)', () => {
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'claude', envVars: { CLAUDE_CODE_USE_BEDROCK: '1' } })).toBe(false);
    expect(isClaudeCodePlanCli({ type: 'cli', command: 'claude', envVars: { CLAUDE_CODE_USE_VERTEX: '1' } })).toBe(false);
  });

  it('safely returns false for nullish input', () => {
    expect(isClaudeCodePlanCli(null)).toBe(false);
    expect(isClaudeCodePlanCli(undefined)).toBe(false);
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
