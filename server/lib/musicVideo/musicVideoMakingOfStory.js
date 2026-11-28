/**
 * Versioned Making-Of story Zod schemas and server normalization for Music Video projects.
 * Shared browser-safe constants and formatters live in `musicVideoMakingOfStoryShared.js`.
 */

import { z } from 'zod';
import {
  MAKING_OF_ITEM_KINDS,
  MAKING_OF_ITEM_ROLES,
  MAKING_OF_POST_PLATFORMS,
  MAKING_OF_POST_STATUSES,
  MAKING_OF_STORY_LIMITS,
  MAKING_OF_X_MAX_MEDIA_PER_POST,
  emptyMakingOfStory,
  normalizeMakingOfTags,
} from './musicVideoMakingOfStoryShared.js';

export {
  MAKING_OF_ITEM_KINDS,
  MAKING_OF_ITEM_ROLES,
  MAKING_OF_ITEM_ROLE_LABELS,
  MAKING_OF_POST_PLATFORMS,
  MAKING_OF_POST_PLATFORM_LABELS,
  MAKING_OF_POST_STATUSES,
  MAKING_OF_POST_STATUS_LABELS,
  MAKING_OF_STORY_LIMITS,
  MAKING_OF_X_MAX_MEDIA_PER_POST,
  autoDistributeMakingOfPartItems,
  emptyMakingOfStory,
  formatMakingOfPostCopy,
  isMakingOfMediaItem,
  makingOfItemKey,
  normalizeMakingOfTags,
  resolveMakingOfPostParts,
  splitMakingOfThreadParts,
} from './musicVideoMakingOfStoryShared.js';

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
// Gallery image filename (`abc.png`, `upload-123.jpg`) or video history id (`uuid` / `upload-123`).
const SAFE_ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{1,140}(?:\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov))?$/i;

function isSafePublicUrl(value) {
  if (!value) return true;
  const parsed = z.string().url().safeParse(value);
  if (!parsed.success) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && !url.username
      && !url.password
      && !/(?:^|\.)(?:localhost|local|internal|lan|home|ts\.net)$/.test(host);
  } catch {
    return false;
  }
}

const tagListSchema = z.array(z.string().max(MAKING_OF_STORY_LIMITS.tagMaxLength * 2))
  .max(MAKING_OF_STORY_LIMITS.maxTags * 2)
  .default([])
  .transform(normalizeMakingOfTags);

const optionalUrlSchema = z.string().trim().max(MAKING_OF_STORY_LIMITS.urlMaxLength)
  .refine(isSafePublicUrl, 'Use a public http(s) URL without credentials or private hostnames.')
  .default('');

const optionalAssetIdSchema = z.string().trim()
  .refine((v) => !v || SAFE_ASSET_ID_PATTERN.test(v), 'Invalid media asset identifier')
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

const optionalSafeIdSchema = z.string().trim()
  .refine((v) => !v || SAFE_ID_PATTERN.test(v), 'Invalid identifier')
  .nullable()
  .optional()
  .transform((v) => (v ? v : null));

export const makingOfItemSchema = z.object({
  id: z.string().regex(SAFE_ID_PATTERN),
  kind: z.enum(MAKING_OF_ITEM_KINDS),
  assetId: optionalAssetIdSchema,
  sceneId: optionalSafeIdSchema,
  refId: optionalSafeIdSchema,
  label: z.string().trim().max(MAKING_OF_STORY_LIMITS.labelMaxLength).default(''),
  role: z.enum(MAKING_OF_ITEM_ROLES).default('process'),
  tags: tagListSchema,
  note: z.string().max(MAKING_OF_STORY_LIMITS.noteMaxLength).default(''),
  sourceUrl: optionalUrlSchema,
  capturedAt: z.string().max(64).default(''),
}).strict();

const partItemIdsSchema = z.array(
  z.array(z.string().regex(SAFE_ID_PATTERN)).max(MAKING_OF_X_MAX_MEDIA_PER_POST),
).max(MAKING_OF_STORY_LIMITS.maxThreadParts);

export const makingOfPostSchema = z.object({
  id: z.string().regex(SAFE_ID_PATTERN),
  title: z.string().trim().min(1).max(MAKING_OF_STORY_LIMITS.titleMaxLength),
  status: z.enum(MAKING_OF_POST_STATUSES).default('idea'),
  platform: z.enum(MAKING_OF_POST_PLATFORMS).default('x'),
  tags: tagListSchema,
  summary: z.string().max(MAKING_OF_STORY_LIMITS.summaryMaxLength).default(''),
  body: z.string().max(MAKING_OF_STORY_LIMITS.bodyMaxLength).default(''),
  itemIds: z.array(z.string().regex(SAFE_ID_PATTERN)).max(MAKING_OF_STORY_LIMITS.maxItems).default([]),
  partItemIds: partItemIdsSchema.default([]),
  publishedUrl: optionalUrlSchema,
  publishedAt: z.string().max(64).nullable().optional().transform((v) => (v ? v : null)),
  updatedAt: z.string().max(64).default(''),
}).strict();

export const makingOfStorySchema = z.object({
  version: z.literal(1).default(1),
  items: z.array(makingOfItemSchema).max(MAKING_OF_STORY_LIMITS.maxItems).default([]),
  posts: z.array(makingOfPostSchema).max(MAKING_OF_STORY_LIMITS.maxPosts).default([]),
}).strict();

export const makingOfItemCaptureSchema = z.object({
  id: z.string().regex(SAFE_ID_PATTERN).optional(),
  kind: z.enum(MAKING_OF_ITEM_KINDS),
  assetId: optionalAssetIdSchema,
  sceneId: optionalSafeIdSchema,
  refId: optionalSafeIdSchema,
  label: z.string().trim().max(MAKING_OF_STORY_LIMITS.labelMaxLength).default(''),
  role: z.enum(MAKING_OF_ITEM_ROLES).default('process'),
  tags: tagListSchema,
  note: z.string().max(MAKING_OF_STORY_LIMITS.noteMaxLength).default(''),
  sourceUrl: optionalUrlSchema,
  postId: optionalSafeIdSchema,
  newPostTitle: z.string().trim().max(MAKING_OF_STORY_LIMITS.titleMaxLength).optional(),
}).strict();

export const makingOfItemPatchSchema = z.object({
  label: z.string().trim().max(MAKING_OF_STORY_LIMITS.labelMaxLength).optional(),
  role: z.enum(MAKING_OF_ITEM_ROLES).optional(),
  tags: tagListSchema.optional(),
  note: z.string().max(MAKING_OF_STORY_LIMITS.noteMaxLength).optional(),
  sourceUrl: optionalUrlSchema.optional(),
  sceneId: optionalSafeIdSchema,
  refId: optionalSafeIdSchema,
}).strict();

export const makingOfPostCreateSchema = z.object({
  title: z.string().trim().min(1).max(MAKING_OF_STORY_LIMITS.titleMaxLength),
  status: z.enum(MAKING_OF_POST_STATUSES).default('idea'),
  platform: z.enum(MAKING_OF_POST_PLATFORMS).default('x'),
  tags: tagListSchema,
  summary: z.string().max(MAKING_OF_STORY_LIMITS.summaryMaxLength).default(''),
  body: z.string().max(MAKING_OF_STORY_LIMITS.bodyMaxLength).default(''),
  itemIds: z.array(z.string().regex(SAFE_ID_PATTERN)).max(MAKING_OF_STORY_LIMITS.maxItems).default([]),
  partItemIds: partItemIdsSchema.default([]),
  publishedUrl: optionalUrlSchema,
  publishedAt: z.string().max(64).nullable().optional().transform((v) => (v ? v : null)),
}).strict();

export const makingOfPostPatchSchema = z.object({
  title: z.string().trim().min(1).max(MAKING_OF_STORY_LIMITS.titleMaxLength).optional(),
  status: z.enum(MAKING_OF_POST_STATUSES).optional(),
  platform: z.enum(MAKING_OF_POST_PLATFORMS).optional(),
  tags: tagListSchema.optional(),
  summary: z.string().max(MAKING_OF_STORY_LIMITS.summaryMaxLength).optional(),
  body: z.string().max(MAKING_OF_STORY_LIMITS.bodyMaxLength).optional(),
  itemIds: z.array(z.string().regex(SAFE_ID_PATTERN)).max(MAKING_OF_STORY_LIMITS.maxItems).optional(),
  partItemIds: partItemIdsSchema.optional(),
  publishedUrl: optionalUrlSchema.optional(),
  publishedAt: z.string().max(64).nullable().optional(),
}).strict();

export const makingOfXDraftPrepareSchema = z.object({
  again: z.boolean().optional(),
}).strict();

/** Dedupe items/posts by id and drop dangling post.itemIds / post.partItemIds references. */
export function normalizeMakingOfStory(input) {
  if (!input) return emptyMakingOfStory();
  const parsed = makingOfStorySchema.parse(input);
  const itemById = new Map();
  for (const item of parsed.items) {
    if (!itemById.has(item.id)) itemById.set(item.id, item);
  }
  const items = [...itemById.values()];
  const postById = new Map();
  for (const post of parsed.posts) {
    if (postById.has(post.id)) continue;
    const seenIds = new Set();
    const itemIds = post.itemIds.filter((id) => {
      if (!itemById.has(id) || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    });
    const rawPartIds = (post.partItemIds || []).map((bucket) => {
      const seenInPart = new Set();
      const cleaned = [];
      for (const id of bucket) {
        if (!itemById.has(id) || seenInPart.has(id)) continue;
        seenInPart.add(id);
        cleaned.push(id);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          itemIds.push(id);
        }
        if (cleaned.length >= MAKING_OF_X_MAX_MEDIA_PER_POST) break;
      }
      return cleaned;
    });
    while (rawPartIds.length && rawPartIds[rawPartIds.length - 1].length === 0) rawPartIds.pop();
    postById.set(post.id, { ...post, itemIds, partItemIds: rawPartIds });
  }
  return { version: 1, items, posts: [...postById.values()] };
}
