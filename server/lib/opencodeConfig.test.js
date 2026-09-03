import { describe, it, expect } from 'vitest';
import {
  buildAgentGeneration,
  buildOpencodeConfig,
  buildOpencodeConfigContent,
  buildOpencodeEnvVars,
  opencodeLocalBaseUrl,
  toBareModelIds,
} from './opencodeConfig.js';
import { LOCAL_RUNTIMES } from './localProviderRuntime.js';

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
      options: { baseURL: 'http://127.0.0.1:5568/v1' },
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

  // `OPENCODE_CONFIG_CONTENT` REPLACES the user's own ~/.config/opencode, so a
  // hand-made plain `opencode` record that declares nothing must keep getting
  // nothing — synthesizing a config would drop every provider it defines.
  it('injects nothing for a namespace-less provider that stores no config', () => {
    expect(buildOpencodeEnvVars(
      { command: 'opencode', ollamaBacked: false },
      'anthropic/claude-sonnet',
    )).toEqual({});
  });

  // A namespace-less record that DOES ship a config is the harness's own catalog
  // (the seeded OpenCode Zen wrappers): nothing to declare and no key to inject,
  // but it still needs the `small_model` pin so OpenCode's own side work stays
  // on the dispatched model instead of its built-in default.
  it('declares no provider entry for a namespace-less OpenCode provider', () => {
    const result = buildOpencodeEnvVars(
      {
        command: 'opencode',
        envVars: { OPENCODE_CONFIG_CONTENT: '{"permission":"allow"}' },
      },
      'opencode/big-pickle',
    );
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg).toEqual({ permission: 'allow', small_model: 'opencode/big-pickle' });
    expect(cfg.provider).toBeUndefined();
    // No gateway key env var rides along — OpenCode authenticates Zen itself.
    expect(Object.keys(result)).toEqual(['OPENCODE_CONFIG_CONTENT']);
  });

  it('preserves a stored config and its small_model pin for a namespace-less provider', () => {
    const stored = JSON.stringify({ permission: 'ask', small_model: 'opencode/mimo-v2.5-free' });
    const result = buildOpencodeEnvVars(
      { command: 'opencode', envVars: { OPENCODE_CONFIG_CONTENT: stored } },
      'opencode/big-pickle',
    );
    expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT)).toEqual({
      permission: 'ask',
      small_model: 'opencode/mimo-v2.5-free',
    });
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

  it('sends llama.cpp its generation defaults, routing thinking through the chat template', () => {
    // The OpenCode llama TUI is the headline case: llama.cpp has no native
    // `think` flag, so a toggle emitted as Ollama's would be silently dropped.
    const result = buildOpencodeEnvVars(
      { command: 'opencode', llamaBacked: true, models: [], temperature: 0.2, topP: 0.9, thinking: true, effort: 'high' },
      'qwen3.8-27b',
    );
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.agent.build).toEqual({
      temperature: 0.2,
      topP: 0.9,
      chat_template_kwargs: { enable_thinking: true },
      reasoningEffort: 'high',
    });
  });

  it('leaves a llama.cpp provider with no configured generation alone', () => {
    // Only Ollama carries the historical 0.6 default — opening the editor up to
    // the other backends must not start pinning a temperature they never had.
    const result = buildOpencodeEnvVars({ command: 'opencode', llamaBacked: true, models: [] }, 'qwen3.8-27b');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.agent).toBeUndefined();
  });

  it('omits the thinking toggle for OrcaRouter, whose upstreams own it', () => {
    const cfg = buildOpencodeConfig('gpt-5', null, 'orcarouter', { temperature: 0.4, thinking: true });
    expect(cfg.agent.build).toEqual({ temperature: 0.4 });
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

  it('declares the run model under provider.vllm at the container endpoint', () => {
    const result = buildOpencodeEnvVars({ command: 'opencode', vllmBacked: true, models: ['qwen3.8-27b'] }, 'qwen3.8-27b');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.vllm.options.baseURL).toBe('http://127.0.0.1:18020/v1');
    expect(cfg.provider.vllm.models['qwen3.8-27b']).toEqual({ name: 'qwen3.8-27b', tool_call: true });
  });

  it('sends vLLM its generation defaults, routing thinking through the chat template', () => {
    // The container's own chat-template default applied instead until #4765:
    // vLLM had no THINKING_STYLE row, so buildAgentGeneration bailed and dropped
    // temperature and topP with it. `enable_thinking: false` + temperature 0.7
    // is the documented posture for tool-calling agent work on this preset.
    const result = buildOpencodeEnvVars(
      { command: 'opencode', vllmBacked: true, models: [], temperature: 0.7, topP: 0.9, thinking: false, effort: 'high' },
      'qwen3.8-27b',
    );
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.agent.build).toEqual({
      temperature: 0.7,
      topP: 0.9,
      chat_template_kwargs: { enable_thinking: false },
      reasoningEffort: 'high',
    });
  });

  it('leaves a vLLM provider with no configured generation alone', () => {
    // Only Ollama carries the historical 0.6 default; an unset control must stay
    // unset so the container keeps its own.
    const result = buildOpencodeEnvVars({ command: 'opencode', vllmBacked: true, models: [] }, 'qwen3.8-27b');
    expect(JSON.parse(result.OPENCODE_CONFIG_CONTENT).agent).toBeUndefined();
  });

  it("injects the vLLM container's API key into options.apiKey, and no ORCAROUTER_API_KEY", () => {
    const result = buildOpencodeEnvVars({
      command: 'opencode',
      vllmBacked: true,
      models: ['qwen3.8-27b'],
      apiKey: 'vllm-key-example',
    }, 'qwen3.8-27b');
    const cfg = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.vllm.options.apiKey).toBe('vllm-key-example');
    // The OrcaRouter env var is that vendor's, not a generic key channel.
    expect(result.ORCAROUTER_API_KEY).toBeUndefined();
  });

  it('leaves options.apiKey off a keyless local namespace even when the provider carries a key', () => {
    const cfg = JSON.parse(buildOpencodeEnvVars({
      command: 'opencode', mtplxBacked: true, models: ['mtplx'], apiKey: 'should-not-leak',
    }, 'mtplx').OPENCODE_CONFIG_CONTENT);
    expect(cfg.provider.mtplx.options.apiKey).toBeUndefined();
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

// A local runtime OpenCode can be pointed at but that has no THINKING_STYLE row
// does not merely lose its thinking checkbox: `buildAgentGeneration` bails on
// the missing key and returns null, taking temperature, topP and
// reasoningEffort with it. That is how the seeded vLLM providers shipped with
// every generation control silently discarded (#4765). Walk LOCAL_RUNTIMES so a
// seventh runtime cannot land with the same hole.
describe('every OpenCode-reachable local runtime forwards generation controls', () => {
  // LM Studio is skipped deliberately — nothing spawns OpenCode against it, so
  // it has no provider entry (and no base URL) in opencodeConfig's table.
  const opencodeRuntimes = Object.keys(LOCAL_RUNTIMES).filter((id) => opencodeLocalBaseUrl(id));

  it('actually walks the runtimes (a degenerate filter would pass vacuously)', () => {
    expect(opencodeRuntimes).toEqual(expect.arrayContaining(['vllm', 'sglang']));
    expect(opencodeRuntimes.length).toBeGreaterThanOrEqual(5);
  });

  it.each(opencodeRuntimes)('%s', (id) => {
    expect(buildAgentGeneration({ temperature: 0.7, topP: 0.9, effort: 'high' }, id))
      .toMatchObject({ temperature: 0.7, topP: 0.9, reasoningEffort: 'high' });
  });
});

describe('SGLang OpenCode config', () => {
  it('declares the sglang namespace at the loopback container endpoint', () => {
    const result = buildOpencodeEnvVars(
      { command: 'opencode', sglangBacked: true, models: ['qwen3.8-27b'] },
      'qwen3.8-27b',
    );
    const config = JSON.parse(result.OPENCODE_CONFIG_CONTENT);
    expect(config.provider.sglang.options.baseURL).toBe('http://127.0.0.1:18021/v1');
    expect(config.provider.sglang.models['qwen3.8-27b']).toEqual({ name: 'qwen3.8-27b', tool_call: true });
  });

  it('routes the thinking toggle through the chat template, like every other local endpoint', () => {
    expect(buildAgentGeneration({ thinking: false }, 'sglang'))
      .toEqual({ chat_template_kwargs: { enable_thinking: false } });
  });

  it('attaches an API key only when the operator set one', () => {
    // SGLang serves unauthenticated unless started with `--api-key`, so a blank
    // key must NOT put an empty `apiKey` into the spawned OpenCode config.
    const blank = JSON.parse(buildOpencodeEnvVars(
      { command: 'opencode', sglangBacked: true, apiKey: '', models: [] }, 'qwen3.8-27b',
    ).OPENCODE_CONFIG_CONTENT);
    expect(blank.provider.sglang.options).not.toHaveProperty('apiKey');

    const keyed = JSON.parse(buildOpencodeEnvVars(
      { command: 'opencode', sglangBacked: true, apiKey: 'operator-key', models: [] }, 'qwen3.8-27b',
    ).OPENCODE_CONFIG_CONTENT);
    expect(keyed.provider.sglang.options.apiKey).toBe('operator-key');
  });
});

describe('small-model pin', () => {
  const gatewayProvider = (extra = {}) => ({
    command: 'opencode',
    gatewayBacked: 'openrouter',
    apiKey: 'sk-or-v1-example',
    models: ['openrouter/auto', 'stealth/ox-alpha'],
    ...extra,
  });

  it('pins OpenCode\'s auxiliary model to the run model so a gateway run bills nothing else', () => {
    const config = JSON.parse(
      buildOpencodeEnvVars(gatewayProvider(), 'stealth/ox-alpha').OPENCODE_CONFIG_CONTENT,
    );
    expect(config.small_model).toBe('openrouter/stealth/ox-alpha');
  });

  it('leaves a stored small_model alone', () => {
    const stored = JSON.stringify({
      permission: 'allow',
      small_model: 'openrouter/anthropic/claude-haiku-4.5',
      provider: { openrouter: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://openrouter.ai/api/v1' } } },
    });
    const config = JSON.parse(
      buildOpencodeEnvVars(gatewayProvider({ envVars: { OPENCODE_CONFIG_CONTENT: stored } }), 'stealth/ox-alpha')
        .OPENCODE_CONFIG_CONTENT,
    );
    expect(config.small_model).toBe('openrouter/anthropic/claude-haiku-4.5');
  });

  it('pins a local runtime too — spawns inherit process.env, so an unset auxiliary model can reach a cloud provider the operator never opted into', () => {
    const config = JSON.parse(
      buildOpencodeEnvVars({ command: 'opencode', ollamaBacked: true, models: ['qwen3'] }, 'qwen3')
        .OPENCODE_CONFIG_CONTENT,
    );
    expect(config.small_model).toBe('ollama/qwen3');
  });
});
