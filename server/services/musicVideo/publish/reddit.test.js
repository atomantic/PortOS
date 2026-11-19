/** Exercise the adapter's serialized page callback with an isolated Reddit session. */
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { redditAdapter } from './reddit.js';

const post = { name: 't3_example', title: 'Example Video', permalink: '/r/example/comments/example/clip/', url: 'https://old.reddit.com/r/example/comments/example/clip/' };

const payload = {
  kind: 'self', title: post.title, subreddit: 'example', url: 'https://example.com/video',
  body: 'Example post body', firstComment: 'Example starter prompt',
};
const canonicalUrl = 'https://www.reddit.com/r/example/comments/example/clip/';
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const httpError = (status) => ({ ok: false, status, json: async () => { throw new SyntaxError('HTML response'); } });
const invalidJson = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Invalid JSON'); } });

function sessionPage(responses = {}) {
  const request = vi.fn(async (url) => {
    const path = url.split('?')[0];
    if (responses[path]) return responses[path]();
    if (path === '/api/me.json') return jsonResponse({ data: { name: 'example-user', modhash: 'example-modhash' } });
    if (path.endsWith('/about/rules.json')) return jsonResponse({ rules: [{ short_name: 'Stay on topic' }] });
    if (path.endsWith('/api/link_flair_v2.json')) return jsonResponse([{ id: 'clip', text: ' Clip ', mod_only: false }]);
    if (path.endsWith('/submitted.json')) return jsonResponse({ data: { children: [{ data: post }] } });
    if (path === '/api/submit') return jsonResponse({ json: { data: post, errors: [] } });
    if (path === '/api/comment') return jsonResponse({ json: { errors: [] } });
    throw new Error(`Unexpected request: ${path}`);
  });
  const timeout = vi.fn(AbortSignal.timeout);
  const page = {
    goto: vi.fn(async () => {}),
    locator: vi.fn(() => ({ click: vi.fn(async () => {}) })),
    waitForURL: vi.fn(async () => {}),
    evaluate: (callback, input) => runInNewContext(`(${callback.toString()})`, { fetch: request, AbortSignal: { timeout }, URLSearchParams })(input),
  };
  return { page, request, timeout };
}

describe('Reddit publishing session', () => {
  it('uses a 15-second abort signal for each request to read a subreddit', async () => {
    const { page, request, timeout } = sessionPage();
    await expect(redditAdapter.prepare(page, payload)).resolves.toMatchObject({
      account: 'example-user',
      rules: ['Stay on topic'],
      flairs: [{ id: 'clip', text: 'Clip' }],
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(timeout.mock.calls).toEqual([[15_000], [15_000], [15_000]]);
    expect(request.mock.calls.map(([, options]) => options.signal)).toEqual(timeout.mock.results.map(({ value }) => value));
  });

  it.each([401, 403, 200])('treats an unauthenticated HTTP %s session as sign-in required', async (status) => {
    const { page, request } = sessionPage({
      '/api/me.json': () => status === 200 ? jsonResponse({ data: {} }) : httpError(status),
    });
    await expect(redditAdapter.prepare(page, payload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['returned HTTP 429', () => httpError(429)],
    ['returned HTTP 503', () => httpError(503)],
    ['timed out after 15 seconds', () => { throw new DOMException('Request aborted', 'TimeoutError'); }],
    ['could not be reached (network error)', () => { throw new TypeError('Failed to fetch'); }],
    ['returned invalid JSON', invalidJson],
  ])('reports a session failure during draft preparation (%s)', async (message, response) => {
    const { page } = sessionPage({ '/api/me.json': response });
    await expect(redditAdapter.prepare(page, payload)).rejects.toMatchObject({
      code: 'PUBLISH_STEP_FAILED',
      message: expect.stringContaining(`/api/me.json ${message}`),
    });
  });

  it.each(['about/rules.json', 'api/link_flair_v2.json'])('reports when Reddit fails to serve %s', async (endpoint) => {
    const { page } = sessionPage({ [`/r/example/${endpoint}`]: () => httpError(503) });
    await expect(redditAdapter.prepare(page, payload)).rejects.toMatchObject({
      code: 'PUBLISH_STEP_FAILED',
      message: expect.stringContaining(`/r/example/${endpoint} returned HTTP 503`),
    });
  });

  it.each(['video', 'self', 'link'])('reports a failed session check for a %s post', async (kind) => {
    const { page, request } = sessionPage({ '/api/me.json': () => httpError(503) });
    await expect(redditAdapter.submit(page, { ...payload, kind })).rejects.toMatchObject({
      code: 'PUBLISH_STEP_FAILED',
      message: expect.stringContaining('/api/me.json returned HTTP 503'),
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('surfaces an HTTP failure from submit before attempting a starter comment', async () => {
    const { page, request } = sessionPage({ '/api/submit': () => httpError(429) });
    await expect(redditAdapter.submit(page, payload)).rejects.toMatchObject({
      code: 'PUBLISH_STEP_FAILED',
      message: expect.stringContaining('/api/submit returned HTTP 429'),
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/me.json', '/api/submit']);
  });

  it('keeps the Reddit rejection status for an API-level post rejection', async () => {
    const { page } = sessionPage({ '/api/submit': () => jsonResponse({ json: { errors: [['BAD_TITLE', 'Title required']] } }) });
    await expect(redditAdapter.submit(page, payload)).rejects.toMatchObject({
      code: 'PUBLISH_REJECTED',
      message: expect.stringContaining('BAD_TITLE: Title required'),
    });
  });
});

describe('Reddit publishing starter comments', () => {
  it.each(['video', 'self', 'link'])('adds an explicitly requested first comment to the returned %s post', async (kind) => {
    const { page, request } = sessionPage();
    const result = await redditAdapter.submit(page, { ...payload, kind });
    expect(result).toEqual({ url: canonicalUrl });
    const comments = request.mock.calls.filter(([url]) => url === '/api/comment');
    expect(comments).toHaveLength(1);
    expect(comments[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(Object.fromEntries(comments[0][1].body)).toEqual({ thing_id: post.name,
      text: 'Example starter prompt', api_type: 'json', uh: 'example-modhash' });
  });

  it.each(['video', 'self', 'link'])('keeps the %s post URL and reports a rejected starter comment', async (kind) => {
    const { page } = sessionPage({
      '/api/comment': () => jsonResponse({ json: { errors: [['RATELIMIT', 'Try again later']] } }),
    });
    await expect(redditAdapter.submit(page, { ...payload, kind })).resolves.toEqual({
      url: canonicalUrl,
      warning: 'Reddit could not add the starter comment: RATELIMIT: Try again later',
    });
  });

  it.each([
    ['HTTP 503', () => httpError(503)],
    ['invalid JSON', invalidJson],
  ])('keeps the post URL when the starter comment response contains %s', async (message, response) => {
    const { page } = sessionPage({ '/api/comment': response });
    await expect(redditAdapter.submit(page, payload)).resolves.toMatchObject({
      url: canonicalUrl,
      warning: expect.stringContaining(`/api/comment returned ${message}`),
    });
  });

  it('publishes native video without adding a comment when none was requested', async () => {
    const { page, request } = sessionPage();
    await expect(redditAdapter.submit(page, { kind: 'video', title: post.title })).resolves.toEqual({ url: canonicalUrl });
    expect(request.mock.calls.some(([url]) => url === '/api/comment')).toBe(false);
  });
});
