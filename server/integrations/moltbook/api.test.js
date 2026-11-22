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
import { solveChallenge } from './challengeSolver.js';

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

  it('never writes the verification code or answer to stdout or stderr', async () => {
    const CODE = 'vc-FIXTURE-CODE-7731';
    const ANSWER = '424242';
    const CHALLENGE = 'FIXTURE CHALLENGE TEXT with numbers 12 and 30';
    solveChallenge.mockResolvedValue(ANSWER);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        id: 'post-2',
        verification_required: true,
        verification: { code: CODE, challenge: CHALLENGE, expires_at: '2099-01-01T00:00:00Z' },
      }))
      .mockResolvedValueOnce(jsonResponse({ success: true, message: 'verified' }));

    await moltbook.createPost(API_KEY, 'general', 'Published title', 'body', {});

    // The verify request must still carry the real pair; only the logs are constrained.
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ verification_code: CODE, answer: ANSWER });

    const output = [...console.log.mock.calls, ...console.error.mock.calls]
      .map(args => args.map(String).join(' '))
      .join('\n');
    expect(output).not.toContain(CODE);
    expect(output).not.toContain(ANSWER);
    expect(output).not.toContain('FIXTURE CHALLENGE');
    expect(output).toContain('Moltbook verification passed');
    expect(output).toContain('Created post "Published title"');
  });
});
