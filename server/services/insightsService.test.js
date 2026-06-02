import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider-readiness check and the HTTP client so the call runs offline.
vi.mock('./ollamaManager.js', () => ({
  ensureProviderReady: vi.fn().mockResolvedValue({ success: true }),
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js';
import { callProviderAISimple } from './insightsService.js';

const PROVIDER = { type: 'api', endpoint: 'http://localhost:1234/v1' };

describe('insightsService.callProviderAISimple — non-JSON-body guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The regression this guards: a non-JSON 200 body used to return { text: '' },
  // which refreshCrossDomainNarrative / generateThemeAnalysis then persisted over
  // narrative.json / themes.json — overwriting the cached result with nothing.
  // It must surface as { error } so the `if (result.error) return` guard bails
  // before any write.
  it('returns { error } (not empty success) on a non-JSON 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse('<html><body>502 Bad Gateway</body></html>'));
    const result = await callProviderAISimple(PROVIDER, 'm', 'prompt');
    expect(result.text).toBeUndefined();
    expect(result.error).toMatch(/non-JSON response/);
  });

  it('returns { error } on a blank 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse(''));
    const result = await callProviderAISimple(PROVIDER, 'm', 'prompt');
    expect(result.error).toMatch(/non-JSON response/);
  });

  // A valid body with empty content is a legitimate (if unusual) result and must
  // still flow through as { text: '' } — the guard must not conflate valid-empty
  // with a parse failure.
  it('returns { text: "" } for a valid body with empty content', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: '' } }] }));
    const result = await callProviderAISimple(PROVIDER, 'm', 'prompt');
    expect(result).toEqual({ text: '' });
  });

  it('returns the content for a valid populated body', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ choices: [{ message: { content: 'hello' } }] }));
    const result = await callProviderAISimple(PROVIDER, 'm', 'prompt');
    expect(result).toEqual({ text: 'hello' });
  });

  it('returns { error } with the status code on a non-2xx response', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse('boom', { ok: false, status: 500 }));
    const result = await callProviderAISimple(PROVIDER, 'm', 'prompt');
    expect(result.error).toMatch(/Provider returned 500: boom/);
  });
});
