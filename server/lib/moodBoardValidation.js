import { z } from 'zod';
import { isValidKey, parseKey } from './mediaItemKey.js';

// =============================================================================
// MOOD BOARD SCHEMAS (issue #911)
// =============================================================================
// A mood board collects visual + textual references that feed the Create suite.
// Boards are db-primary, local-only records; items live inline in the board's
// JSONB. validation.js re-exports everything here so deep imports keep working.

export const MOOD_BOARD_ITEM_TYPES = Object.freeze(['image', 'text', 'video']);

// A media-key references an indexed asset as `<kind>:<ref>` (e.g.
// `image:my-render.png`, `video:job-123`). Reuse the shared key validator from
// mediaItemKey.js (the same vocabulary mediaCollections / mediaAnnotations use)
// so a board can't pin a key the rest of PortOS would reject.
const mediaKeySchema = z.string().trim().refine(isValidKey, 'mediaKey must be a valid `<kind>:<ref>` media key');

// A `type:'video'` board item's mediaKey ref is the on-disk FILENAME
// (extension included), not a bare history id: playback resolves it as
// `/data/videos/<ref>` and the peer-sync asset manifest passes an extensioned
// ref through untouched, so `video:job-123` would 404 locally and mis-guess
// `.mp4` on the wire. parseKey already bounds the ref and rejects `:`; this
// adds the path-traversal guard (mirroring sanitizeAssetFilename) and the
// extension requirement. Shared with the item-update invariant in
// moodBoard/logic.js so a PATCH can't swap a video item onto a non-video or
// extension-less key.
export function isVideoItemMediaKey(key) {
  const parsed = parseKey(key || '');
  if (parsed?.kind !== 'video') return false;
  const { ref } = parsed;
  if (ref.includes('/') || ref.includes('\\')) return false;
  if (ref === '.' || ref === '..') return false;
  return /\.[a-z0-9]{2,6}$/i.test(ref);
}

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
// `text` item requires non-empty text; a `video` item (#4188) requires a
// `video:<filename>` mediaKey — the ref is the on-disk filename (extension
// included) so playback (`/data/videos/<ref>`) and the peer-sync asset
// manifest both resolve without guessing, and `imageUrl` optionally carries
// the poster thumbnail. The cross-field rule is enforced with a superRefine
// so the failure is specific.
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
  } else if (val.type === 'video') {
    if (!isVideoItemMediaKey(val.mediaKey)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'a video item requires a `video:<filename>` mediaKey (filename with extension)',
        path: ['mediaKey'],
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

// Per-item prompt-from-media analysis (#4188 Phase 3) — written by the item
// PATCH after a user-triggered vision run on the item's media. Additive on the
// wire: the board federates whole-record LWW (sanitizeBoardForSync's `...raw`
// spread) and an older peer preserves the unknown key, so no `moodBoards`
// schema-gate bump — same precedent as the `pinterest` sub-object. Bounds
// mirror the analyzer's own caps (MAX_PROMPT_LEN / MAX_REASON_LEN in
// mediaPromptFromMedia.js). `null` on the PATCH clears a stored analysis.
export const moodBoardItemAnalysisSchema = z.object({
  prompt: z.string().trim().min(1).max(8000),
  negativePrompt: z.string().max(8000).nullable().optional(),
  rationale: z.string().max(1200).nullable().optional(),
  providerId: z.string().max(128).nullable().optional(),
  model: z.string().max(256).nullable().optional(),
  analyzedAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

// Item PATCH — caption/source on any item, plus the type-appropriate body
// field. No `type` switch (an item's kind is fixed at creation); every field
// optional so a partial edit validates. `analysis` applies to media items
// only (enforced in logic.js where the item's type is known).
export const moodBoardItemUpdateSchema = z.object({
  caption: captionSchema,
  source: sourceSchema,
  text: z.string().trim().max(10000).nullable().optional(),
  imageUrl: imageUrlSchema.nullable().optional(),
  mediaKey: mediaKeySchema.nullable().optional(),
  analysis: moodBoardItemAnalysisSchema.nullable().optional(),
}).strict();
