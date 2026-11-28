// Zod request schemas for the continuous video episode routes.

import { z } from 'zod';
import { MIN_CONTEXT_FRAMES, MAX_CONTEXT_FRAMES } from './videoContinuity.js';
import { CONTINUOUS_VIDEO_BACKENDS } from './continuousVideoBackends.js';

const lineSchema = z.object({
  type: z.enum(['action', 'dialogue']),
  speaker: z.string().min(1).max(200).optional(),
  voice: z.string().max(200).optional(),
  text: z.string().max(4000),
});

const sceneSchema = z.object({
  sceneId: z.string().max(200).optional(),
  location: z.string().max(200).optional(),
  lines: z.array(lineSchema).min(1),
});

const bibleEntrySchema = z.object({ descriptor: z.string().min(1).max(2000) });

const bibleSchema = z.object({
  styleDescriptor: z.string().max(2000).optional(),
  cast: z.record(bibleEntrySchema).optional(),
  locations: z.record(bibleEntrySchema).optional(),
});

// Backend render knobs a caller may steer. `settings`/`pythonPath` are always
// server-resolved below and never accepted here — Zod strips any unknown key
// (including an attempted apiKey/pythonPath/settings override) by default.
const renderOptionsSchema = z.object({
  modelId: z.string().max(64).optional(),
  width: z.number().min(64).max(2048).optional(),
  height: z.number().min(64).max(2048).optional(),
  negativePrompt: z.string().max(8000).optional(),
  seed: z.number().optional(),
  falModelId: z.string().min(1).max(200).optional(),
  falDuration: z.number().min(1).max(60).optional(),
  aspectRatio: z.enum(['16:9', '9:16', '1:1']).optional(),
  reactorSeconds: z.number().min(1).max(60).optional(),
  continuityStrategy: z.enum(['frame', 'window']).optional(),
  contextFrames: z.number().int().min(MIN_CONTEXT_FRAMES).max(MAX_CONTEXT_FRAMES).optional(),
});

const compilerOptionsSchema = z.object({
  maxWords: z.number().int().positive().max(200).optional(),
  maxSpeakers: z.number().int().positive().max(10).optional(),
  maxChainLength: z.number().int().positive().max(50).optional(),
  fps: z.number().positive().max(60).optional(),
  frameGrid: z.enum(['uniform', '17n+5']).optional(),
});

export const previewBodySchema = z.object({
  scenes: z.array(sceneSchema).min(1).max(200),
  bible: bibleSchema,
  framings: z.array(z.string().max(200).nullable()).max(2000).optional(),
  compilerOptions: compilerOptionsSchema.optional(),
});

export const submitBodySchema = previewBodySchema.extend({
  backend: z.enum(CONTINUOUS_VIDEO_BACKENDS).optional(),
  renderOptions: renderOptionsSchema.optional(),
});
