import { describe, expect, it } from 'vitest';
import { createVideoDiagnosticTail, normalizeVideoFailure } from './videoFailure.js';

describe('local video diagnostic privacy boundary', () => {
  it('rejects generic exits and progress, retaining only a bounded useful final cause', () => {
    expect(normalizeVideoFailure('Exit code 1')).toBeNull();
    const tail = createVideoDiagnosticTail();
    tail.push('stderr', 'RuntimeError: obsolete exception\n');
    tail.push('stderr', 'x'.repeat(20000));
    tail.push('stdout', 'STAGE:load-model\nSTATUS:working\nprompt: RuntimeError: invented prose\n');
    expect(tail.failure()?.summary || null).toBeNull();
    tail.push('stderr', '\nRuntimeError: shader compilation failed');
    expect(tail.failure()?.summary || null).toBe('RuntimeError: shader compilation failed');
    tail.push('stderr', "\nKeyError: 'width'");
    expect(tail.failure().summary).toBe('KeyError: redacted diagnostic details');
  });

  it('scrubs conditioning, tokens, credentials and POSIX/Windows paths before identity or display', () => {
    const token = `ghp_${'x'.repeat(30)}`;
    const error = `RuntimeError: failure for invented private prompt at /mock/private/model and C:\\mock\\model token=arbitrary ${token}`;
    const failure = normalizeVideoFailure(error, { prompts: ['invented private prompt'] });
    expect(failure.classification).toBe('runtimeerror');
    expect(failure.cause).not.toMatch(/invented|private|mock|arbitrary|ghp_/);
    expect(failure.cause.length).toBeLessThanOrEqual(240);
    expect(normalizeVideoFailure('RuntimeError: authentication failed password="invented secret words"').cause)
      .toBe('authentication failed [credential]');
    const basic = Buffer.from('example:invented-password').toString('base64');
    const basicFailure = normalizeVideoFailure(`RuntimeError: request failed Authorization: Basic ${basic}`);
    expect(basicFailure.cause).toBe('request failed [credential]');
    expect(basicFailure.signature).toBe(normalizeVideoFailure('RuntimeError: request failed Authorization: Basic changed').signature);
    expect(normalizeVideoFailure('RuntimeError: shape mismatch')).not.toEqual(normalizeVideoFailure('RuntimeError: shader compilation failed'));
    expect(normalizeVideoFailure("ModuleNotFoundError: No module named 'example_runtime'"))
      .toMatchObject({ classification: 'missing-module', cause: 'Python module example_runtime is missing' });
  });
});

it('keeps redacted identifiers distinct and removes entire paths containing spaces', () => {
  const first = normalizeVideoFailure("AttributeError: 'Tokenizer' object has no attribute 'encode'");
  const second = normalizeVideoFailure("AttributeError: 'Pipeline' object has no attribute 'decode'");
  expect(first.cause).toBe(second.cause);
  expect(first.signature).not.toBe(second.signature);
  for (const path of ['/mock/private folder/encoder file', 'C:\\mock\\private folder\\encoder file']) {
    const failure = normalizeVideoFailure(`RuntimeError: Substituted text encoder is missing: ${path}`);
    expect(failure.cause).toBe('Substituted text encoder is missing: [path]');
    expect(failure.signature).toMatch(/^[a-f0-9]{64}$/);
  }
});
