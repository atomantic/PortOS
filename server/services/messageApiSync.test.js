import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the token source and the HTTP client so the sync runs offline.
vi.mock('./messageTokenExtractor.js', () => ({
  getToken: vi.fn(),
  clearTokenCache: vi.fn(),
}));
vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(),
}));

import { getToken } from './messageTokenExtractor.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { syncOutlookApi } from './messageApiSync.js';

const ACCOUNT = { id: 'acc-1', email: 'a@example.com' };
const okResponse = (body) => ({ ok: true, status: 200, text: async () => body });

describe('syncOutlookApi — malformed-body masquerade guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToken.mockResolvedValue({ token: 'fake-token' });
  });

  // The regression this guards: a non-JSON 200 body used to become
  // { messages: [], status: 'success' }, a truthy result that suppressed the
  // Playwright fallback in messageSync.js (and mid-pagination would prune still
  // -valid cached messages). It must return null to preserve the fallback.
  it('returns null (triggering the Playwright fallback) on a non-JSON 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(okResponse('<html><body>502 Bad Gateway</body></html>'));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result).toBeNull();
  });

  it('returns null on a blank 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(okResponse(''));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result).toBeNull();
  });

  // A legitimately-empty inbox still reports success (no spurious fallback).
  it('still reports success for a valid empty { value: [] } body', async () => {
    fetchWithTimeout.mockResolvedValue(okResponse(JSON.stringify({ value: [] })));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result.status).toBe('success');
    expect(result.messages).toEqual([]);
  });

  it('parses messages from a valid populated body', async () => {
    fetchWithTimeout.mockResolvedValue(okResponse(JSON.stringify({ value: [{ Id: 'msg-1', Subject: 'Hello' }] })));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'unread' });
    expect(result.status).toBe('success');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].subject).toBe('Hello');
  });
});
