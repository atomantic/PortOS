import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: fetchMock }));
vi.mock('./rateLimits.js', () => ({
  checkRateLimit: vi.fn(() => ({ allowed: true })),
  recordAction: vi.fn(),
  syncFromExternal: vi.fn(),
}));
vi.mock('./challengeSolver.js', () => ({ solveChallenge: vi.fn() }));

import * as moltbook from './api.js';
import { syncFromExternal } from './rateLimits.js';

const API_KEY = 'mb-test-key-1a2b3c';
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('moltbook authenticated writes', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization and Content-Type: application/json on an authenticated POST', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'post-1' }));
    await moltbook.createComment(API_KEY, 'post-1', 'hello');

    const [url, config] = fetchMock.mock.calls[0];
    expect(url).toContain('/posts/post-1/comments');
    expect(config.method).toBe('POST');
    expect(config.headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(config.headers['Content-Type']).toBe('application/json');
    expect(config.body).toBe(JSON.stringify({ content: 'hello' }));
  });

  it('still hands the Authorization header to the 429 rate-limit sync', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'slow down' }, 429));
    await expect(moltbook.createPost(API_KEY, 'general', 'title', 'body')).rejects.toThrow();

    expect(syncFromExternal).toHaveBeenCalledWith(API_KEY, 'post');
  });
});
