/**
 * Zod schemas for the game routes: records, sprite/music/artwork bindings, publishing and feedback.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { EFFORT_LEVELS } from './provider/providerModels.js';

// Game studio (#3177): managed-app binding, reusable asset bindings, bundle
// compile, and user-triggered AI feedback.
const gameNameSchema = z.string().trim().min(1).max(120);
const gameAppIdSchema = z.string().trim().min(1).max(128);
const gameAssetIdSchema = z.string().trim().min(1).max(128);

export const gameCreateSchema = z.object({
  appId: gameAppIdSchema,
  name: gameNameSchema,
}).strict();

export const gameUpdateSchema = z.object({
  appId: gameAppIdSchema.optional(),
  name: gameNameSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: 'at least one field is required',
});

export const gameSpriteBindingSchema = z.object({
  spriteId: gameAssetIdSchema,
}).strict();

// Repo-relative publish destination inside the managed app repository. The
// extension gate is per-lane (PNG artwork vs library audio); the traversal
// refinements are shared so the two lanes can't drift.
const gameDestinationSchema = (extensionPattern, extensionMessage) => z.string()
  .trim()
  .min(1)
  .max(500)
  .regex(extensionPattern, extensionMessage)
  .refine((value) => !value.startsWith('/') && !value.includes('\\'), 'must be a repo-relative path')
  .refine((value) => !value.split('/').includes('..'), 'must not traverse outside the app repository');
const gameMusicDestinationSchema = gameDestinationSchema(
  /\.(?:mp3|wav|m4a|ogg|flac)$/i,
  'must end in a supported audio extension',
);
const gamePublishOptionsSchema = z.object({
  acknowledgeOverwrite: z.boolean().optional(),
}).strict();

export const gameMusicBindingSchema = z.object({
  trackId: gameAssetIdSchema,
  destinationPath: gameMusicDestinationSchema.optional(),
}).strict();

export const gameMusicBindingUpdateSchema = z.object({
  destinationPath: gameMusicDestinationSchema,
}).strict();

export const gameMusicPublishSchema = gamePublishOptionsSchema;

const GAME_ARTWORK_ROLES = [
  'title-key-art',
  'game-logo',
  'biome-luminous-wilds',
  'biome-mineral-steppe',
  'biome-tide-meadow',
  'loading-screen',
  'other',
];

const gameArtworkFilenameSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/i, 'must be a gallery PNG filename')
  .max(255);
const gameArtworkDestinationSchema = gameDestinationSchema(/\.png$/i, 'must end in .png');

export const gameArtworkBindingSchema = z.object({
  imageFilename: gameArtworkFilenameSchema,
  label: z.string().trim().min(1).max(120),
  role: z.enum(GAME_ARTWORK_ROLES),
  destinationPath: gameArtworkDestinationSchema,
}).strict();

export const gameArtworkBindingUpdateSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  role: z.enum(GAME_ARTWORK_ROLES).optional(),
  destinationPath: gameArtworkDestinationSchema.optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, {
  message: 'at least one field is required',
});

export const gameArtworkPublishSchema = gamePublishOptionsSchema;

export const gameFeedbackSchema = z.object({
  providerId: z.string().trim().min(1).max(128),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
  prompt: z.string().trim().min(1).max(4_000),
}).strict();
