import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createProviderService } from '../lib/aiToolkit/providers.js';
import { join } from 'path';

/**
 * `getAllProviders()` resolves an ENVELOPE — `{ activeProvider, providers: [] }`
 * — not a bare array. Callers that forgot wrote `Array.isArray(providers)`
 * guards that are never true, and so silently resolved to an empty list:
 *
 *   - the capability matrix reported "no OpenCode TUI provider is configured"
 *     for every runtime, on installs that had one;
 *   - `runtimeApiKey` never found a key, so a vLLM behind VLLM_API_KEY 401'd on
 *     every sample.
 *
 * Both shipped green, because their suites mocked the call as a bare array. This
 * guard pins the envelope so a future reader cannot re-derive the wrong shape
 * from a mock, and points anyone who just wants the records at `listProviders`.
 */
describe('getAllProviders returns an envelope, not a list', () => {
  it('returns the active provider and resolved record list as an envelope', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'provider-envelope-'));
    try {
      const service = createProviderService({ dataDir: directory, providersFile: 'providers.json' });
      await service.createProvider({ id: 'example', name: 'Example', type: 'api', enabled: true });
      await service.setActiveProvider('example');
      const result = await service.getAllProviders();
      expect(Array.isArray(result)).toBe(false);
      expect(result).toMatchObject({ activeProvider: 'example', providers: [{ id: 'example' }] });
      expect(Array.isArray(result.providers)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('has a wrapper that unwraps it, so callers never need to know', async () => {
    const { listProviders } = await import('./providers.js');
    expect(typeof listProviders).toBe('function');
  });
});
