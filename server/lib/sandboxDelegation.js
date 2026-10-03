import { z } from 'zod';

// A context packet is data supplied by the orchestrator, never a path to read.
export const sandboxModelRouteSchema = z.object({
  providerId: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200),
}).strict();

export const sandboxDelegationConfigSchema = z.object({
  workers: z.array(sandboxModelRouteSchema).max(20),
  evaluator: sandboxModelRouteSchema.nullable(),
}).strict();

export const sandboxDelegationRequestSchema = z.object({
  ...sandboxModelRouteSchema.shape,
  kind: z.enum(['coding', 'text', 'animation']),
  task: z.string().trim().min(1).max(8000),
  context: z.string().trim().min(1).max(48000),
  criteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
  maxAttempts: z.number().int().min(1).max(2).optional().default(1),
}).strict();

export const sandboxEvaluationSchema = z.object({
  safe: z.boolean(),
  contextSufficient: z.boolean(),
  summary: z.string().trim().min(1).max(2000),
  checks: z.array(z.object({
    criterion: z.number().int().min(0).max(11),
    passed: z.boolean(),
    evidence: z.string().trim().min(1).max(1000),
  }).strict()).min(1).max(12),
}).strict();

export const SANDBOX_DELEGATION_OUTPUT_CHARS = 48000;

export const normalizeSandboxDelegationConfig = (raw) =>
  sandboxDelegationConfigSchema.safeParse(raw).data || { workers: [], evaluator: null };

export const sameSandboxRoute = (left, right) =>
  left?.providerId === right?.providerId && left?.model === right?.model;

