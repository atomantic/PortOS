import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildCliArgs, stripBrokenModelFlags } from './cliProviderArgs.js';

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
      expect(args).toEqual(['exec', '--model', 'gpt-5', '-']);
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

  describe('stripBrokenModelFlags', () => {
    it('drops dangling / empty model flags but keeps pinned ones', () => {
      expect(stripBrokenModelFlags(['--model'])).toEqual([]);
      expect(stripBrokenModelFlags(['--model='])).toEqual([]);
      expect(stripBrokenModelFlags(['--model', 'x'])).toEqual(['--model', 'x']);
    });
  });
});
