/**
 * Zod schemas for launch-video and HTML-composition render requests and their contracts.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { knownFilmStyleIdSchema } from './filmStyleGrammars.js';

export const appLaunchVideoPublishSchema = z.object({
  format: z.enum(['mp4', 'gif']).default('gif'),
  videoId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
}).strict();

const LAUNCH_VIDEO_MOTION_STYLES = Object.freeze(['walkthrough', 'showreel', 'ui-morph']);

// One launch timeline can render several frames (#8960). Each name maps to the
// exact size a composition declares in portosComposition.formats; the order is
// the canonical render/delivery order.
export const LAUNCH_VIDEO_FORMAT_SIZES = Object.freeze({ landscape: '1920x1080', vertical: '1080x1920', square: '1080x1080' });
export const LAUNCH_VIDEO_FORMATS = Object.freeze(Object.keys(LAUNCH_VIDEO_FORMAT_SIZES));
const launchVideoFormatSchema = z.enum(LAUNCH_VIDEO_FORMATS);
const launchVideoFormatListSchema = z.array(launchVideoFormatSchema).min(1).max(LAUNCH_VIDEO_FORMATS.length)
  .refine(list => new Set(list).size === list.length, 'formats must not repeat');

// A style reference (#8961): a frame, a short clip, or a Media History image
// or video. `source` picks the bucket the filename is resolved against —
// `gallery` (Media History's own images/videos folders) or `upload` (the
// generic /api/uploads scratch dir) — so the route can contain the read to
// exactly one directory per kind, never a client-supplied path.
const launchVideoStyleReferenceSchema = z.object({
  kind: z.enum(['image', 'video']),
  source: z.enum(['gallery', 'upload']),
  filename: z.string().min(1).max(255).regex(/^[^/\\]+$/, 'filename must not contain a path separator'),
}).strict();

// Off / Light / Film shutter presets; the mapping lives in services/htmlComposition.
const htmlCompositionMotionBlurChoiceSchema = z.enum(['off', 'light', 'film']);

export const appLaunchVideoRequestSchema = z.object({
  sourceVideoId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  feedback: z.string().trim().min(1).max(4000).optional(),
  tone: z.enum(['default', 'polished', 'deadpan', 'cinematic', 'parody']).default('default'),
  direction: z.string().trim().max(2000).default(''),
  // `format` is the single-frame form older callers send; `formats` asks one
  // run for several aspect ratios of the same film. The route normalizes both.
  format: launchVideoFormatSchema.optional(),
  formats: launchVideoFormatListSchema.optional(),
  targetDurationSec: z.number().int().min(15).max(120).default(20),
  generateMusic: z.boolean().default(false),
  musicMethod: z.enum(['agent', 'service']).default('agent'),
  // Legacy boolean for older callers; true means motionStyle "showreel".
  motionGraphics: z.boolean().optional(),
  motionStyle: z.enum(LAUNCH_VIDEO_MOTION_STYLES).optional(),
  // Contact-sheet proof → critique → fix passes before the final render.
  critiqueRounds: z.number().int().min(0).max(4).default(2),
  // Render-time motion blur (#9080); omitted, the composition's own setting stands.
  motionBlur: htmlCompositionMotionBlurChoiceSchema.optional(),
  // Ask the agent to consult installed motion-design skills (npm run setup:motion).
  motionSkills: z.boolean().default(false),
  musicTrack: z.string().min(1).max(255).regex(/^[^/\\]+$/).optional(),
  styleReference: launchVideoStyleReferenceSchema.optional(),
  // Curated medium rulebook (#10254); only its motion/camera/sound/native-move parts reach the prompt.
  styleGrammarId: knownFilmStyleIdSchema.optional(),
}).strict();

export const launchVideoOptionsSchema = z.object({
  sourceVideoId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  targetDurationSec: z.number().min(15).max(120),
  appId: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128).optional(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(128).optional(),
}).strict().refine(value => Boolean(value.appId) === Boolean(value.runId), 'appId and runId must be supplied together');

export const launchVideoStoryboardSchema = z.object({
  posterSec: z.number().nonnegative(),
  scenes: z.array(z.object({
    durationSec: z.number().positive(),
    lines: z.array(z.object({
      text: z.string().trim().min(1).max(10000),
      wordCount: z.number().int().positive(),
      holdSec: z.number().positive(),
    }).strict()).max(100),
  }).strict()).min(1).max(100),
}).strict();

// HTML composition inputs are local, editable assets, never provider prompts.
export const htmlCompositionRenderSchema = z.object({
  launchVideo: launchVideoOptionsSchema.optional(),
  synthesizeMusic: z.boolean().optional(),
  // Master synthesized, library and uploaded audio to -14 LUFS / -1.5 dBTP; false keeps the bed as supplied.
  masterLoudness: z.boolean().optional(),
  // Overrides the page's own portosComposition.motionBlur when present (#9080).
  motionBlur: htmlCompositionMotionBlurChoiceSchema.optional(),
  directory: z.string().min(1).max(1024).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes(':') && !value.split('/').some(part => part === '..' || part === '.' || !part), 'directory must be a relative path inside data'),
  musicTrack: z.string().min(1).max(255).regex(/^[^/\\]+$/, 'musicTrack must be a Music-library filename').optional(),
  audioUpload: z.string().min(1).max(255).regex(/^[^/\\\0]+$/, 'audioUpload must be an uploaded audio filename').refine(value => value !== '.' && value !== '..', 'audioUpload must be an uploaded audio filename').optional(),
  // Several aspect ratios of one timeline, rendered in sequence on one page.
  // Omitted, the job renders the composition's own width/height as before.
  formats: launchVideoFormatListSchema.optional(),
  // A proof renders a silent contact sheet for review instead of the video;
  // `format` checks one declared framing, defaulting to the composition's own.
  proof: z.object({ everySec: z.number().min(0.25).max(10).default(1), format: launchVideoFormatSchema.optional() }).strict().optional(),
}).refine(value => [value.synthesizeMusic, value.musicTrack, value.audioUpload].filter(Boolean).length <= 1, 'Choose synthesized music, a library track, or uploaded audio')
  .refine(value => !(value.proof && (value.synthesizeMusic || value.musicTrack || value.audioUpload)), 'A proof is silent; omit synthesizeMusic, musicTrack and audioUpload')
  .refine(value => !(value.proof && value.formats), 'A proof checks one framing; use proof.format instead of formats');

// Public renders stay capped at 120s. A music-video owner passes a higher
// ceiling (the song length, hard-capped by the caller at 900s) and gets the
// same frame rules. superRefine lives on this factory because the exported
// schema is a ZodEffects and cannot be extended in place.
export function htmlCompositionContractSchemaFor(maxDurationSec = 120) {
  return z.object({
    durationSec: z.number().min(1).max(maxDurationSec),
    fps: z.number().int().min(12).max(60),
    width: z.number().int(),
    height: z.number().int(),
    // Subframes averaged per output frame to fake motion blur on fast moves.
    // The integer form (1 default) keeps the existing tmix path byte for byte;
    // the object form (#9077) samples a centred shutter in linear light, with a
    // fixed count or 'auto' refinement that stops once the average converges.
    motionBlur: z.union([
      z.number().int().min(1).max(4),
      z.object({
        shutter: z.number().min(0.05).max(1).default(0.5),
        samples: z.union([z.literal('auto'), z.number().int().min(4).max(64)]).default('auto'),
        tolerance: z.number().min(1).max(8).default(2),
      }).strict(),
    ]).default(1),
    // Extra sizes this one timeline can render (#8960), reframed by the optional
    // layout({ width, height }) hook before each format's first seek.
    formats: z.array(z.enum(Object.values(LAUNCH_VIDEO_FORMAT_SIZES))).min(1).max(LAUNCH_VIDEO_FORMATS.length).optional(),
    layout: z.boolean().default(false),
  }).superRefine((value, ctx) => {
    if (!['1920x1080', '1080x1920', '1080x1080', '1280x720'].includes(`${value.width}x${value.height}`)) {
      ctx.addIssue({ code: 'custom', path: ['width'], message: 'width/height must be 1920x1080, 1080x1920, 1080x1080 or 1280x720' });
    }
    if (Math.abs(value.durationSec * value.fps - Math.round(value.durationSec * value.fps)) > 1e-8) {
      ctx.addIssue({ code: 'custom', path: ['durationSec'], message: 'durationSec × fps must be a whole number of frames' });
    }
  });
}

export const htmlCompositionContractSchema = htmlCompositionContractSchemaFor(120);
