/** Request schemas for Music Video release kits, covers, and platform posts. */

import { z } from 'zod';
import { DISTROKID_REMEMBERED_OPTIONS } from '../../distrokidGenres.js';
import { COVER_DESIGN_OPTIONS } from '../musicVideoCoverOverlay.js';
import { CROSS_LINK_EDIT_TARGETS } from '../musicVideoCrossLinks.js';
import { MUSIC_VIDEO_PUBLISH_TARGETS } from '../musicVideoValidation.js';
import { VERTICAL_FRAME_THEME_IDS } from '../musicVideoVerticalFrame.js';
import { videoHistoryIdSchema } from './shared.js';

// #9281: publishing kit — per-platform copy edits, the copy draft request, the chosen thumbnail.
const kitText = (max) => z.string().max(max);

export const musicVideoPublishCopyPatchSchema = z.object({
  youtube: z.object({ title: kitText(100), description: kitText(5000), tags: z.array(kitText(60)).max(30) }).partial().strict().optional(),
  shorts: z.object({ title: kitText(100), description: kitText(5000) }).partial().strict().optional(),
  x: z.object({ hook: kitText(280), story: kitText(25000) }).partial().strict().optional(),
  linkedin: z.object({ post: kitText(3000) }).partial().strict().optional(),
  facebook: z.object({ post: kitText(63206) }).partial().strict().optional(),
  tiktok: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  sunoHook: z.object({ caption: kitText(300) }).partial().strict().optional(),
  instagram: z.object({ caption: kitText(2200) }).partial().strict().optional(),
  reddit: z.object({ title: kitText(300), body: kitText(40000) }).partial().strict().optional(),
  stackerNews: z.object({ title: kitText(80), body: kitText(40000) }).partial().strict().optional(),
  substack: z.object({ title: kitText(100), subtitle: kitText(250), body: kitText(40000) }).partial().strict().optional(),
  notes: kitText(8000).optional(),
  // The draft inputs save as they are edited, not only when Draft runs; '' clears a link.
  links: z.object({ youtube: z.union([z.string().url().max(500), z.literal('')]), song: z.union([z.string().url().max(500), z.literal('')]) }).partial().strict().optional(),
  draftOptions: z.object({
    include: z.object({ title: z.boolean(), lyrics: z.boolean(), spend: z.boolean(), chapters: z.boolean(), hashtags: z.boolean() }).partial().strict().optional(),
    length: z.enum(['short', 'full']).optional(),
  }).strict().optional(),
  // The printable flyer's text (client/src/lib/musicVideoFlyer.js); `url` overrides the YouTube link the QR encodes, '' clears it.
  flyer: z.object({
    kicker: kitText(60), title: kitText(120), byline: kitText(120), tagline: kitText(300), scanLine: kitText(60), printedLink: kitText(120), details: kitText(1200),
    url: z.union([z.string().url().max(500), z.literal('')]),
    image: z.enum(['cover', 'youtubeThumbnail', 'thumbnail', 'gallery', 'none']),
    // A gallery image (data/images/<file>) for image: 'gallery'.
    imageFile: z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((f) => f !== '.' && f !== '..'),
    style: z.enum(['80s', 'clean']),
    layout: z.enum(['full', 'half']),
  }).partial().strict().optional(),
  // What the director typed or picked on each platform's Publish row, saved as edited so a
  // reload or another tab shows it again. Replaces that platform's saved answers.
  postOptions: z.lazy(() => musicVideoPublishPostOptionsSchema).optional(),
  // Platforms skipped for this release only (without changing install-wide settings).
  skippedTargets: z.array(z.lazy(() => musicVideoPublishTargetSchema)).max(20).optional(),
}).strict();

export const musicVideoPublishCopyDraftSchema = z.object({
  providerId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  notes: kitText(8000).optional(),
  links: z.object({ youtube: z.string().url().max(500), song: z.string().url().max(500) }).partial().strict().optional(),
  // What the draft may use beyond the notes and links; omitted keys keep their defaults (title on, the rest off).
  include: z.object({ title: z.boolean(), lyrics: z.boolean(), spend: z.boolean(), chapters: z.boolean(), hashtags: z.boolean() }).partial().strict().optional(),
  length: z.enum(['short', 'full']).optional(),
  // The director agreed to replace posts written or edited by hand since the last draft.
  replaceEdited: z.boolean().optional(),
}).strict();

// Plan the promotion as scheduled steps for the artist (Review Hub › Actions).
export const musicVideoPromotionPlanSchema = z.object({
  providerId: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  goal: z.string().trim().max(1500).optional(),
  audience: z.string().trim().max(1000).optional(),
  days: z.number().int().min(1).max(30).optional(),
}).strict();

export const musicVideoPublishFrameSchema = z.object({ atSec: z.number().finite().min(0) }).strict();

export const musicVideoPublishKitBuildSchema = z.object({
  loudnessPreset: z.enum(['as-mixed', 'web']).default('as-mixed'),
  crop: z.object({
    renderHistoryId: videoHistoryIdSchema,
    filename: z.string().min(1).max(255),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    startSec: z.number().finite().min(0),
    endSec: z.number().finite().positive(),
    position: z.number().finite().min(0).max(1),
  }).strict().refine(({ startSec, endSec }) => endSec > startSec, { path: ['endSec'], message: 'Must be after the start time' }).optional(),
  vertical: z.object({
    mode: z.enum(['auto', 'crop', 'framed']).default('auto'),
    span: z.enum(['hook', 'full']).default('hook'),
    theme: z.enum(VERTICAL_FRAME_THEME_IDS).default('cinema-matte'),
    title: z.string().max(120).optional(),
    subtitle: z.string().max(160).optional(),
    footerNote: z.string().max(120).optional(),
    showLyrics: z.boolean().optional(),
    showWaveform: z.boolean().optional(),
  }).strict().optional(),
}).strict();

// Release cover art: a source (a kit thumbnail or a gallery image) composed
// with the title and artist tag, or a fresh source image from a backend.
const coverArtSourceSchema = z.object({ kind: z.enum(['thumbnail', 'image']), filename: z.string().min(1).max(300) }).strict();

export const musicVideoCoverArtComposeSchema = z.object({
  source: coverArtSourceSchema.optional(),
  title: z.string().max(60).optional(),
  tag: z.string().max(24).optional(),
  focusX: z.number().min(0).max(1).optional(),
  // false = a finished cover from elsewhere: squared and sized, no title or tag set on it.
  lettering: z.boolean().optional(),
}).strict();

// The YouTube thumbnail: a source composed 16:9 with the title in the cover's lettering.
export const musicVideoYoutubeThumbnailComposeSchema = z.object({
  source: coverArtSourceSchema.optional(),
  title: z.string().max(60).optional(),
  focusX: z.number().min(0).max(1).optional(),
  focusY: z.number().min(0).max(1).optional(),
  lettering: z.boolean().optional(),
}).strict();

// "Paint the title": the image model restyles a frame with the title drawn in. Preview takes no source.
export const musicVideoYoutubeThumbnailPaintPreviewSchema = z.object({
  title: z.string().trim().min(1).max(60),
  notes: z.string().max(1500).optional(),
}).strict();

export const musicVideoYoutubeThumbnailPaintSchema = musicVideoYoutubeThumbnailPaintPreviewSchema.extend({ source: coverArtSourceSchema }).strict();

export const musicVideoCoverArtDesignSchema = z.object({
  direction: z.string().max(1500).optional(),
  providerId: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(200).optional(),
}).strict();

// #10345: the Lettering controls. A design is every COVER_DESIGN_OPTIONS field
// plus tracking, colors and the rule; any subset is a patch over the song's
// current design. `typeface` is a free string here (a built-in name or a
// `font:<id>` for an uploaded font) and is resolved against the uploaded fonts
// when the design is normalized.
const coverHex = z.string().regex(/^#[0-9a-f]{6}$/i);

const coverDesignFields = Object.fromEntries(Object.entries(COVER_DESIGN_OPTIONS)
  .map(([key, list]) => [key, key === 'typeface' ? z.string().min(1).max(60) : z.enum(list)]));

const musicVideoCoverDesignSchema = z.object({
  ...coverDesignFields,
  tracking: z.number().min(-0.05).max(0.3),
  titleColor: coverHex,
  accentColor: coverHex,
  rule: z.boolean(),
}).partial().strict();

export const musicVideoCoverDesignSaveSchema = z.object({ design: musicVideoCoverDesignSchema }).strict();

export const musicVideoArtistStyleSaveSchema = z.object({
  name: z.string().trim().min(1).max(60),
  design: musicVideoCoverDesignSchema,
}).strict();

export const musicVideoArtistStyleDeleteSchema = z.object({ name: z.string().trim().min(1).max(60) }).strict();

export const musicVideoCoverArtGenerateSchema = z.object({
  notes: z.string().max(1500).optional(),
  reference: z.object({ kind: z.literal('image'), filename: z.string().min(1).max(300) }).strict().optional(),
}).strict();

export const musicVideoPublishTargetSchema = z.enum(MUSIC_VIDEO_PUBLISH_TARGETS);

const publishUrl = z.string().url().max(500);

// #9287: which platforms the director posts to (opt-in), the account for each,
// and a post's link, reception and notes.
const publishPlatformEntry = z.object({ enabled: z.boolean(), account: z.string().max(100).nullable() }).partial().strict();

// DistroKid also keeps the release answers that repeat on every project ('' or null forgets one).
const rememberedAnswer = z.string().max(100).nullable();

const distrokidPlatformEntry = publishPlatformEntry.extend({
  defaults: z.object(Object.fromEntries(DISTROKID_REMEMBERED_OPTIONS.map((k) => [k, rememberedAnswer]))).partial().strict(),
}).partial().strict();

export const musicVideoPublishPlatformsPatchSchema = z.object(Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS
  .map((t) => [t, (t === 'distrokid' ? distrokidPlatformEntry : publishPlatformEntry).optional()]))).strict();

export const musicVideoPublishPostSchema = z.object({
  url: publishUrl.nullable(),
  // Marks the platform done without a link (a DistroKid upload has none until the stores go live).
  posted: z.literal(true),
  reception: z.enum(['good', 'mixed', 'poor']).nullable(),
  notes: z.string().max(2000).nullable(),
  // The release's other posts this one now links to (cross-links), added to what it linked already.
  links: z.array(musicVideoPublishTargetSchema).max(MUSIC_VIDEO_PUBLISH_TARGETS.length),
}).partial().strict().refine((b) => Object.keys(b).length > 0, { message: 'url, posted, reception, notes or links is required' });

// Whether new drafts list the release's other posts, and which posted platform gets its missing links.
export const musicVideoPublishCrossLinksSchema = z.object({ enabled: z.boolean() }).strict();

export const musicVideoCrossLinkTargetSchema = z.enum(CROSS_LINK_EDIT_TARGETS);

export const musicVideoCrossLinkEditSchema = z.object({}).strict();

export const musicVideoPublishPrepareSchema = z.object({
  subreddit: z.string().max(40),
  kind: z.enum(['self', 'link', 'video']),
  url: publishUrl,
  flairId: z.string().max(100),
  flairText: z.string().max(64),
  firstComment: kitText(10000),
  // LinkedIn, Facebook: put the full video and song links in a first comment (default on).
  linksComment: z.boolean(),
  // Facebook: turn on the post's AI label (default on).
  aiLabel: z.boolean(),
  territory: z.string().max(40),
  // Substack: the publication (name.substack.com or a custom domain); defaults to the account under Where you post.
  publication: z.string().trim().min(1).max(200),
  songUrl: publishUrl,
  pin: z.boolean(),
  // Suno Hook: keep the page's lyric overlay (default off: the cut carries its own).
  showLyrics: z.boolean(),
  prompt: kitText(25000),
  storyImage: z.string().min(1).max(300),
  // A gallery image (data/images/<file>) for the story reply, in place of a video frame.
  storyImageFile: z.string().min(1).max(255).regex(/^[^/\\]+$/).refine((f) => f !== '.' && f !== '..'),
  cutId: z.string().min(1).max(100),
  // Fill a draft for a platform the release was already posted to.
  again: z.boolean(),
  // DistroKid (the song as a Spotify single): who it is by and the store flags.
  artistName: z.string().trim().min(1).max(100),
  songwriterFirst: z.string().trim().min(1).max(100),
  songwriterLast: z.string().trim().min(1).max(100),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  explicit: z.boolean(),
  instrumental: z.boolean(),
  aiLyrics: z.boolean(),
  aiMusic: z.boolean(),
  aiVocals: z.boolean(),
  genre: z.string().trim().min(1).max(60),
  secondaryGenre: z.string().trim().min(1).max(60),
  language: z.string().trim().min(1).max(60),
  songwriterRole: z.enum(['music', 'lyrics', 'both']),
  newArtistProfile: z.boolean(),
  preserveCaps: z.boolean(),
  performerName: z.string().trim().min(1).max(100),
  performerRole: z.string().trim().min(1).max(60),
  producerName: z.string().trim().min(1).max(100),
  previewStartSec: z.number().min(0).max(3600),
}).partial().strict();

// A row's answers are kept while half-typed (a link mid-edit), so values are checked by
// type only here; Fill draft still validates them against the prepare schema.
const postOptionValue = z.union([z.string().max(25000), z.boolean(), z.number().finite()]);

const postOptionsEntry = z.object(Object.fromEntries(Object.keys(musicVideoPublishPrepareSchema.shape)
  .filter((k) => k !== 'again').map((k) => [k, postOptionValue]))).partial().strict();

const musicVideoPublishPostOptionsSchema = z.object(Object.fromEntries(MUSIC_VIDEO_PUBLISH_TARGETS
  .map((t) => [t, postOptionsEntry]))).partial().strict();
