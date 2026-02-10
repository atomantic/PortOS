/**
 * Agent Published Content Helpers
 *
 * Shared logic for collecting published posts/comments from activity logs.
 * Used by both the agentTools route and agentActionExecutor.
 */

import * as agentActivity from './agentActivity.js';

/**
 * Collect published posts and comments from activity logs over N days
 */
export async function collectPublishedPosts(agentId, numDays) {
  const postMap = new Map();
  const commentMap = new Map();

  for (let i = 0; i < numDays; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);

    const [postActivities, commentActivities, engageActivities] = await Promise.all([
      agentActivity.getActivities(agentId, { date, action: 'post' }),
      agentActivity.getActivities(agentId, { date, action: 'comment' }),
      agentActivity.getActivities(agentId, { date, action: 'engage' })
    ]);

    for (const activity of postActivities) {
      if (activity.status !== 'completed') continue;
      const postId = activity.result?.postId || activity.id;
      const title = activity.result?.title || activity.params?.title;
      const submolt = activity.result?.submolt || activity.params?.submolt;
      if (!postMap.has(postId)) {
        postMap.set(postId, { postId: activity.result?.postId || null, title, submolt, publishedAt: activity.timestamp });
      }
    }

    for (const activity of commentActivities) {
      if (activity.status !== 'completed') continue;
      const commentId = activity.result?.commentId || activity.id;
      const postId = activity.result?.postId || activity.params?.postId;
      const isReply = activity.result?.isReply;
      if (!commentMap.has(commentId)) {
        commentMap.set(commentId, { commentId: activity.result?.commentId || null, postId, isReply: !!isReply, publishedAt: activity.timestamp });
      }
    }

    for (const activity of engageActivities) {
      if (activity.status !== 'completed' || !activity.result?.comments) continue;
      for (const c of activity.result.comments) {
        if (!c.commentId || commentMap.has(c.commentId)) continue;
        commentMap.set(c.commentId, {
          commentId: c.commentId,
          postId: c.postId,
          postTitle: c.postTitle,
          isReply: false,
          publishedAt: activity.timestamp
        });
      }
    }
  }

  return { postMap, commentMap };
}
