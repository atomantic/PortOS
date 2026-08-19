import { describe, it, expect } from 'vitest';
import {
  buildOpencodeConfig,
  buildOpencodeConfigContent,
  buildOpencodeEnvVars,
  toBareModelIds,
} from './opencodeConfig.js';

describe('toBareModelIds', () => {
  it('strips the ollama/ namespace, drops empties, and dedupes', () => {
    expect(toBareModelIds(['ollama/qwen2.5:7b', 'qwen2.5:7b', '', null, 'llama3.1:8b']))
      .toEqual(['qwen2.5:7b', 'llama3.1:8b']);
  });

  it('accepts a single id', () => {
    expect(toBareModelIds('ollama/mistral:7b')).toEqual(['mistral:7b']);
  });

  it('keeps a slash-bearing id intact after stripping only the leading namespace', () => {
    expect(toBareModelIds('ollama/hf.co/user/model:tag')).toEqual(['hf.co/user/model:tag']);
  });

  it('strips the MTPLX namespace without treating slash-bearing ids as providers', () => {
    expect(toBareModelIds(['mtplx/mtplx', 'mtplx/qwen/model'], 'mtplx'))
      .toEqual(['mtplx', 'qwen/model']);
  });

  it('keeps OrcaRouter stored ids unchanged for the models map', () => {
    expect(toBareModelIds(['orcarouter/auto', 'anthropic/claude-sonnet-4.6'], 'orcarouter'))
      .toEqual(['orcarouter/auto', 'anthropic/claude-sonnet-4.6']);
  });

  it('rejects an unknown local provider key instead of silently using Ollama', () => {
    expect(() => toBareModelIds('model', 'unknown')).toThrow(/unsupported opencode local provider/i);
  });
});

describe('buildOpencodeConfig', () => {
  it('returns base config without a models map when no model provided', () => {
    const cfg = buildOpencodeConfig(null);
    expect(cfg.permission).toBe('allow');
    expect(cfg.provider.ollama).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
    });
    // no top-level models key, and none under the provider
    expect(cfg.models).toBeUndefined();
    expect(cfg.provider.ollama.models).toBeUndefined();
  });

  it('declares the BARE model id under provider.ollama.models (not a top-level map)', () => {
    const cfg = buildOpencodeConfig('ollama/qwen2.5:7b');
    // OpenCode has no top-level models map — it must be nested per-provider
    expect(cfg.models).toBeUndefined();
    expect(cfg.provider.ollama.models).toEqual({
      'qwen2.5:7b': { name: 'qwen2.5:7b', tool_call: true },
    });
  });

  it('declares multiple models with bare keys', () => {
    const cfg = buildOpencodeConfig(['ollama/qwen2.5:7b', 'llama3.1:8b']);
    expect(Object.keys(cfg.provider.ollama.models).sort()).toEqual(['llama3.1:8b', 'qwen2.5:7b']);
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toEqual({ name: 'qwen2.5:7b', tool_call: true });
  });

  it('preserves a slash-bearing bare model id', () => {
    const cfg = buildOpencodeConfig('ollama/hf.co/user/model:tag');
    expect(cfg.provider.ollama.models['hf.co/user/model:tag']).toBeDefined();
  });

  it('preserves a custom base config (baseURL, permission, extra keys) and unions its existing models', () => {
    const base = {
      permission: 'ask',
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Remote Ollama',
          options: { baseURL: 'http://gpu-box:11434/v1' },
          models: { 'kept:70b': { name: 'kept:70b', tool_call: true } },
        },
      },
    };
    const cfg = buildOpencodeConfig('qwen2.5:7b', base);
    expect(cfg.permission).toBe('ask');
    expect(cfg.provider.ollama.options.baseURL).toBe('http://gpu-box:11434/v1');
    // hand-maintained model kept, runtime model added
    expect(cfg.provider.ollama.models['kept:70b']).toBeDefined();
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toEqual({ name: 'qwen2.5:7b', tool_call: true });
    // does not mutate the caller's base object
    expect(base.provider.ollama.models['qwen2.5:7b']).toBeUndefined();
  });

  it('declares MTPLX models under provider.mtplx with its local endpoint', () => {
    const cfg = buildOpencodeConfig('mtplx/mtplx', null, 'mtplx');
    expect(cfg.provider.ollama).toBeUndefined();
    expect(cfg.provider.mtplx).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'MTPLX (local MTP)',
      options: { baseURL: 'http://127.0.0.1:8000/v1' },
    });
    expect(cfg.provider.mtplx.models).toEqual({
      mtplx: { name: 'mtplx', tool_call: true },
    });
  });

  it('declares llama models under provider.llama with its local endpoint', () => {
    const cfg = buildOpencodeConfig(['llama/dflash', 'llama/qwen3.8-27b-dflash2'], null, 'llama');
    expect(cfg.provider.ollama).toBeUndefined();
    expect(cfg.provider.llama).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'llama.cpp (local)',
      options: { baseURL: 'http://127.0.0.1:8080/v1' },
    });
    expect(cfg.provider.llama.models).toEqual({
      dflash: { name: 'dflash', tool_call: true },
      'qwen3.8-27b-dflash2': { name: 'qwen3.8-27b-dflash2', tool_call: true },
    });
  });

  it('declares OrcaRouter models under unchanged keys and its gateway endpoint', () => {
    const cfg = buildOpencodeConfig(['orcarouter/auto', 'anthropic/claude-sonnet-4.6'], null, 'orcarouter');
    expect(cfg.provider.orcarouter).toMatchObject({
      npm: '@ai-sdk/openai-compatible',
      name: 'OrcaRouter',
      options: { baseURL: 'https://api.orcarouter.ai/v1' },
    });
    expect(Object.keys(cfg.provider.orcarouter.models).sort()).toEqual([
      'anthropic/claude-sonnet-4.6', 'orcarouter/auto',
    ]);
  });
});

describe('buildOpencodeConfigContent', () => {
  it('returns valid JSON with the models map nested under the provider', () => {
    const json = buildOpencodeConfigContent('ollama/qwen2.5:7b');
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json);
    expect(parsed.provider.ollama.models['qwen2.5:7b']).toEqual({
      name: 'qwen2.5:7b',
      tool_call: true,
    });
  });

  it('serializes the base config (no models) for null model', () => {
    const parsed = JSON.parse(buildOpencodeConfigContent(null));
    expect(parsed.permission).toBe('allow');
    expect(parsed.provider.ollama.models).toBeUndefined();
  });
});

describe('buildOpencodeEnvVars', () => {
  it('returns empty object for non-OpenCode providers', () => {
    expect(buildOpencodeEnvVars({ command: 'claude' }, 'claude-opus-4')).toEqual({});
  });

  it('returns empty object for OpenCode providers without ollamaBacked', () => {
    expect(buildOpencodeEnvVars(
      { command: 'opencode', ollamaBacked: false },
      'anthropic/claude-sonnet',
    )).toEqual({});
  });

  it('declares the run model (bare) under provider.ollama.models', () => {
    const result = buildOpencodeEnvVars({ command: 'opencode', ollamaBacked: true, models: [], temperature: 0.6, thinking: false }, 'qwen2.5:7b');
    expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toEqual({ name: 'qwen2.5:7b', tool_call: true });
    expect(cfg.agent.build).toEqual({ temperature: 0.6, think: false });
  });

  it('passes a task-level reasoning effort through to Ollama', () => {
    const cfg = buildOpencodeConfig('qwen2.5:7b', null, 'ollama', {
      temperature: '0.25',
      thinking: 'true',
      effort: 'high',
    });
    expect(cfg.agent.build).toEqual({ temperature: 0.25, think: true, reasoningEffort: 'high' });
  });

  it('declares the run model under provider.mtplx.models for MTPLX-backed OpenCode', () => {
    const result = buildOpencodeEnvVars({ command: 'opencode', mtplxBacked: true, models: ['mtplx'] }, 'mtplx');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.mtplx.options.baseURL).toBe('http://127.0.0.1:8000/v1');
    expect(cfg.provider.mtplx.models.mtplx).toEqual({ name: 'mtplx', tool_call: true });
  });

  it('injects the sibling OrcaRouter API key only into the composed spawn config', () => {
    const storedConfig = JSON.stringify({
      permission: 'allow',
      provider: { orcarouter: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.orcarouter.ai/v1' } } },
    });
    const result = buildOpencodeEnvVars({
      command: 'opencode',
      orcarouterBacked: true,
      models: ['orcarouter/auto'],
      envVars: { OPENCODE_CONFIG_CONTENT: storedConfig },
      orcarouterApiKey: 'sk-orca-example',
    }, 'orcarouter/auto');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.orcarouter.models['orcarouter/auto']).toEqual({ name: 'orcarouter/auto', tool_call: true });
    expect(cfg.provider.orcarouter.options.apiKey).toBe('sk-orca-example');
    expect(result.ORCAROUTER_API_KEY).toBe('sk-orca-example');
    expect(storedConfig).not.toContain('sk-orca-example');
  });

  it('unions the provider models, defaultModel, and the run model (deduped, bare)', () => {
    const provider = {
      command: 'opencode', ollamaBacked: true,
      models: ['qwen2.5:7b', 'llama3.1:8b'], defaultModel: 'llama3.1:8b',
    };
    const cfg = JSON.parse(buildOpencodeEnvVars(provider, 'mistral:7b').OPENCODE_CONFIG_CONTENT);
    expect(Object.keys(cfg.provider.ollama.models).sort()).toEqual(['llama3.1:8b', 'mistral:7b', 'qwen2.5:7b']);
  });

  it('handles an absolute path to the opencode binary', () => {
    const result = buildOpencodeEnvVars({ command: '/opt/homebrew/bin/opencode', ollamaBacked: true, models: [] }, 'qwen2.5:7b');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toBeDefined();
  });

  it('handles null model gracefully (no models map when nothing is configured)', () => {
    const result = buildOpencodeEnvVars({ command: 'opencode', ollamaBacked: true, models: [] }, null);
    expect(result.OPENCODE_CONFIG_CONTENT).toBeDefined();
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models).toBeUndefined();
  });

  it('falls back to defaultModel when no run model is passed', () => {
    const result = buildOpencodeEnvVars({ command: 'opencode', ollamaBacked: true, models: [], defaultModel: 'qwen2.5:7b' }, null);
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toBeDefined();
  });

  it('preserves a provider-customized stored baseURL instead of replacing it with localhost', () => {
    const provider = {
      command: 'opencode', ollamaBacked: true, models: ['qwen2.5:7b'],
      envVars: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: 'allow',
          provider: { ollama: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://gpu-box:11434/v1' } } },
        }),
      },
    };
    const cfg = JSON.parse(buildOpencodeEnvVars(provider, 'qwen2.5:7b').OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.options.baseURL).toBe('http://gpu-box:11434/v1');
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toBeDefined();
  });

  it('falls back to the canonical default when the stored config is unparseable', () => {
    const provider = {
      command: 'opencode', ollamaBacked: true, models: ['qwen2.5:7b'],
      envVars: { OPENCODE_CONFIG_CONTENT: 'not json' },
    };
    const cfg = JSON.parse(buildOpencodeEnvVars(provider, null).OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.provider.ollama.models['qwen2.5:7b']).toBeDefined();
  });
});
