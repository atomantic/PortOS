import { describe, expect, it } from 'vitest';
import { isKnownCliStderrNoise } from './cliStderrNoise.js';

describe('isKnownCliStderrNoise', () => {
  it('drops the claude CLI SDK unrecognized-model telemetry line', () => {
    expect(isKnownCliStderrNoise('[claude-code:unrecognized_model] {"model":"gemma3:27b","query_source":"sdk"}')).toBe(true);
  });

  it('keeps an unrelated stderr line', () => {
    expect(isKnownCliStderrNoise('ECONNREFUSED 127.0.0.1:11434')).toBe(false);
  });
});
