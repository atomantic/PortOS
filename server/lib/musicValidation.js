// Zod request schemas for the music routes.

import { z } from 'zod';
import { MUSIC_CODE_LANGUAGES, MUSIC_CODE_MAX } from './musicCodeLimits.js';
import { federatedMediaAudioProfileSchema } from './federatedMediaWire.js';
import { musicDescribeInputSchema, musicLyricsInputSchema, musicDesignerFields } from './musicDesignerValidation.js';

export const runtimeQuerySchema = z.object({ runtime: z.string().optional() });

export const installSchema = z.object({
  engine: z.string().trim().min(1).max(60),
  repo: z.string().trim().min(1).max(200),
  name: z.string().trim().max(200).optional(),
});

// --- Stepped designer (#4305) ----------------------------------------------
// Empty/whitespace picker values normalize to undefined so a blank <select>
// means "use the install's active provider / the provider's default model"
// instead of reaching the runner as a whitespace string (same preprocessing as
// `refinePromptSchema` in routes/mediaJobs.js).
const blankToUndefined = (s) => {
  const v = (s ?? '').trim();
  return v.length > 0 ? v : undefined;
};

// Shared picker + meta-prompt-override fields for both designer routes. The
// template cap matches the description cap — an override is an instruction
// block, not a document.
const designerPickerShape = {
  ...musicDesignerFields,
  providerId: z.string().max(128).optional().transform(blankToUndefined),
  model: z.string().max(256).optional().transform(blankToUndefined),
  effort: z.string().max(64).optional().transform(blankToUndefined),
};

// Caps mirror the Generate form's own limits: a concept/description feeds the
// prompt field (≤8000), lyrics feed the lyrics field (≤20000).
export const describeSchema = musicDescribeInputSchema.extend(designerPickerShape);

export const lyricsSchema = musicLyricsInputSchema.extend(designerPickerShape);

export const codeShape = z.object({
  description: z.string().trim().max(8000).optional(),
  lyrics: z.string().trim().max(20000).optional(),
  // The script of an animation the piece scores, and that film's length.
  scene: z.string().max(20000).optional().transform(blankToUndefined),
  durationSec: z.number().int().min(1).max(600).optional(),
  // The code in the editor, to revise. It is prompt input for an authorized
  // authoring provider; playback uses the language's separate render boundary.
  current: z.string().max(MUSIC_CODE_MAX).optional().transform(blankToUndefined),
  language: z.enum(MUSIC_CODE_LANGUAGES).optional().default('strudel'),
  ...designerPickerShape,
}).omit({ template: true });

export const codeSchema = codeShape.refine((body) => !!body.description || !!body.scene, {
  message: 'description is required', path: ['description'],
});

const captionField = z.string().max(8000).refine((value) => value.trim().length > 0, 'prompt is required');

export const generateSchema = z.object({
  prompt: captionField,
  // No default: distinguish ABSENT (don't touch the track's lyrics) from a
  // present '' (the user cleared them and generated without — persist the clear).
  lyrics: z.string().max(20000).optional(),
  // A render-level override: ignore even supplied lyrics without clearing the
  // track's saved lyric field when the completed audio is attached.
  instrumentalOnly: z.boolean().optional().default(false),
  engine: z.string().trim().min(1).max(80).optional(),
  modelId: z.string().trim().min(1).max(256).optional(),
  // The peer record id is machine-local routing intent. It never crosses the
  // provider boundary. Free-form text stays local too: remote execution uses a
  // fixed-vocabulary instrumental profile rendered by the worker.
  // Why audio alone is restricted that way:
  // docs/decisions/2026-08-20-federated-visual-prompts.md
  mediaProviderPeerId: z.string().uuid().optional(),
  remoteMusicProfile: federatedMediaAudioProfileSchema.optional(),
  durationSec: z.number().positive().max(600).optional(),
  durationMode: z.enum(['auto', 'manual']).optional(),
  // Attach the result to an existing track (else a new one is created). The
  // title seeds a freshly-created track; ignored when trackId is given.
  trackId: z.string().trim().max(80).optional(),
  title: z.string().trim().max(200).optional(),
  artistId: z.string().trim().max(80).optional().default(''),
  artist: z.string().trim().max(120).optional().default(''),
  albumId: z.string().trim().max(80).optional().default(''),
}).superRefine((value, ctx) => {
  if (!value.mediaProviderPeerId) {
    if (value.remoteMusicProfile) {
      ctx.addIssue({
        code: 'custom',
        path: ['remoteMusicProfile'],
        message: 'remoteMusicProfile requires a remote media provider',
      });
    }
    return;
  }
  if (!value.engine) {
    ctx.addIssue({ code: 'custom', path: ['engine'], message: 'engine is required for a remote media provider' });
  }
  if (!value.modelId) {
    ctx.addIssue({ code: 'custom', path: ['modelId'], message: 'modelId is required for a remote media provider' });
  }
  if (!value.remoteMusicProfile) {
    ctx.addIssue({ code: 'custom', path: ['remoteMusicProfile'], message: 'remoteMusicProfile is required for a remote media provider' });
  }
  // Lyrics used to be refused outright here. They now cross to an allowlisted
  // peer (ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 2),
  // but only when the resolved capability says the model sings AND the peer's
  // build accepts them on the wire — neither of which this schema can see.
  // The check moved into the handler, below the capability resolve.
});
