import { z } from 'zod';
import { isValidKey } from './mediaItemKey.js';

// =============================================================================
// MOOD BOARD SCHEMAS (issue #911)
// =============================================================================
// A mood board collects visual + textual references that feed the Create suite.
// Boards are db-primary, local-only records; items live inline in the board's
// JSONB. validation.js re-exports everything here so deep imports keep working.

export const MOOD_BOARD_ITEM_TYPES = Object.freeze(['image', 'text']);

// A media-key references an indexed asset as `<kind>:<ref>` (e.g.
// `image:my-render.png`, `video:job-123`). Reuse the shared key validator from
// mediaItemKey.js (the same vocabulary mediaCollections / mediaAnnotations use)
// so a board can't pin a key the rest of PortOS would reject.
const mediaKeySchema = z.string().trim().refine(isValidKey, 'mediaKey must be a valid `<kind>:<ref>` media key');

// External/pinned image URL. http(s) or a same-origin app path (e.g. a served
// `/data/images/...` URL). Bounded; the UI renders it in an <img>, so no exotic
// schemes. A protocol-relative `//host/...` is rejected: it starts with `/` but
// resolves to an arbitrary external origin, which the leading-slash branch is
// not meant to allow.
const imageUrlSchema = z.string().trim().min(1).max(2048).refine(
  (v) => /^https?:\/\//.test(v) || (v.startsWith('/') && !v.startsWith('//')),
  'imageUrl must be an http(s) URL or an absolute app path',
);

const captionSchema = z.string().max(2000).nullable().optional();
const sourceSchema = z.string().max(2048).nullable().optional();

// Board create. description optional (defaults to '' in the record builder).
export const moodBoardCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
}).strict();

// Board PATCH — only the editable board-level fields. items[] is managed via
// the dedicated item endpoints, never a bulk board PATCH.
export const moodBoardUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
}).strict();

// Add-item. An `image` item requires at least one of mediaKey / imageUrl; a
// `text` item requires non-empty text. The cross-field rule is enforced with a
// superRefine so the failure is specific.
export const moodBoardItemCreateSchema = z.object({
  type: z.enum(MOOD_BOARD_ITEM_TYPES),
  mediaKey: mediaKeySchema.nullable().optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  text: z.string().trim().max(10000).nullable().optional(),
  caption: captionSchema,
  source: sourceSchema,
}).strict().superRefine((val, ctx) => {
  if (val.type === 'image') {
    if (!val.mediaKey && !val.imageUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'an image item requires mediaKey or imageUrl',
        path: ['imageUrl'],
      });
    }
  } else if (val.type === 'text') {
    if (!val.text || !val.text.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a text item requires non-empty text',
        path: ['text'],
      });
    }
  }
});

// Pinterest link body. The URL shape is validated lightly here (present, http(s),
// bounded); the Pinterest-host check + board-URL→feed-URL normalization happens
// in `normalizePinterestFeedUrl` (server/lib/pinterestFeed.js), which throws a
// specific 400 so the user sees *why* a non-Pinterest URL was rejected.
export const moodBoardPinterestLinkSchema = z.object({
  url: z.string().trim().min(1).max(2048).refine(
    (v) => /^https?:\/\//.test(v),
    'url must be an http(s) Pinterest board URL',
  ),
}).strict();

// Item PATCH — caption/source on any item, plus the type-appropriate body
// field. No `type` switch (an item's kind is fixed at creation); every field
// optional so a partial edit validates.
export const moodBoardItemUpdateSchema = z.object({
  caption: captionSchema,
  source: sourceSchema,
  text: z.string().trim().max(10000).nullable().optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  mediaKey: mediaKeySchema.nullable().optional(),
}).strict();
