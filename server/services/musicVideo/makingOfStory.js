/**
 * Making-Of story service for Music Video projects.
 *
 * All writes serialize through `mutateProjectRecord` so concurrent captures
 * from take strips, Assets, Look references, and the Making-Of management page
 * never clobber each other.
 */

import { randomUUID } from 'node:crypto';
import { ServerError } from '../../lib/errorHandler.js';
import {
  MAKING_OF_STORY_LIMITS,
  emptyMakingOfStory,
  makingOfItemKey,
  normalizeMakingOfStory,
  normalizeMakingOfTags,
} from '../../lib/musicVideo/musicVideoMakingOfStory.js';
import { mutateProjectRecord } from './projects.js';

function currentStory(project) {
  return project?.makingOfStory ? normalizeMakingOfStory(project.makingOfStory) : emptyMakingOfStory();
}

/**
 * Capture (or update) a media/reference/note item in the project's Making-Of bank.
 * If `id` matches an existing item, updates it; otherwise if `(kind, assetId)`
 * already exists and `id` is omitted, updates that item in place so re-clicking
 * "Making of" on a take or reference edits its metadata instead of duplicating it.
 * Optionally attaches the item to an existing `postId` or creates a new post
 * when `newPostTitle` is supplied.
 */
export async function captureMakingOfItem(projectId, input) {
  const now = new Date().toISOString();
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    const items = [...story.items];
    const posts = [...story.posts];

    const key = makingOfItemKey(input.kind, input.assetId);
    const existingIndex = input.id
      ? items.findIndex((entry) => entry.id === input.id)
      : key
        ? items.findIndex((entry) => makingOfItemKey(entry.kind, entry.assetId) === key)
        : -1;

    let item;
    if (existingIndex >= 0) {
      const existing = items[existingIndex];
      item = {
        ...existing,
        kind: input.kind ?? existing.kind,
        assetId: input.assetId !== undefined ? input.assetId : existing.assetId,
        sceneId: input.sceneId !== undefined ? input.sceneId : existing.sceneId,
        refId: input.refId !== undefined ? input.refId : existing.refId,
        label: input.label !== undefined ? input.label : existing.label,
        role: input.role ?? existing.role,
        tags: input.tags ? normalizeMakingOfTags(input.tags) : existing.tags,
        note: input.note !== undefined ? input.note : existing.note,
        sourceUrl: input.sourceUrl !== undefined ? input.sourceUrl : existing.sourceUrl,
      };
      items[existingIndex] = item;
    } else {
      if (items.length >= MAKING_OF_STORY_LIMITS.maxItems) {
        throw new ServerError(`Making-of bank is at its ${MAKING_OF_STORY_LIMITS.maxItems}-item limit`, {
          status: 409,
          code: 'MAKING_OF_LIMIT',
        });
      }
      item = {
        id: input.id || `moi-${randomUUID().slice(0, 12)}`,
        kind: input.kind,
        assetId: input.assetId ?? null,
        sceneId: input.sceneId ?? null,
        refId: input.refId ?? null,
        label: input.label || '',
        role: input.role || 'process',
        tags: normalizeMakingOfTags(input.tags || []),
        note: input.note || '',
        sourceUrl: input.sourceUrl || '',
        capturedAt: now,
      };
      items.push(item);
    }

    let createdPost = null;
    if (input.newPostTitle?.trim()) {
      if (posts.length >= MAKING_OF_STORY_LIMITS.maxPosts) {
        throw new ServerError(`Making-of posts are at the ${MAKING_OF_STORY_LIMITS.maxPosts}-post limit`, {
          status: 409,
          code: 'MAKING_OF_LIMIT',
        });
      }
      createdPost = {
        id: `mop-${randomUUID().slice(0, 12)}`,
        title: input.newPostTitle.trim(),
        status: 'idea',
        platform: 'x',
        tags: [...item.tags],
        summary: '',
        body: '',
        itemIds: [item.id],
        publishedUrl: '',
        publishedAt: null,
        updatedAt: now,
      };
      posts.push(createdPost);
    } else if (input.postId) {
      const postIndex = posts.findIndex((entry) => entry.id === input.postId);
      if (postIndex < 0) {
        throw new ServerError('Making-of post not found', { status: 404, code: 'NOT_FOUND' });
      }
      const post = posts[postIndex];
      if (!post.itemIds.includes(item.id)) {
        posts[postIndex] = { ...post, itemIds: [...post.itemIds, item.id], updatedAt: now };
      }
    }

    const nextStory = normalizeMakingOfStory({ version: 1, items, posts });
    return { project: { ...current, makingOfStory: nextStory }, item, createdPost, story: nextStory };
  });
  return { item: outcome.item, createdPost: outcome.createdPost, story: outcome.story, project: outcome.project };
}

export async function updateMakingOfItem(projectId, itemId, patch) {
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    const index = story.items.findIndex((entry) => entry.id === itemId);
    if (index < 0) throw new ServerError('Making-of item not found', { status: 404, code: 'NOT_FOUND' });
    const existing = story.items[index];
    const updated = {
      ...existing,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeMakingOfTags(patch.tags) } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
      ...(patch.sceneId !== undefined ? { sceneId: patch.sceneId } : {}),
      ...(patch.refId !== undefined ? { refId: patch.refId } : {}),
    };
    const items = [...story.items];
    items[index] = updated;
    const nextStory = normalizeMakingOfStory({ ...story, items });
    return { project: { ...current, makingOfStory: nextStory }, item: updated, story: nextStory };
  });
  return { item: outcome.item, story: outcome.story, project: outcome.project };
}

export async function deleteMakingOfItem(projectId, itemId) {
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    if (!story.items.some((entry) => entry.id === itemId)) {
      throw new ServerError('Making-of item not found', { status: 404, code: 'NOT_FOUND' });
    }
    const items = story.items.filter((entry) => entry.id !== itemId);
    const posts = story.posts.map((post) => (
      post.itemIds.includes(itemId)
        ? { ...post, itemIds: post.itemIds.filter((id) => id !== itemId) }
        : post
    ));
    const nextStory = normalizeMakingOfStory({ version: 1, items, posts });
    return { project: { ...current, makingOfStory: nextStory }, story: nextStory };
  });
  return { story: outcome.story, project: outcome.project };
}

export async function createMakingOfPost(projectId, input) {
  const now = new Date().toISOString();
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    if (story.posts.length >= MAKING_OF_STORY_LIMITS.maxPosts) {
      throw new ServerError(`Making-of posts are at the ${MAKING_OF_STORY_LIMITS.maxPosts}-post limit`, {
        status: 409,
        code: 'MAKING_OF_LIMIT',
      });
    }
    const status = input.status || 'idea';
    const post = {
      id: `mop-${randomUUID().slice(0, 12)}`,
      title: input.title,
      status,
      platform: input.platform || 'x',
      tags: normalizeMakingOfTags(input.tags || []),
      summary: input.summary || '',
      body: input.body || '',
      itemIds: input.itemIds || [],
      publishedUrl: input.publishedUrl || '',
      publishedAt: input.publishedAt ?? (status === 'posted' ? now : null),
      updatedAt: now,
    };
    const nextStory = normalizeMakingOfStory({ ...story, posts: [...story.posts, post] });
    const saved = nextStory.posts.find((entry) => entry.id === post.id);
    return { project: { ...current, makingOfStory: nextStory }, post: saved, story: nextStory };
  });
  return { post: outcome.post, story: outcome.story, project: outcome.project };
}

export async function updateMakingOfPost(projectId, postId, patch) {
  const now = new Date().toISOString();
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    const index = story.posts.findIndex((entry) => entry.id === postId);
    if (index < 0) throw new ServerError('Making-of post not found', { status: 404, code: 'NOT_FOUND' });
    const existing = story.posts[index];
    const nextStatus = patch.status ?? existing.status;
    let nextPublishedAt = patch.publishedAt !== undefined ? patch.publishedAt : existing.publishedAt;
    if (nextStatus === 'posted' && !nextPublishedAt) nextPublishedAt = now;
    const updated = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      status: nextStatus,
      ...(patch.platform !== undefined ? { platform: patch.platform } : {}),
      ...(patch.tags !== undefined ? { tags: normalizeMakingOfTags(patch.tags) } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.itemIds !== undefined ? { itemIds: patch.itemIds } : {}),
      ...(patch.publishedUrl !== undefined ? { publishedUrl: patch.publishedUrl } : {}),
      publishedAt: nextPublishedAt,
      updatedAt: now,
    };
    const posts = [...story.posts];
    posts[index] = updated;
    const nextStory = normalizeMakingOfStory({ ...story, posts });
    const saved = nextStory.posts.find((entry) => entry.id === postId);
    return { project: { ...current, makingOfStory: nextStory }, post: saved, story: nextStory };
  });
  return { post: outcome.post, story: outcome.story, project: outcome.project };
}

export async function deleteMakingOfPost(projectId, postId) {
  const outcome = await mutateProjectRecord(projectId, (current) => {
    const story = currentStory(current);
    if (!story.posts.some((entry) => entry.id === postId)) {
      throw new ServerError('Making-of post not found', { status: 404, code: 'NOT_FOUND' });
    }
    const posts = story.posts.filter((entry) => entry.id !== postId);
    const nextStory = normalizeMakingOfStory({ ...story, posts });
    return { project: { ...current, makingOfStory: nextStory }, story: nextStory };
  });
  return { story: outcome.story, project: outcome.project };
}
