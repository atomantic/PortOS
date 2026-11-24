/**
 * Zod schemas for instance-level settings: location, network setup, API access, instance features, autofixer, creative director and embeddings.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';
import { INSTANCE_FEATURE_IDS, INSTANCE_FEATURE_GROUP_IDS } from './instanceFeatureRegistry.js';

// Per-API external-access flags (issue: public API surface). Stored under the
// top-level `apiAccess` settings key (client-readable — NOT under `secrets`).
// Drives `server/lib/apiRegistry.js`: an entry that is `exposed && !requireAuth`
// re-opens its public mount even when the PortOS password is on. Both flags are
// optional so a partial PUT only patches what it carries; the registry fills
// absent flags from its per-API defaults (exposed:false, requireAuth:false).
const apiAccessEntrySchema = z.object({
  exposed: z.boolean().optional(),
  requireAuth: z.boolean().optional(),
}).strict();

export const apiAccessSettingsSchema = z.object({
  voice: apiAccessEntrySchema.optional(),
  sdapi: apiAccessEntrySchema.optional(),
}).strict();

// Install-local feature participation flags. `instanceFeatureRegistry.js` owns
// the available feature ids and both schemas derive from it, so registering a
// feature there needs no edit here; the schemas keep generic settings saves from
// persisting an unknown or malformed feature state.
export const instanceFeatureSettingsSchema = z.object(
  Object.fromEntries(INSTANCE_FEATURE_IDS.map((id) => [
    id,
    z.object({ enabled: z.boolean().optional() }).strict().optional(),
  ]))
).strict();

export const instanceFeatureIdSchema = z.enum([...INSTANCE_FEATURE_IDS]);

// `enabled: null` is the tri-state override going back to "inherit" — it clears
// the stored value rather than writing a third sentinel, so a grouped feature's
// resolution falls through to its group's `enabled` flag (see resolveOne in
// services/instanceFeatures.js). Every existing caller sends a real boolean;
// only the grouped-feature override control in Settings > Features sends null.
export const instanceFeatureUpdateSchema = z.object({
  enabled: z.boolean().nullable(),
}).strict();

// Install-local feature GROUP participation flags. A group has no inherit
// state of its own — just an on/off default-true toggle — so unlike
// instanceFeatureUpdateSchema above this stays non-nullable.
export const instanceFeatureGroupSettingsSchema = z.object(
  Object.fromEntries(INSTANCE_FEATURE_GROUP_IDS.map((id) => [
    id,
    z.object({ enabled: z.boolean().optional() }).strict().optional(),
  ]))
).strict();

export const instanceFeatureGroupIdSchema = z.enum([...INSTANCE_FEATURE_GROUP_IDS]);

export const instanceFeatureGroupUpdateSchema = z.object({
  enabled: z.boolean(),
}).strict();

// Geographic home location for location-aware features — the `weather_now`
// voice tool today, any future location-dependent surface tomorrow. Stored on
// `settings.location`. lat/lon are nullable so the user can clear a saved
// location and fall the consuming tool back to its default. The refine enforces
// both-or-neither so a half-set pair can't pin a nonsensical coordinate
// (e.g. a custom latitude with a default longitude).
export const locationSettingsSchema = z.object({
  lat: z.number().min(-90).max(90).nullable().optional(),
  lon: z.number().min(-180).max(180).nullable().optional(),
}).strict().refine(
  (d) => (d.lat == null) === (d.lon == null),
  { message: 'Provide both lat and lon, or neither.' },
);

// Durable "don't show this again" for the dashboard first-run card (#5640).
// Top-level general-settings boolean — same record as timezone/location, never
// localStorage. Absent means show; only an explicit true suppresses.
export const networkSetupPreferenceSchema = z.enum(['tailscale', 'tailcat', 'none']);

export const hideFirstRunCardSchema = z.boolean();

// Provider-agnostic embeddings settings: the one setting that drives BOTH
// catalog and memory embedding (#18296). `provider: 'none'` disables both —
// rows persist without an embedding and a re-embed action backfills. While the
// key is absent the catalog is off and memory keeps the legacy CoS config.
// Model is optional so the user can pick provider first and choose a model from
// the live list in the UI; it is stamped into the VARCHAR(100)
// `embedding_model` columns, hence max(100).
export const settingsEmbeddingsSchema = z.object({
  provider: z.enum(['ollama', 'lmstudio', 'none']),
  model: z.string().trim().max(100).optional().nullable(),
}).strict();
