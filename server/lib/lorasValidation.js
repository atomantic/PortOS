// Zod request schemas for the loras routes.

import { paginationQuerySchema } from './queryValidation.js';
import { z } from 'zod';
import { RUNNER_FAMILIES, VIDEO_LORA_FAMILIES } from './runners.js';
import { HF_LORA_FAMILIES } from './huggingfaceLora.js';
import { emptyToUndefined } from './zodCompat.js';

// `force` is read as a raw string; `limit`/`offset` keep parsePagination's lenient fallback.
export const forceQuerySchema = z.object({ force: z.string().optional() });

export const suggestionsQuerySchema = paginationQuerySchema.merge(forceQuerySchema);

// Live keyword search + cursor pagination within one runner family. Backs the
// per-category search box and "Load more" button on /models/loras. Uncached —
// results are query/cursor-specific. `query` blank = top ranking for that
// family (so "Load more" with no keyword just pages the leaderboard).
export const searchQuerySchema = z.object({
  runner: z.enum(Object.values(RUNNER_FAMILIES)),
  // emptyToUndefined: a blank box (`query=`) is a valid "top ranking" request,
  // not a validation error — coerce '' → undefined before the optional check.
  query: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  cursor: z.preprocess(emptyToUndefined, z.string().max(512).optional()),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

// Live keyword/author/repository search across all of HuggingFace for video
// LoRAs (LTX-Video / MiniMax H3) — backs the video search box + family filter
// + "Load more" pagination on /models/loras (#6500). Short-cached server-side
// per (family, query, author, cursor) since each page fans out one metadata
// fetch per candidate repo. `family` omitted/'all' searches both families.
// `cursor` is opaque — always the previous page's `nextCursor`, never built
// by the client.
export const videoSearchQuerySchema = z.object({
  family: z.enum([...Object.values(VIDEO_LORA_FAMILIES), 'all']).optional(),
  query: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  author: z.preprocess(emptyToUndefined, z.string().max(120).optional()),
  // HF's opaque Link-header cursor is a base64-ish query blob — longer than a
  // Civitai cursor, so it gets its own generous-but-bounded cap.
  cursor: z.preprocess(emptyToUndefined, z.string().max(2048).optional()),
  limit: z.coerce.number().int().min(1).max(24).optional(),
});

export const authPostSchema = z.object({ apiKey: z.string().min(1).max(256) });

export const installSchema = z.object({
  url: z.string().min(1).max(1024),
  // Optional one-shot key override — useful if the user wants to test a
  // restricted LoRA without persisting their key in Settings yet.
  apiKey: z.string().min(1).max(256).optional(),
});

// Confirm-step disk preflight for a LoRA install. `source` picks Civitai vs
// HuggingFace; the URL is the same shape the install endpoints already take.
// `family`/`file` are the same optional overrides the HF install stream takes —
// a caller that already knows them (the curated video quick-install cards)
// forwards them so the previewed file matches what installFromHuggingface
// will actually pick, rather than re-guessing from the bare URL.
export const installPreflightSchema = z.object({
  url: z.string().min(1).max(1024),
  source: z.enum(['civitai', 'huggingface']).optional().default('civitai'),
  apiKey: z.string().min(1).max(256).optional(),
  family: z.enum(HF_LORA_FAMILIES).optional(),
  file: z.string().min(1).max(512).regex(/\.safetensors$/i).optional(),
});

// Install an image or video LoRA from a HuggingFace repo (Flux.2 Klein,
// fal / Lightricks LTX, MiniMax H3), streaming byte-level download `progress` frames (SSE-encoded) so the form can
// show a percentage instead of a static "Downloading…" (matching the image/video
// model download badge UX). POST, not GET: this endpoint mutates state (downloads
// + writes a LoRA), and the client reads the stream body with fetch() (not
// EventSource), so url/family ride in the JSON body — a state-changing GET would
// be reachable by a top-level cross-origin navigation carrying a SameSite=Lax
// session cookie (CSRF), which authGate's Origin check can't see. The HF token
// always comes from settings/env, never the request. Terminal frames:
// `{type:'complete', sidecar}` or `{type:'error', message, code}` — the client
// re-uses `code` (e.g. HF_UNKNOWN_FAMILY) to drive the inline family-confirm
// retry, exactly as the plain POST path's thrown error does.
export const hfInstallStreamSchema = z.object({
  url: z.string().min(1).max(1024),
  family: z.enum(HF_LORA_FAMILIES).optional(),
  file: z.string().min(1).max(512).regex(/\.safetensors$/i).optional(),
});

// The Catalog character reads its installed adapters here. Declare this
// before the generic filename route.
export const byCharacterSchema = z.object({
  entryId: z.preprocess(emptyToUndefined, z.string().max(128).optional()),
  ingredientId: z.preprocess(emptyToUndefined, z.string().max(128).optional()),
}).refine((q) => q.entryId || q.ingredientId, { message: 'entryId or ingredientId required' });

export const patchSchema = z.object({
  // Only user-editable fields. Civitai-derived blocks (`civitai`, `file`,
  // `runnerFamily`, `triggerWords`) are not patchable through this surface
  // — the user would have to delete + reinstall to refresh those.
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  recommendedScale: z.number().min(0).max(2).optional(),
  notes: z.string().max(2000).optional(),
});
