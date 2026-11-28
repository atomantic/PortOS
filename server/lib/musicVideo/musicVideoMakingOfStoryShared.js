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

export const MAKING_OF_STORY_LIMITS = Object.freeze({
  maxItems: 300,
  maxPosts: 50,
  maxTags: 20,
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

/** Format a staged post for clipboard copy, optionally with its ordered media checklist. */
export function formatMakingOfPostCopy(post, items = [], { includeMedia = false } = {}) {
  const sections = [];
  const body = (post.body || '').trim();
  if (body) sections.push(body);
  else if (post.summary?.trim()) sections.push(post.summary.trim());
  else sections.push(post.title);

  if (includeMedia) {
    const byId = new Map(items.map((item) => [item.id, item]));
    const attached = (post.itemIds || []).map((id) => byId.get(id)).filter(Boolean);
    if (attached.length) {
      const lines = attached.map((item, idx) => {
        const role = MAKING_OF_ITEM_ROLE_LABELS[item.role] || item.role;
        const asset = item.assetId ? ` [${item.kind === 'video' ? 'video' : 'image'}: ${item.assetId}]` : '';
        const note = item.note?.trim() ? ` — ${item.note.trim()}` : '';
        return `${idx + 1}. (${role}) ${item.label || item.assetId || 'Note'}${asset}${note}`;
      });
      sections.push(`Media attachments:\n${lines.join('\n')}`);
    }
  }
  return sections.join('\n\n');
}
