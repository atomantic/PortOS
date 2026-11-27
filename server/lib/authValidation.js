/**
 * Zod schemas for authentication, session revocation, and agent-key management.
 */

import { z } from 'zod';

export const loginSchema = z.object({ password: z.string().min(1).max(256) }).strict();

export const setPasswordSchema = z.object({
  newPassword: z.string().min(8).max(256),
  currentPassword: z.string().max(256).optional(),
}).strict();

export const clearPasswordSchema = z.object({ currentPassword: z.string().min(1).max(256) }).strict();

// Batch revoke is label-scoped so it can only ever drop non-interactive
// credentials (never the caller's browser session, which carries no label).
export const revokeSessionsQuerySchema = z.object({ label: z.literal('agent') }).strict();

export const sessionIdParamSchema = z.object({ id: z.string().min(1).max(64).regex(/^[a-f0-9]+$/) }).strict();

export const agentKeyToggleSchema = z.object({ enabled: z.boolean() }).strict();
