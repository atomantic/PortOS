/**
 * Agent Feed Filter Service
 *
 * Scores and filters Moltbook feed posts based on agent topic relevance.
 * Used for finding posts to engage with autonomously.
 */

/**
 * Score posts against an agent's topics and interests
 */
export function scorePosts(agent, posts) {
  const topics = (agent.personality?.topics || []).map(t => t.toLowerCase());

  if (topics.length === 0) {
    return posts.map(post => ({ ...post, relevanceScore: 1, matchedTopics: [] }));
  }

  return posts.map(post => {
    const titleLower = (post.title || '').toLowerCase();
    const contentLower = (post.content || '').toLowerCase();
    const text = `${titleLower} ${contentLower}`;

    let score = 0;
    const matchedTopics = [];

    // Topic match: +3 per matching topic
    for (const topic of topics) {
      if (text.includes(topic)) {
        score += 3;
        matchedTopics.push(topic);
      }
    }

    // Submolt alignment: +2 if submolt matches a topic
    const submoltRaw = typeof post.submolt === 'object' ? post.submolt?.name : post.submolt;
    const submoltLower = (submoltRaw || '').toLowerCase();
    // Every string includes '', so a post without a submolt must not match.
    if (submoltLower && topics.some(t => submoltLower.includes(t) || t.includes(submoltLower))) {
      score += 2;
    }

    // Low comment count: +1 (room for engagement)
    if ((post.commentCount ?? post.comment_count ?? 0) < 5) {
      score += 1;
    }

    // Recency: +1 if posted within last 6 hours
    const createdAt = post.createdAt ?? post.created_at;
    if (createdAt) {
      const age = Date.now() - new Date(createdAt).getTime();
      if (age < 6 * 60 * 60 * 1000) {
        score += 1;
      }
    }

    return { ...post, relevanceScore: score, matchedTopics };
  }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

/** Author name of a Moltbook post or comment (the API returns a string or an object). */
export function moltbookAuthorName(item) {
  return typeof item?.author === 'object' ? item.author?.name : item?.author;
}

/**
 * Fetch feed and filter by relevance to agent
 */
export async function findRelevantPosts(client, agent, options = {}) {
  const {
    sort = 'hot',
    limit = 25,
    minScore = 2,
    maxResults = 10,
    excludePostIds = []
  } = options;

  console.log(`🔍 Finding relevant posts for "${agent.name}" (sort=${sort}, min=${minScore})`);

  const feed = await client.getFeed(sort, limit);
  const posts = feed.posts || feed || [];

  const scored = scorePosts(agent, posts);

  const filtered = scored
    .filter(p => p.relevanceScore >= minScore)
    .filter(p => !excludePostIds.includes(p.id))
    .slice(0, maxResults);

  console.log(`🔍 Found ${filtered.length}/${posts.length} relevant posts for "${agent.name}"`);
  return filtered;
}

/**
 * Find posts worth replying to (not already commented on by this agent).
 * Callers pass `agentUsername`; without it a scheduled run comments again on
 * the same hot posts.
 */
export async function findReplyOpportunities(client, agent, options = {}) {
  const {
    sort = 'hot',
    limit = 25,
    minScore = 2,
    maxCandidates = 5,
    agentUsername = null
  } = options;

  const relevantPosts = await findRelevantPosts(client, agent, {
    sort,
    limit,
    minScore,
    maxResults: maxCandidates * 2
  });

  const opportunities = [];

  for (const post of relevantPosts) {
    const commentsResponse = await client.getComments(post.id);
    const comments = commentsResponse.comments || commentsResponse || [];

    // Skip if agent already commented
    if (agentUsername && comments.some(c => moltbookAuthorName(c) === agentUsername)) {
      continue;
    }

    const reason = post.matchedTopics.length > 0
      ? `Matches topics: ${post.matchedTopics.join(', ')}`
      : 'Relevant to interests';

    opportunities.push({
      post,
      comments,
      replyTo: null,
      reason
    });

    if (opportunities.length >= maxCandidates) break;
  }

  console.log(`💡 Found ${opportunities.length} reply opportunities for "${agent.name}"`);
  return opportunities;
}
