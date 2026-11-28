/**
 * Deliver PortOS notifications for new published comments and replies on a configured YouTube channel.
 *
 * Storage: file-primary. The polling checkpoint is local operational state under data/youtube,
 * backed up with that directory and never federated. It keeps no comment text or raw comment IDs.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWrite, ensureDir } from '../lib/fileCore.js';
import { readJSONFile } from '../lib/jsonIo.js';
import { NOTIFICATION_TYPES } from '../lib/notificationTypes.js';
import { PATHS } from '../lib/paths.js';
import { readPortosEnvValue } from '../lib/portosEnv.js';
import { getEvent, schedule } from './eventScheduler.js';
import { addNotification, exists } from './notifications.js';

const EVENT_ID = 'youtube-comment-watch';
const MINUTE_MS = 60_000;
const OVERLAP_MS = 24 * 60 * MINUTE_MS;
const API_ROOT = 'https://www.googleapis.com/youtube/v3/';
const TYPE = NOTIFICATION_TYPES.YOUTUBE_COMMENT;
const MISSING_STATE = Symbol('missing YouTube comment watcher checkpoint');
const timestamp = z.number().int().nonnegative();
const stateSchema = z.object({
  version: z.literal(1),
  activatedAt: timestamp,
  checkedAt: timestamp.nullable(),
  seen: z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}$/), timestamp]))
});
const commentSchema = z.object({
  id: z.string().min(1),
  snippet: z.object({ publishedAt: z.iso.datetime() })
});
const threadSchema = z.object({
  snippet: z.object({
    videoId: z.string().optional(),
    topLevelComment: commentSchema,
    totalReplyCount: z.number().int().nonnegative()
  }),
  replies: z.object({ comments: z.array(commentSchema) }).optional()
});

function setting(name) {
  return (process.env[name] || readPortosEnvValue(name) || '').trim();
}

async function* listItems(endpoint, params, itemSchema, apiKey) {
  const schema = z.object({ items: z.array(itemSchema), nextPageToken: z.string().min(1).optional() });
  const url = new URL(endpoint, API_ROOT);
  url.search = new URLSearchParams({ maxResults: '100', ...params }).toString();
  const seenTokens = new Set();
  while (true) {
    let response;
    try {
      response = await fetch(url, {
        headers: { 'X-Goog-Api-Key': apiKey },
        redirect: 'error',
        signal: AbortSignal.timeout(15_000)
      });
    } catch {
      throw new Error(`YouTube ${endpoint} request failed or timed out`);
    }
    if (!response.ok) {
      if (endpoint === 'comments' && response.status === 404) {
        const body = await response.json().catch(() => null);
        if (Array.isArray(body?.error?.errors) && body.error.errors.some(item => item?.reason === 'commentNotFound')) return;
      }
      throw new Error(`YouTube ${endpoint} returned HTTP ${response.status}`);
    }
    const parsed = schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error(`YouTube ${endpoint} returned an invalid page`);
    yield* parsed.data.items;
    const token = parsed.data.nextPageToken;
    if (!token) return;
    if (seenTokens.has(token)) throw new Error(`YouTube ${endpoint} repeated a page token`);
    seenTokens.add(token);
    url.searchParams.set('pageToken', token);
  }
}

async function* listVideoComments(channelId, apiKey) {
  const threads = listItems('commentThreads', {
    part: 'snippet,replies',
    allThreadsRelatedToChannelId: channelId,
    fields: 'nextPageToken,items(snippet(videoId,topLevelComment(id,snippet(publishedAt)),totalReplyCount),replies(comments(id,snippet(publishedAt))))'
  }, threadSchema, apiKey);
  for await (const { snippet, replies } of threads) {
    if (!snippet.videoId) continue;
    yield { comment: snippet.topLevelComment, isReply: false };
    if (snippet.totalReplyCount === 0) continue;
    const embedded = replies?.comments ?? [];
    // Time ordering is for threads. A reply may land under any old thread.
    const comments = embedded.length === snippet.totalReplyCount ? embedded : listItems('comments', {
      part: 'snippet',
      parentId: snippet.topLevelComment.id,
      fields: 'nextPageToken,items(id,snippet(publishedAt))'
    }, commentSchema, apiKey);
    for await (const comment of comments) yield { comment, isReply: true };
  }
}

async function readState(stateFile) {
  const raw = await readJSONFile(stateFile, MISSING_STATE, { strict: true, allowArray: false, logError: false });
  if (raw === MISSING_STATE) return null;
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid YouTube comment watcher checkpoint');
  return parsed.data;
}

async function poll({ channelId, apiKey, stateFile }) {
  const startedAt = Date.now();
  const state = await readState(stateFile);
  if (!state) throw new Error('YouTube comment watcher checkpoint is missing');
  // Rescan the overlap for indexing delay and changes to page boundaries. Leave
  // the checkpoint unchanged on a failed scan so the next run covers the gap.
  const lower = Math.max(state.activatedAt, (state.checkedAt ?? state.activatedAt) - OVERLAP_MS);
  const seen = new Map(state.seen.filter(([, publishedAt]) => publishedAt >= lower));
  const discovered = new Map();
  for await (const { comment, isReply } of listVideoComments(channelId, apiKey)) {
    const publishedAt = Date.parse(comment.snippet.publishedAt);
    if (publishedAt < lower) continue;
    const key = createHash('sha256').update(comment.id).digest('hex');
    if (!seen.has(key)) discovered.set(key, { publishedAt, isReply });
  }

  for (const [key, { publishedAt, isReply }] of [...discovered].sort((a, b) => a[1].publishedAt - b[1].publishedAt)) {
    // Notification history also covers a write that succeeded before a failed
    // checkpoint write or server shutdown. The scheduler serializes this job.
    if (!await exists(TYPE, 'commentKey', key)) {
      await addNotification({
        type: TYPE,
        title: isReply ? 'New YouTube reply' : 'New YouTube comment',
        description: isReply ? 'A new reply was posted on one of your videos.' : 'A new comment was posted on one of your videos.',
        link: `https://studio.youtube.com/channel/${channelId}/comments/inbox`,
        metadata: { commentKey: key }
      });
    }
    seen.set(key, publishedAt);
  }
  await atomicWrite(stateFile, { ...state, checkedAt: startedAt, seen: [...seen] });
}

export async function startYoutubeCommentWatcher() {
  if (getEvent(EVENT_ID)) return;
  const channelId = setting('YOUTUBE_COMMENT_CHANNEL_ID');
  const apiKey = setting('YOUTUBE_COMMENT_API_KEY');
  if (!channelId && !apiKey) return;
  if (!apiKey || !/^UC[A-Za-z0-9_-]{22}$/.test(channelId)) {
    throw new Error('YouTube comment watcher needs YOUTUBE_COMMENT_API_KEY and a valid YOUTUBE_COMMENT_CHANNEL_ID');
  }
  const intervalMinutes = Number(setting('YOUTUBE_COMMENT_INTERVAL_MINUTES') || '60');
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new Error('YOUTUBE_COMMENT_INTERVAL_MINUTES must be a whole number from 5 to 1440');
  }

  const directory = join(PATHS.data, 'youtube');
  const stateFile = join(directory, `comments-${channelId}.json`);
  const state = await readState(stateFile);
  if (!state) {
    await ensureDir(directory);
    await atomicWrite(stateFile, { version: 1, activatedAt: Date.now(), checkedAt: null, seen: [] });
  }

  const intervalMs = intervalMinutes * MINUTE_MS;
  schedule({
    id: EVENT_ID,
    type: 'interval',
    intervalMs,
    lastRunAt: state?.checkedAt ?? Date.now() - intervalMs,
    handler: () => poll({ channelId, apiKey, stateFile }),
    metadata: { source: 'youtubeCommentWatcher' }
  });
}
