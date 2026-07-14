import { describe, it, expect, vi } from 'vitest';
import {
  ANTIGRAVITY_CONFIGURED_DEFAULT,
  CODEX_CONFIGURED_DEFAULT,
  GROK_CONFIGURED_DEFAULT,
  isCodexConfiguredDefault,
  isConfiguredDefaultModel,
  resolveCliModel,
  filterSelectableModels,
  hasModelFlag,
  extractBakedModel,
  isBedrockEnabled,
  hasBedrockRegionPrefix,
  toBedrockModelId,
  resolveBedrockCliModel,
  prefixOpencodeModel,
  isOpencodeCommand,
  isClaudeCommand,
  isOllamaClaudeProvider,
  applyLeanClaudeArgs,
  LEAN_CLAUDE_ARGS,
  commandBasename,
  providerSuppliesGithubToken,
  CLAUDE_EFFORT_LEVELS,
  CODEX_EFFORT_LEVELS,
  EFFORT_LEVELS,
  effortLevelsForProvider,
  resolveCliEffort,
  hasEffortFlag,
  buildEffortArgs,
  CODEX_UPDATE_CHECK_KEY,
  hasCodexUpdateCheckConfig,
  buildCodexStartupArgs,
  isCodexProvider
} from './providerModels.js';

describe('providerModels', () => {
  describe('providerSuppliesGithubToken', () => {
    it('is true when envVars carries GH_TOKEN or GITHUB_TOKEN (even if empty-string)', () => {
      expect(providerSuppliesGithubToken({ envVars: { GH_TOKEN: 'x' } })).toBe(true);
      expect(providerSuppliesGithubToken({ envVars: { GITHUB_TOKEN: 'x' } })).toBe(true);
      // `in` check, not truthiness: an intentionally-empty override still counts.
      expect(providerSuppliesGithubToken({ envVars: { GH_TOKEN: '' } })).toBe(true);
    });

    it('is false when the provider has no github credential in envVars', () => {
      expect(providerSuppliesGithubToken({ envVars: { OTHER: 'x' } })).toBe(false);
      expect(providerSuppliesGithubToken({ envVars: {} })).toBe(false);
      expect(providerSuppliesGithubToken({})).toBe(false);
      expect(providerSuppliesGithubToken(null)).toBe(false);
      expect(providerSuppliesGithubToken(undefined)).toBe(false);
    });
  });

  describe('commandBasename', () => {
    it('strips directory prefixes, lowercases, and drops a .exe suffix', () => {
      expect(commandBasename('grok')).toBe('grok');
      expect(commandBasename('/opt/homebrew/bin/Grok')).toBe('grok');
      expect(commandBasename('C:\\tools\\GROK.exe')).toBe('grok');
      expect(commandBasename('./bin/opencode')).toBe('opencode');
    });

    it('returns empty string for empty/non-string input', () => {
      expect(commandBasename('')).toBe('');
      expect(commandBasename(null)).toBe('');
      expect(commandBasename(undefined)).toBe('');
      expect(commandBasename(42)).toBe('');
    });
  });

  describe('isCodexConfiguredDefault', () => {
    it('matches the sentinel exactly', () => {
      expect(isCodexConfiguredDefault(CODEX_CONFIGURED_DEFAULT)).toBe(true);
      expect(isCodexConfiguredDefault('codex-configured-default')).toBe(true);
    });

    it('rejects everything else', () => {
      expect(isCodexConfiguredDefault('gpt-5')).toBe(false);
      expect(isCodexConfiguredDefault('')).toBe(false);
      expect(isCodexConfiguredDefault(null)).toBe(false);
      expect(isCodexConfiguredDefault(undefined)).toBe(false);
    });
  });

  describe('isOpencodeCommand', () => {
    it('matches the bare binary, a path, and a Windows .exe', () => {
      expect(isOpencodeCommand('opencode')).toBe(true);
      expect(isOpencodeCommand('/opt/homebrew/bin/opencode')).toBe(true);
      expect(isOpencodeCommand('./bin/opencode')).toBe(true);
      expect(isOpencodeCommand('C:\\tools\\opencode.exe')).toBe(true);
    });

    it('rejects other commands, batch shims, and non-strings', () => {
      expect(isOpencodeCommand('claude')).toBe(false);
      expect(isOpencodeCommand('/usr/bin/codex')).toBe(false);
      expect(isOpencodeCommand('opencode-wrapper')).toBe(false);
      // .cmd/.bat shims aren't directly spawnable (shell:false), so not matched
      expect(isOpencodeCommand('opencode.cmd')).toBe(false);
      expect(isOpencodeCommand('')).toBe(false);
      expect(isOpencodeCommand(null)).toBe(false);
      expect(isOpencodeCommand(undefined)).toBe(false);
    });
  });

  describe('prefixOpencodeModel', () => {
    const oc = { command: 'opencode', ollamaBacked: true };

    it('namespaces for a path-configured opencode binary (not just the bare command)', () => {
      expect(prefixOpencodeModel({ command: '/opt/homebrew/bin/opencode', ollamaBacked: true }, 'qwen2.5:7b')).toBe('ollama/qwen2.5:7b');
    });

    it('namespaces a bare Ollama id under ollama/ for ollama-backed opencode providers', () => {
      expect(prefixOpencodeModel(oc, 'qwen2.5:7b')).toBe('ollama/qwen2.5:7b');
    });

    it('is idempotent — an already-namespaced id is returned unchanged', () => {
      expect(prefixOpencodeModel(oc, 'ollama/qwen2.5:7b')).toBe('ollama/qwen2.5:7b');
    });

    it('namespaces a slash-bearing Ollama id (opencode splits on the first slash)', () => {
      expect(prefixOpencodeModel(oc, 'hf.co/user/model:tag')).toBe('ollama/hf.co/user/model:tag');
    });

    it('does NOT prefix a non-ollama-backed opencode provider (keeps its qualified id)', () => {
      // A user-configured OpenCode provider on another backend stores an
      // already-qualified provider/model id — prefixing would mis-route it.
      const ocOther = { command: 'opencode' };
      expect(prefixOpencodeModel(ocOther, 'openai/gpt-4o')).toBe('openai/gpt-4o');
      expect(prefixOpencodeModel({ command: 'opencode', ollamaBacked: false }, 'anthropic/claude-sonnet')).toBe('anthropic/claude-sonnet');
    });

    it('is a no-op for non-opencode providers', () => {
      expect(prefixOpencodeModel({ command: 'claude', ollamaBacked: true }, 'qwen2.5:7b')).toBe('qwen2.5:7b');
      expect(prefixOpencodeModel({ command: 'codex' }, 'gpt-5')).toBe('gpt-5');
    });

    it('is a no-op for empty / nullish models', () => {
      expect(prefixOpencodeModel(oc, '')).toBe('');
      expect(prefixOpencodeModel(oc, null)).toBeNull();
      expect(prefixOpencodeModel(oc, undefined)).toBeUndefined();
    });
  });

  describe('resolveCliModel', () => {
    it('returns null for configured-default sentinels so --model is omitted', () => {
      expect(resolveCliModel(CODEX_CONFIGURED_DEFAULT)).toBeNull();
      expect(resolveCliModel(ANTIGRAVITY_CONFIGURED_DEFAULT)).toBeNull();
      expect(resolveCliModel(GROK_CONFIGURED_DEFAULT)).toBeNull();
    });

    it('returns null for empty / nullish values', () => {
      expect(resolveCliModel(null)).toBeNull();
      expect(resolveCliModel(undefined)).toBeNull();
      expect(resolveCliModel('')).toBeNull();
    });

    it('returns the model string when concrete', () => {
      expect(resolveCliModel('gpt-5')).toBe('gpt-5');
      expect(resolveCliModel('claude-opus-4-7')).toBe('claude-opus-4-7');
    });
  });

  describe('effortLevelsForProvider', () => {
    it('returns codex levels for the codex id or command (path/exe tolerant)', () => {
      expect(effortLevelsForProvider({ id: 'codex', command: 'codex' })).toBe(CODEX_EFFORT_LEVELS);
      expect(effortLevelsForProvider({ id: 'my-codex', command: '/opt/homebrew/bin/codex' })).toBe(CODEX_EFFORT_LEVELS);
      expect(effortLevelsForProvider({ id: 'custom', command: 'Codex.exe' })).toBe(CODEX_EFFORT_LEVELS);
    });

    it('returns claude levels for claude-code* ids and the claude command', () => {
      expect(effortLevelsForProvider({ id: 'claude-code', command: 'claude' })).toBe(CLAUDE_EFFORT_LEVELS);
      expect(effortLevelsForProvider({ id: 'claude-code-bedrock', command: 'claude' })).toBe(CLAUDE_EFFORT_LEVELS);
      expect(effortLevelsForProvider({ id: 'claude-code-tui' })).toBe(CLAUDE_EFFORT_LEVELS);
      expect(effortLevelsForProvider({ id: 'claude-ollama', command: '/usr/local/bin/claude' })).toBe(CLAUDE_EFFORT_LEVELS);
    });

    it('returns null for providers without an effort control (and does NOT default blank commands to claude)', () => {
      expect(effortLevelsForProvider({ id: 'antigravity-cli', command: 'agy' })).toBeNull();
      expect(effortLevelsForProvider({ id: 'opencode-ollama', command: 'opencode' })).toBeNull();
      expect(effortLevelsForProvider({ id: 'grok-cli', command: 'grok' })).toBeNull();
      expect(effortLevelsForProvider({ id: 'ollama' })).toBeNull();
      expect(effortLevelsForProvider(null)).toBeNull();
    });

  });

  describe('isCodexProvider', () => {
    it('matches shipped ids and codex command basenames', () => {
      expect(isCodexProvider({ id: 'codex' })).toBe(true);
      expect(isCodexProvider({ id: 'codex-tui' })).toBe(true);
      expect(isCodexProvider({ id: 'custom', command: '/opt/homebrew/bin/codex' })).toBe(true);
      expect(isCodexProvider({ id: 'claude-code', command: 'claude' })).toBe(false);
      expect(isCodexProvider(null)).toBe(false);
    });
  });

  describe('buildEffortArgs', () => {
    it('emits --effort for claude and a -c config pair for codex', () => {
      expect(buildEffortArgs('high', { id: 'claude-code', command: 'claude' })).toEqual(['--effort', 'high']);
      expect(buildEffortArgs('ultra', { id: 'codex', command: 'codex' })).toEqual(['-c', 'model_reasoning_effort=ultra']);
    });

    it('emits the codex shape for a RENAMED codex provider (detection and emission agree)', () => {
      expect(buildEffortArgs('ultra', { id: 'my-codex', command: '/opt/homebrew/bin/codex' }))
        .toEqual(['-c', 'model_reasoning_effort=ultra']);
    });

    it('returns [] when unset, unsupported, or already baked into existing args', () => {
      expect(buildEffortArgs(null, { id: 'codex', command: 'codex' })).toEqual([]);
      expect(buildEffortArgs('high', { id: 'grok-cli', command: 'grok' })).toEqual([]);
      expect(buildEffortArgs('max', { id: 'claude-code', command: 'claude' }, ['--effort', 'low'])).toEqual([]);
    });
  });

  describe('resolveCliEffort', () => {
    it('passes a supported level through for claude and codex', () => {
      expect(resolveCliEffort('high', { id: 'claude-code', command: 'claude' })).toBe('high');
      expect(resolveCliEffort('ultra', { id: 'codex', command: 'codex' })).toBe('ultra');
    });

    it('clamps codex-only values to the claude equivalents on a claude provider', () => {
      expect(resolveCliEffort('minimal', { id: 'claude-code', command: 'claude' })).toBe('low');
      expect(resolveCliEffort('ultra', { id: 'claude-code', command: 'claude' })).toBe('max');
    });

    it('returns null for unset/unknown values and effort-less providers', () => {
      expect(resolveCliEffort(null, { id: 'codex', command: 'codex' })).toBeNull();
      expect(resolveCliEffort('', { id: 'codex', command: 'codex' })).toBeNull();
      expect(resolveCliEffort('bogus', { id: 'codex', command: 'codex' })).toBeNull();
      expect(resolveCliEffort('high', { id: 'grok-cli', command: 'grok' })).toBeNull();
    });
  });

  describe('hasEffortFlag', () => {
    it('detects a baked --effort pin in both arg shapes', () => {
      expect(hasEffortFlag(['--effort', 'high'])).toBe(true);
      expect(hasEffortFlag(['--effort=high'])).toBe(true);
    });

    it('detects a baked codex model_reasoning_effort config pair', () => {
      expect(hasEffortFlag(['-c', 'model_reasoning_effort=high'])).toBe(true);
    });

    it('ignores a dangling --effort with no value and unrelated args', () => {
      expect(hasEffortFlag(['--effort'])).toBe(false);
      expect(hasEffortFlag(['--effort', '--verbose'])).toBe(false);
      expect(hasEffortFlag(['--model', 'gpt-5'])).toBe(false);
      expect(hasEffortFlag(null)).toBe(false);
    });
  });

  describe('hasCodexUpdateCheckConfig', () => {
    it('detects a baked check_for_update_on_startup config pair (any value)', () => {
      expect(hasCodexUpdateCheckConfig(['-c', `${CODEX_UPDATE_CHECK_KEY}=false`])).toBe(true);
      expect(hasCodexUpdateCheckConfig(['-c', `${CODEX_UPDATE_CHECK_KEY}=true`])).toBe(true);
      // separate-arg `--config` long form
      expect(hasCodexUpdateCheckConfig(['--config', `${CODEX_UPDATE_CHECK_KEY}=true`])).toBe(true);
    });

    it('detects the joined `--config=<key>=<v>` / `-c=<key>=<v>` forms', () => {
      expect(hasCodexUpdateCheckConfig([`--config=${CODEX_UPDATE_CHECK_KEY}=true`])).toBe(true);
      expect(hasCodexUpdateCheckConfig([`-c=${CODEX_UPDATE_CHECK_KEY}=false`])).toBe(true);
    });

    it('is false for unrelated args, non-arrays, and non-string elements', () => {
      expect(hasCodexUpdateCheckConfig(['-c', 'model_reasoning_effort=high'])).toBe(false);
      expect(hasCodexUpdateCheckConfig(['exec', '-'])).toBe(false);
      expect(hasCodexUpdateCheckConfig(null)).toBe(false);
      expect(hasCodexUpdateCheckConfig([undefined, 42])).toBe(false);
    });
  });

  describe('buildCodexStartupArgs', () => {
    it('emits the update-check disable pair when nothing is pinned', () => {
      expect(buildCodexStartupArgs()).toEqual(['-c', `${CODEX_UPDATE_CHECK_KEY}=false`]);
      expect(buildCodexStartupArgs(['exec', '-'])).toEqual(['-c', `${CODEX_UPDATE_CHECK_KEY}=false`]);
    });

    it('returns [] when the user already pinned the key (their value wins)', () => {
      expect(buildCodexStartupArgs(['-c', `${CODEX_UPDATE_CHECK_KEY}=true`])).toEqual([]);
      expect(buildCodexStartupArgs([`--config=${CODEX_UPDATE_CHECK_KEY}=true`])).toEqual([]);
    });
  });

  describe('isConfiguredDefaultModel', () => {
    it('matches every configured-default sentinel', () => {
      expect(isConfiguredDefaultModel(CODEX_CONFIGURED_DEFAULT)).toBe(true);
      expect(isConfiguredDefaultModel(ANTIGRAVITY_CONFIGURED_DEFAULT)).toBe(true);
      expect(isConfiguredDefaultModel(GROK_CONFIGURED_DEFAULT)).toBe(true);
      expect(isConfiguredDefaultModel('gpt-5')).toBe(false);
    });
  });

  describe('filterSelectableModels', () => {
    it('strips configured-default sentinels from the list', () => {
      expect(filterSelectableModels([
        'a',
        CODEX_CONFIGURED_DEFAULT,
        ANTIGRAVITY_CONFIGURED_DEFAULT,
        GROK_CONFIGURED_DEFAULT,
        'b',
      ])).toEqual(['a', 'b']);
    });

    it('returns an empty list for nullish input', () => {
      expect(filterSelectableModels(null)).toEqual([]);
      expect(filterSelectableModels(undefined)).toEqual([]);
    });

    it('passes a sentinel-free list through unchanged', () => {
      expect(filterSelectableModels(['a', 'b'])).toEqual(['a', 'b']);
    });
  });

  describe('hasModelFlag', () => {
    it('detects --model with separated value', () => {
      expect(hasModelFlag(['--model', 'gpt-5'])).toBe(true);
    });

    it('detects -m with separated value', () => {
      expect(hasModelFlag(['-m', 'gpt-5'])).toBe(true);
    });

    it('detects joined --model=value', () => {
      expect(hasModelFlag(['--model=gpt-5'])).toBe(true);
    });

    it('detects joined -m=value', () => {
      expect(hasModelFlag(['-m=gpt-5'])).toBe(true);
    });

    it('returns false for separated flag at end of argv', () => {
      expect(hasModelFlag(['--foo', '--model'])).toBe(false);
    });

    it('returns false when separated --model is followed by another flag', () => {
      expect(hasModelFlag(['--model', '--other'])).toBe(false);
    });

    it('returns false for joined form with no value (`--model=`)', () => {
      expect(hasModelFlag(['--model='])).toBe(false);
      expect(hasModelFlag(['-m='])).toBe(false);
    });

    it('returns false for unrelated argv', () => {
      expect(hasModelFlag(['--verbose', 'exec', '-'])).toBe(false);
      expect(hasModelFlag([])).toBe(false);
    });

    it('returns false for non-array input', () => {
      expect(hasModelFlag(null)).toBe(false);
      expect(hasModelFlag('not-an-array')).toBe(false);
    });
  });

  describe('extractBakedModel', () => {
    it('extracts from separated --model form', () => {
      expect(extractBakedModel(['--model', 'gpt-5'])).toBe('gpt-5');
    });

    it('extracts from separated -m form', () => {
      expect(extractBakedModel(['-m', 'gpt-5'])).toBe('gpt-5');
    });

    it('extracts from joined --model=value form', () => {
      expect(extractBakedModel(['--model=gpt-5'])).toBe('gpt-5');
    });

    it('extracts from joined -m=value form', () => {
      expect(extractBakedModel(['-m=gpt-5'])).toBe('gpt-5');
    });

    it('returns null when separated form has no value', () => {
      expect(extractBakedModel(['--model'])).toBeNull();
      expect(extractBakedModel(['--model', '--other'])).toBeNull();
    });

    it('returns null when joined form has empty value', () => {
      expect(extractBakedModel(['--model='])).toBeNull();
      expect(extractBakedModel(['-m='])).toBeNull();
    });

    it('returns null when no model flag is present', () => {
      expect(extractBakedModel(['--verbose', 'exec'])).toBeNull();
      expect(extractBakedModel([])).toBeNull();
    });

    it('returns null for non-array input', () => {
      expect(extractBakedModel(null)).toBeNull();
      expect(extractBakedModel(undefined)).toBeNull();
    });
  });

  it('extractBakedModel returning a value implies hasModelFlag is true', () => {
    // The sound direction: if extractBakedModel finds a real value, the args
    // definitely contain a usable model flag. The reverse direction does NOT
    // hold for adversarial argv shapes — extractBakedModel returns early on
    // the first --model/-m it sees and may give up (returning null) on a
    // valueless first flag even when a later --model has a real value.
    const shapes = [
      ['--model', 'gpt-5'],
      ['-m', 'gpt-5'],
      ['--model=gpt-5'],
      ['-m=gpt-5'],
      ['--model'],
      ['--model='],
      // Adversarial: first flag has no value, second one does. Documents
      // current early-exit behavior — extractBakedModel returns null on the
      // first '--model' (because next is '--other'), so hasModelFlag may
      // disagree with it. We only assert the sound direction.
      ['--model', '--other', '--model', 'gpt-5'],
      // Mixed argv with other tool flags before the model pin.
      ['--temperature', '0.7', '--model', 'gpt-5']
    ];
    for (const args of shapes) {
      const has = hasModelFlag(args);
      const baked = extractBakedModel(args);
      if (baked !== null) {
        expect(has, `args=${JSON.stringify(args)}`).toBe(true);
      }
    }
  });

  describe('isBedrockEnabled', () => {
    it('is true for the documented and common truthy spellings', () => {
      for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'anything']) {
        expect(isBedrockEnabled({ CLAUDE_CODE_USE_BEDROCK: v }), v).toBe(true);
      }
    });
    it('is false for off / unset spellings', () => {
      for (const v of ['0', 'false', 'FALSE', 'no', '', '  ']) {
        expect(isBedrockEnabled({ CLAUDE_CODE_USE_BEDROCK: v }), v).toBe(false);
      }
      expect(isBedrockEnabled({})).toBe(false);
      expect(isBedrockEnabled()).toBe(typeof process.env.CLAUDE_CODE_USE_BEDROCK !== 'undefined'
        ? isBedrockEnabled(process.env) : false);
    });
  });

  describe('hasBedrockRegionPrefix', () => {
    it('recognizes region-prefixed and bare anthropic. forms', () => {
      expect(hasBedrockRegionPrefix('global.anthropic.claude-opus-4-8')).toBe(true);
      expect(hasBedrockRegionPrefix('us.anthropic.claude-opus-4-1-20250805-v1:0')).toBe(true);
      expect(hasBedrockRegionPrefix('eu.anthropic.claude-sonnet-4-6')).toBe(true);
      expect(hasBedrockRegionPrefix('apac.anthropic.claude-haiku-4-5')).toBe(true);
      expect(hasBedrockRegionPrefix('anthropic.claude-opus-4-8-v1:0')).toBe(true);
    });
    it('rejects bare ids and non-strings', () => {
      expect(hasBedrockRegionPrefix('claude-opus-4-8')).toBe(false);
      expect(hasBedrockRegionPrefix('gpt-5')).toBe(false);
      expect(hasBedrockRegionPrefix('')).toBe(false);
      expect(hasBedrockRegionPrefix(null)).toBe(false);
      expect(hasBedrockRegionPrefix(undefined)).toBe(false);
    });
  });

  describe('toBedrockModelId', () => {
    const ON = { CLAUDE_CODE_USE_BEDROCK: '1' };

    it('is a no-op when Bedrock mode is off (every bare id passes through)', () => {
      for (const id of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5', 'gpt-5']) {
        expect(toBedrockModelId(id, {}), id).toBe(id);
        expect(toBedrockModelId(id, { CLAUDE_CODE_USE_BEDROCK: '0' }), id).toBe(id);
      }
    });

    it('prefix-rewrites each bare Claude family when Bedrock is on (no env override)', () => {
      const table = [
        ['claude-opus-4-8', 'global.anthropic.claude-opus-4-8'],
        ['claude-sonnet-4-6', 'global.anthropic.claude-sonnet-4-6'],
        ['claude-fable-5', 'global.anthropic.claude-fable-5'],
        ['claude-haiku-4-5-20251001', 'global.anthropic.claude-haiku-4-5-20251001'],
      ];
      for (const [bare, expected] of table) {
        expect(toBedrockModelId(bare, ON), bare).toBe(expected);
      }
    });

    it('prefers the matching ANTHROPIC_DEFAULT_<FAMILY>_MODEL when it is region-prefixed', () => {
      const env = {
        CLAUDE_CODE_USE_BEDROCK: '1',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'us.anthropic.claude-opus-4-8-20260101-v1:0',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'global.anthropic.claude-sonnet-4-6-v1:0',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5-v1:0',
        ANTHROPIC_DEFAULT_FABLE_MODEL: 'global.anthropic.claude-fable-5-v1:0',
      };
      expect(toBedrockModelId('claude-opus-4-8', env)).toBe('us.anthropic.claude-opus-4-8-20260101-v1:0');
      expect(toBedrockModelId('claude-sonnet-4-6', env)).toBe('global.anthropic.claude-sonnet-4-6-v1:0');
      expect(toBedrockModelId('claude-haiku-4-5-20251001', env)).toBe('us.anthropic.claude-haiku-4-5-v1:0');
      expect(toBedrockModelId('claude-fable-5', env)).toBe('global.anthropic.claude-fable-5-v1:0');
    });

    it('ignores a non-region-prefixed env override and falls back to prefix-rewrite', () => {
      const env = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-8' };
      expect(toBedrockModelId('claude-opus-4-8', env)).toBe('global.anthropic.claude-opus-4-8');
    });

    it('is a no-op for ids already carrying a region / anthropic. prefix', () => {
      for (const id of [
        'global.anthropic.claude-opus-4-5-20251101-v1:0',
        'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'anthropic.claude-opus-4-8-v1:0',
      ]) {
        expect(toBedrockModelId(id, ON), id).toBe(id);
      }
    });

    it('leaves non-Claude ids untouched even with Bedrock on (must contain "claude")', () => {
      for (const id of [
        'gpt-5', 'gemini-2.5-pro', 'o1-preview',
        // A custom alias that merely contains a family word but isn't a Claude
        // id must NOT be rewritten (would otherwise become global.anthropic.*).
        'sonnet', 'my-sonnet-lora', 'opus-tune-v2',
      ]) {
        expect(toBedrockModelId(id, ON), id).toBe(id);
      }
    });

    it('passes through empty / non-string ids', () => {
      expect(toBedrockModelId('', ON)).toBe('');
      expect(toBedrockModelId(null, ON)).toBeNull();
      expect(toBedrockModelId(undefined, ON)).toBeUndefined();
    });
  });

  describe('resolveBedrockCliModel', () => {
    it('returns the mapped id and warns once per provider+model', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const opts = { env: { CLAUDE_CODE_USE_BEDROCK: '1' }, providerId: 'claude-code-resolve-test' };
      const first = resolveBedrockCliModel('claude-opus-4-8', opts);
      const second = resolveBedrockCliModel('claude-opus-4-8', opts);
      expect(first).toBe('global.anthropic.claude-opus-4-8');
      expect(second).toBe('global.anthropic.claude-opus-4-8');
      // Deduped: only the first rewrite of this provider+model logs.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(/CLAUDE_CODE_USE_BEDROCK/);
      spy.mockRestore();
    });

    it('does not warn when the id is unchanged (off Bedrock, or already prefixed)', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(resolveBedrockCliModel('claude-opus-4-8', { env: {} })).toBe('claude-opus-4-8');
      expect(resolveBedrockCliModel('us.anthropic.claude-opus-4-7-v1:0', { env: { CLAUDE_CODE_USE_BEDROCK: '1' } }))
        .toBe('us.anthropic.claude-opus-4-7-v1:0');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('isClaudeCommand', () => {
    it('matches bare, pathed, and Windows forms of the claude binary', () => {
      expect(isClaudeCommand('claude')).toBe(true);
      expect(isClaudeCommand('/opt/homebrew/bin/claude')).toBe(true);
      expect(isClaudeCommand('C:\\tools\\Claude.EXE')).toBe(true);
    });

    it('treats an empty/null command as claude (the spawners default to it)', () => {
      expect(isClaudeCommand('')).toBe(true);
      expect(isClaudeCommand(null)).toBe(true);
      expect(isClaudeCommand(undefined)).toBe(true);
    });

    it('rejects other binaries and non-strings', () => {
      expect(isClaudeCommand('opencode')).toBe(false);
      expect(isClaudeCommand('codex')).toBe(false);
      expect(isClaudeCommand('/usr/bin/claudette')).toBe(false);
      expect(isClaudeCommand(42)).toBe(false);
    });
  });

  describe('isOllamaClaudeProvider', () => {
    it('requires BOTH the ollamaBacked marker and a claude command', () => {
      expect(isOllamaClaudeProvider({ ollamaBacked: true, command: 'claude' })).toBe(true);
      expect(isOllamaClaudeProvider({ ollamaBacked: true, command: 'opencode' })).toBe(false);
      expect(isOllamaClaudeProvider({ command: 'claude' })).toBe(false);
      expect(isOllamaClaudeProvider(null)).toBe(false);
    });

    it('honors an explicitly resolved command over provider.command', () => {
      expect(isOllamaClaudeProvider({ ollamaBacked: true, command: '' }, 'claude')).toBe(true);
      expect(isOllamaClaudeProvider({ ollamaBacked: true, command: '' }, 'codex')).toBe(false);
    });
  });

  describe('applyLeanClaudeArgs', () => {
    const ollamaClaude = { ollamaBacked: true, command: 'claude' };

    it('appends --bare and --strict-mcp-config for Ollama-backed claude providers', () => {
      expect(applyLeanClaudeArgs(ollamaClaude, ['--dangerously-skip-permissions']))
        .toEqual(['--dangerously-skip-permissions', ...LEAN_CLAUDE_ARGS]);
    });

    it('is idempotent against user-baked lean flags', () => {
      expect(applyLeanClaudeArgs(ollamaClaude, ['--bare'])).toEqual(['--bare', '--strict-mcp-config']);
      expect(applyLeanClaudeArgs(ollamaClaude, [...LEAN_CLAUDE_ARGS])).toEqual([...LEAN_CLAUDE_ARGS]);
    });

    it('is a no-op for non-Ollama or non-claude providers', () => {
      const args = ['--dangerously-skip-permissions'];
      expect(applyLeanClaudeArgs({ command: 'claude' }, args)).toBe(args);
      expect(applyLeanClaudeArgs({ ollamaBacked: true, command: 'opencode' }, args)).toBe(args);
    });
  });
});
