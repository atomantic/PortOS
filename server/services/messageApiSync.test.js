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
import { mockJsonResponse, mockTextResponse } from '../lib/testHelper.js';
import { syncOutlookApi } from './messageApiSync.js';

const ACCOUNT = { id: 'acc-1', email: 'a@example.com' };

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
    fetchWithTimeout.mockResolvedValue(mockTextResponse('<html><body>502 Bad Gateway</body></html>'));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result).toBeNull();
  });

  it('returns null on a blank 200 body', async () => {
    fetchWithTimeout.mockResolvedValue(mockTextResponse(''));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result).toBeNull();
  });

  // A legitimately-empty inbox still reports success (no spurious fallback).
  it('still reports success for a valid empty { value: [] } body', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [] }));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'full' });
    expect(result.status).toBe('success');
    expect(result.messages).toEqual([]);
    expect(result.inboxComplete).toBe(true);
  });

  it('parses messages from a valid populated body', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [{ Id: 'msg-1', Subject: 'Hello' }] }));
    const result = await syncOutlookApi(ACCOUNT, { messages: [] }, null, { mode: 'unread' });
    expect(result.status).toBe('success');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].subject).toBe('Hello');
    expect(result.inboxComplete).toBe(false);
  });
  it('does not certify a capped listing with another page', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({
      value: Array.from({ length: 200 }, (_, i) => ({ Id: 'mail-' + i })),
      '@odata.nextLink': 'https://outlook.office.com/next',
    }));
    const result = await syncOutlookApi(ACCOUNT, {}, null, { mode: 'full' });
    expect(result.messages).toHaveLength(200);
    expect(result.inboxComplete).toBe(false);
  });

  it('certifies a full snapshot only after its last page', async () => {
    fetchWithTimeout.mockResolvedValueOnce(mockJsonResponse({
      value: [{ Id: 'a' }], '@odata.nextLink': 'https://outlook.office.com/next',
    })).mockResolvedValueOnce(mockJsonResponse({ value: [{ Id: 'b' }] }));
    const result = await syncOutlookApi(ACCOUNT, {}, null, { mode: 'full' });
    expect(result.messages).toHaveLength(2);
    expect(result.inboxComplete).toBe(true);
  });

  it('merges valid rows without certifying malformed membership', async () => {
    fetchWithTimeout.mockResolvedValue(mockJsonResponse({ value: [{ Id: 'a' }, {}] }));
    const result = await syncOutlookApi(ACCOUNT, {}, null, { mode: 'full' });
    expect(result.messages).toHaveLength(1);
    expect(result.inboxComplete).toBe(false);
  });

});
