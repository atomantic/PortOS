/**
 * Browser-safe shared constants and pure helpers for Music Video Making-Of stories.
 * Imported by both server validation/services and client UI without pulling in `zod`.
 */

export const MAKING_OF_ITEM_KINDS = ['image', 'video', 'reference', 'note'];

export const MAKING_OF_ITEM_ROLES = [
  'fail',
  'before',
  'after',
  'process',
  'reference',
  'final',
  'lesson',
];

export const MAKING_OF_ITEM_ROLE_LABELS = Object.freeze({
  fail: 'Fail / Bloopers',
  before: 'Before',
  after: 'After',
  process: 'Process / WIP',
  reference: 'Reference / Guide',
  final: 'Final',
  lesson: 'Lesson / Tip',
});

export const MAKING_OF_POST_STATUSES = ['idea', 'draft', 'staged', 'posted'];

export const MAKING_OF_POST_STATUS_LABELS = Object.freeze({
  idea: 'Idea',
  draft: 'Draft',
  staged: 'Staged',
  posted: 'Posted',
});

export const MAKING_OF_POST_PLATFORMS = [
  'x',
  'youtube',
  'tiktok',
  'instagram',
  'linkedin',
  'facebook',
  'substack',
  'reddit',
  'blog',
  'multi',
];

export const MAKING_OF_POST_PLATFORM_LABELS = Object.freeze({
  x: 'X',
  youtube: 'YouTube',
  tiktok: 'TikTok',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  substack: 'Substack',
  reddit: 'Reddit',
  blog: 'Blog',
  multi: 'Multi-platform',
});

export const MAKING_OF_X_MAX_MEDIA_PER_POST = 4;

export const MAKING_OF_STORY_LIMITS = Object.freeze({
  maxItems: 300,
  maxPosts: 50,
  maxTags: 20,
  maxThreadParts: 25,
  tagMaxLength: 40,
  labelMaxLength: 200,
  noteMaxLength: 4000,
  titleMaxLength: 200,
  summaryMaxLength: 1000,
  bodyMaxLength: 20000,
  urlMaxLength: 2048,
});

export function normalizeMakingOfTags(tags) {
  if (!Array.isArray(tags)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().replace(/^#+/, '').replace(/\s+/g, '-').slice(0, MAKING_OF_STORY_LIMITS.tagMaxLength);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAKING_OF_STORY_LIMITS.maxTags) break;
  }
  return out;
}

export function emptyMakingOfStory() {
  return { version: 1, items: [], posts: [] };
}

/** Canonical lookup key for matching whether a media/reference asset is already saved. */
export function makingOfItemKey(kind, assetId) {
  if (!assetId) return null;
  const mediaKind = kind === 'video' ? 'video' : 'image';
  return `${mediaKind}:${assetId}`;
}

/** Whether a Making-Of item carries an attachable image/video file. */
export function isMakingOfMediaItem(item) {
  return Boolean(item && item.kind !== 'note' && item.assetId);
}

/**
 * Split a Making-Of post into individual thread post texts on `---` dividers.
 * Falls back to summary or title when body is blank so single-post ideas still resolve.
 */
export function splitMakingOfThreadParts(post) {
  const body = (post?.body || '').trim();
  if (body) {
    return body
      .split(/\n\s*---\s*\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, MAKING_OF_STORY_LIMITS.maxThreadParts);
  }
  const fallback = (post?.summary || '').trim() || (post?.title || '').trim();
  return fallback ? [fallback] : [];
}

/**
 * Resolve each thread part alongside the Making-Of media items assigned to it.
 * Uses explicit `post.partItemIds` whenever present. For a single-part post with
 * no explicit `partItemIds`, falls back to the first `MAKING_OF_X_MAX_MEDIA_PER_POST`
 * media items from `post.itemIds` so single posts work with zero extra wiring.
 */
export function resolveMakingOfPostParts(post, items = []) {
  const texts = splitMakingOfThreadParts(post);
  const byId = new Map(items.map((item) => [item.id, item]));
  const explicit = Array.isArray(post?.partItemIds) ? post.partItemIds : [];
  const hasExplicit = explicit.some((bucket) => Array.isArray(bucket) && bucket.length > 0);
  return texts.map((text, index) => {
    let rawIds = [];
    if (hasExplicit) {
      rawIds = Array.isArray(explicit[index]) ? explicit[index] : [];
    } else if (texts.length === 1) {
      rawIds = (post?.itemIds || []).filter((id) => isMakingOfMediaItem(byId.get(id))).slice(0, MAKING_OF_X_MAX_MEDIA_PER_POST);
    }
    const seen = new Set();
    const partItems = [];
    for (const id of rawIds) {
      if (seen.has(id)) continue;
      const entry = byId.get(id);
      if (!isMakingOfMediaItem(entry)) continue;
      seen.add(id);
      partItems.push(entry);
      if (partItems.length >= MAKING_OF_X_MAX_MEDIA_PER_POST) break;
    }
    return { index, text, items: partItems };
  });
}

/**
 * Evenly distribute a post's staged media items across its thread parts, respecting
 * `MAKING_OF_X_MAX_MEDIA_PER_POST` per part so the director has a ready starting point.
 */
export function autoDistributeMakingOfPartItems(post, items = []) {
  const texts = splitMakingOfThreadParts(post);
  if (!texts.length) return [];
  const byId = new Map(items.map((item) => [item.id, item]));
  const mediaIds = (post?.itemIds || []).filter((id) => isMakingOfMediaItem(byId.get(id)));
  const buckets = texts.map(() => []);
  if (!mediaIds.length) return buckets;
  const maxTotal = texts.length * MAKING_OF_X_MAX_MEDIA_PER_POST;
  const capped = mediaIds.slice(0, maxTotal);
  let cursor = 0;
  for (let i = 0; i < texts.length && cursor < capped.length; i += 1) {
    const remainingParts = texts.length - i;
    const remainingItems = capped.length - cursor;
    const take = Math.min(MAKING_OF_X_MAX_MEDIA_PER_POST, Math.ceil(remainingItems / remainingParts));
    buckets[i] = capped.slice(cursor, cursor + take);
    cursor += take;
  }
  return buckets;
}

/** Format a staged post for clipboard copy, optionally with its ordered media checklist. */
export function formatMakingOfPostCopy(post, items = [], { includeMedia = false } = {}) {
  const formatItemLine = (item, idx) => {
    const role = MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role;
    const asset = item.assetId ? ` [${item.kind === 'video' ? 'video' : 'image'}: ${item.assetId}]` : '';
    const note = item.note?.trim() ? ` — ${item.note.trim()}` : '';
    return `${idx + 1}. (${role}) ${item.label || item.assetId || 'Note'}${asset}${note}`;
  };

  const parts = resolveMakingOfPostParts(post, items);
  const hasPartMedia = parts.some((part) => part.items.length > 0);
  if (includeMedia && hasPartMedia && parts.length > 1) {
    const assigned = new Set();
    const sections = parts.map((part) => {
      for (const item of part.items) assigned.add(item.id);
      if (!part.items.length) return part.text;
      const mediaLines = part.items.map(formatItemLine).join('\n');
      return `${part.text}\n\nAttachments (Part ${part.index + 1}):\n${mediaLines}`;
    });
    const byId = new Map(items.map((item) => [item.id, item]));
    const extra = (post.itemIds || []).map((id) => byId.get(id)).filter((entry) => entry && !assigned.has(entry.id));
    if (extra.length) {
      sections.push(`Additional staged media:\n${extra.map(formatItemLine).join('\n')}`);
    }
    return sections.join('\n\n---\n\n');
  }

  const sections = [];
  const body = (post.body || '').trim();
  if (body) sections.push(body);
  else if (post.summary?.trim()) sections.push(post.summary.trim());
  else sections.push(post.title);

  if (includeMedia) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const attached = (post.itemIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (attached.length) {
      sections.push(`Media attachments:\n${attached.map(formatItemLine).join('\n')}`);
    }
  }
  return sections.join('\n\n');
}
