/**
 * Zod schemas for model-comparison observations, catalog import, discovery and benchmark-run routes.
 *
 * Moved out of the retired catch-all validation.js (#16828); the route family that consumes these schemas imports this module directly.
 */

import { z } from 'zod';

// Reference prices and PortOS-run benchmark observations. A source is attached
// to each metric because prices, scores and runtime measurements differ.
const isAllowedComparisonSourceUrl = value => {
  if (/^portos:\/\/model-comparison\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
};
const comparisonSourceSchema = z.object({
  url: z.string().min(1).max(2000).refine(
    isAllowedComparisonSourceUrl,
    'Source must use HTTPS or identify a PortOS benchmark run',
  ),
  retrievedAt: z.string().datetime().refine(value => Date.parse(value) <= Date.now(), 'Source date cannot be in the future'),
  methodology: z.string().min(1).max(1000),
}).strict();
const comparisonMetricSchema = z.object({ value: z.number().finite().nonnegative(), source: comparisonSourceSchema }).strict();
export const modelComparisonObservationSchema = z.object({
  id: z.string().min(1).max(200),
  provider: z.string().min(1).max(160),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80),
  configuration: z.string().min(1).max(500),
  billing: z.enum(['api', 'subscription', 'local', 'free', 'unknown']),
  benchmark: z.string().min(1).max(160),
  quality: comparisonMetricSchema.nullable(),
  costPerTask: comparisonMetricSchema.nullable(),
  inputPerMillion: comparisonMetricSchema.nullable(),
  outputPerMillion: comparisonMetricSchema.nullable(),
  reasoningPerMillion: comparisonMetricSchema.nullable(),
  responseSeconds: comparisonMetricSchema.nullable(),
  tokensPerSecond: comparisonMetricSchema.nullable(),
  tokensPerRun: comparisonMetricSchema.nullable().optional(),
  inputTokens: comparisonMetricSchema.nullable().optional(),
  outputTokens: comparisonMetricSchema.nullable().optional(),
  apiEquivalentCost: comparisonMetricSchema.nullable().optional(),
  tokenBasis: z.enum(['measured', 'estimated', 'mixed']).nullable().optional(),
  completedTasks: z.number().int().nonnegative().max(1000).nullable().optional(),
  totalTasks: z.number().int().positive().max(1000).nullable().optional(),
  quota: z.object({ unitsPerTask: z.number().finite().nonnegative(), unit: z.string().min(1).max(80), source: comparisonSourceSchema }).strict().nullable(),
  notes: z.string().max(2000),
}).strict().superRefine((row, ctx) => {
  if (row.benchmark === 'PortOS Research Index v1 (AA v4.3.2 scale)' && row.quality) {
    if (row.quality.value > 100) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quality', 'value'], message: 'PortOS research index must be between 0 and 100' });
    if (!row.quality.source.methodology.startsWith('PortOS estimate:')) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['quality', 'source', 'methodology'], message: 'Research estimates must disclose their derivation with PortOS estimate:' });
  }
});
const modelComparisonCatalogBaseSchema = z.object({
  schemaVersion: z.literal(1),
  // Source imports can contain thousands of independently attributed rows and
  // are applied as one atomic catalog merge.
  observations: z.array(modelComparisonObservationSchema).max(12000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set();
  value.observations.forEach((row, index) => {
    if (ids.has(row.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index, 'id'], message: 'Duplicate observation id' });
    ids.add(row.id);
    if (!row.quality && !row.costPerTask && !row.inputPerMillion && !row.outputPerMillion && !row.reasoningPerMillion && !row.responseSeconds && !row.tokensPerSecond && !row.quota && !row.tokensPerRun && !row.inputTokens && !row.outputTokens && !row.apiEquivalentCost) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['observations', index], message: 'At least one sourced metric is required' });
    }
  });
});
// A migration may legitimately retire the last legacy observation. The stored
// catalog can then be empty, but client imports still need at least one row.
export const modelComparisonCatalogSchema = modelComparisonCatalogBaseSchema;
export const modelComparisonImportSchema = modelComparisonCatalogBaseSchema.refine(
  value => value.observations.length > 0,
  { message: 'At least one observation is required', path: ['observations'] },
);

export const modelComparisonDiscoverySchema = z.object({ providerId: z.string().min(1).max(200) }).strict();

export const modelComparisonBenchmarkRunSchema = z.object({
  providerId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  effort: z.string().min(1).max(80).nullable().optional(),
}).strict();
