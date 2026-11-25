import { describe, expect, it } from 'vitest';
import { getHarnessContextTarget, harnessContextError, parseHarnessContext } from './harnessContextForm.js';

describe('harness context input', () => {
  it.each([
    ['64K', 65536], ['256k', 262144], ['1M', 1000000], ['512,000', 512000],
    ['  ', null], ['1e6', undefined], ['1,2', undefined], ['511', undefined], ['3M', undefined],
  ])('parses %s without rounding', (raw, count) => {
    expect(parseHarnessContext(raw)).toBe(count);
  });

  it('will not reveal a masked OpenCode configuration', () => {
    const provider = { type: 'cli', command: 'opencode', defaultModel: 'example', splashBacked: true,
      envVars: { OPENCODE_CONFIG_CONTENT: '***' }, secretEnvVars: ['OPENCODE_CONFIG_CONTENT'] };
    expect(getHarnessContextTarget(provider)).toBeNull();
  });

  it('leaves room for OpenCode input and output limits', () => {
    expect(harnessContextError({ output: 8192 }, '8K')).toMatch(/output limit/);
    expect(harnessContextError({ input: 32768, output: 8192 }, '16K')).toMatch(/input limit/);
    expect(harnessContextError({ input: 32768, output: 8192 }, '64K')).toBeNull();
  });
});
