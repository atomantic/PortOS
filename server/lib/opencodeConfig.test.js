import { describe, it, expect } from 'vitest';
import {
  buildOpencodeConfig,
  buildOpencodeConfigContent,
  buildOpencodeEnvVars,
} from './opencodeConfig.js';

describe('buildOpencodeConfig', () => {
  it('returns base config without models map when no model provided', () => {
    const cfg = buildOpencodeConfig(null);
    expect(cfg.permission).toBe('allow');
    expect(cfg.provider.ollama).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
    });
    expect(cfg.models).toBeUndefined();
  });

  it('includes the prefixed model in the models map', () => {
    const cfg = buildOpencodeConfig('ollama/qwen2.5:7b');
    expect(cfg.models).toEqual({
      'ollama/qwen2.5:7b': { name: 'ollama/qwen2.5:7b', tool_call: true },
    });
  });

  it('preserves the model id exactly as passed', () => {
    const cfg = buildOpencodeConfig('ollama/hf.co/user/model:tag');
    expect(cfg.models['ollama/hf.co/user/model:tag']).toBeDefined();
  });
});

describe('buildOpencodeConfigContent', () => {
  it('returns valid JSON', () => {
    const json = buildOpencodeConfigContent('ollama/qwen2.5:7b');
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.models['ollama/qwen2.5:7b']).toEqual({
      name: 'ollama/qwen2.5:7b',
      tool_call: true,
    });
  });

  it('serializes the base config for null model', () => {
    const json = buildOpencodeConfigContent(null);
    const parsed = JSON.parse(json);
    expect(parsed.permission).toBe('allow');
    expect(parsed.models).toBeUndefined();
  });
});

describe('buildOpencodeEnvVars', () => {
  it('returns empty object for non-OpenCode providers', () => {
    const result = buildOpencodeEnvVars({ command: 'claude' }, 'claude-opus-4');
    expect(result).toEqual({});
  });

  it('returns empty object for OpenCode providers without ollamaBacked', () => {
    const result = buildOpencodeEnvVars(
      { command: 'opencode', ollamaBacked: false },
      'anthropic/claude-sonnet'
    );
    expect(result).toEqual({});
  });

  it('returns dynamic OPENCODE_CONFIG_CONTENT for Ollama-backed OpenCode', () => {
    const result = buildOpencodeEnvVars(
      { command: 'opencode', ollamaBacked: true },
      'qwen2.5:7b'
    );
    expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    // prefixOpencodeModel adds the ollama/ prefix
    expect(cfg.models['ollama/qwen2.5:7b']).toEqual({
      name: 'ollama/qwen2.5:7b',
      tool_call: true,
    });
  });

  it('handles absolute path to opencode binary', () => {
    const result = buildOpencodeEnvVars(
      { command: '/opt/homebrew/bin/opencode', ollamaBacked: true },
      'qwen2.5:7b'
    );
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.models['ollama/qwen2.5:7b']).toBeDefined();
  });

  it('handles null model gracefully', () => {
    const result = buildOpencodeEnvVars(
      { command: 'opencode', ollamaBacked: true },
      null
    );
    expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.models).toBeUndefined();
  });
});
