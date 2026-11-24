/**
 * Zod schemas for feature priority pins, the pin update body and the visit beacon body.
 *
 * Pins live at `settings.featurePriorities.overrides[areaId]`, stored the way `settings.instanceFeatures` is: the area ids come from the catalog, so adding an area needs no edit here, and a generic settings save cannot persist an unknown area or tier.
 */

import { z } from 'zod';
import { FEATURE_AREAS } from './featureAreas.js';
import { FEATURE_PRIORITY_TIERS } from './featurePriorityScoring.js';

const AREA_IDS = FEATURE_AREAS.map((entry) => entry.id);

export const featurePriorityTierSchema = z.enum([...FEATURE_PRIORITY_TIERS]);

export const featurePriorityAreaIdSchema = z.enum([...AREA_IDS]);

// An absent key means "auto"; clearing a pin removes the key rather than storing a sentinel.
export const featurePrioritySettingsSchema = z.object({
  overrides: z.object(
    Object.fromEntries(AREA_IDS.map((id) => [id, featurePriorityTierSchema.optional()])),
  ).strict().optional(),
}).strict();

// `tier: null` clears the pin.
export const featurePriorityUpdateSchema = z.object({
  tier: featurePriorityTierSchema.nullable(),
}).strict();

// A pathname is at most a few hundred characters; the cap stops the beacon being a free-text sink.
export const featureVisitSchema = z.object({
  path: z.string().min(1).max(512),
}).strict();
