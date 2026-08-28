import { describe, expect, it, vi } from 'vitest';
import {
  imageCapabilityAllowsAttempt,
  resolvePersistentMindImageCapability,
} from './persistentMindImageCapability.js';

describe('Persistent Mind image capability', () => {
  it('supports Codex and Claude CLI providers but rejects other CLI and TUI transports', async () => {
    await expect(resolvePersistentMindImageCapability({ provider: { type: 'cli', command: 'codex' }, model: 'gpt-5' })).resolves.toMatchObject({ status: 'supported' });
    await expect(resolvePersistentMindImageCapability({ provider: { type: 'cli', command: 'claude' }, model: 'claude-opus' })).resolves.toMatchObject({ status: 'supported' });
    await expect(resolvePersistentMindImageCapability({ provider: { type: 'cli', command: 'opencode' }, model: 'example' })).resolves.toMatchObject({ status: 'unsupported' });
    await expect(resolvePersistentMindImageCapability({ provider: { type: 'tui' }, model: 'example' })).resolves.toMatchObject({ status: 'unsupported' });
  });

  it('prefers authoritative local inventory and capability metadata', async () => {
    const listBackendModels = vi.fn(async () => [{ id: 'example-vlm', type: 'llm' }]);
    const getOllamaCapabilities = vi.fn(async () => ['completion', 'vision']);
    await expect(resolvePersistentMindImageCapability(
      { provider: { id: 'ollama', type: 'api' }, model: 'example-vlm' },
      { listBackendModels, getOllamaCapabilities },
    )).resolves.toMatchObject({ status: 'supported' });
    expect(getOllamaCapabilities).toHaveBeenCalledWith('example-vlm');
  });

  it('leaves an unenumerated API model attemptable without claiming support', async () => {
    const provider = { id: 'example-api', type: 'api', models: ['example-model'] };
    const capability = await resolvePersistentMindImageCapability({ provider, model: 'example-model' });
    expect(capability.status).toBe('unknown');
    expect(imageCapabilityAllowsAttempt(capability, provider)).toBe(true);
    expect(imageCapabilityAllowsAttempt(capability, { type: 'cli' })).toBe(false);
  });
});
