/**
 * Agent Published Content Helpers
 *
 * Shared logic for collecting published posts/comments from activity logs.
 * Used by both the agentTools route and agentActionExecutor.
 */

import * as agentActivity from './agentActivity.js';
import { moltbookAuthorName } from './agentFeedFilter.js';

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

/**
 * Comments earlier monitor runs already replied to or upvoted. A monitor run
 * re-reads every comment on every post in its window, so without this the agent
 * publishes another reply to the same comment on each run.
 */
export async function collectHandledComments(agentId, numDays) {
  const replied = new Set();
  const upvoted = new Set();
  // Inclusive of the partial day at the far edge of the window.
  for (let i = 0; i <= numDays; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const runs = await agentActivity.getActivities(agentId, { date, action: 'monitor', limit: Infinity });
    // Count every run that recorded a delivery, including one halted by a suspension.
    for (const { result } of runs) {
      for (const entry of result?.replied ?? []) replied.add(entry.commentId);
      for (const entry of result?.upvoted ?? []) upvoted.add(entry.commentId);
    }
  }
  return { replied, upvoted };
}

/** Parent ids the agent already answered in this thread, for a run that failed before logging. */
export function ownReplyParentIds(comments, agentUsername) {
  return new Set(comments
    .filter(c => agentUsername && moltbookAuthorName(c) === agentUsername)
    .map(c => c.parentId ?? c.parent_id)
    .filter(Boolean));
}
