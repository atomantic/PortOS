import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildCliArgs, stripBrokenModelFlags, prepareCliPrompt } from './cliProviderArgs.js';

describe('cliProviderArgs', () => {
  // buildCliArgs reads process.env for the Bedrock signal; isolate the tests
  // from whatever the host/CI environment happens to set.
  let savedBedrock;
  beforeEach(() => {
    savedBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  });
  afterEach(() => {
    if (savedBedrock === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK;
    else process.env.CLAUDE_CODE_USE_BEDROCK = savedBedrock;
  });

  describe('buildCliArgs — Claude Code (default)', () => {
    it('passes a bare Claude model through unchanged when Bedrock mode is off', () => {
      const args = buildCliArgs({ id: 'claude-code', command: 'claude', defaultModel: 'claude-opus-4-8' });
      expect(args).toEqual(['-p', '-', '--model', 'claude-opus-4-8']);
    });

    it('maps a bare Claude model to its Bedrock form when CLAUDE_CODE_USE_BEDROCK is set (via provider.envVars)', () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const args = buildCliArgs({
        id: 'claude-code',
        command: 'claude',
        defaultModel: 'claude-opus-4-8',
        envVars: { CLAUDE_CODE_USE_BEDROCK: '1' },
      });
      expect(args).toEqual(['-p', '-', '--model', 'global.anthropic.claude-opus-4-8']);
      spy.mockRestore();
    });

    it('leaves an already-region-prefixed Bedrock model untouched', () => {
      const args = buildCliArgs({
        id: 'claude-code-bedrock',
        command: 'claude',
        defaultModel: 'us.anthropic.claude-opus-4-7-v1:0',
        envVars: { CLAUDE_CODE_USE_BEDROCK: '1' },
      });
      expect(args).toEqual(['-p', '-', '--model', 'us.anthropic.claude-opus-4-7-v1:0']);
    });

    it('respects a user-baked --model pin and skips injection (no Bedrock map)', () => {
      const args = buildCliArgs({
        id: 'claude-code',
        command: 'claude',
        defaultModel: 'claude-opus-4-8',
        args: ['--model', 'claude-sonnet-4-6'],
        envVars: { CLAUDE_CODE_USE_BEDROCK: '1' },
      });
      expect(args).toEqual(['--model', 'claude-sonnet-4-6', '-p', '-']);
    });
  });

  describe('buildCliArgs — other vendors are never Bedrock-mapped', () => {
    it('codex model passes through even with Bedrock on', () => {
      const args = buildCliArgs({
        id: 'codex',
        command: 'codex',
        defaultModel: 'gpt-5',
        envVars: { CLAUDE_CODE_USE_BEDROCK: '1' },
      });
      expect(args).toEqual(['exec', '-c', 'check_for_update_on_startup=false', '--model', 'gpt-5', '-']);
    });

    it('passes the selected GPT-5.6 Codex tier to the CLI', () => {
      const args = buildCliArgs({
        id: 'codex', command: 'codex', defaultModel: 'gpt-5.6-sol',
      });
      expect(args).toEqual(['exec', '-c', 'check_for_update_on_startup=false', '--model', 'gpt-5.6-sol', '-']);
    });
  });

  describe('buildCliArgs — OpenCode Ollama', () => {
    it('runs `opencode run -m ollama/<model>` (prompt rides stdin)', () => {
      const args = buildCliArgs({
        id: 'opencode-ollama', command: 'opencode', args: ['run'],
        ollamaBacked: true, defaultModel: 'qwen2.5:7b',
      });
      expect(args).toEqual(['run', '-m', 'ollama/qwen2.5:7b']);
    });

    it('prepends the run subcommand when the saved args dropped it', () => {
      const args = buildCliArgs({
        id: 'opencode-ollama', command: 'opencode', args: [], ollamaBacked: true,
        defaultModel: 'qwen2.5:7b',
      });
      expect(args).toEqual(['run', '-m', 'ollama/qwen2.5:7b']);
    });

    it('omits -m when no model is configured (opencode falls back to its own default)', () => {
      const args = buildCliArgs({ id: 'opencode-ollama', command: 'opencode', args: ['run'], ollamaBacked: true, defaultModel: null });
      expect(args).toEqual(['run']);
    });

    it('respects a user-baked -m pin and skips injection', () => {
      const args = buildCliArgs({
        id: 'opencode-ollama', command: 'opencode', args: ['run', '-m', 'ollama/custom'], ollamaBacked: true,
        defaultModel: 'qwen2.5:7b',
      });
      expect(args).toEqual(['run', '-m', 'ollama/custom']);
    });

    it('takes the opencode path for a path-configured binary (not the Claude fallback)', () => {
      const args = buildCliArgs({
        id: 'opencode-ollama', command: '/opt/homebrew/bin/opencode', args: ['run'], ollamaBacked: true,
        defaultModel: 'qwen2.5:7b',
      });
      expect(args).toEqual(['run', '-m', 'ollama/qwen2.5:7b']);
    });
  });

  describe('buildCliArgs — Grok Build CLI', () => {
    it('builds a headless one-shot invocation without --model when using the configured-default sentinel', () => {
      const args = buildCliArgs({ id: 'grok-cli', command: 'grok', defaultModel: 'grok-configured-default' });
      expect(args).toEqual([
        '--output-format', 'plain',
        '--permission-mode', 'bypassPermissions',
        '--prompt-file', '/dev/stdin',
      ]);
      expect(args).not.toContain('--model');
      expect(args).not.toContain('grok-configured-default');
    });

    it('omits the model flag when no defaultModel is set (grok uses its own default)', () => {
      const args = buildCliArgs({ id: 'grok-cli', command: 'grok', defaultModel: null });
      expect(args).toEqual([
        '--output-format', 'plain',
        '--permission-mode', 'bypassPermissions',
        '--prompt-file', '/dev/stdin',
      ]);
    });

    it('injects --model when a concrete model id is set', () => {
      const args = buildCliArgs({ id: 'my-grok', command: '/opt/homebrew/bin/grok', defaultModel: 'grok-code-fast-1' });
      expect(args).toContain('--prompt-file');
      expect(args).toContain('/dev/stdin');
      expect(args).toEqual(expect.arrayContaining(['--model', 'grok-code-fast-1']));
    });

    it('respects a user-baked --output-format and does not inject plain', () => {
      const args = buildCliArgs({ id: 'grok-cli', command: 'grok', args: ['--output-format', 'json'], defaultModel: 'grok-configured-default' });
      expect(args.filter((a) => a === '--output-format')).toHaveLength(1);
      expect(args).toContain('json');
      expect(args).not.toContain('plain');
    });

    it('respects a user-baked --model and does not duplicate it', () => {
      const args = buildCliArgs({ id: 'grok-cli', command: 'grok', args: ['--model', 'grok-code-fast-1'], defaultModel: 'grok-configured-default' });
      expect(args.filter((a) => a === '--model')).toHaveLength(1);
      expect(args).toContain('grok-code-fast-1');
      expect(args).not.toContain('grok-configured-default');
    });

    it('respects a user-baked prompt source and does not append --prompt-file', () => {
      const args = buildCliArgs({ id: 'grok-cli', command: 'grok', args: ['-p', 'hello'], defaultModel: 'grok-configured-default' });
      expect(args).not.toContain('--prompt-file');
      expect(args).not.toContain('/dev/stdin');
    });
  });

  describe('buildCliArgs — Kimi Code CLI', () => {
    it('builds an empty headless argv for the sentinel (seeded args) — no mode flag exists (#4139)', () => {
      const args = buildCliArgs({ id: 'kimi-cli', command: 'kimi', args: [], defaultModel: 'kimi-configured-default' });
      expect(args).toEqual([]);
      expect(args).not.toContain('--model');
      expect(args).not.toContain('kimi-configured-default');
    });

    it('never injects --print or --afk — kimi rejects both outright (#4139)', () => {
      const args = buildCliArgs({ id: 'kimi-cli', command: 'kimi', args: [], defaultModel: 'kimi-k2' });
      expect(args).not.toContain('--print');
      expect(args).not.toContain('--afk');
    });

    it('injects --model when a concrete model id is set (path/exe tolerant)', () => {
      const args = buildCliArgs({ id: 'my-kimi', command: '/opt/homebrew/bin/kimi', args: [], defaultModel: 'kimi-k2' });
      expect(args).toEqual(['--model', 'kimi-k2']);
    });

    it('respects a user-baked --model and does not duplicate it', () => {
      const args = buildCliArgs({ id: 'kimi-cli', command: 'kimi', args: ['--model', 'mine'], defaultModel: 'kimi-configured-default' });
      expect(args.filter((a) => a === '--model')).toHaveLength(1);
      expect(args).toContain('mine');
    });

    it('delivers the prompt as the --prompt argv value (useStdin false)', () => {
      const built = buildCliArgs({ id: 'kimi-cli', command: 'kimi', args: [], defaultModel: 'kimi-configured-default' });
      const { args, useStdin } = prepareCliPrompt('kimi', built, 'write a haiku');
      expect(args).toEqual(['--prompt', 'write a haiku']);
      expect(useStdin).toBe(false);
    });
  });

  describe('buildCliArgs — Cursor Agent CLI', () => {
    it('builds a headless --print --force invocation with the model (seeded args)', () => {
      const args = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--force'], defaultModel: 'auto' });
      expect(args).toEqual(['--print', '--force', '--model', 'auto']);
    });

    it('adds --print and --force when the saved args omit them', () => {
      const args = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: [], defaultModel: null });
      expect(args).toEqual(['--print', '--force']);
    });

    it('is path/exe tolerant', () => {
      const args = buildCliArgs({ id: 'my-cursor', command: '/Users/x/.local/bin/cursor-agent', args: [], defaultModel: 'composer-2.5' });
      expect(args).toEqual(['--print', '--force', '--model', 'composer-2.5']);
    });

    it('respects a user-baked --model and does not duplicate it', () => {
      const args = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--force', '--model', 'mine'], defaultModel: 'auto' });
      expect(args.filter((a) => a === '--model')).toHaveLength(1);
      expect(args).toContain('mine');
      expect(args).not.toContain('auto');
    });

    it('preserves a pinned --auto-review but still clears the trust gate', () => {
      // --auto-review grants approval but NOT trust; without a trust flag cursor
      // exits on "Workspace Trust Required" before doing any work.
      const args = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--auto-review'], defaultModel: null });
      expect(args).toEqual(['--print', '--auto-review', '--trust']);
    });

    it('delivers the prompt over stdin (useStdin true) — cursor reads raw stdin in print mode', () => {
      const built = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: ['--print', '--force'], defaultModel: 'auto' });
      const { args, useStdin } = prepareCliPrompt('cursor-agent', built, 'write a haiku');
      expect(args).toEqual(built);
      expect(useStdin).toBe(true);
    });

    it('does not fall through to the Claude Code branch (no `-p -` stdin marker)', () => {
      const args = buildCliArgs({ id: 'cursor-cli', command: 'cursor-agent', args: [], defaultModel: 'auto' });
      expect(args).not.toContain('-');
    });
  });

  // `provider.effort` is how promptRunner hands a per-run reasoning-effort
  // override down to the arg builders (there is no `effort` parameter on
  // executeCliRun) — see executeProviderRunOnce's providerForRun clone.
  describe('buildCliArgs — provider.effort', () => {
    const AGY_CATALOG = [
      'gemini-3.6-flash-high', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-low',
      'gemini-3.1-pro-high', 'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
    ];

    it('emits --effort for Claude Code', () => {
      expect(buildCliArgs({ id: 'claude-code', command: 'claude', defaultModel: 'claude-opus-5', effort: 'max' }))
        .toEqual(['-p', '-', '--model', 'claude-opus-5', '--effort', 'max']);
    });

    it('emits the -c config pair for Codex', () => {
      expect(buildCliArgs({ id: 'codex', command: 'codex', defaultModel: 'gpt-5', effort: 'xhigh' }))
        .toEqual([
          'exec', '-c', 'check_for_update_on_startup=false',
          '--model', 'gpt-5', '-c', 'model_reasoning_effort=xhigh', '-',
        ]);
    });

    it('emits a base --model plus --effort for Antigravity', () => {
      expect(buildCliArgs({
        id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.6-flash', effort: 'high', models: AGY_CATALOG,
      })).toEqual(['--model', 'gemini-3.6-flash', '--effort', 'high', '--dangerously-skip-permissions', '--print']);
    });

    it('clamps an Antigravity effort the selected model does not offer', () => {
      // agy errors on `--model gemini-3.1-pro --effort medium`.
      expect(buildCliArgs({
        id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.1-pro', effort: 'medium', models: AGY_CATALOG,
      })).toEqual(['--model', 'gemini-3.1-pro', '--effort', 'low', '--dangerously-skip-permissions', '--print']);
    });

    it('splits a legacy suffixed Antigravity model into base + --effort', () => {
      expect(buildCliArgs({
        id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.6-flash-medium', models: AGY_CATALOG,
      })).toEqual(['--model', 'gemini-3.6-flash', '--effort', 'medium', '--dangerously-skip-permissions', '--print']);
    });

    // #4110: mirrors runCliProviderPrompt's `[...buildCliArgs(p), ...extraArgs]` — agy's
    // print flag is a bare trailing marker at build time, so extraArgs land past
    // it and prepareCliPrompt has to re-anchor `--print <prompt>` at the end.
    it('keeps --print + prompt final for Antigravity even with trailing extraArgs', () => {
      const provider = { id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.6-flash', models: AGY_CATALOG };
      const extraArgs = ['--include-directories', '/srv/example'];
      const built = [...buildCliArgs(provider), ...extraArgs];
      const { args, useStdin } = prepareCliPrompt('agy', built, 'write a haiku');
      expect(args.slice(-2)).toEqual(['--print', 'write a haiku']);
      expect(args.filter((a) => a === '--print')).toHaveLength(1);
      for (const extra of extraArgs) expect(args.indexOf(extra)).toBeLessThan(args.indexOf('--print'));
      expect(useStdin).toBe(false);
    });

    it('is unchanged for Antigravity with no extraArgs', () => {
      const provider = { id: 'antigravity-cli', command: 'agy', defaultModel: 'gemini-3.6-flash', models: AGY_CATALOG };
      const { args } = prepareCliPrompt('agy', buildCliArgs(provider), 'write a haiku');
      expect(args).toEqual([
        '--model', 'gemini-3.6-flash', '--dangerously-skip-permissions', '--print', 'write a haiku',
      ]);
    });

    it('is a no-op for providers with no effort control', () => {
      expect(buildCliArgs({ id: 'opencode', command: 'opencode', defaultModel: 'qwen3', effort: 'high' }))
        .toEqual(['run', '-m', 'qwen3']);
      expect(buildCliArgs({ id: 'grok-cli', command: 'grok', defaultModel: 'grok-4', effort: 'high' }))
        .not.toContain('--effort');
    });

    it('lets a user-baked --effort pin win', () => {
      expect(buildCliArgs({
        id: 'claude-code', command: 'claude', defaultModel: 'claude-opus-5', effort: 'max', args: ['--effort', 'low'],
      })).toEqual(['--effort', 'low', '-p', '-', '--model', 'claude-opus-5']);
    });
  });

  describe('stripBrokenModelFlags', () => {
    it('drops dangling / empty model flags but keeps pinned ones', () => {
      expect(stripBrokenModelFlags(['--model'])).toEqual([]);
      expect(stripBrokenModelFlags(['--model='])).toEqual([]);
      expect(stripBrokenModelFlags(['--model', 'x'])).toEqual(['--model', 'x']);
    });
  });
});
