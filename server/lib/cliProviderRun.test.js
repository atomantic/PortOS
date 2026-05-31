import { describe, it, expect } from 'vitest';
import { pickCliProvider, runCliProviderPrompt } from './cliProviderRun.js';

const cli = (id, extra = {}) => ({ id, type: 'cli', command: id, enabled: true, models: [], ...extra });

describe('pickCliProvider', () => {
  const providers = {
    'claude-code': cli('claude-code', { defaultModel: 'claude-opus-4-7', models: ['claude-opus-4-7', 'claude-haiku-4-5'] }),
    'codex': cli('codex', { defaultModel: 'codex-configured-default', models: ['codex-configured-default'] }),
    'antigravity-cli': cli('antigravity-cli', { command: 'agy', defaultModel: 'antigravity-configured-default', models: ['antigravity-configured-default'] }),
    'ollama': { id: 'ollama', type: 'api', enabled: true, defaultModel: 'llama3' },
    'disabled-cli': cli('disabled-cli', { enabled: false }),
  };

  it('accepts the on-disk map shape (keyed by id)', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'codex' });
    expect(provider.id).toBe('codex');
  });

  it('accepts an array shape', () => {
    const { provider } = pickCliProvider(Object.values(providers), { providerId: 'antigravity-cli' });
    expect(provider.id).toBe('antigravity-cli');
  });

  it('falls back to claude-code when providerId is unset', () => {
    const { provider, model } = pickCliProvider(providers, {});
    expect(provider.id).toBe('claude-code');
    expect(model).toBe('claude-opus-4-7');
  });

  it('falls back to claude-code when the requested provider does not exist', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'nonexistent' });
    expect(provider.id).toBe('claude-code');
  });

  it('honors a custom fallbackId', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'nope', fallbackId: 'codex' });
    expect(provider.id).toBe('codex');
  });

  it('never selects an API provider', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'ollama' });
    expect(provider.id).not.toBe('ollama');
    expect(provider.type).toBe('cli');
  });

  it('never selects a disabled CLI provider', () => {
    const { provider } = pickCliProvider(providers, { providerId: 'disabled-cli' });
    expect(provider.id).not.toBe('disabled-cli');
  });

  it('honors a requested model when the provider offers it', () => {
    const { model } = pickCliProvider(providers, { providerId: 'claude-code', model: 'claude-haiku-4-5' });
    expect(model).toBe('claude-haiku-4-5');
  });

  it('drops a stale model the provider does not offer, falling back to its default', () => {
    const { model } = pickCliProvider(providers, { providerId: 'claude-code', model: 'gemini-2.5-pro' });
    expect(model).toBe('claude-opus-4-7');
  });

  it('errors when no CLI provider is configured', () => {
    const result = pickCliProvider({ ollama: providers.ollama }, {});
    expect(result.error).toMatch(/No enabled CLI provider/);
  });
});

describe('runCliProviderPrompt', () => {
  it('rejects a missing command without spawning', async () => {
    const result = await runCliProviderPrompt({ provider: { id: 'x' }, prompt: 'hi' });
    expect(result.error).toMatch(/no command/i);
  });

  it('rejects an empty prompt without spawning', async () => {
    const result = await runCliProviderPrompt({ provider: cli('antigravity-cli'), prompt: '' });
    expect(result.error).toMatch(/non-empty/);
  });

  it('delivers the prompt via stdin and collects stdout', async () => {
    // A legacy gemini-cli test double with no model returns [] (no flags), so `cat`
    // simply echoes stdin back out — a clean end-to-end spawn test.
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'cat', args: [] },
      prompt: 'hello stdin world',
    });
    expect(result.error).toBeUndefined();
    expect(result.text).toBe('hello stdin world');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces a spawn failure for a nonexistent binary', async () => {
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'this-binary-does-not-exist-xyz', args: [] },
      prompt: 'hi',
    });
    expect(result.error).toMatch(/Failed to spawn/);
  });

  it('settles cleanly when the child exits before reading stdin (no EPIPE crash)', async () => {
    // `true` exits 0 immediately and never drains stdin. Writing a large prompt
    // to its closed stdin would emit EPIPE — the helper must swallow that and
    // resolve via the close handler instead of throwing an unhandled error.
    const result = await runCliProviderPrompt({
      provider: { id: 'gemini-cli', type: 'cli', command: 'true', args: [] },
      prompt: 'x'.repeat(100000),
    });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
  });
});
