import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProviderCatalogService } from './providerCatalogService.js';

const service = () => createProviderCatalogService({
  loadProviders: async () => ({ providers: {} }),
  saveProviders: async () => {},
  withGatewayApiKey: (p) => p,
  defaultSamplePath: '/nonexistent',
});

describe('_fetchGeminiModels', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sends the key in x-goog-api-key and never in the URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [
        { name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed-b', supportedGenerationMethods: ['embedContent'] },
      ] }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await service()._fetchGeminiModels({ apiKey: 'secret-key-123' });
    expect(models).toEqual(['gemini-a']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(String(url)).not.toContain('secret-key-123');
    expect(init.headers['x-goog-api-key']).toBe('secret-key-123');
  });

  it('rejects a key that is not header-safe without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(service()._fetchGeminiModels({ apiKey: 'bad\nkey' })).rejects.toMatchObject({ status: 400 });
    await expect(service()._fetchGeminiModels({ apiKey: 'k☃' })).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
