/** Zod schemas for federated-media provider settings, routing and versioned job submissions. */

import { z } from 'zod';
import { a2vLoraStageStrengthsSchema, isDefaultA2vLoraStages } from './videoLoraStageValidation.js';
import { imageEdgeSchema, refineImagePixelCap, PIXEL_CAP_MESSAGE, mediaFilenameSchema } from './sharedSchemas.js';
import { FEDERATED_MEDIA_ASSET_MAX_COUNT, FEDERATED_MEDIA_MAX_VIDEO_FRAMES, federatedMediaInputAssetRefSchema, isFederatedMediaAudioPrompt, federatedSourceAudioSchema } from './federatedMediaWire.js';
import { isPlainObject } from './objects.js';

// Federated media is an opt-in provider surface. The outer objects remain
// passthrough for mixed-version peers/settings UIs: a rolled-back install must
// preserve fields introduced by a newer build while still validating every
// field this build understands.
export const federatedMediaModelSchema = z.object({
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
}).passthrough();

const federatedMediaModelListSchema = z.array(federatedMediaModelSchema).max(100).refine(
  (models) => new Set(models.map((model) => `${model.engine}\u0000${model.modelId}`)).size === models.length,
  { message: 'models must not contain duplicate engine/model pairs' },
);

// Image/video federation shares this same model-pair shape (`{ engine,
// modelId }`) as audio for wire uniformity, but only `engine: 'local'`
// resolves to a live capability today — the provider only has readiness
// signals for this install's own local generator, not the cloud-CLI image/
// video backends (codex/grok/agy/external), which spend a *provider's own*
// account quota rather than sharing this machine's GPU. A peer that
// configures a non-local engine simply reports 'unknown-engine' and never
// admits a job, so this schema doesn't need to special-case it.
export const federatedMediaProviderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  maxQueuedJobs: z.number().int().min(1).max(20).optional(),
  audioModels: federatedMediaModelListSchema.optional(),
  imageModels: federatedMediaModelListSchema.optional(),
  videoModels: federatedMediaModelListSchema.optional(),
}).passthrough();

// Consumer-side peer selection is independent from the provider's local queue
// limit. Unknown fields stay round-trip-safe across mixed-version Instances
// clients while known model pairs remain unique and bounded.
export const federatedMediaPeerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  audioModels: federatedMediaModelListSchema.optional(),
  imageModels: federatedMediaModelListSchema.optional(),
  videoModels: federatedMediaModelListSchema.optional(),
}).passthrough();

// Where UNATTENDED jobs (Creative Director / Creative Commission) of a given
// kind render. One peer + one model per kind, chosen by the local operator and
// stored server-side, so an LLM planner never names a peer. Nullable because
// clearing a kind is how routing is turned back off — an absent key means
// "unchanged", an explicit null means "render locally again".
export const federatedMediaRouteSchema = z.object({
  peerId: z.string().trim().min(1).max(200),
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
}).strict();

export const federatedMediaRoutingSchema = z.object({
  image: federatedMediaRouteSchema.nullable().optional(),
  video: federatedMediaRouteSchema.nullable().optional(),
}).passthrough();

export const federationSettingsSchema = z.object({
  strictPullAuthorization: z.boolean().optional(),
  mediaProvider: federatedMediaProviderSettingsSchema.optional(),
  mediaRouting: federatedMediaRoutingSchema.optional(),
}).passthrough();

export const federatedMediaJobRoutingSchema = z.object({
  engine: z.string().trim().min(1).max(80),
  modelId: z.string().trim().min(1).max(256),
  durationSec: z.number().finite().min(1).max(3600).optional(),
  durationMode: z.enum(['auto', 'manual']).optional(),
}).strict();

// Provider submissions accept model selection, the canonical fixed-vocabulary
// instrumental prompt, and — since ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 2 — free-form
// lyrics. The asymmetry between the two text fields is deliberate rather than
// inconsistent: a style/mood/instrument profile renders `prompt` with no
// expressive loss, so the privacy-safe canonical form is required there; lyrics
// ARE the words, so no alphabet encodes them without discarding them, and they
// cross verbatim under the same submission-body rule image/video prompts do.
// The provider still refuses them for a model whose capability reports
// `lyrics: false`. URLs, paths, commands, provider credentials, and unknown
// fields are excluded by the strict object as before.
const federatedMediaAudioJobSubmissionSchema = federatedMediaJobRoutingSchema.extend({
  kind: z.literal('audio'),
  prompt: z.string().trim().min(1).max(8000),
  lyrics: z.string().max(50_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!isFederatedMediaAudioPrompt(value.prompt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['prompt'],
      message: 'prompt must be rendered from a privacy-safe federated audio profile',
    });
  }
});

// Image/video prompts cross as submitted, with no fixed-vocabulary rendering
// like audio's: there is no closed taxonomy for arbitrary visual/motion content
// the way audio has a finite style/mood/instrument alphabet. Why that does not
// breach the "no PII on federation" rule — a submitted job body is not a status
// payload, and status/capability payloads stay absolutely prompt-free — is
// ADR docs/decisions/2026-08-20-federated-visual-prompts.md.
//
// Conditioning IMAGES ride the same rule (ADR
// docs/decisions/2026-08-22-federated-media-input-assets.md rule 1), by id
// rather than by value: the bytes went up through the authenticated,
// digest-verified asset endpoint first. What is still refused here — and refused
// by the routes, since neither has a field to name it — is a MODEL (LoRA
// weights, rule 3) and multi-step CHAIN STATE (a video to extend, chained
// chunks, IC-LoRA references, rule 4).
// Exported UN-REFINED as well, and the split is load-bearing rather than
// cosmetic. The cross-field rule below pairs `initImageStrength` with
// `initImage` — but a conditioning image reaches the body as an asset id
// resolved immediately BEFORE submission, so the persisted marker legitimately
// carries the strength with no image beside it yet. The marker and the request
// builder validate against the base; the provider route, which sees the fully
// assembled body, validates against the refined schema.
export const federatedMediaImageJobSubmissionBaseSchema = federatedMediaJobRoutingSchema.omit({
  durationSec: true, durationMode: true,
}).extend({
  kind: z.literal('image'),
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(4000).optional(),
  width: imageEdgeSchema,
  height: imageEdgeSchema,
  steps: z.number().int().min(1).max(150).optional(),
  guidance: z.number().finite().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  initImage: federatedMediaInputAssetRefSchema.optional(),
  initImageStrength: z.number().finite().min(0).max(1).optional(),
  referenceImages: z.array(federatedMediaInputAssetRefSchema)
    .max(FEDERATED_MEDIA_ASSET_MAX_COUNT).optional(),
}).strict()
  .refine(refineImagePixelCap, { message: PIXEL_CAP_MESSAGE, path: ['width'] });

export const federatedMediaImageJobSubmissionSchema = federatedMediaImageJobSubmissionBaseSchema
  // A strength with nothing to apply it to is a caller bug, not a default to
  // guess at: silently ignoring it renders at full denoise, which is the
  // opposite of what a low strength asked for.
  .refine((value) => value.initImageStrength === undefined || value.initImage !== undefined, {
    message: 'initImageStrength requires an initImage',
    path: ['initImageStrength'],
  });

// Same boundary as the image schema above — see the ADRs named there.
//
// Exported UN-REFINED as well: `negotiateVideoConstraints` re-validates a
// partially-negotiated body against `.partial()`, and Zod refuses `.partial()`
// on a schema carrying refinements. Splitting the object from its cross-field
// rule keeps both callers honest instead of dropping the rule to keep the
// partial working.
export const federatedMediaVideoJobSubmissionBaseSchema = federatedMediaJobRoutingSchema.omit({
  durationSec: true, durationMode: true,
}).extend({
  kind: z.literal('video'),
  a2vLoraStageStrengths: a2vLoraStageStrengthsSchema.refine(isDefaultA2vLoraStages, {
    message: 'Federated video does not support per-stage user LoRA strengths',
  }).optional(),
  prompt: z.string().trim().min(1).max(4000),
  negativePrompt: z.string().trim().max(4000).optional(),
  width: z.number().int().min(64).max(2048).optional(),
  height: z.number().int().min(64).max(2048).optional(),
  numFrames: z.number().int().min(1).max(FEDERATED_MEDIA_MAX_VIDEO_FRAMES).optional(),
  fps: z.number().int().min(1).max(60).optional(),
  steps: z.number().int().min(1).max(150).optional(),
  guidance: z.number().finite().min(0).max(30).optional(),
  seed: z.number().int().min(0).optional(),
  sourceImage: federatedMediaInputAssetRefSchema.optional(),
  lastImage: federatedMediaInputAssetRefSchema.optional(),
  sourceAudio: federatedMediaInputAssetRefSchema.optional(),
  audioConditioning: federatedSourceAudioSchema.optional(),
}).strict();

export const federatedMediaVideoJobSubmissionSchema = federatedMediaVideoJobSubmissionBaseSchema
  .refine((v) => Boolean(v.sourceAudio) === Boolean(v.audioConditioning), {
    message: 'sourceAudio and audioConditioning must be supplied together',
  })
  .refine((v) => !v.audioConditioning || (v.fps !== undefined && v.numFrames !== undefined), {
    message: 'Source audio requires explicit fps and numFrames for its exact window',
  })
  .refine((v) => !v.sourceAudio || (!v.lastImage && v.sourceAudio.assetId.endsWith(v.audioConditioning?.clipSha256 || '!')), {
    message: 'Source audio must match its clip digest and cannot combine with an end frame',
  })
  // First-last-frame needs both ends. A lone end frame would render a plain
  // text-to-video clip and quietly discard the frame the caller supplied.
  .refine((value) => value.lastImage === undefined || value.sourceImage !== undefined, {
    message: 'lastImage requires a sourceImage (first-last-frame needs both ends)',
    path: ['lastImage'],
  });

// An already-shipped consumer's request body never carries `kind` — it only
// knows the pre-existing audio-only shape. Defaulting the missing field to
// 'audio' before the discriminated union runs keeps that body validating
// exactly as before; a new consumer names its kind explicitly.
export const federatedMediaJobSubmissionSchema = z.preprocess(
  (value) => (isPlainObject(value) && value.kind === undefined ? { ...value, kind: 'audio' } : value),
  z.discriminatedUnion('kind', [
    federatedMediaAudioJobSubmissionSchema,
    federatedMediaImageJobSubmissionSchema,
    federatedMediaVideoJobSubmissionSchema,
  ]),
);

export const federatedMediaIdempotencyKeySchema = z.string().trim().min(1).max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Idempotency-Key contains unsupported characters');

export const federatedMediaJobParamsSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const federatedMediaStatusQuerySchema = z.object({
  kinds: z.string().trim().max(40).regex(/^[a-z]+(,[a-z]+)*$/).optional(),
}).passthrough();

// POST /api/peer-media/delete — a paired peer asks this machine to delete a
// media row it holds. Video rows key on the history id, images on the filename.
export const peerMediaDeleteSchema = z.object({
  kind: z.enum(['video', 'image']),
  key: z.string().min(1).max(512),
}).strict();

export const mediaSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const peerMediaCopySchema = z.object({
  kind: z.enum(['video', 'image']),
  filename: mediaFilenameSchema,
  sha256: mediaSha256Schema.optional(),
}).strict();

const isoTimestampSchema = z.string().max(64).refine((v) => Number.isFinite(Date.parse(v)), 'Must be a timestamp');

// POST /api/peer-media/release — a paired peer asks this machine to drop its
// copy of a file's bytes in favor of the primary holder (services/mediaHolders.js).
export const peerMediaReleaseSchema = z.object({
  kind: z.enum(['video', 'image']),
  filename: mediaFilenameSchema,
  primaryInstanceId: z.string().min(1).max(128),
  primaryAt: isoTimestampSchema,
  sha256: mediaSha256Schema.optional(),
}).strict();
