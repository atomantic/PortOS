import { describe, expect, it } from 'vitest';
import { applyTaskGenerationOverrides } from './taskGenerationOverrides.js';
import { buildOpencodeEnvVars } from './opencodeConfig.js';

describe('applyTaskGenerationOverrides', () => {
  it('preserves a non-enumerable gateway key on the execution copy', () => {
    const provider = {
      id: 'opencode-nvidia-nim-tui',
      command: 'opencode',
      gatewayBacked: 'nvidia-nim',
      models: ['moonshotai/kimi-k3'],
      defaultModel: 'moonshotai/kimi-k3',
      effort: 'medium',
    };
    Object.defineProperty(provider, 'apiKey', {
      value: 'nvapi-test-key',
      enumerable: false,
      configurable: true,
    });

    const overridden = applyTaskGenerationOverrides(provider, { effort: 'high' });

    expect(overridden).not.toBe(provider);
    expect(overridden.apiKey).toBe('nvapi-test-key');
    expect(Object.keys(overridden)).not.toContain('apiKey');
    expect(overridden.effort).toBe('high');

    const env = buildOpencodeEnvVars(overridden, 'moonshotai/kimi-k3');
    expect(env.NVIDIA_API_KEY).toBe('nvapi-test-key');
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider['nvidia-nim'].options.apiKey)
      .toBe('nvapi-test-key');
  });

  it('layers valid overrides without mutating the stored provider', () => {
    const provider = { id: 'opencode-ollama-tui', temperature: 0.6, thinking: true };

    const overridden = applyTaskGenerationOverrides(provider, {
      temperature: '0.2',
      thinking: false,
      effort: ' low ',
    });

    expect(overridden).toMatchObject({ temperature: 0.2, thinking: false, effort: 'low' });
    expect(provider).toEqual({ id: 'opencode-ollama-tui', temperature: 0.6, thinking: true });
  });
});
