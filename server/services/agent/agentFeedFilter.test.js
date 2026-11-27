import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findRelevantPosts, findReplyOpportunities, moltbookAuthorName, scorePosts } from './agentFeedFilter.js';

const agent = { name: 'Example Agent', personality: { topics: ['Fungi', 'BOTANY'] } };

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }).setSystemTime(new Date('2026-01-01T12:00:00Z')));
afterEach(() => vi.useRealTimers());

describe('scorePosts', () => {
  it('ranks by topic, community, discussion size, and recency across feed field formats', () => {
    const posts = [
      { id: 'unrelated', title: 'Seascapes', submolt: null, commentCount: 5, createdAt: '2026-01-01T06:00:00Z' },
      { id: 'community', submolt: 'Fungal botany', commentCount: 5 },
      { id: 'discussion', content: 'BOTANY and more botany', commentCount: 4 },
      { id: 'recent', title: 'FUNGI', content: 'Botany', submolt: { name: 'fungi' }, comment_count: 3, created_at: '2026-01-01T06:01:00Z' },
    ];

    expect(scorePosts(agent, posts)).toEqual([
      { ...posts[3], relevanceScore: 10, matchedTopics: ['fungi', 'botany'] },
      { ...posts[2], relevanceScore: 4, matchedTopics: ['botany'] },
      { ...posts[1], relevanceScore: 2, matchedTopics: [] },
      { ...posts[0], relevanceScore: 0, matchedTopics: [] },
    ]);
  });

  it('assigns neutral scores in feed order when the agent has no topics', () => {
    const posts = [{ id: 'first' }, { id: 'second', title: 'Botany' }];

    expect(scorePosts({ name: agent.name }, posts)).toEqual(
      posts.map(post => ({ ...post, relevanceScore: 1, matchedTopics: [] }))
    );
  });
});

describe('moltbookAuthorName', () => {
  it.each([
    [{ author: 'example' }, 'example'],
    [{ author: { name: 'example' } }, 'example'],
    [{ author: null }, undefined],
    [{}, undefined],
  ])('reads the name from %j', (item, name) => {
    expect(moltbookAuthorName(item)).toBe(name);
  });
});

describe('findRelevantPosts', () => {
  it('applies the inclusive score threshold, exclusions, and result cap to the ranked feed', async () => {
    const posts = [
      { id: 'below-threshold' },
      { id: 'last', submolt: 'fungi', commentCount: 5 },
      { id: 'first', title: 'Botany' },
      { id: 'excluded', title: 'Fungi and botany' },
    ];
    const client = { getFeed: vi.fn().mockResolvedValue({ posts }) };

    const options = { sort: 'new', limit: 15, minScore: 2, maxResults: 2, excludePostIds: ['excluded'] };
    const result = await findRelevantPosts(client, agent, options);
    expect(client.getFeed).toHaveBeenCalledWith('new', 15);
    expect(result.map(post => post.id)).toEqual(['first', 'last']);
    expect(await findRelevantPosts(client, agent, { ...options, maxResults: 1 })).toEqual([result[0]]);
  });
});

describe('findReplyOpportunities', () => {
  it('skips either author representation and stops reading comments when the cap is reached', async () => {
    const posts = [
      { id: 'answered-string', title: 'Fungi and botany' },
      { id: 'answered-object', title: 'Fungi and botany' },
      { id: 'topic', title: 'Botany' },
      { id: 'community', submolt: 'fungi' },
      { id: 'third', submolt: 'fungi' },
      { id: 'unused', submolt: 'fungi' },
    ];
    const topicComments = [{ author: { name: 'another-agent' } }];
    const client = {
      getFeed: vi.fn().mockResolvedValue(posts),
      getComments: vi.fn()
        .mockResolvedValueOnce({ comments: [{ author: 'example' }] })
        .mockResolvedValueOnce([{ author: { name: 'example' } }])
        .mockResolvedValueOnce({ comments: topicComments })
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]),
    };

    expect(await findReplyOpportunities(client, agent, { agentUsername: 'example', maxCandidates: 3 })).toEqual([
      { post: { ...posts[2], relevanceScore: 4, matchedTopics: ['botany'] }, comments: topicComments, replyTo: null, reason: 'Matches topics: botany' },
      { post: { ...posts[3], relevanceScore: 3, matchedTopics: [] }, comments: [], replyTo: null, reason: 'Relevant to interests' },
      { post: { ...posts[4], relevanceScore: 3, matchedTopics: [] }, comments: [], replyTo: null, reason: 'Relevant to interests' },
    ]);
    expect(client.getComments.mock.calls).toEqual([['answered-string'], ['answered-object'], ['topic'], ['community'], ['third']]);
  });
});
