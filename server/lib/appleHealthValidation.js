import { z } from 'zod';

// =============================================================================
// APPLE HEALTH INGEST SCHEMAS
// Validates payloads from the Health Auto Export iOS app (v7+)
// =============================================================================

/**
 * Individual data point from a health metric.
 * Uses passthrough to allow future fields added by app updates.
 */
export const healthDataPointSchema = z.object({
  date: z.string().min(1),
  qty: z.number().optional(),
  // Heart rate fields
  Min: z.number().optional(),
  Avg: z.number().optional(),
  Max: z.number().optional(),
  // Sleep analysis fields
  totalSleep: z.number().optional(),
  deep: z.number().optional(),
  rem: z.number().optional(),
  core: z.number().optional(),
  awake: z.number().optional()
}).passthrough();

/**
 * A named health metric with its associated data points.
 */
export const healthMetricSchema = z.object({
  name: z.string().min(1),
  units: z.string().optional(),
  data: z.array(healthDataPointSchema)
});

/**
 * Top-level ingest payload schema matching Health Auto Export JSON format:
 * {
 *   "data": {
 *     "metrics": [...],
 *     "workouts": [...]
 *   }
 * }
 * Uses passthrough on the data object to allow future Health Auto Export fields.
 */
export const healthIngestSchema = z.object({
  data: z.object({
    metrics: z.array(healthMetricSchema).default([]),
    workouts: z.array(z.unknown()).default([])
  }).passthrough()
});

// Repeated keys (?metrics=a&metrics=b) parse to an array; z.string() refuses them with a 400.
export const appleHealthLatestMetricsQuerySchema = z.object({
  metrics: z.string().max(2000).optional()
});

export const appleHealthDayParamSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});
