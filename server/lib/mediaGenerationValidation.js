/**
 * Zod schemas for the image/video generation routes: cancel, model downloads, hosted providers, delete, primary and extend bodies.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { mediaFilenameSchema } from './sharedSchemas.js';

// Media cancellation bodies (#9932). An OMITTED jobId keeps the legacy
// "newest/running job" selection; a SUPPLIED jobId must be a usable id — a
// malformed one (array, object, null, blank) is a 400, never silently treated
// as absent, because absent selects a different live render to cancel.
const mediaCancelJobIdSchema = z.string().trim().min(1).max(200);
export const imageCancelBodySchema = z.object({
  jobId: mediaCancelJobIdSchema.optional(),
  all: z.boolean().optional(),
});
export const videoCancelBodySchema = z.object({
  jobId: mediaCancelJobIdSchema.optional(),
});

// Provider whose delete is being run for a finished render (services/hostedRenderRemoteDelete.js).
export const hostedProviderParamSchema = z.enum(['runway', 'fal', 'higgsfield']);

// Video downloader (#1946) — paste a YouTube/x.com URL, download the full
// video. The host allowlist is enforced in the service (assertSupportedVideoUrl)
// so the error names the supported hosts; the schema just guards the shape.
export const videoDownloadSchema = z.object({
  url: z.string().url().max(2048)
});

export const imageVisibilityBodySchema = z.object({ hidden: z.boolean().default(false) });

export const modelDownloadParamsSchema = z.object({ modelId: z.string().min(1).max(256) });
export const icLoraDownloadParamsSchema = z.object({ mode: z.string().min(1).max(256) });
export const textEncoderDownloadParamsSchema = z.object({ id: z.string().min(1).max(256) });

// DELETE /api/image-gen/:filename, /api/video-gen/history/:id — `force=1` deletes
// a file records still use (services/mediaUsage.js); without it a used file is refused.
export const mediaDeleteQuerySchema = z.object({ force: z.enum(['0', '1']).optional() }).passthrough();

// POST /api/media/holders/primary — keep one holder's copy, release the others.
export const mediaMakePrimarySchema = z.object({
  kind: z.enum(['video', 'image']),
  filename: mediaFilenameSchema,
  instanceId: z.string().min(1).max(128),
}).strict();

// #16150: extend a hosted clip. The prompt is sent as written; a Music Video caller names the take it extends.
export const videoExtendBodySchema = z.object({
  prompt: z.string().min(1).max(20000),
  dryRun: z.boolean().optional(),
  musicVideo: z.object({
    projectId: z.string().min(1).max(200),
    sceneId: z.string().min(1).max(200),
    takeId: z.string().min(1).max(128),
  }).strict().optional(),
}).strict();
