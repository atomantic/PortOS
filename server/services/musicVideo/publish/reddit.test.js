/** Exercise the adapter's serialized page callback with an isolated Reddit session. */
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { redditAdapter } from './reddit.js';

const post = { name: 't3_example', title: 'Example Video', permalink: '/r/example/comments/example/clip/', url: 'https://old.reddit.com/r/example/comments/example/clip/' };

const payload = {
  kind: 'self', title: post.title, subreddit: 'example', url: 'https://example.com/video',
  body: 'Example post body', firstComment: 'Example starter prompt',
};
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
    throw new Error(`Unexpected request: ${path}`);
  });
  const timeout = vi.fn(AbortSignal.timeout);
  const page = {
    goto: vi.fn(async () => {}),
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
});

const videoPayload = { kind: 'video', title: post.title, subreddit: 'example', flairId: 'clip', video: { path: '/example/clip.mp4' } };

// Records every click, keyed by the selector (or text filter) it resolved to, so a test can assert the
// composer was filled but the submit button was never pressed.
function videoPage({ buttonDisabled = 0 } = {}) {
  const { page: sessionOnly, request } = sessionPage();
  const events = [];
  const files = [];
  const target = (name) => ({ click: vi.fn(async () => { events.push(`click:${name}`); }) });
  const locator = vi.fn((selector) => ({
    ...target(selector),
    filter: ({ hasText }) => ({ first: () => target(`${selector}[${hasText}]`) }),
    first: () => target(selector),
  }));
  let checks = 0;
  const button = { id: 'inner-post-submit-button', disabled: false, getAttribute: () => null };
  const waitForFunction = vi.fn(async (callback) => {
    // A nested shadow root holds the button, as on the real composer.
    const inner = { querySelectorAll: () => [button] };
    const host = { id: 'host', shadowRoot: inner, querySelectorAll: () => [] };
    const document = { querySelectorAll: () => [host] };
    const evaluate = () => { button.disabled = checks++ < buttonDisabled; return runInNewContext(`(${callback.toString()})()`, { document }); };
    for (let i = 0; i <= buttonDisabled; i++) if (evaluate()) return true;
    throw new Error('timeout');
  });
  const page = {
    ...sessionOnly,
    goto: vi.fn(async (url) => { events.push(`goto:${url}`); }),
    waitForTimeout: vi.fn(async () => {}),
    waitForEvent: vi.fn(async () => ({ setFiles: async (path) => { files.push(path); } })),
    getByPlaceholder: vi.fn(() => ({ last: () => target('search') })),
    keyboard: { insertText: vi.fn(async (text) => { events.push(`type:${text}`); }) },
    locator,
    waitForFunction,
  };
  return { page, events, files, request, button };
}

describe('Reddit native video draft', () => {
  it('attaches the video, types the title, picks the flair and never presses the submit button', async () => {
    const { page, events, files } = videoPage();
    const result = await redditAdapter.prepare(page, videoPayload);

    expect(events[0]).toBe('goto:https://www.reddit.com/r/example/submit/?type=MEDIA');
    expect(page.waitForEvent).toHaveBeenCalledWith('filechooser', expect.any(Object));
    expect(files).toEqual(['/example/clip.mp4']);
    expect(events).toEqual(expect.arrayContaining([
      'click:post-composer-standalone-toolbar button[Video]',
      'click:post-composer-title textarea[name=title]',
      `type:${post.title}`,
      'click:#reddit-post-flair-button',
      'click:search',
      'type:Clip',
      'click:faceplate-radio-input[value="clip"]',
    ]));
    expect(events.filter((e) => e.includes('inner-post-submit-button'))).toEqual([]);
    expect(page.locator).not.toHaveBeenCalledWith('#inner-post-submit-button');
    expect(result).toMatchObject({ account: 'example-user', kind: 'video', subreddit: 'example', flairText: 'Clip', rules: ['Stay on topic'] });
    expect(result.warning).toBeUndefined();
  });

  it('warns and skips the flair modal when the subreddit does not offer the requested flair', async () => {
    const { page, events } = videoPage();
    const result = await redditAdapter.prepare(page, { ...videoPayload, flairId: 'missing' });
    expect(result.flairText).toBeNull();
    expect(result.warning).toMatch(/flair is not offered/);
    expect(events).not.toContain('click:#reddit-post-flair-button');
  });

  it('waits for the shadow-DOM submit button to enable without clicking it', async () => {
    const { page, events, button } = videoPage({ buttonDisabled: 2 });
    await redditAdapter.prepare(page, videoPayload);
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), null, { timeout: 600_000 });
    expect(button.disabled).toBe(false);
    expect(events.some((e) => e.includes('submit-button'))).toBe(false);
  });

  it('requires a signed-in session before touching the composer controls', async () => {
    const { page, files } = videoPage();
    const { page: signedOut } = sessionPage({ '/api/me.json': () => httpError(401) });
    await expect(redditAdapter.prepare({ ...page, evaluate: signedOut.evaluate }, videoPayload)).rejects.toMatchObject({ code: 'PUBLISH_LOGIN_REQUIRED' });
    expect(files).toEqual([]);
  });
});

describe('Reddit post detection', () => {
  const landed = (url, shown = true) => ({
    url: () => url,
    waitForFunction: vi.fn(async (_fn, text) => {
      if (!shown) throw new Error('timeout');
      return text;
    }),
  });

  it('canonicalizes an old.reddit.com post URL to www.reddit.com', async () => {
    const page = landed('https://old.reddit.com/r/example/comments/abc123/clip');
    await expect(redditAdapter.findPost(page, { title: post.title })).resolves.toBe('https://www.reddit.com/r/example/comments/abc123/clip');
    expect(page.waitForFunction).toHaveBeenCalledWith(expect.any(Function), post.title, expect.any(Object));
  });

  it.each([
    'https://www.reddit.com/r/example/submit/?type=MEDIA',
    'https://www.reddit.com/r/example/',
    'https://example.com/r/example/comments/abc123/clip/',
  ])('returns null for the non-post URL %s', async (url) => {
    await expect(redditAdapter.findPost(landed(url), { title: post.title })).resolves.toBeNull();
  });

  it('returns null when the post page does not show the title', async () => {
    const page = landed('https://www.reddit.com/r/example/comments/abc123/clip/', false);
    await expect(redditAdapter.findPost(page, { title: post.title })).resolves.toBeNull();
  });
});
