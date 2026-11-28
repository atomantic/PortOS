import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'youtube-comment-watch-' });
vi.mock('../lib/paths.js', async () => makeProxy(await vi.importActual('../lib/paths.js')));
vi.mock('../lib/portosEnv.js', () => ({ readPortosEnvValue: () => null }));

const { cancel, getEvent, triggerNow } = await import('./eventScheduler.js');
const { getNotifications, invalidateCache, notificationEvents } = await import('./notifications.js');
const { startYoutubeCommentWatcher } = await import('./youtubeCommentWatcher.js');

const eventId = 'youtube-comment-watch';
const channelId = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const old = '2026-01-01T00:00:00Z';
const recent = '2026-01-03T00:15:00Z';
const comment = (id, publishedAt) => ({ id, snippet: { publishedAt } });
const thread = (topLevelComment, { videoId = 'examplevid1', count = 0, replies = [] } = {}) => ({
  snippet: { videoId, topLevelComment, totalReplyCount: count },
  replies: { comments: replies }
});

beforeEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
  invalidateCache();
  vi.stubEnv('YOUTUBE_COMMENT_CHANNEL_ID', channelId);
  vi.stubEnv('YOUTUBE_COMMENT_API_KEY', 'test-key');
  vi.stubEnv('YOUTUBE_COMMENT_INTERVAL_MINUTES', '');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-03T00:00:00Z'));
});

afterEach(() => {
  cancel(eventId);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
afterAll(cleanup);

it('registers no schedule until the channel and key are configured', async () => {
  vi.stubEnv('YOUTUBE_COMMENT_CHANNEL_ID', '');
  vi.stubEnv('YOUTUBE_COMMENT_API_KEY', '');
  await startYoutubeCommentWatcher();
  expect(getEvent(eventId)).toBeNull();
  vi.stubEnv('YOUTUBE_COMMENT_CHANNEL_ID', channelId);
  await expect(startYoutubeCommentWatcher()).rejects.toThrow(/needs YOUTUBE_COMMENT_API_KEY/);
  expect(getEvent(eventId)).toBeNull();
});

it('alerts for paginated video comments and replies on old threads, retries failures and deduplicates after restart', async () => {
  const fetch = vi.fn(async (url, options) => {
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.searchParams.has('key')).toBe(false);
    expect(options.headers['X-Goog-Api-Key']).toBe('test-key');
    const page = url.searchParams.get('pageToken');
    if (url.pathname.endsWith('/comments')) {
      expect(url.searchParams.get('parentId')).toBe('old-parent');
      return page
        ? Response.json({ items: [comment('new-reply', recent)] })
        : Response.json({ nextPageToken: 'reply-page-2', items: [comment('old-reply', old)] });
    }
    expect(url.searchParams.get('allThreadsRelatedToChannelId')).toBe(channelId);
    if (!page) {
      return Response.json({ nextPageToken: 'thread-page-2', items: [
        thread(comment('old-parent', old), { count: 2, replies: [comment('old-reply', old)] }),
        thread(comment('new-thread', recent))
      ] });
    }
    if (failPage) return new Response(null, { status: 503 });
    return Response.json({ items: [
      { snippet: { topLevelComment: comment('channel-comment', recent), totalReplyCount: 0 } },
      thread(comment('another-old-parent', old), { count: 1, replies: [comment('embedded-reply', recent)] })
    ] });
  });
  vi.stubGlobal('fetch', fetch);
  let failPage = true;

  await startYoutubeCommentWatcher();
  expect(getEvent(eventId).intervalMs).toBe(60 * 60_000);
  expect(fetch).not.toHaveBeenCalled();
  vi.setSystemTime(new Date('2026-01-03T01:00:00Z'));
  await triggerNow(eventId);
  expect(getEvent(eventId)).toMatchObject({ lastRunSucceeded: false, lastError: 'YouTube commentThreads returned HTTP 503' });
  expect(await getNotifications()).toEqual([]);

  failPage = false;
  const added = vi.fn();
  notificationEvents.on('added', added);
  try {
    await triggerNow(eventId);
    expect(getEvent(eventId).lastRunSucceeded).toBe(true);
    await expect(getNotifications({ unreadOnly: true })).resolves.toHaveLength(3);
    expect(added.mock.calls.map(([entry]) => entry.title).sort()).toEqual([
      'New YouTube comment', 'New YouTube reply', 'New YouTube reply'
    ]);
    expect(added).toHaveBeenCalledWith(expect.objectContaining({
      type: 'youtube_comment', link: `https://studio.youtube.com/channel/${channelId}/comments/inbox`
    }));
    cancel(eventId);
    invalidateCache();
    await startYoutubeCommentWatcher();
    await triggerNow(eventId);
    expect(added).toHaveBeenCalledTimes(3);
  } finally {
    notificationEvents.off('added', added);
  }
});
