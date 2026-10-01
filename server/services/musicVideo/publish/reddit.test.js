/** Adapter contract: explicit starter comments follow the same post returned
 * to the director for native-video, text and link publishing. No browser or
 * network is involved; execute the page callback with an isolated session API.
 */
import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { redditAdapter } from './reddit.js';

const post = { name: 't3_example', title: 'Example Video', permalink: '/r/example/comments/example/clip/', url: 'https://old.reddit.com/r/example/comments/example/clip/' };

function sessionPage() {
  const request = vi.fn(async (url) => {
    const body = url === '/api/me.json' ? { data: { name: 'example-user', modhash: 'example-modhash' } }
      : url.includes('/submitted.json') ? { data: { children: [{ data: post }] } }
        : url === '/api/submit' ? { json: { data: post, errors: [] } }
          : { json: { errors: [] } };
    return { json: async () => body };
  });
  const page = {
    locator: vi.fn(() => ({ click: vi.fn(async () => {}) })),
    waitForURL: vi.fn(async () => {}),
    evaluate: (callback, input) => runInNewContext(`(${callback.toString()})`, { fetch: request, URLSearchParams })(input),
  };
  return { page, request };
}

describe('Reddit publishing starter comments', () => {
  it.each(['video', 'self', 'link'])('adds an explicitly requested first comment to the returned %s post', async (kind) => {
    const { page, request } = sessionPage();
    const result = await redditAdapter.submit(page, { kind, title: post.title, subreddit: 'example',
      url: 'https://example.com/video', body: 'Example post body', firstComment: 'Example starter prompt' });
    expect(result.url).toBe('https://www.reddit.com/r/example/comments/example/clip/');
    const comments = request.mock.calls.filter(([url]) => url === '/api/comment');
    expect(comments).toHaveLength(1);
    expect(comments[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(Object.fromEntries(comments[0][1].body)).toEqual({ thing_id: post.name,
      text: 'Example starter prompt', api_type: 'json', uh: 'example-modhash' });
  });

  it('publishes native video without adding a comment when none was requested', async () => {
    const { page, request } = sessionPage();
    await expect(redditAdapter.submit(page, { kind: 'video', title: post.title })).resolves.toEqual({ url: 'https://www.reddit.com/r/example/comments/example/clip/' });
    expect(request.mock.calls.some(([url]) => url === '/api/comment')).toBe(false);
  });
});
