import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActivities } from './agentActivity.js';
import { collectHandledComments, collectPublishedPosts, ownReplyParentIds } from './agentPublished.js';

vi.mock('./agentActivity.js', () => ({ getActivities: vi.fn() }));

const now = new Date(2026, 0, 3, 12);
const yesterday = new Date(2026, 0, 2, 12);
const agentId = 'fixture-agent';
const timestamp = '2026-01-03T00:00:00Z';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(now);
  getActivities.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('collectPublishedPosts', () => {
  it('collects completed deliveries, prefers newer duplicates, and keeps legacy activity IDs as map keys', async () => {
    const completed = { status: 'completed', timestamp };
    getActivities
      .mockResolvedValueOnce([
        { ...completed, result: { postId: 'post-1', title: 'Published title', submolt: 'botany' }, params: { title: 'Draft' } },
        { ...completed, id: 'legacy-post', params: { title: 'Legacy title', submolt: 'fungi' } },
        { status: 'failed', result: { postId: 'failed-post' } },
      ])
      .mockResolvedValueOnce([
        { ...completed, result: { commentId: 'comment-1', postId: 'post-1', isReply: true } },
        { ...completed, id: 'legacy-comment', params: { postId: 'post-1' } },
        { status: 'running', result: { commentId: 'pending-comment' } },
      ])
      .mockResolvedValueOnce([
        { ...completed, result: { comments: [
          { commentId: 'comment-1', postId: 'duplicate-post' },
          { commentId: 'engagement-1', postId: 'post-2', postTitle: 'Other post' },
          { postId: 'no-comment-id' },
        ] } },
        { status: 'failed', result: { comments: [{ commentId: 'failed-engagement' }] } },
      ])
      .mockResolvedValueOnce([{ ...completed, result: { postId: 'post-1', title: 'Older title' } }])
      .mockResolvedValueOnce([{ ...completed, result: { commentId: 'comment-1', postId: 'older-post' } }])
      .mockResolvedValueOnce([]);

    expect(await collectPublishedPosts(agentId, 2)).toEqual({
      postMap: new Map([
        ['post-1', { postId: 'post-1', title: 'Published title', submolt: 'botany', publishedAt: timestamp }],
        ['legacy-post', { postId: null, title: 'Legacy title', submolt: 'fungi', publishedAt: timestamp }],
      ]),
      commentMap: new Map([
        ['comment-1', { commentId: 'comment-1', postId: 'post-1', isReply: true, publishedAt: timestamp }],
        ['legacy-comment', { commentId: null, postId: 'post-1', isReply: false, publishedAt: timestamp }],
        ['engagement-1', { commentId: 'engagement-1', postId: 'post-2', postTitle: 'Other post', isReply: false, publishedAt: timestamp }],
      ]),
    });
    expect(getActivities.mock.calls).toEqual([now, yesterday].flatMap(date =>
      ['post', 'comment', 'engage'].map(action => [agentId, { date, action }])
    ));
  });
});

describe('collectHandledComments', () => {
  it('includes the edge day and retains recorded deliveries from interrupted monitor runs', async () => {
    getActivities
      .mockResolvedValueOnce([
        { status: 'failed', result: { replied: [{ commentId: 'reply-1' }], upvoted: [{ commentId: 'vote-1' }] } },
        { status: 'running' },
      ])
      .mockResolvedValueOnce([
        { status: 'completed', result: { replied: [{ commentId: 'reply-1' }, { commentId: 'reply-2' }] } },
        { status: 'completed', result: { upvoted: [{ commentId: 'vote-2' }] } },
      ]);

    expect(await collectHandledComments(agentId, 1)).toEqual({
      replied: new Set(['reply-1', 'reply-2']),
      upvoted: new Set(['vote-1', 'vote-2']),
    });
    expect(getActivities.mock.calls).toEqual([now, yesterday].map(date =>
      [agentId, { date, action: 'monitor', limit: Infinity }]
    ));
  });
});

describe('ownReplyParentIds', () => {
  it('collects unique parent IDs from this agent across both API formats', () => {
    const comments = [
      { author: 'example', parent_id: 'parent-1' },
      { author: { name: 'example' }, parentId: 'parent-2' },
      { author: 'example', parentId: 'parent-2' },
      { author: 'example', parentId: null },
      { author: 'someone-else', parentId: 'other-parent' },
      { parentId: 'anonymous-parent' },
    ];

    expect(ownReplyParentIds(comments, 'example')).toEqual(new Set(['parent-1', 'parent-2']));
    expect(ownReplyParentIds(comments, null)).toEqual(new Set());
  });
});
